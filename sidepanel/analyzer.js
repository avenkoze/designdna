// DesignDNA — analyzer. Runs in the side panel.
// Takes the raw sampler payload + background CSS-parse data and produces
// the final analysis object consumed by the UI and exporters.
// Exposed as a global: window.DDNA.analyze(payload, cssData)

(function () {
  'use strict';

  // ---------------------------- color math ----------------------------

  function parseColor(str) {
    if (!str) return null;
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(str);
    if (m) {
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    }
    // Modern space-separated syntax: rgb(11 11 12 / 0.5)
    const m2 = /rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/.exec(str);
    if (m2) {
      let a = 1;
      if (m2[4] !== undefined) a = m2[4].endsWith('%') ? parseFloat(m2[4]) / 100 : +m2[4];
      return { r: +m2[1], g: +m2[2], b: +m2[3], a };
    }
    return null;
  }

  function toHex(c) {
    const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  function srgbToLinear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function rgbToLab(c) {
    const r = srgbToLinear(c.r);
    const g = srgbToLinear(c.g);
    const b = srgbToLinear(c.b);
    // sRGB D65 → XYZ
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    let z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = f(x);
    y = f(y);
    z = f(z);
    return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
  }

  function deltaE(l1, l2) {
    return Math.sqrt((l1.L - l2.L) ** 2 + (l1.a - l2.a) ** 2 + (l1.b - l2.b) ** 2);
  }

  function luminance(c) {
    return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
  }

  function contrastRatio(c1, c2) {
    const l1 = luminance(c1);
    const l2 = luminance(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function saturation(c) {
    const max = Math.max(c.r, c.g, c.b) / 255;
    const min = Math.min(c.r, c.g, c.b) / 255;
    if (max === 0) return 0;
    return (max - min) / max; // HSV saturation
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
  }

  // Parses literal color values found in design tokens: hex, rgb(), hsl().
  // Returns null for var() refs, gradients, and anything else non-literal.
  function parseTokenColor(value) {
    if (!value) return null;
    const v = value.trim();
    const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
    if (hex) {
      let h = hex[1];
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      };
    }
    const rgb = parseColor(v);
    if (rgb) return rgb;
    const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%/i.exec(v);
    if (hsl) return hslToRgb(+hsl[1], +hsl[2], +hsl[3]);
    return null;
  }

  function extractTokenColors(rawProps) {
    const out = [];
    for (const name in rawProps || {}) {
      const rgb = parseTokenColor(rawProps[name]);
      if (rgb && rgb.a >= 0.05 && out.length < 80) {
        out.push({ name, rgb, lab: rgbToLab(rgb), hex: toHex(rgb) });
      }
    }
    return out;
  }

  // ---------------------------- colors ----------------------------

  function analyzeColors(rawColors, tokenColors) {
    const clusters = [];
    const sorted = (rawColors || [])
      .map((entry) => {
        const c = parseColor(entry.value);
        if (!c || c.a < 0.05) return null;
        return { rgb: c, lab: rgbToLab(c), weight: entry.area * c.a, sources: { [entry.source]: entry.area } };
      })
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight);

    for (const item of sorted) {
      let merged = false;
      for (const cl of clusters) {
        if (deltaE(cl.lab, item.lab) < 10) {
          cl.weight += item.weight;
          for (const s in item.sources) cl.sources[s] = (cl.sources[s] || 0) + item.sources[s];
          merged = true;
          break;
        }
      }
      if (!merged && clusters.length < 60) {
        clusters.push({ rgb: item.rgb, lab: item.lab, weight: item.weight, sources: { ...item.sources } });
      }
    }

    clusters.sort((a, b) => b.weight - a.weight);
    const total = clusters.reduce((s, c) => s + c.weight, 0) || 1;
    const top = clusters.slice(0, 12);

    // Role heuristics
    let bg = null;
    let fg = null;
    let accent = null;
    // background: largest weighted cluster dominated by 'bg' samples
    bg = top.find((c) => (c.sources.bg || 0) >= c.weight * 0.5) || top[0] || null;
    if (bg) {
      // foreground: highest contrast vs bg among text-bearing clusters
      let best = 0;
      for (const c of top) {
        if (c === bg || !(c.sources.text > 0)) continue;
        const cr = contrastRatio(c.rgb, bg.rgb);
        if (cr > best) {
          best = cr;
          fg = c;
        }
      }
      // accent: most saturated remaining color with non-trivial weight
      let bestScore = 0;
      for (const c of top) {
        if (c === bg || c === fg) continue;
        const sat = saturation(c.rgb);
        if (sat < 0.25) continue;
        const score = sat * Math.pow(c.weight / total, 0.3);
        if (score > bestScore) {
          bestScore = score;
          accent = c;
        }
      }
    }

    // Cross-check against design-token colors: a token within ΔE 10 of a
    // sampled cluster is the canonical value (designer intent beats rendered
    // pixels). Sampled colors with no token match are "rendered tones".
    const hasTokens = (tokenColors || []).length > 0;
    const tokenFor = (cluster) => {
      let best = null;
      let bestDe = 10;
      for (const t of tokenColors || []) {
        const de = deltaE(cluster.lab, t.lab);
        if (de < bestDe) {
          bestDe = de;
          best = t;
        }
      }
      return best;
    };

    const palette = top.map((c) => {
      const token = hasTokens ? tokenFor(c) : null;
      return {
        hex: token ? token.hex : toHex(c.rgb),
        rgb: `rgb(${Math.round(c.rgb.r)}, ${Math.round(c.rgb.g)}, ${Math.round(c.rgb.b)})`,
        pct: Math.round((c.weight / total) * 1000) / 10,
        role: c === bg ? 'background' : c === fg ? 'foreground' : c === accent ? 'accent' : '',
        sources: Object.keys(c.sources).sort((a, b) => c.sources[b] - c.sources[a]),
        token: token ? token.name : null,
        rendered: hasTokens && !token
      };
    });

    return {
      palette,
      background: bg ? toHex(bg.rgb) : null,
      foreground: fg ? toHex(fg.rgb) : null,
      accent: accent ? toHex(accent.rgb) : null,
      isDark: bg ? luminance(bg.rgb) < 0.5 : null,
      contrast: bg && fg ? Math.round(contrastRatio(bg.rgb, fg.rgb) * 10) / 10 : null
    };
  }

  // ---------------------------- typography ----------------------------

  const RATIO_NAMES = [
    [1.067, 'minor second (1.067)'],
    [1.125, 'major second (1.125)'],
    [1.2, 'minor third (1.2)'],
    [1.25, 'major third (1.25)'],
    [1.333, 'perfect fourth (1.333)'],
    [1.414, 'augmented fourth (1.414)'],
    [1.5, 'perfect fifth (1.5)'],
    [1.618, 'golden ratio (1.618)']
  ];

  function topKey(freqMap) {
    let best = null;
    let n = -1;
    for (const k in freqMap || {}) {
      if (freqMap[k] > n) {
        n = freqMap[k];
        best = k;
      }
    }
    return best;
  }

  // Type-size tokens (--text-*, --font-size-*, --heading-*, …) are the
  // designer's declared scale — merge them in, converting rem/em via the
  // page's root font-size.
  function extractTokenSizes(rawProps, rootFontSize) {
    const out = [];
    const root = rootFontSize || 16;
    const nameRe = /--[\w-]*(text|font-size|fs|type|heading|title|display)[\w-]*/i;
    for (const name in rawProps || {}) {
      if (!nameRe.test(name)) continue;
      const m = /^([\d.]+)(px|rem|em)$/.exec(String(rawProps[name]).trim());
      if (!m) continue;
      const px = m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * root;
      if (isFinite(px) && px >= 8 && px <= 200) out.push(px);
    }
    return out;
  }

  function analyzeTypography(typo, fonts, cssData, rawProps) {
    const tags = typo && typo.tags ? typo.tags : {};
    const sizeFreq = typo && typo.sizeFreq ? typo.sizeFreq : {};

    // --- scale ---
    const sizes = new Set();
    for (const k in sizeFreq) {
      const v = Math.round(parseFloat(k) * 2) / 2;
      if (isFinite(v) && v >= 8 && v <= 200 && sizeFreq[k] >= 2) sizes.add(v);
    }
    // always include heading sizes even if rare
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const t = tags[tag];
      if (t) {
        const s = topKey(t.sizes);
        if (s) {
          const v = Math.round(parseFloat(s) * 2) / 2;
          if (isFinite(v) && v >= 8 && v <= 200) sizes.add(v);
        }
      }
    }
    // merge token-declared sizes
    for (const px of extractTokenSizes(rawProps, typo && typo.rootFontSize)) {
      sizes.add(Math.round(px * 2) / 2);
    }
    const scale = [...sizes].sort((a, b) => a - b);

    let ratio = null;
    let ratioName = null;
    if (scale.length >= 3) {
      const ratios = [];
      for (let i = 1; i < scale.length; i++) {
        const r = scale[i] / scale[i - 1];
        if (r > 1.02 && r < 2.2) ratios.push(r);
      }
      if (ratios.length >= 2) {
        ratios.sort((a, b) => a - b);
        const median = ratios[Math.floor(ratios.length / 2)];
        const spread = ratios[ratios.length - 1] - ratios[0];
        if (spread < 0.35) {
          ratio = Math.round(median * 1000) / 1000;
          for (const [r, name] of RATIO_NAMES) {
            if (Math.abs(median - r) < 0.035) {
              ratioName = name;
              break;
            }
          }
        }
      }
    }

    // --- families with roles ---
    const famUsage = new Map(); // family -> {headings, body, ui, weights:Set}
    const note = (family, role, weight) => {
      if (!family) return;
      const f = family.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (!f) return;
      let e = famUsage.get(f);
      if (!e) {
        e = { family: f, roles: new Set(), weights: new Set() };
        famUsage.set(f, e);
      }
      e.roles.add(role);
      if (weight) e.weights.add(String(weight));
    };
    const samples = (fonts && fonts.samples) || {};
    for (const sel in samples) {
      const s = samples[sel];
      const role = /^h[1-6]$/.test(sel) ? 'headings' : sel === 'p' || sel === 'body' ? 'body' : 'ui';
      note(s.fontFamily, role, s.fontWeight);
    }
    for (const tag in tags) {
      const t = tags[tag];
      const role = /^h[1-6]$/.test(tag) ? 'headings' : tag === 'p' ? 'body' : 'ui';
      note(topKey(t.families), role, topKey(t.weights));
    }
    for (const f of (fonts && fonts.loaded) || []) {
      const e = famUsage.get(f.family);
      if (e) e.weights.add(String(f.weight));
    }
    // webfonts from @font-face are real brand fonts — surface them even if unmatched
    for (const fam of (cssData && cssData.fontFaces) || []) {
      if (!famUsage.has(fam)) {
        famUsage.set(fam, { family: fam, roles: new Set(['webfont']), weights: new Set() });
      }
    }

    const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy', 'ui-monospace', 'ui-sans-serif', 'ui-serif']);
    const families = [...famUsage.values()]
      .map((e) => ({
        family: e.family,
        roles: [...e.roles],
        weights: [...e.weights].sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0)),
        generic: GENERIC.has(e.family.toLowerCase())
      }))
      .sort((a, b) => (a.generic ? 1 : 0) - (b.generic ? 1 : 0))
      .slice(0, 8);

    // --- per-tag summary ---
    const tagSummary = {};
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'li', 'span']) {
      const t = tags[tag];
      if (!t || !t.count) continue;
      tagSummary[tag] = {
        size: topKey(t.sizes),
        weight: topKey(t.weights),
        lineHeight: topKey(t.lineHeights),
        letterSpacing: topKey(t.letterSpacings),
        family: topKey(t.families)
      };
    }

    return { families, scale, ratio, ratioName, tags: tagSummary };
  }

  // ---------------------------- spacing ----------------------------

  function analyzeSpacing(values) {
    const freq = {};
    for (const v of values || []) {
      const r = Math.round(v);
      freq[r] = (freq[r] || 0) + 1;
    }
    const entries = Object.entries(freq)
      .map(([v, n]) => ({ value: +v, count: n }))
      .filter((e) => e.value >= 2)
      .sort((a, b) => b.count - a.count);

    // Cluster near-identical values (±2px) into the most frequent representative
    const clustered = [];
    for (const e of entries) {
      const hit = clustered.find((c) => Math.abs(c.value - e.value) <= 2);
      if (hit) hit.count += e.count;
      else clustered.push({ ...e });
    }
    clustered.sort((a, b) => b.count - a.count);
    // Drop outliers: a spacing value is only part of the system if it
    // occurs on 3+ distinct elements.
    const top = clustered
      .filter((c) => c.count >= 3)
      .slice(0, 10)
      .sort((a, b) => a.value - b.value);

    // Base unit detection
    const all = (values || []).filter((v) => v >= 4);
    let base = null;
    if (all.length >= 5) {
      const share = (unit) => all.filter((v) => v % unit === 0).length / all.length;
      if (share(8) >= 0.6) base = 8;
      else if (share(4) >= 0.6) base = 4;
    }
    return { values: top, base, sampleCount: (values || []).length };
  }

  // ---------------------------- motion ----------------------------

  const KNOWN_BEZIERS = [
    [/cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/, 'expo-out'],
    [/cubic-bezier\(0\.87,\s*0,\s*0\.13,\s*1\)/, 'expo-in-out'],
    [/cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/, 'quint-out'],
    [/cubic-bezier\(0\.83,\s*0,\s*0\.17,\s*1\)/, 'quint-in-out'],
    [/cubic-bezier\(0\.25,\s*0\.1,\s*0\.25,\s*1\)/, 'ease (default)'],
    [/cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/, 'material standard'],
    [/cubic-bezier\(0\.65,\s*0,\s*0\.35,\s*1\)/, 'cubic-in-out'],
    [/cubic-bezier\(0\.33,\s*1,\s*0\.68,\s*1\)/, 'cubic-out']
  ];

  function friendlyEasing(value) {
    for (const [re, name] of KNOWN_BEZIERS) {
      if (re.test(value)) return name;
    }
    return null;
  }

  function parseDurationMs(d) {
    const m = /([\d.]+)\s*(ms|s)/.exec(d);
    if (!m) return null;
    return m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
  }

  function analyzeMotion(payload, cssData) {
    // Merge computed easings (freq maps) with stylesheet-parsed easings (arrays)
    const easeFreq = {};
    const add = (v, n) => {
      if (!v) return;
      const key = v.trim();
      if (!key) return;
      easeFreq[key] = (easeFreq[key] || 0) + n;
    };
    for (const k in payload.easings || {}) add(k, payload.easings[k]);
    for (const e of (cssData && cssData.easings) || []) add(e, 1);

    const easings = Object.entries(easeFreq)
      .map(([value, count]) => ({ value, count, name: friendlyEasing(value) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Durations
    const durMs = [];
    for (const k in payload.durations || {}) {
      const ms = parseDurationMs(k);
      if (ms !== null && ms > 0) for (let i = 0; i < payload.durations[k]; i++) durMs.push(ms);
    }
    for (const d of (cssData && cssData.durations) || []) if (d > 0) durMs.push(d);
    durMs.sort((a, b) => a - b);
    const durations = durMs.length
      ? {
          min: durMs[0],
          max: durMs[durMs.length - 1],
          median: durMs[Math.floor(durMs.length / 2)]
        }
      : null;

    // Keyframes: names from stylesheets + computed animation-name usage
    const kfNames = new Set();
    for (const kf of (cssData && cssData.keyframes) || []) kfNames.add(kf.name);
    for (const n in payload.animationNames || {}) if (n && n !== 'none') kfNames.add(n);

    const libs = payload.motionLibs && payload.motionLibs.libs ? payload.motionLibs.libs : [];
    const libDetail = payload.motionLibs && payload.motionLibs.detail ? payload.motionLibs.detail : {};

    // Bundled-library signatures from script scanning (lower confidence).
    // Skip anything the window-global detection already confirmed.
    const BUNDLED_CANONICAL = {
      gsap: 'GSAP',
      ScrollTrigger: 'ScrollTrigger',
      ScrollSmoother: 'ScrollSmoother',
      lenis: 'Lenis',
      'locomotive-scroll': 'Locomotive Scroll',
      'framer-motion': 'Framer Motion',
      anime: 'Anime.js',
      barba: 'Barba.js',
      swup: 'Swup'
    };
    const confirmed = new Set(libs.map((l) => l.toLowerCase()));
    const gsapPlugins = ((libDetail.GSAP && libDetail.GSAP.plugins) || []).map((p) => p.toLowerCase());
    const bundled = [];
    for (const sig of (cssData && cssData.bundled) || []) {
      const canonical = BUNDLED_CANONICAL[sig] || sig;
      const lc = canonical.toLowerCase();
      const alreadyConfirmed =
        [...confirmed].some((c) => c.indexOf(lc) !== -1) || gsapPlugins.indexOf(lc) !== -1;
      if (!alreadyConfirmed) bundled.push(canonical);
    }

    return {
      libs,
      libDetail,
      bundled,
      easings,
      durations,
      keyframes: [...kfNames].slice(0, 25),
      keyframeBodies: ((cssData && cssData.keyframes) || []).slice(0, 10),
      hasMotion: libs.length > 0 || bundled.length > 0 || easings.length > 0 || kfNames.size > 0
    };
  }

  // ---------------------------- hero media ----------------------------

  function analyzeMedia(payload) {
    const media = payload.media || {};
    const detail = (payload.motionLibs && payload.motionLibs.detail) || {};
    const libs = (payload.motionLibs && payload.motionLibs.libs) || [];
    const contexts = detail.canvasContexts || [];
    const threejs = libs.some((l) => l.indexOf('Three.js') !== -1);

    const videos = (media.videos || []).map((v) => ({
      ...v,
      label: v.fullscreenBackground ? 'fullscreen video background' : 'video'
    }));

    const canvases = (media.canvases || []).map((c, i) => {
      const context = contexts[i] || null;
      const isGl = context === 'webgl' || context === 'webgl2';
      let library = null;
      if (isGl && threejs) library = 'Three.js';
      else if (isGl) library = 'WebGL';
      return {
        ...c,
        context,
        library,
        label: c.fullscreen
          ? 'fullscreen ' + (isGl ? 'WebGL' : 'canvas') + ' animation'
          : isGl
            ? 'WebGL canvas'
            : 'canvas'
      };
    });

    return { videos, canvases, hasMedia: videos.length > 0 || canvases.length > 0 };
  }

  // ---------------------------- geometry ----------------------------

  function classifyRadius(px) {
    if (px <= 2) return 'sharp';
    if (px < 8) return 'rounded';
    if (px >= 999) return 'pill';
    if (px >= 24) return 'very soft';
    return 'soft';
  }

  function analyzeGeometry(radii, shadows) {
    const radiusEntries = Object.entries(radii || {})
      .map(([value, count]) => {
        const first = value.split(/[\s/]/)[0];
        let cls = null;
        if (first.endsWith('%')) {
          cls = parseFloat(first) >= 50 ? 'circle/pill' : 'percent';
        } else {
          const px = parseFloat(first);
          if (isFinite(px)) cls = classifyRadius(px);
        }
        return { value, count, class: cls };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    let radiusStyle = 'not detected';
    if (radiusEntries.length) {
      const dominant = radiusEntries[0];
      radiusStyle = dominant.class || 'mixed';
    } else {
      radiusStyle = 'sharp (no rounding found)';
    }

    const shadowEntries = Object.entries(shadows || {})
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    let shadowStyle = 'flat (no shadows)';
    if (shadowEntries.length) {
      const blur = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(shadowEntries[0].value);
      if (blur) {
        const b = parseFloat(blur[3]);
        shadowStyle = b >= 20 ? 'soft, diffused' : b >= 6 ? 'moderate' : 'hard, tight';
      } else {
        shadowStyle = 'present';
      }
    }

    return { radii: radiusEntries, radiusStyle, shadows: shadowEntries, shadowStyle };
  }

  // ---------------------------- layout ----------------------------

  function analyzeLayout(layout, cssData) {
    const out = { ...(layout || {}) };
    const widths = Object.entries(out.containerMaxWidths || {})
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
    out.containerMaxWidths = widths;
    out.breakpoints = (cssData && cssData.breakpoints) || [];
    return out;
  }

  // ---------------------------- custom props ----------------------------

  function mergeCustomProps(samplerProps, cssData) {
    const merged = { ...((cssData && cssData.customProps) || {}), ...(samplerProps || {}) };
    const keys = Object.keys(merged);
    const groups = { color: [], spacing: [], typography: [], radius: [], shadow: [], motion: [], other: [] };
    for (const k of keys) {
      const lk = k.toLowerCase();
      const v = merged[k];
      let g = 'other';
      if (/(color|clr|bg|background|fill|stroke|brand|accent|primary|secondary)/.test(lk) || /^#|^rgb|^hsl|^oklch|^lab/.test(v)) g = 'color';
      else if (/(space|spacing|gap|margin|padding|size-)/.test(lk)) g = 'spacing';
      else if (/(font|text|type|leading|tracking|line-height)/.test(lk)) g = 'typography';
      else if (/(radius|rounded)/.test(lk)) g = 'radius';
      else if (/(shadow|elevation)/.test(lk)) g = 'shadow';
      else if (/(ease|easing|duration|transition|anim|speed)/.test(lk)) g = 'motion';
      groups[g].push({ name: k, value: v });
    }
    for (const g in groups) groups[g] = groups[g].slice(0, 40);
    return { count: keys.length, groups };
  }

  // ---------------------------- main ----------------------------

  function analyze(payload, cssData) {
    cssData = cssData || {};
    // Raw merged token map (sampler computed values win over stylesheet text)
    const rawProps = { ...(cssData.customProps || {}), ...(payload.customProps || {}) };
    return {
      meta: {
        url: payload.url,
        hostname: payload.hostname,
        title: payload.title,
        capturedAt: payload.capturedAt,
        viewport: payload.viewport,
        sampledElements: payload.sampledElements,
        stylesheets: {
          linked: (payload.stylesheets && payload.stylesheets.hrefs ? payload.stylesheets.hrefs.length : 0),
          inline: (payload.stylesheets && payload.stylesheets.inlineCount) || 0,
          fetched: cssData.sheetsFetched || 0,
          failed: cssData.sheetsFailed || 0
        },
        errors: payload.errors || []
      },
      colors: analyzeColors(payload.colors, extractTokenColors(rawProps)),
      typography: analyzeTypography(payload.typography, payload.fonts, cssData, rawProps),
      spacing: analyzeSpacing(payload.spacing),
      motion: analyzeMotion(payload, cssData),
      media: analyzeMedia(payload),
      geometry: analyzeGeometry(payload.radii, payload.shadows),
      layout: analyzeLayout(payload.layout, cssData),
      details: payload.details || {},
      customProps: mergeCustomProps(payload.customProps, cssData),
      mediaQueries: cssData.mediaQueries || []
    };
  }

  window.DDNA = { analyze };
})();

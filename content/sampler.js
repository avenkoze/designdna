// DesignDNA — content script (isolated world). Dumb collector:
// gathers RAW data only and resolves a single JSON payload as the
// executeScript completion value. All heavy analysis happens in the
// side panel (sidepanel/analyzer.js).
//
// Every sub-extractor is wrapped so one failure never kills the run.

(async () => {
  const payload = {
    ok: true,
    url: location.href,
    hostname: location.hostname,
    title: document.title || location.hostname,
    capturedAt: new Date().toISOString(),
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
    motionLibs: null,
    customProps: {},
    fonts: { loaded: [], samples: {} },
    colors: [],
    typography: { tags: {}, sizeFreq: {}, rootFontSize: 16 },
    media: { videos: [], canvases: [] },
    scripts: [],
    spacing: [],
    radii: {},
    shadows: {},
    easings: {},
    durations: {},
    animationNames: {},
    layout: {},
    details: {},
    stylesheets: { hrefs: [], inlineCount: 0 },
    sampledElements: 0,
    errors: []
  };

  const safe = (label, fn) => {
    try {
      fn();
    } catch (e) {
      payload.errors.push(label + ': ' + (e && e.message ? e.message : String(e)));
    }
  };

  // ---- 0. Listen for the MAIN-world detection relay (injected separately) ----
  safe('libListener', () => {
    const onLibs = (e) => {
      if (e.source === window && e.data && e.data.__DESIGN_DNA_LIBS__) {
        payload.motionLibs = e.data.__DESIGN_DNA_LIBS__;
        window.removeEventListener('message', onLibs);
      }
    };
    window.addEventListener('message', onLibs);
  });

  // ---- 1. Auto-scroll BEFORE sampling: triggers lazy content + entrance anims ----
  await autoScroll().catch(() => {});

  // ---- 2. CSS custom properties ----
  safe('customProps', () => {
    payload.customProps = collectCustomProps();
  });

  // ---- 3. Fonts ----
  safe('fonts', () => {
    payload.fonts = collectFonts();
  });

  // ---- Hero media (video/canvas metadata) — also feeds the overlay filter ----
  let largeMediaRects = [];
  safe('media', () => {
    largeMediaRects = collectMedia();
  });

  // ---- 4–7. Single visible-element pass: colors, type, geometry, easings ----
  safe('elementPass', () => {
    sampleElements(largeMediaRects);
  });

  // ---- Headings: explicit pass, ignores viewport/opacity (entrance anims
  //      hide them at sample time) and reads the heading's own computed
  //      style so split-text char/word spans don't pollute the scale ----
  safe('headings', () => {
    sampleHeadings();
  });

  // ---- 5. Spacing of section-level elements ----
  safe('spacing', () => {
    payload.spacing = collectSpacing();
  });

  // ---- 7. Layout signals ----
  safe('layout', () => {
    payload.layout = collectLayout();
  });

  // ---- 8. Details: ::selection, cursor, scrollbar ----
  safe('details', () => {
    payload.details = collectDetails();
  });

  // ---- 9. Stylesheet hrefs + inline <style> count ----
  safe('stylesheets', () => {
    payload.stylesheets = collectStylesheetRefs();
  });

  // ---- 10. Same-origin script srcs → background scans for bundled libs ----
  safe('scripts', () => {
    payload.scripts = collectScriptRefs();
  });

  // Give the MAIN-world relay a final grace window if it hasn't landed yet.
  if (!payload.motionLibs) {
    await new Promise((r) => setTimeout(r, 400));
  }

  return payload;

  // ======================================================================

  function autoScroll() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          scrollTo(0, 0);
        } catch (e) {}
        setTimeout(resolve, 150);
      };
      try {
        const TOTAL = 1900; // ~2s round trip
        const startY = scrollY;
        const maxY = Math.max(
          0,
          (document.documentElement.scrollHeight || document.body.scrollHeight || 0) - innerHeight
        );
        if (maxY < 50) return finish(); // nothing to scroll
        const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        const t0 = performance.now();
        const step = (now) => {
          if (done) return;
          const t = Math.min(1, (now - t0) / TOTAL);
          let y;
          if (t < 0.6) {
            y = startY + (maxY - startY) * easeInOut(t / 0.6); // down
          } else {
            y = maxY * (1 - easeInOut((t - 0.6) / 0.4)); // back up
          }
          scrollTo(0, y);
          if (t < 1) requestAnimationFrame(step);
          else finish();
        };
        requestAnimationFrame(step);
        setTimeout(finish, 3500); // hard safety cap
      } catch (e) {
        finish();
      }
    });
  }

  function collectCustomProps() {
    const props = {};
    const CAP = 300;

    const grabComputed = (el) => {
      if (!el) return;
      const cs = getComputedStyle(el);
      for (let i = 0; i < cs.length && Object.keys(props).length < CAP; i++) {
        const name = cs[i];
        if (name && name.indexOf('--') === 0) {
          const v = cs.getPropertyValue(name).trim();
          if (v && !(name in props)) props[name] = v.slice(0, 200);
        }
      }
    };
    grabComputed(document.documentElement);
    grabComputed(document.body);

    // Discover var names declared in accessible stylesheets, resolve via computed.
    const root = getComputedStyle(document.documentElement);
    const harvestRules = (rules) => {
      if (!rules) return;
      for (const rule of rules) {
        if (Object.keys(props).length >= CAP) return;
        try {
          if (rule.style) {
            for (let i = 0; i < rule.style.length; i++) {
              const name = rule.style[i];
              if (name.indexOf('--') === 0 && !(name in props)) {
                const v =
                  root.getPropertyValue(name).trim() ||
                  rule.style.getPropertyValue(name).trim();
                if (v) props[name] = v.slice(0, 200);
              }
            }
          }
          if (rule.cssRules) harvestRules(rule.cssRules);
        } catch (e) {}
      }
    };
    const allSheets = [];
    try {
      allSheets.push(...document.styleSheets);
    } catch (e) {}
    try {
      allSheets.push(...(document.adoptedStyleSheets || []));
    } catch (e) {}
    for (const sheet of allSheets) {
      let rules = null;
      try {
        rules = sheet.cssRules; // cross-origin throws SecurityError — skip
      } catch (e) {
        continue;
      }
      harvestRules(rules);
    }
    return props;
  }

  function collectFonts() {
    const out = { loaded: [], samples: {} };
    try {
      const seen = new Set();
      document.fonts.forEach((f) => {
        const family = String(f.family).replace(/['"]/g, '');
        const key = family + '|' + f.weight + '|' + f.style;
        if (seen.has(key) || seen.size > 60) return;
        seen.add(key);
        out.loaded.push({ family, weight: f.weight, style: f.style, status: f.status });
      });
    } catch (e) {}
    const selectors = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'nav', 'body'];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        out.samples[sel] = {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing
        };
      } catch (e) {}
    }
    return out;
  }

  // Collect visible elements, viewport-first, shadow DOM included, capped.
  function collectVisibleElements(cap) {
    const inViewport = [];
    const rest = [];
    const vw = innerWidth;
    const vh = innerHeight;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'BR', 'WBR']);

    const visit = (root, depth) => {
      if (depth > 4) return; // shadow nesting guard
      let walker;
      try {
        walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      } catch (e) {
        return;
      }
      let node;
      while ((node = walker.nextNode())) {
        if (inViewport.length + rest.length >= cap * 3) return;
        if (SKIP.has(node.tagName)) continue;
        try {
          if (node.shadowRoot) visit(node.shadowRoot, depth + 1);
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const item = { el: node, rect };
          if (rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw) {
            inViewport.push(item);
          } else {
            rest.push(item);
          }
        } catch (e) {}
      }
    };
    visit(document.body || document.documentElement, 0);
    return inViewport.concat(rest).slice(0, cap);
  }

  function sampleElements(largeMediaRects) {
    const items = collectVisibleElements(1500);
    payload.sampledElements = items.length;
    const colorMap = new Map(); // "value|source" -> {value, source, area}
    const viewportArea = innerWidth * innerHeight;

    // True when an element sits ON TOP of a large canvas/video (its painted
    // background isn't what the user actually sees). Ancestors of the media
    // element are behind it, not overlaying it — keep those.
    const overlaysMedia = (el, rect) => {
      const elArea = rect.width * rect.height;
      if (elArea <= 0) return false;
      for (const m of largeMediaRects) {
        try {
          if (el === m.el || el.contains(m.el)) continue;
          const ix = Math.max(0, Math.min(rect.right, m.rect.right) - Math.max(rect.left, m.rect.left));
          const iy = Math.max(0, Math.min(rect.bottom, m.rect.bottom) - Math.max(rect.top, m.rect.top));
          if ((ix * iy) / elArea >= 0.5) return true;
        } catch (e) {}
      }
      return false;
    };
    const bump = (map, key) => {
      if (!key) return;
      map[key] = (map[key] || 0) + 1;
    };
    const addColor = (value, source, weight) => {
      if (!value) return;
      const v = value.trim();
      if (v === 'transparent' || v === 'rgba(0, 0, 0, 0)' || v === 'rgba(0,0,0,0)') return;
      const key = v + '|' + source;
      const entry = colorMap.get(key);
      if (entry) entry.area += weight;
      else if (colorMap.size < 600) colorMap.set(key, { value: v, source, area: weight });
    };

    for (const { el, rect } of items) {
      let cs;
      try {
        cs = getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;

      const area = Math.min(rect.width * rect.height, viewportArea);
      const tagName = el.tagName;

      // Colors, weighted by bounding-box area. Canvas/video paint their own
      // pixels and overlay elements aren't what the user sees — skip both
      // for background weighting.
      if (tagName !== 'CANVAS' && tagName !== 'VIDEO' && !overlaysMedia(el, rect)) {
        addColor(cs.backgroundColor, 'bg', area);
      }

      const hasText = (() => {
        try {
          for (const n of el.childNodes) {
            if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length > 0) return true;
          }
        } catch (e) {}
        return false;
      })();
      if (hasText) addColor(cs.color, 'text', area);

      if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) {
        addColor(cs.borderTopColor, 'border', Math.max(1, (rect.width + rect.height) * 2));
      }

      // Typography, per tag, on real text elements. Headings are owned by
      // the dedicated heading pass; split-text spans INSIDE headings carry
      // the heading's font anyway, so skip them here too.
      if (hasText) {
        const tag = tagName.toLowerCase();
        const isHeading = /^h[1-6]$/.test(tag);
        let insideHeading = false;
        if (!isHeading) {
          try {
            insideHeading = !!(el.closest && el.closest('h1,h2,h3,h4,h5,h6'));
          } catch (e) {}
        }
        if (!isHeading && !insideHeading) {
          recordTypography(tag, cs);
        }
      }

      // Geometry
      if (cs.borderRadius && cs.borderRadius !== '0px') bump(payload.radii, cs.borderRadius.slice(0, 60));
      if (cs.boxShadow && cs.boxShadow !== 'none') bump(payload.shadows, cs.boxShadow.slice(0, 200));

      // Motion (computed): only when an actual transition/animation exists
      try {
        const durs = (cs.transitionDuration || '').split(',').map((s) => s.trim());
        if (durs.some((d) => d && d !== '0s')) {
          for (const fn of splitTimingFunctions(cs.transitionTimingFunction)) bump(payload.easings, fn);
          for (const d of durs) if (d && d !== '0s') bump(payload.durations, d);
        }
        if (cs.animationName && cs.animationName !== 'none') {
          for (const n of cs.animationName.split(',')) bump(payload.animationNames, n.trim());
          for (const fn of splitTimingFunctions(cs.animationTimingFunction)) bump(payload.easings, fn);
          for (const d of (cs.animationDuration || '').split(',')) {
            const dd = d.trim();
            if (dd && dd !== '0s') bump(payload.durations, dd);
          }
        }
      } catch (e) {}
    }

    payload.colors = [...colorMap.values()].sort((a, b) => b.area - a.area).slice(0, 400);
  }

  function recordTypography(tag, cs) {
    const bump = (map, key) => {
      if (!key) return;
      map[key] = (map[key] || 0) + 1;
    };
    let t = payload.typography.tags[tag];
    if (!t && Object.keys(payload.typography.tags).length < 40) {
      t = payload.typography.tags[tag] = {
        count: 0,
        sizes: {},
        weights: {},
        families: {},
        lineHeights: {},
        letterSpacings: {}
      };
    }
    if (t) {
      t.count++;
      bump(t.sizes, cs.fontSize);
      bump(t.weights, cs.fontWeight);
      bump(t.families, firstFamily(cs.fontFamily));
      bump(t.lineHeights, cs.lineHeight);
      bump(t.letterSpacings, cs.letterSpacing);
    }
    bump(payload.typography.sizeFreq, cs.fontSize);
  }

  // Explicit h1–h6 pass: no viewport or opacity filter (entrance animations
  // leave headings at opacity:0 / translated off-screen at sample time).
  // Reads the heading element's OWN computed style, so split-text libraries
  // that shatter the text into per-char spans can't skew the numbers.
  function sampleHeadings() {
    try {
      payload.typography.rootFontSize =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    } catch (e) {}
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      let els = [];
      try {
        els = document.querySelectorAll(tag);
      } catch (e) {
        continue;
      }
      let n = 0;
      for (const el of els) {
        if (n++ >= 20) break;
        try {
          if (!el.textContent || !el.textContent.trim()) continue;
          recordTypography(tag, getComputedStyle(el));
        } catch (e) {}
      }
    }
  }

  // Video/canvas metadata only — never read pixels (tainted/empty buffers).
  // Returns the rect list of large media so the color pass can skip overlays.
  function collectMedia() {
    const vw = innerWidth;
    const vh = innerHeight;
    const vpArea = vw * vh || 1;
    const large = [];
    const coverage = (rect) => {
      const ix = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
      const iy = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
      return (ix * iy) / vpArea;
    };
    const note = (el, rect) => {
      if (rect.width * rect.height >= vpArea * 0.2) large.push({ el, rect });
    };
    try {
      let n = 0;
      for (const v of document.querySelectorAll('video')) {
        if (n++ >= 10) break;
        const rect = v.getBoundingClientRect();
        let src = '';
        try {
          src = v.currentSrc || v.getAttribute('src') || '';
          if (!src) {
            const s = v.querySelector('source[src]');
            if (s) src = s.src || s.getAttribute('src') || '';
          }
        } catch (e) {}
        const cov = coverage(rect);
        payload.media.videos.push({
          src: String(src).slice(0, 300),
          poster: String(v.poster || '').slice(0, 300),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          autoplay: !!v.autoplay,
          loop: !!v.loop,
          muted: !!v.muted,
          coveragePct: Math.round(cov * 100),
          fullscreenBackground: cov > 0.6
        });
        note(v, rect);
      }
    } catch (e) {}
    try {
      let n = 0;
      for (const c of document.querySelectorAll('canvas')) {
        if (n++ >= 10) break;
        const rect = c.getBoundingClientRect();
        const cov = coverage(rect);
        payload.media.canvases.push({
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          attrWidth: c.width || 0,
          attrHeight: c.height || 0,
          coveragePct: Math.round(cov * 100),
          fullscreen: cov > 0.6
        });
        note(c, rect);
      }
    } catch (e) {}
    return large;
  }

  function collectScriptRefs() {
    const srcs = new Set();
    try {
      document.querySelectorAll('script[src]').forEach((s) => {
        try {
          const u = new URL(s.src, location.href);
          if (u.origin === location.origin && /^https?:$/.test(u.protocol)) srcs.add(u.href);
        } catch (e) {}
      });
    } catch (e) {}
    return [...srcs].slice(0, 8);
  }

  // Split a timing-function list on top-level commas (cubic-bezier has inner commas).
  function splitTimingFunctions(str) {
    if (!str) return [];
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function firstFamily(fontFamily) {
    if (!fontFamily) return '';
    return fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  }

  function collectSpacing() {
    const values = [];
    let els = [];
    try {
      els = document.querySelectorAll(
        'section, header, main, footer, article, [class*="section"], [class*="container"]'
      );
    } catch (e) {}
    let n = 0;
    for (const el of els) {
      if (n++ >= 150) break;
      try {
        const cs = getComputedStyle(el);
        for (const prop of [
          'marginTop',
          'marginBottom',
          'paddingTop',
          'paddingRight',
          'paddingBottom',
          'paddingLeft'
        ]) {
          const v = parseFloat(cs[prop]);
          if (isFinite(v) && v > 0 && v < 1000) values.push(Math.round(v));
        }
      } catch (e) {}
    }
    return values.slice(0, 900);
  }

  function collectLayout() {
    const layout = {};
    try {
      const bodyCs = getComputedStyle(document.body);
      layout.bodyDisplay = bodyCs.display;
      layout.bodyFontFamily = bodyCs.fontFamily;
      layout.bodyBackground = bodyCs.backgroundColor;
    } catch (e) {}
    try {
      const main = document.querySelector('main, [role="main"], #main, #root, #app, #__next, #__nuxt');
      if (main) {
        const cs = getComputedStyle(main);
        layout.mainDisplay = cs.display;
        if (cs.display.indexOf('grid') !== -1) layout.gridTemplateColumns = cs.gridTemplateColumns;
      }
    } catch (e) {}
    // Max-widths of likely containers
    try {
      const widths = {};
      const candidates = document.querySelectorAll(
        'main, [class*="container"], [class*="wrapper"], [class*="content"], section > div'
      );
      let n = 0;
      for (const el of candidates) {
        if (n++ >= 120) break;
        const mw = getComputedStyle(el).maxWidth;
        if (mw && mw !== 'none') widths[mw] = (widths[mw] || 0) + 1;
      }
      layout.containerMaxWidths = widths;
    } catch (e) {}
    // Full-bleed sections (width >= 98vw)
    try {
      let fullBleed = 0;
      let sections = 0;
      const secs = document.querySelectorAll('section, header, footer, [class*="section"]');
      let n = 0;
      for (const el of secs) {
        if (n++ >= 120) break;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        sections++;
        if (r.width >= innerWidth * 0.98) fullBleed++;
      }
      layout.fullBleedSections = fullBleed;
      layout.measuredSections = sections;
    } catch (e) {}
    return layout;
  }

  function collectDetails() {
    const details = {};
    // ::selection (probe via getComputedStyle pseudo arg + stylesheet evidence)
    try {
      const sel = getComputedStyle(document.body, '::selection');
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      let inStylesheet = false;
      try {
        for (const sheet of document.styleSheets) {
          let rules = null;
          try {
            rules = sheet.cssRules;
          } catch (e) {
            continue;
          }
          if (!rules) continue;
          for (const rule of rules) {
            if (rule.selectorText && rule.selectorText.indexOf('::selection') !== -1) {
              inStylesheet = true;
              break;
            }
          }
          if (inStylesheet) break;
        }
      } catch (e) {}
      const selBg = sel ? sel.backgroundColor : '';
      const styled =
        inStylesheet ||
        (selBg && selBg !== 'rgba(0, 0, 0, 0)' && selBg !== 'transparent' && selBg !== bodyBg);
      details.selection = styled ? { background: selBg, color: sel ? sel.color : '' } : null;
    } catch (e) {
      details.selection = null;
    }
    // Custom cursor
    try {
      const cur = getComputedStyle(document.body).cursor;
      const hasCursorEl = !!document.querySelector(
        '[class*="cursor"][class*="custom"], .custom-cursor, #cursor'
      );
      details.customCursor =
        (cur && cur !== 'auto' && cur !== 'default' && cur !== 'pointer') || cur === 'none' || hasCursorEl;
      details.bodyCursor = cur;
    } catch (e) {}
    // Custom scrollbar CSS presence
    try {
      let custom = false;
      const docCs = getComputedStyle(document.documentElement);
      if (docCs.scrollbarWidth && docCs.scrollbarWidth !== 'auto') custom = true;
      if (!custom) {
        for (const sheet of document.styleSheets) {
          let rules = null;
          try {
            rules = sheet.cssRules;
          } catch (e) {
            continue;
          }
          if (!rules) continue;
          for (const rule of rules) {
            if (rule.selectorText && rule.selectorText.indexOf('-webkit-scrollbar') !== -1) {
              custom = true;
              break;
            }
          }
          if (custom) break;
        }
      }
      details.customScrollbar = custom;
    } catch (e) {}
    return details;
  }

  function collectStylesheetRefs() {
    const hrefs = new Set();
    try {
      document.querySelectorAll('link[rel~="stylesheet"]').forEach((l) => {
        if (l.href) hrefs.add(l.href);
      });
    } catch (e) {}
    try {
      for (const sheet of document.styleSheets) {
        if (sheet.href) hrefs.add(sheet.href);
      }
    } catch (e) {}
    let inlineCount = 0;
    try {
      inlineCount = document.querySelectorAll('style').length;
    } catch (e) {}
    return { hrefs: [...hrefs].slice(0, 40), inlineCount };
  }
})();

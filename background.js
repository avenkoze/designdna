// DesignDNA — service worker.
// Roles: open side panel on action click, fetch cross-origin stylesheets
// (content scripts can't read them due to CORS), parse CSS text with regex
// and return structured data to the side panel.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'DESIGNDNA_FETCH_CSS') {
    const cssJob = fetchAndParseAll(Array.isArray(msg.hrefs) ? msg.hrefs : []);
    const scriptJob = scanScriptsForLibs(Array.isArray(msg.scriptHrefs) ? msg.scriptHrefs : []);
    Promise.all([cssJob, scriptJob])
      .then(([data, bundled]) => {
        data.bundled = bundled;
        sendResponse(data);
      })
      .catch(() => sendResponse(emptyCssData()));
    return true; // keep the message channel open for the async response
  }
  return false;
});

function emptyCssData() {
  return {
    customProps: {},
    keyframes: [],
    breakpoints: [],
    mediaQueries: [],
    easings: [],
    durations: [],
    fontFaces: [],
    bundled: [],
    sheetsFetched: 0,
    sheetsFailed: 0
  };
}

// Window-global detection misses bundled libraries (Vite/webpack swallow the
// globals). Regex-scan the page's same-origin script files for signatures —
// lower confidence than a live global, labeled as "bundled" downstream.
const LIB_SIGNATURES = [
  [/\bgsap\b/, 'gsap'],
  [/\bScrollTrigger\b/, 'ScrollTrigger'],
  [/\bScrollSmoother\b/, 'ScrollSmoother'],
  [/\blenis\b/i, 'lenis'],
  [/locomotive-scroll/i, 'locomotive-scroll'],
  [/framer-motion/i, 'framer-motion'],
  [/\banime\b/, 'anime'],
  [/\bbarba\b/i, 'barba'],
  [/\bswup\b/i, 'swup']
];

async function scanScriptsForLibs(hrefs) {
  const found = new Set();
  const unique = [...new Set(hrefs)]
    .filter((h) => typeof h === 'string' && /^https?:\/\//i.test(h))
    .slice(0, 5);
  await Promise.all(
    unique.map(async (href) => {
      try {
        const text = await fetchWithTimeout(href, 5000, /javascript|ecmascript|text|octet/i);
        if (!text) return;
        const t = text.slice(0, 1024 * 1024); // 1MB cap per file
        for (const [re, name] of LIB_SIGNATURES) {
          if (re.test(t)) found.add(name);
        }
      } catch (e) {
        // silent skip
      }
    })
  );
  return [...found];
}

async function fetchAndParseAll(hrefs) {
  const data = emptyCssData();
  const unique = [...new Set(hrefs)]
    .filter((h) => typeof h === 'string' && /^https?:\/\//i.test(h))
    .slice(0, 30);

  await Promise.all(
    unique.map(async (href) => {
      const text = await fetchWithTimeout(href, 5000);
      if (text === null) {
        data.sheetsFailed++;
        return;
      }
      data.sheetsFetched++;
      try {
        parseCssText(text, data);
      } catch (e) {
        // a single malformed sheet must never kill the batch
      }
    })
  );

  // Dedupe + trim collections
  data.keyframes = dedupeBy(data.keyframes, (k) => k.name).slice(0, 40);
  data.breakpoints = [...new Set(data.breakpoints)].sort((a, b) => a - b);
  data.mediaQueries = [...new Set(data.mediaQueries)].slice(0, 30);
  data.fontFaces = [...new Set(data.fontFaces)].slice(0, 30);
  data.easings = data.easings.slice(0, 2000);
  data.durations = data.durations.slice(0, 2000);
  return data;
}

async function fetchWithTimeout(url, ms, acceptTypes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !(acceptTypes || /css|text|octet/i).test(type)) return null;
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > 1.5 * 1024 * 1024) return null;
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseCssText(text, data) {
  // --custom-property declarations
  const propRe = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)[;}]/g;
  let m;
  let propCount = 0;
  while ((m = propRe.exec(text)) && propCount < 400) {
    const name = m[1];
    const value = m[2].trim();
    if (value && !(name in data.customProps)) {
      data.customProps[name] = value.slice(0, 200);
      propCount++;
    }
  }

  // @keyframes blocks (brace-balanced scan; regex alone can't handle nesting)
  for (const block of extractNamedBlocks(text, /@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g)) {
    data.keyframes.push({ name: block.name, body: block.body.slice(0, 800) });
  }

  // @media conditions → breakpoint px values
  const mediaRe = /@media\s*([^{]+)\{/g;
  while ((m = mediaRe.exec(text))) {
    const cond = m[1].trim().slice(0, 120);
    if (cond) data.mediaQueries.push(cond);
    const pxRe = /(\d+(?:\.\d+)?)px/g;
    let px;
    while ((px = pxRe.exec(cond))) {
      const v = parseFloat(px[1]);
      if (v >= 200 && v <= 3000) data.breakpoints.push(v);
    }
  }

  // transition / animation values → easing functions + durations
  const declRe = /(?:transition|animation)(?:-timing-function|-duration)?\s*:\s*([^;{}]+)[;}]/g;
  while ((m = declRe.exec(text))) {
    const value = m[1];
    const easeRe = /cubic-bezier\([^)]*\)|steps\([^)]*\)|ease-in-out|ease-in|ease-out|ease|linear(?:\([^)]*\))?|step-start|step-end/g;
    let e;
    while ((e = easeRe.exec(value))) data.easings.push(e[0]);
    const durRe = /(\d*\.?\d+)(ms|s)(?![\w-])/g;
    let d;
    while ((d = durRe.exec(value))) {
      const msv = d[2] === 's' ? parseFloat(d[1]) * 1000 : parseFloat(d[1]);
      if (msv > 0 && msv < 60000) data.durations.push(Math.round(msv));
    }
  }

  // @font-face families
  for (const block of extractAnonymousBlocks(text, /@font-face\s*\{/g)) {
    const fam = /font-family\s*:\s*([^;}]+)/i.exec(block);
    if (fam) data.fontFaces.push(fam[1].trim().replace(/^['"]|['"]$/g, ''));
  }
}

// Finds "@rule name {" then walks braces to capture the full body.
function extractNamedBlocks(text, headRe) {
  const out = [];
  let m;
  while ((m = headRe.exec(text)) && out.length < 60) {
    const body = readBalanced(text, headRe.lastIndex);
    if (body !== null) out.push({ name: m[1], body });
  }
  return out;
}

function extractAnonymousBlocks(text, headRe) {
  const out = [];
  let m;
  while ((m = headRe.exec(text)) && out.length < 60) {
    const body = readBalanced(text, headRe.lastIndex);
    if (body !== null) out.push(body);
  }
  return out;
}

// Reads from `start` (just past an opening brace) to its matching close brace.
function readBalanced(text, start) {
  let depth = 1;
  let i = start;
  const max = Math.min(text.length, start + 20000);
  while (i < max && depth > 0) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return text.slice(start, i - 1).trim();
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

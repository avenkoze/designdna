// DesignDNA — side panel UI logic.
// Orchestrates: inject sampler (isolated) + lib detector (MAIN world),
// send stylesheet hrefs to background for CORS-free fetching, run the
// analyzer, render results, handle exports.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    analyzeBtn: $('analyzeBtn'),
    status: $('status'),
    statusText: $('statusText'),
    statusSpinner: $('statusSpinner'),
    results: $('results'),
    exportBar: $('exportBar'),
    siteMeta: $('siteMeta'),
    siteFavicon: $('siteFavicon'),
    siteHost: $('siteHost'),
    siteDate: $('siteDate'),
    toast: $('toast')
  };

  let currentAnalysis = null;

  // ---------------------------------------------------------------- helpers

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function setStatus(text, { loading = false, error = false } = {}) {
    if (!text) {
      els.status.hidden = true;
      return;
    }
    els.status.hidden = false;
    els.status.classList.toggle('error', error);
    els.statusSpinner.hidden = !loading;
    els.statusText.textContent = text;
  }

  let toastTimer = null;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 1400);
  }

  async function copyToClipboard(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(label + ' copied');
    } catch (e) {
      // Fallback for stubborn focus situations
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast(label + ' copied');
      } catch (e2) {
        toast('Copy failed');
      }
    }
  }

  function isRestrictedUrl(url) {
    if (!url) return true;
    return (
      /^(chrome|edge|about|view-source|devtools|chrome-extension|moz-extension|file):/i.test(url) ||
      /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com)/i.test(
        url
      )
    );
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  // ---------------------------------------------------------------- analyze

  async function analyze() {
    const tab = await getActiveTab().catch(() => null);
    if (!tab) {
      setStatus('No active tab found.', { error: true });
      return;
    }
    if (isRestrictedUrl(tab.url)) {
      els.results.hidden = true;
      els.exportBar.hidden = true;
      setStatus('Cannot analyze this page. Browser-internal and Web Store pages are off limits — open a regular website and try again.', { error: true });
      return;
    }

    els.analyzeBtn.disabled = true;
    els.analyzeBtn.querySelector('.btn-label').textContent = 'Analyzing…';
    els.results.hidden = true;
    els.exportBar.hidden = true;
    setStatus('Scrolling page & sampling computed styles…', { loading: true });

    try {
      const target = { tabId: tab.id };

      // 1. Sampler (isolated world). It registers its postMessage listener
      //    synchronously, then auto-scrolls (~2s) before sampling — so the
      //    MAIN-world detector injected right after has plenty of time.
      const samplerPromise = chrome.scripting.executeScript({
        target,
        files: ['content/sampler.js']
      });

      // 2. Motion-lib detector (MAIN world), tiny delay so the sampler's
      //    listener is definitely registered first.
      await new Promise((r) => setTimeout(r, 80));
      const mainWorldPromise = chrome.scripting
        .executeScript({ target, files: ['injected/main-world.js'], world: 'MAIN' })
        .catch(() => null);

      const [samplerRes, mainRes] = await Promise.all([samplerPromise, mainWorldPromise]);
      const payload = samplerRes && samplerRes[0] ? samplerRes[0].result : null;
      if (!payload || !payload.ok) {
        throw new Error('Extraction returned no data. The page may block script injection.');
      }
      // Fallback path: direct return value from the MAIN-world script.
      if (!payload.motionLibs && mainRes && mainRes[0] && mainRes[0].result) {
        payload.motionLibs = mainRes[0].result;
      }

      // 3. Cross-origin stylesheets via the service worker.
      setStatus('Fetching & parsing stylesheets…', { loading: true });
      let cssData = null;
      try {
        cssData = await chrome.runtime.sendMessage({
          type: 'DESIGNDNA_FETCH_CSS',
          hrefs: (payload.stylesheets && payload.stylesheets.hrefs) || [],
          scriptHrefs: payload.scripts || []
        });
      } catch (e) {
        cssData = null;
      }

      // 4. Analyze + render.
      const analysis = window.DDNA.analyze(payload, cssData);
      currentAnalysis = analysis;
      renderMeta(analysis, tab);
      renderAll(analysis);
      setStatus('');
      els.results.hidden = false;
      els.exportBar.hidden = false;

      // 5. Cache so reopening the panel on this tab restores results.
      try {
        await chrome.storage.session.set({ ['analysis_' + tab.id]: { analysis, favIconUrl: tab.favIconUrl || '' } });
      } catch (e) {}
    } catch (err) {
      setStatus(
        'Analysis failed: ' + (err && err.message ? err.message : 'unknown error'),
        { error: true }
      );
    } finally {
      els.analyzeBtn.disabled = false;
      els.analyzeBtn.querySelector('.btn-label').textContent = 'Re-analyze';
    }
  }

  // ---------------------------------------------------------------- render

  function renderMeta(a, tab) {
    els.siteMeta.hidden = false;
    const fav = (tab && tab.favIconUrl) || '';
    if (fav && /^(https?|data):/i.test(fav)) {
      els.siteFavicon.src = fav;
      els.siteFavicon.style.display = '';
    } else {
      els.siteFavicon.style.display = 'none';
    }
    els.siteHost.textContent = a.meta.hostname;
    els.siteDate.textContent =
      'Captured ' +
      new Date(a.meta.capturedAt).toLocaleString() +
      ' · ' +
      a.meta.sampledElements +
      ' elements';
  }

  function empty(msg) {
    return '<div class="empty">' + esc(msg || 'Not detected') + '</div>';
  }

  function renderAll(a) {
    renderColors(a);
    renderTypography(a);
    renderSpacing(a);
    renderMotion(a);
    renderLayout(a);
    renderDetails(a);
    renderTokens(a);
  }

  function renderColors(a) {
    const body = $('colorsBody');
    const p = a.colors.palette;
    if (!p.length) {
      body.innerHTML = empty();
      return;
    }
    let html = '';
    if (a.colors.isDark !== null) {
      html +=
        '<div class="theme-line"><strong>' +
        (a.colors.isDark ? 'Dark' : 'Light') +
        ' theme</strong>' +
        (a.colors.contrast ? ' · fg/bg contrast <strong>' + esc(a.colors.contrast) + ':1</strong>' : '') +
        '</div>';
    }
    html += '<div class="swatch-grid">';
    for (const c of p) {
      const note = c.token ? c.token : c.rendered ? 'rendered tone' : '';
      html +=
        '<button class="swatch" data-hex="' + esc(c.hex) + '" title="Click to copy ' + esc(c.hex) +
        (note ? ' · ' + esc(note) : '') + '">' +
        '<div class="swatch-chip" style="background:' + esc(c.hex) + '"></div>' +
        '<div class="swatch-hex">' + esc(c.hex) + '</div>' +
        '<div class="swatch-role">' + esc(c.role || '') + '</div>' +
        '<div class="swatch-pct">' + esc(c.pct) + '%' +
        (note ? ' · ' + esc(note.length > 14 ? note.slice(0, 14) + '…' : note) : '') +
        '</div></button>';
    }
    html += '</div>';
    body.innerHTML = html;
    body.querySelectorAll('.swatch').forEach((b) =>
      b.addEventListener('click', () => copyToClipboard(b.dataset.hex, b.dataset.hex))
    );
  }

  function renderTypography(a) {
    const body = $('typographyBody');
    const t = a.typography;
    if (!t.families.length && !t.scale.length) {
      body.innerHTML = empty();
      return;
    }
    let html = '';
    for (const f of t.families) {
      html +=
        '<div class="font-card">' +
        '<div class="font-name">' + esc(f.family) + '</div>' +
        '<div class="font-meta">' +
        esc(f.roles.join(' · ')) +
        (f.weights.length ? ' — ' + esc(f.weights.join(', ')) : '') +
        '</div></div>';
    }
    if (t.scale.length) {
      html += '<div class="sub-label" style="margin-top:14px">Type scale</div><div class="scale-viz">';
      const max = t.scale[t.scale.length - 1];
      for (const s of [...t.scale].reverse()) {
        const w = Math.max(6, Math.round((s / max) * 100));
        html +=
          '<div class="scale-row"><div class="scale-bar" style="width:' + w + '%"></div>' +
          '<div class="scale-label">' + esc(s) + 'px</div></div>';
      }
      html += '</div>';
      if (t.ratio) {
        html +=
          '<div class="ratio-line">Ratio ≈ <strong>' + esc(t.ratio) + '</strong>' +
          (t.ratioName ? ' — ' + esc(t.ratioName) : '') +
          '</div>';
      }
    }
    const tagKeys = Object.keys(t.tags);
    if (tagKeys.length) {
      html += '<table class="mini-table"><tr><th>El</th><th>Size</th><th>Weight</th><th>Leading</th></tr>';
      for (const tag of tagKeys) {
        const x = t.tags[tag];
        html +=
          '<tr><td>' + esc(tag) + '</td><td>' + esc(x.size || '—') + '</td><td>' +
          esc(x.weight || '—') + '</td><td>' + esc(x.lineHeight || '—') + '</td></tr>';
      }
      html += '</table>';
    }
    body.innerHTML = html;
  }

  function renderSpacing(a) {
    const body = $('spacingBody');
    const s = a.spacing;
    if (!s.values.length) {
      body.innerHTML = empty();
      return;
    }
    let html = '<div class="chip-row">';
    for (const v of s.values) {
      html += '<span class="chip">' + esc(v.value) + 'px<span class="n">×' + esc(v.count) + '</span></span>';
    }
    html += '</div>';
    html +=
      '<div class="note">' +
      (s.base
        ? 'Spacing follows a <span class="mono" style="color:var(--accent)">' + s.base + 'px</span> base grid.'
        : 'No consistent base grid detected.') +
      '</div>';
    body.innerHTML = html;
  }

  function renderMotion(a) {
    const body = $('motionBody');
    const m = a.motion;
    if (!m.hasMotion) {
      body.innerHTML = empty('Largely static — no significant motion detected');
      return;
    }
    let html = '';
    if (m.libs.length) {
      html += '<div class="sub-label">Libraries</div><div class="chip-row">';
      for (const lib of m.libs) {
        const d = m.libDetail[lib];
        let label = lib;
        if (d && d.version) label += ' ' + d.version;
        if (d && d.plugins && d.plugins.length) label += ' +' + d.plugins.join('/');
        html += '<span class="chip accent">' + esc(label) + '</span>';
      }
      html += '</div>';
    }
    if (m.bundled && m.bundled.length) {
      html += '<div class="sub-label">Bundled (signature scan)</div><div class="chip-row">';
      for (const b of m.bundled) html += '<span class="chip">bundled: ' + esc(b) + '</span>';
      html += '</div>';
    }
    if (m.easings.length) {
      html += '<div class="sub-label">Easings</div>';
      for (const e of m.easings) {
        html +=
          '<div class="kv"><span class="k">' +
          (e.name ? esc(e.name) : '&nbsp;') +
          ' <span style="opacity:.55">×' + esc(e.count) + '</span></span>' +
          '<span class="v">' + esc(e.value) + '</span></div>';
      }
    }
    if (m.durations) {
      const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 's' : Math.round(n) + 'ms');
      html +=
        '<div class="sub-label">Durations</div><div class="kv"><span class="k">range / median</span>' +
        '<span class="v">' + esc(ms(m.durations.min)) + ' – ' + esc(ms(m.durations.max)) +
        ' / ' + esc(ms(m.durations.median)) + '</span></div>';
    }
    if (m.keyframes.length) {
      html += '<div class="sub-label">Keyframes</div><div class="chip-row">';
      for (const k of m.keyframes) html += '<span class="chip">' + esc(k) + '</span>';
      html += '</div>';
    }
    body.innerHTML = html || empty();
  }

  function renderLayout(a) {
    const body = $('layoutBody');
    const l = a.layout;
    let html = '';
    if (l.containerMaxWidths && l.containerMaxWidths.length) {
      html += '<div class="sub-label">Container max-widths</div><div class="chip-row">';
      for (const w of l.containerMaxWidths) {
        html += '<span class="chip">' + esc(w.value) + '<span class="n">×' + esc(w.count) + '</span></span>';
      }
      html += '</div>';
    }
    if (l.mainDisplay) {
      html += '<div class="kv"><span class="k">main display</span><span class="v">' + esc(l.mainDisplay) + '</span></div>';
    }
    if (l.gridTemplateColumns) {
      html += '<div class="kv"><span class="k">grid columns</span><span class="v">' + esc(l.gridTemplateColumns) + '</span></div>';
    }
    if (typeof l.fullBleedSections === 'number' && l.measuredSections) {
      html +=
        '<div class="kv"><span class="k">full-bleed sections</span><span class="v">' +
        esc(l.fullBleedSections + ' / ' + l.measuredSections) + '</span></div>';
    }
    if (l.breakpoints && l.breakpoints.length) {
      html += '<div class="sub-label">Breakpoints</div><div class="chip-row">';
      for (const b of l.breakpoints) html += '<span class="chip">' + esc(b) + 'px</span>';
      html += '</div>';
    }
    // Hero media
    if (a.media && a.media.hasMedia) {
      html += '<div class="sub-label">Hero media</div>';
      for (const v of a.media.videos) {
        const flags = [v.autoplay && 'autoplay', v.loop && 'loop', v.muted && 'muted'].filter(Boolean).join('/');
        html +=
          '<div class="kv"><span class="k">' + esc(v.label) + '</span><span class="v">' +
          esc(v.width + '×' + v.height + ' · ' + v.coveragePct + '% vp' + (flags ? ' · ' + flags : '')) +
          '</span></div>';
      }
      for (const c of a.media.canvases) {
        html +=
          '<div class="kv"><span class="k">' + esc(c.label) + '</span><span class="v">' +
          esc(
            c.width + '×' + c.height + ' · ' + c.coveragePct + '% vp' +
            (c.context ? ' · ' + c.context : '') +
            (c.library ? ' · ' + c.library : '')
          ) +
          '</span></div>';
      }
    }
    // Geometry lives here visually too
    html += '<div class="sub-label">Geometry</div>';
    html += '<div class="kv"><span class="k">corner style</span><span class="v">' + esc(a.geometry.radiusStyle) + '</span></div>';
    if (a.geometry.radii.length) {
      html += '<div class="chip-row">';
      for (const r of a.geometry.radii) {
        html += '<span class="chip">' + esc(r.value) + '<span class="n">×' + esc(r.count) + '</span></span>';
      }
      html += '</div>';
    }
    html += '<div class="kv"><span class="k">shadow style</span><span class="v">' + esc(a.geometry.shadowStyle) + '</span></div>';
    body.innerHTML = html || empty();
  }

  function renderDetails(a) {
    const body = $('detailsBody');
    const d = a.details;
    let html = '';
    html +=
      '<div class="kv"><span class="k">custom ::selection</span><span class="v">' +
      (d.selection ? esc(d.selection.background) : 'no') + '</span></div>';
    html +=
      '<div class="kv"><span class="k">custom cursor</span><span class="v">' +
      (d.customCursor ? 'yes' + (d.bodyCursor && d.bodyCursor !== 'auto' ? ' (' + esc(d.bodyCursor) + ')' : '') : 'no') +
      '</span></div>';
    html +=
      '<div class="kv"><span class="k">custom scrollbar</span><span class="v">' +
      (d.customScrollbar ? 'yes' : 'no') + '</span></div>';
    html +=
      '<div class="kv"><span class="k">stylesheets</span><span class="v">' +
      esc(a.meta.stylesheets.linked + ' linked · ' + a.meta.stylesheets.inline + ' inline · ' + a.meta.stylesheets.fetched + ' fetched') +
      '</span></div>';
    body.innerHTML = html;
  }

  function renderTokens(a) {
    const body = $('tokensBody');
    const cp = a.customProps;
    if (!cp.count) {
      body.innerHTML = empty('No CSS custom properties — likely utility-class or CSS-in-JS styling');
      return;
    }
    let html = '<div class="note" style="margin:0 0 6px">' + esc(cp.count) + ' custom properties found.</div>';
    for (const group in cp.groups) {
      const items = cp.groups[group];
      if (!items.length) continue;
      html += '<div class="sub-label">' + esc(group) + ' (' + items.length + ')</div>';
      for (const p of items.slice(0, 12)) {
        html +=
          '<div class="kv"><span class="k mono" style="font-size:10.5px">' + esc(p.name) + '</span>' +
          '<span class="v">' + esc(p.value.length > 48 ? p.value.slice(0, 48) + '…' : p.value) + '</span></div>';
      }
      if (items.length > 12) {
        html += '<div class="note">+' + (items.length - 12) + ' more in JSON export</div>';
      }
    }
    body.innerHTML = html;
  }

  // ---------------------------------------------------------------- exports

  function bindExports() {
    $('exportMd').addEventListener('click', () => {
      if (!currentAnalysis) return;
      copyToClipboard(window.DDNAExport.markdown(currentAnalysis), 'Markdown brief');
    });
    $('exportJson').addEventListener('click', () => {
      if (!currentAnalysis) return;
      copyToClipboard(window.DDNAExport.json(currentAnalysis), 'JSON');
    });
    $('exportPrompt').addEventListener('click', () => {
      if (!currentAnalysis) return;
      copyToClipboard(window.DDNAExport.prompt(currentAnalysis), 'AI prompt');
    });
  }

  // ---------------------------------------------------------------- init

  async function restoreCached() {
    try {
      const tab = await getActiveTab();
      if (!tab) return;
      if (isRestrictedUrl(tab.url)) {
        setStatus('Cannot analyze this page. Open a regular website and hit Analyze.', { error: true });
        return;
      }
      const key = 'analysis_' + tab.id;
      const stored = await chrome.storage.session.get(key);
      const entry = stored[key];
      if (entry && entry.analysis && entry.analysis.meta && entry.analysis.meta.url === tab.url) {
        currentAnalysis = entry.analysis;
        renderMeta(entry.analysis, { favIconUrl: entry.favIconUrl });
        renderAll(entry.analysis);
        els.results.hidden = false;
        els.exportBar.hidden = false;
        els.analyzeBtn.querySelector('.btn-label').textContent = 'Re-analyze';
      }
    } catch (e) {}
  }

  els.analyzeBtn.addEventListener('click', analyze);
  bindExports();
  restoreCached();
})();

// DesignDNA — injected into the page's MAIN world via chrome.scripting.executeScript.
// Detects motion/animation libraries living on `window`, which isolated-world
// content scripts cannot see. Relays the detection map to the content script
// via postMessage; the IIFE completion value is also returned to the caller
// of executeScript as a fallback path.

(() => {
  const detection = { libs: [], detail: {} };
  const add = (name, info) => {
    detection.libs.push(name);
    if (info) detection.detail[name] = info;
  };

  try {
    const w = window;

    // GSAP (+ plugins)
    try {
      if (w.gsap && w.gsap.version) {
        const plugins = [];
        try {
          const globals =
            w.gsap.core && typeof w.gsap.core.globals === 'function'
              ? w.gsap.core.globals()
              : {};
          if (w.ScrollTrigger || globals.ScrollTrigger) plugins.push('ScrollTrigger');
          if (w.ScrollSmoother || globals.ScrollSmoother) plugins.push('ScrollSmoother');
          if (w.SplitText || globals.SplitText) plugins.push('SplitText');
          if (w.Draggable || globals.Draggable) plugins.push('Draggable');
        } catch (e) {}
        add('GSAP', { version: String(w.gsap.version), plugins });
      }
    } catch (e) {}

    // Lenis smooth scroll
    try {
      if (w.Lenis || w.lenis || document.documentElement.classList.contains('lenis')) {
        add('Lenis', { version: (w.Lenis && w.Lenis.version) || null });
      }
    } catch (e) {}

    // Locomotive Scroll
    try {
      if (
        w.LocomotiveScroll ||
        document.querySelector('[data-scroll-container]') ||
        document.documentElement.classList.contains('has-scroll-smooth')
      ) {
        add('Locomotive Scroll');
      }
    } catch (e) {}

    // Framer Motion (no global — look for its DOM markers)
    try {
      if (
        document.querySelector('[data-framer-name], [data-framer-appear-id], [data-projection-id]') ||
        w.__framer_importFromPackage
      ) {
        add('Framer Motion');
      }
    } catch (e) {}

    // Anime.js
    try {
      if (w.anime) add('Anime.js', { version: (w.anime && w.anime.version) || null });
    } catch (e) {}

    // Three.js → WebGL
    try {
      if (w.THREE) {
        add('Three.js (WebGL)', { version: w.THREE.REVISION ? 'r' + w.THREE.REVISION : null });
      }
    } catch (e) {}

    // Page transition libs
    try {
      if (w.barba) add('Barba.js');
    } catch (e) {}
    try {
      if (w.swup) add('Swup');
    } catch (e) {}

    // Raw WebGL canvas (covers custom engines, OGL, curtains.js, shaders...)
    // Also records the context type per canvas (document order, matching the
    // sampler's canvas list). getContext returns the EXISTING context when
    // the type matches and null when the canvas already holds a different
    // one — so a null on both WebGL probes means a 2d/bitmap context.
    try {
      const canvases = document.querySelectorAll('canvas');
      detection.detail.canvasCount = canvases.length;
      const contexts = [];
      let webgl = false;
      let i = 0;
      for (const c of canvases) {
        if (i++ >= 10) break;
        let type = null;
        try {
          if (c.getContext('webgl2')) type = 'webgl2';
          else if (c.getContext('webgl')) type = 'webgl';
          else type = '2d';
        } catch (e) {}
        contexts.push(type);
        if (type === 'webgl' || type === 'webgl2') webgl = true;
      }
      detection.detail.canvasContexts = contexts;
      if (webgl && !detection.libs.some((l) => l.indexOf('WebGL') !== -1)) {
        add('WebGL canvas');
      }
    } catch (e) {}
  } catch (e) {}

  try {
    window.postMessage({ __DESIGN_DNA_LIBS__: detection }, '*');
  } catch (e) {}

  return detection;
})();

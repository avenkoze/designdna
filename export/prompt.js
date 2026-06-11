// DesignDNA — AI-ready prompt block generator.
// Global: window.DDNAExport.prompt(analysis) → string

(function () {
  'use strict';
  window.DDNAExport = window.DDNAExport || {};

  function ms(n) {
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 's' : Math.round(n) + 'ms';
  }

  // One-line hero description, e.g. "Hero: fullscreen WebGL motion background"
  function heroLine(a) {
    if (!a.media || !a.media.hasMedia) return undefined;
    const glCanvas = a.media.canvases.find((c) => c.fullscreen && (c.context === 'webgl' || c.context === 'webgl2'));
    if (glCanvas) return 'Hero: fullscreen WebGL motion background' + (glCanvas.library && glCanvas.library !== 'WebGL' ? ' (' + glCanvas.library + ')' : '');
    const canvas2d = a.media.canvases.find((c) => c.fullscreen);
    if (canvas2d) return 'Hero: fullscreen canvas animation background';
    const video = a.media.videos.find((v) => v.fullscreenBackground);
    if (video) return 'Hero: fullscreen video background';
    return undefined;
  }

  window.DDNAExport.prompt = function (a) {
    // Compact structured data — only the signal, no raw dumps.
    const data = {
      theme: a.colors.isDark === null ? undefined : a.colors.isDark ? 'dark' : 'light',
      colors: {
        background: a.colors.background || undefined,
        foreground: a.colors.foreground || undefined,
        accent: a.colors.accent || undefined,
        palette: a.colors.palette.slice(0, 8).map((c) => ({
          hex: c.hex,
          role: c.role || undefined,
          share: c.pct + '%',
          token: c.token || undefined,
          note: c.rendered ? 'rendered tone (not a design token)' : undefined
        }))
      },
      typography: {
        families: a.typography.families.map((f) => ({
          family: f.family,
          roles: f.roles,
          weights: f.weights.length ? f.weights : undefined
        })),
        scalePx: a.typography.scale,
        scaleRatio: a.typography.ratioName || a.typography.ratio || undefined,
        elements: a.typography.tags
      },
      spacing: {
        baseUnit: a.spacing.base ? a.spacing.base + 'px' : undefined,
        commonValuesPx: a.spacing.values.map((v) => v.value)
      },
      motion: {
        libraries: a.motion.libs.length ? a.motion.libs : undefined,
        bundledLibraries:
          a.motion.bundled && a.motion.bundled.length
            ? a.motion.bundled.map((b) => 'bundled: ' + b)
            : undefined,
        easings: a.motion.easings.slice(0, 5).map((e) => e.name || e.value),
        durationRange: a.motion.durations
          ? ms(a.motion.durations.min) + '–' + ms(a.motion.durations.max)
          : undefined,
        keyframeAnimations: a.motion.keyframes.length ? a.motion.keyframes : undefined,
        feel: a.motion.hasMotion ? undefined : 'largely static'
      },
      geometry: {
        cornerStyle: a.geometry.radiusStyle,
        radii: a.geometry.radii.slice(0, 4).map((r) => r.value),
        shadowStyle: a.geometry.shadowStyle
      },
      layout: {
        containerMaxWidths: (a.layout.containerMaxWidths || []).map((w) => w.value),
        breakpointsPx: a.layout.breakpoints || [],
        fullBleed:
          typeof a.layout.fullBleedSections === 'number' && a.layout.measuredSections
            ? a.layout.fullBleedSections + '/' + a.layout.measuredSections + ' sections'
            : undefined,
        hero: heroLine(a),
        heroMedia:
          a.media && a.media.hasMedia
            ? [
                ...a.media.videos.map((v) => ({
                  type: 'video',
                  label: v.label,
                  viewportCoverage: v.coveragePct + '%',
                  flags: [v.autoplay && 'autoplay', v.loop && 'loop', v.muted && 'muted'].filter(Boolean)
                })),
                ...a.media.canvases.map((c) => ({
                  type: 'canvas',
                  label: c.label,
                  context: c.context || undefined,
                  library: c.library || undefined,
                  viewportCoverage: c.coveragePct + '%'
                }))
              ]
            : undefined
      },
      details: {
        customSelection: a.details.selection ? a.details.selection.background : undefined,
        customCursor: a.details.customCursor || undefined,
        customScrollbar: a.details.customScrollbar || undefined
      }
    };

    const structured = JSON.stringify(data, null, 2);

    return (
      'Build a website using this design language:\n\n' +
      '```json\n' +
      structured +
      '\n```\n\n' +
      'Recreate the visual system (colors, type scale, spacing, motion feel) — ' +
      'do NOT copy the content or exact layout.'
    );
  };
})();

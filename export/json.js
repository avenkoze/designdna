// DesignDNA — raw token JSON exporter.
// Global: window.DDNAExport.json(analysis) → string

(function () {
  'use strict';
  window.DDNAExport = window.DDNAExport || {};

  window.DDNAExport.json = function (a) {
    const tokens = {
      $schema: 'designdna/v1',
      meta: a.meta,
      colors: {
        theme: a.colors.isDark === null ? null : a.colors.isDark ? 'dark' : 'light',
        background: a.colors.background,
        foreground: a.colors.foreground,
        accent: a.colors.accent,
        contrast: a.colors.contrast,
        palette: a.colors.palette
      },
      typography: a.typography,
      spacing: a.spacing,
      motion: {
        libraries: a.motion.libs,
        bundledLibraries: a.motion.bundled || [],
        libraryDetail: a.motion.libDetail,
        easings: a.motion.easings,
        durations: a.motion.durations,
        keyframes: a.motion.keyframes
      },
      media: a.media || { videos: [], canvases: [], hasMedia: false },
      geometry: a.geometry,
      layout: a.layout,
      details: a.details,
      customProperties: a.customProps,
      mediaQueries: a.mediaQueries
    };
    return JSON.stringify(tokens, null, 2);
  };
})();

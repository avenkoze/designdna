// DesignDNA — Markdown style brief generator.
// Global: window.DDNAExport.markdown(analysis) → string

(function () {
  'use strict';
  window.DDNAExport = window.DDNAExport || {};

  function ms(n) {
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 's' : Math.round(n) + 'ms';
  }

  window.DDNAExport.markdown = function (a) {
    const L = [];
    const push = (...lines) => L.push(...lines);

    push(
      `# Style Brief — ${a.meta.hostname}`,
      '',
      `> Design DNA extracted by DesignDNA on ${new Date(a.meta.capturedAt).toLocaleString()}`,
      `> Source: ${a.meta.url}`,
      ''
    );

    // ---- Colors ----
    push('## Color System', '');
    if (a.colors.palette.length) {
      if (a.colors.isDark !== null) {
        push(`**Theme:** ${a.colors.isDark ? 'dark' : 'light'}` + (a.colors.contrast ? ` · fg/bg contrast ${a.colors.contrast}:1` : ''), '');
      }
      push('| Hex | Role | Share | Used as | Token |', '|---|---|---|---|---|');
      for (const c of a.colors.palette) {
        const token = c.token ? '`' + c.token + '`' : c.rendered ? '_rendered tone_' : '—';
        push(`| \`${c.hex}\` | ${c.role || '—'} | ${c.pct}% | ${c.sources.join(', ')} | ${token} |`);
      }
    } else {
      push('_Not detected._');
    }
    push('');

    // ---- Typography ----
    push('## Typography', '');
    if (a.typography.families.length) {
      push('**Font families:**', '');
      for (const f of a.typography.families) {
        const w = f.weights.length ? ` — weights: ${f.weights.join(', ')}` : '';
        push(`- **${f.family}** (${f.roles.join(', ')})${w}`);
      }
      push('');
    }
    if (a.typography.scale.length) {
      push(`**Type scale (px):** ${a.typography.scale.join(' · ')}`);
      if (a.typography.ratio) {
        push(`**Scale ratio:** ~${a.typography.ratio}${a.typography.ratioName ? ` — ${a.typography.ratioName}` : ''}`);
      }
      push('');
    }
    const tagKeys = Object.keys(a.typography.tags);
    if (tagKeys.length) {
      push('| Element | Size | Weight | Line height | Letter spacing |', '|---|---|---|---|---|');
      for (const tag of tagKeys) {
        const t = a.typography.tags[tag];
        push(`| ${tag} | ${t.size || '—'} | ${t.weight || '—'} | ${t.lineHeight || '—'} | ${t.letterSpacing || '—'} |`);
      }
      push('');
    }
    if (!a.typography.families.length && !a.typography.scale.length) push('_Not detected._', '');

    // ---- Spacing ----
    push('## Spacing', '');
    if (a.spacing.values.length) {
      push(`**Common values (px):** ${a.spacing.values.map((v) => v.value).join(' · ')}`);
      push(`**Base unit:** ${a.spacing.base ? a.spacing.base + 'px grid' : 'no consistent grid detected'}`, '');
    } else {
      push('_Not detected._', '');
    }

    // ---- Motion ----
    push('## Motion', '');
    if (a.motion.hasMotion) {
      if (a.motion.libs.length) {
        const libs = a.motion.libs.map((l) => {
          const d = a.motion.libDetail[l];
          if (d && d.version) return `${l} ${d.version}${d.plugins && d.plugins.length ? ' (+' + d.plugins.join(', ') + ')' : ''}`;
          return l;
        });
        push(`**Libraries:** ${libs.join(' · ')}`, '');
      }
      if (a.motion.bundled && a.motion.bundled.length) {
        push(`**Bundled (signature scan, lower confidence):** ${a.motion.bundled.map((b) => 'bundled: ' + b).join(' · ')}`, '');
      }
      if (a.motion.easings.length) {
        push('**Easing functions (by frequency):**', '');
        for (const e of a.motion.easings) {
          push(`- \`${e.value}\`${e.name ? ` (${e.name})` : ''} ×${e.count}`);
        }
        push('');
      }
      if (a.motion.durations) {
        push(`**Durations:** ${ms(a.motion.durations.min)} – ${ms(a.motion.durations.max)} (median ${ms(a.motion.durations.median)})`, '');
      }
      if (a.motion.keyframes.length) {
        push(`**Keyframe animations:** ${a.motion.keyframes.map((k) => '`' + k + '`').join(', ')}`, '');
      }
    } else {
      push('_Largely static — no significant motion detected._', '');
    }

    // ---- Geometry ----
    push('## Geometry', '');
    push(`**Corner style:** ${a.geometry.radiusStyle}`);
    if (a.geometry.radii.length) {
      push(`**Radii:** ${a.geometry.radii.map((r) => '`' + r.value + '`').join(' · ')}`);
    }
    push(`**Shadow style:** ${a.geometry.shadowStyle}`);
    if (a.geometry.shadows.length) {
      push('', '**Top shadows:**', '');
      for (const s of a.geometry.shadows) push('- `' + s.value + '`');
    }
    push('');

    // ---- Layout ----
    push('## Layout', '');
    const lay = a.layout;
    if (lay.containerMaxWidths && lay.containerMaxWidths.length) {
      push(`**Container max-widths:** ${lay.containerMaxWidths.map((w) => '`' + w.value + '`').join(' · ')}`);
    }
    if (lay.mainDisplay) push(`**Main display:** \`${lay.mainDisplay}\`${lay.gridTemplateColumns ? ` — grid columns: \`${lay.gridTemplateColumns}\`` : ''}`);
    if (typeof lay.fullBleedSections === 'number' && lay.measuredSections) {
      push(`**Full-bleed sections:** ${lay.fullBleedSections}/${lay.measuredSections}`);
    }
    if (lay.breakpoints && lay.breakpoints.length) {
      push(`**Breakpoints (px):** ${lay.breakpoints.join(' · ')}`);
    }
    if (a.media && a.media.hasMedia) {
      push('', '**Hero media:**', '');
      for (const v of a.media.videos) {
        const flags = [v.autoplay && 'autoplay', v.loop && 'loop', v.muted && 'muted'].filter(Boolean).join('/');
        push(
          `- Video — ${v.label} (${v.width}×${v.height}, ${v.coveragePct}% of viewport${flags ? ', ' + flags : ''})` +
            (v.src ? ` — \`${v.src}\`` : '')
        );
      }
      for (const c of a.media.canvases) {
        push(
          `- Canvas — ${c.label} (${c.width}×${c.height}, ${c.coveragePct}% of viewport` +
            (c.context ? `, ${c.context}` : '') +
            (c.library ? `, ${c.library}` : '') +
            ')'
        );
      }
    }
    push('');

    // ---- Details ----
    push('## Details', '');
    const d = a.details;
    push(`- Custom \`::selection\`: ${d.selection ? `yes (bg ${d.selection.background})` : 'no'}`);
    push(`- Custom cursor: ${d.customCursor ? 'yes' + (d.bodyCursor && d.bodyCursor !== 'auto' ? ` (\`${d.bodyCursor}\`)` : '') : 'no'}`);
    push(`- Custom scrollbar: ${d.customScrollbar ? 'yes' : 'no'}`);
    push('');

    // ---- Design tokens ----
    if (a.customProps.count) {
      push('## Design Tokens (CSS Custom Properties)', '', `${a.customProps.count} custom properties found.`, '');
      for (const group in a.customProps.groups) {
        const items = a.customProps.groups[group];
        if (!items.length) continue;
        push(`### ${group}`, '', '```css');
        for (const p of items.slice(0, 20)) push(`${p.name}: ${p.value};`);
        push('```', '');
      }
    }

    return L.join('\n');
  };
})();

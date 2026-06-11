# DesignDNA

> **⚠️ Beta** — v0.1.0-beta. Works, but expect rough edges. Issues and feedback welcome.

Chrome extension (Manifest V3, vanilla JS, zero dependencies) that extracts the
complete "design DNA" of any website — colors, typography, spacing, motion,
layout — and exports it as an AI-ready style brief.

## Install (Load unpacked)

1. Clone or download this repo: `git clone https://github.com/avenkoze/designdna.git`
2. Open `chrome://extensions` and enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the cloned `designdna` folder (the one containing `manifest.json`)
5. Open any website, click the DesignDNA toolbar icon → side panel opens → **Analyze this page**

## How it works

| File | Role |
|---|---|
| `background.js` | Service worker — fetches cross-origin stylesheets (CORS bypass) and regex-parses custom props, `@keyframes`, `@media`, easings, `@font-face`; scans same-origin scripts for bundled motion-lib signatures |
| `injected/main-world.js` | Runs in the page's MAIN world — detects GSAP, Lenis, Locomotive, Framer Motion, Anime.js, Three.js, Barba, Swup, raw WebGL + per-canvas context types |
| `content/sampler.js` | Isolated-world dumb collector — auto-scrolls, then samples computed styles of up to 1500 visible elements (shadow DOM included), returns one JSON payload |
| `sidepanel/analyzer.js` | All heavy lifting — LAB color clustering with design-token cross-check, type-scale ratio detection, spacing base-unit detection, easing ranking, radius/shadow classification, hero media labeling |
| `export/*.js` | Markdown brief, raw token JSON, AI prompt block |

## Exports

- **Copy Markdown Brief** — structured `style-brief.md`
- **Copy JSON** — raw design tokens
- **Copy AI Prompt** — "Build a website using this design language…" block,
  ready to paste into any LLM

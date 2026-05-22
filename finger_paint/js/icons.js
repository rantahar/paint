/* ────────────────────────────────────────────────────────────
   icons.js — SVG icon strings.
   Each entry is the inner markup of a 24×24 viewBox SVG.
   Add to FP.icons; use FP.icon(name, sizePx) to get a full <svg>.
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

FP.icons = {
  marker:      `<path d="M3 17l4-4 10-10 3 3L10 16l-4 4H3v-3z"/>
                <line x1="14" y1="7" x2="17" y2="10"/>`,

  watercolor:  `<path d="M12 2C6 10 4 14 4 17a8 8 0 0016 0c0-3-2-7-8-15z"
                      fill="#a8d8f0" stroke="#222" stroke-width="2" opacity="0.85"/>`,

  crayon:      `<rect x="7" y="3" width="10" height="15" rx="1.5"
                      fill="#ffd066" stroke="#222" stroke-width="2"/>
                <path d="M7 18l5 3 5-3" fill="#cc8822" stroke="#222" stroke-width="2"
                      stroke-linejoin="round"/>`,

  eraser:      `<path d="M20 20H7L3 16l10-10 7 7-3 3"/>
                <path d="M6.5 17.5l5-5" stroke="#aaa" stroke-width="1.5"/>`,

  sizeUp:      `<line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>`,

  sizeDown:    `<line x1="5" y1="12" x2="19" y2="12"/>`,

  bgFill:      `<rect x="3" y="3" width="18" height="18" rx="2"
                      fill="#bbddff" stroke="#222" stroke-width="2.2"/>
                <path d="M6 17 L11 11 L15 14 L18 10" fill="none" stroke="#226" stroke-width="1.5"/>`,

  clear:       `<polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4h6v2"/>`,

  upload:      `<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>`,

  save:        `<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>`,

  download:    `<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="3" x2="12" y2="15"/>`,

  delete:      `<polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6M14 11v6"/>`,

  book:        `<path d="M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4z"/>
                <path d="M20 4h-6a3 3 0 00-3 3v13a2 2 0 012-2h7z"/>`,

  reload:      `<polyline points="3 4 3 10 9 10"/>
                <path d="M20.49 15a9 9 0 11-2.13-9.36L23 10"/>`,

  scrollLeft:  `<polyline points="15 18 9 12 15 6"/>`,
  scrollRight: `<polyline points="9 18 15 12 9 6"/>`,
  scrollUp:    `<polyline points="18 15 12 9 6 15"/>`,
  scrollDown:  `<polyline points="6 9 12 15 18 9"/>`,

  cancel:      `<line x1="6" y1="6" x2="18" y2="18"/>
                <line x1="18" y1="6" x2="6" y2="18"/>`,
};

// Convenience: returns an <svg> element of given pixel size,
// using the named icon's inner markup.
FP.icon = function (name, sizePx) {
  const inner = FP.icons[name] || '';
  const svg = `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24"
       fill="none" stroke="#222" stroke-width="2.2"
       stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return svg;
};

/**
 * Page-bg picker icon: a fan of 3 letter-shaped papers in `color`, each with
 * a black outline so the stack reads as 3 distinct pages. Used in place of
 * the regular color swatches when the page picker is open — visually cues
 * the user that tapping selects a page BACKGROUND color, not a paint color.
 */
FP.pageFanIcon = function (color, sizePx) {
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24">
    <rect x="3.5" y="6" width="11" height="14" rx="0.8"
          fill="${color}" stroke="#222" stroke-width="1.2"
          transform="rotate(-14 9 13)"/>
    <rect x="9.5" y="6" width="11" height="14" rx="0.8"
          fill="${color}" stroke="#222" stroke-width="1.2"
          transform="rotate(14 15 13)"/>
    <rect x="6.5" y="3.5" width="11" height="14" rx="0.8"
          fill="${color}" stroke="#222" stroke-width="1.2"/>
  </svg>`;
};

// Active checkmark overlay — white check with black halo, bottom-right corner
FP.activeMark = function (sizePx) {
  const s = Math.max(8, sizePx * 0.38);
  const off = sizePx * 0.06;
  return `<svg class="active-mark" width="${s}" height="${s}" viewBox="0 0 24 24"
            style="bottom:${off}px;right:${off}px;" fill="none">
    <polyline points="4 13 9 18 20 7" stroke="black" stroke-width="4"
              stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="4 13 9 18 20 7" stroke="white" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
};

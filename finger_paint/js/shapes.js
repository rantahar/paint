/* ────────────────────────────────────────────────────────────
   shapes.js — premade stamp shapes for the Shape tool.

   Each shape is defined ONCE as an SVG path string in a unit space
   (centred on 0,0; radius ≈ 1; upright). The same string drives:
     • canvas rendering (via Path2D + a DOMMatrix transform), and
     • the toolbar option icon (via a plain <svg><path>),
   so the button always previews exactly what gets stamped.

   Rendering strokes the OUTLINE only — the outline width is the
   brush thickness, so the size slider composes with every shape.
   With the rainbow paint the outline is drawn as concentric colour
   bands (widest red first, narrowest violet last), giving a
   symmetric rainbow edge whose band width also follows thickness.

   Gesture model (see canvas.js): press = shape centre, drag sets
   radius AND rotation (drag straight up = upright), plain tap
   stamps at a default size.
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

(function () {
  'use strict';

  // ── Unit-space path definitions ────────────────────────────
  function starPath(points, outerR, innerR) {
    const cmds = [];
    for (let i = 0; i < points * 2; i++) {
      const r = (i % 2 === 0) ? outerR : innerR;
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      cmds.push(`${i === 0 ? 'M' : 'L'} ${(Math.cos(a) * r).toFixed(3)} ${(Math.sin(a) * r).toFixed(3)}`);
    }
    return cmds.join(' ') + ' Z';
  }

  function flowerPath(petals, tipR, ctrlR, spreadRad, coreR) {
    const cmds = [];
    for (let k = 0; k < petals; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / petals;
      const tx = Math.cos(a) * tipR,             ty = Math.sin(a) * tipR;
      const c1x = Math.cos(a - spreadRad) * ctrlR, c1y = Math.sin(a - spreadRad) * ctrlR;
      const c2x = Math.cos(a + spreadRad) * ctrlR, c2y = Math.sin(a + spreadRad) * ctrlR;
      cmds.push(`M 0 0 Q ${c1x.toFixed(3)} ${c1y.toFixed(3)} ${tx.toFixed(3)} ${ty.toFixed(3)}`
              + ` Q ${c2x.toFixed(3)} ${c2y.toFixed(3)} 0 0`);
    }
    // Centre disc as its own subpath.
    cmds.push(`M ${coreR} 0 A ${coreR} ${coreR} 0 1 0 ${-coreR} 0 A ${coreR} ${coreR} 0 1 0 ${coreR} 0 Z`);
    return cmds.join(' ');
  }

  const DEFS = {
    circle:   'M 1 0 A 1 1 0 1 0 -1 0 A 1 1 0 1 0 1 0 Z',
    square:   'M -0.85 -0.85 L 0.85 -0.85 L 0.85 0.85 L -0.85 0.85 Z',
    triangle: 'M 0 -1 L 0.9 0.55 L -0.9 0.55 Z',
    star:     starPath(5, 1, 0.45),
    heart:    'M 0 0.85 C -0.85 0.3 -1.05 -0.25 -0.62 -0.62 ' +
              'C -0.25 -0.92 0 -0.55 0 -0.35 ' +
              'C 0 -0.55 0.25 -0.92 0.62 -0.62 ' +
              'C 1.05 -0.25 0.85 0.3 0 0.85 Z',
    flower:   flowerPath(6, 1, 0.85, 0.42, 0.22),
    moon:     'M 0.42 -0.9 A 1 1 0 1 0 0.42 0.9 A 0.78 0.78 0 1 1 0.42 -0.9 Z',
  };

  const ORDER = ['circle', 'square', 'triangle', 'star', 'heart', 'flower', 'moon'];

  // ── Path2D cache + transforms ──────────────────────────────
  const _unitCache = {};
  function _unitPath(id) {
    if (!_unitCache[id]) _unitCache[id] = new Path2D(DEFS[id]);
    return _unitCache[id];
  }

  function _transformedPath(id, cx, cy, r, angleRad) {
    const m = new DOMMatrix()
      .translate(cx, cy)
      .rotate((angleRad * 180) / Math.PI)
      .scale(r);
    const p = new Path2D();
    p.addPath(_unitPath(id), m);
    return p;
  }

  // ── Canvas rendering ───────────────────────────────────────
  // Stroke the shape outline at (cx, cy) with radius r (painting units)
  // and rotation angleRad. lineWidth is the full outline width (2×brush
  // size). Solid colours stroke once; rainbow strokes N times with
  // decreasing widths so the outline reads as concentric colour bands.
  function render(ctx, id, cx, cy, r, angleRad, color, lineWidth) {
    if (!DEFS[id]) return;
    const p = _transformedPath(id, cx, cy, r, angleRad);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    if (FP.rainbow && FP.rainbow.isRainbow(color)) {
      const colors = FP.rainbow.bandColors();
      const n = colors.length;
      for (let i = 0; i < n; i++) {
        ctx.strokeStyle = colors[i];
        ctx.lineWidth   = Math.max(0.5, (lineWidth * (n - i)) / n);
        ctx.stroke(p);
      }
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth   = Math.max(0.5, lineWidth);
      ctx.stroke(p);
    }
    ctx.restore();
  }

  // ── Toolbar icon ───────────────────────────────────────────
  // The icon is the shape's own unit path, so the button previews the
  // exact geometry that will be stamped.
  function icon(id, sizePx) {
    const d = DEFS[id] || '';
    return `<svg width="${sizePx}" height="${sizePx}" viewBox="-1.3 -1.3 2.6 2.6"
        fill="none" stroke="#222" stroke-width="0.17"
        stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  }

  FP.shapes = { DEFS, ORDER, render, icon };
})();

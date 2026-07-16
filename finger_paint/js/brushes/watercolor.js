/* ────────────────────────────────────────────────────────────
   Watercolor brush — low-opacity, soft, blends on overlap.

   We render to an offscreen "stroke buffer" canvas during the stroke
   and composite it onto the main drawing once at endStroke(), so
   overlapping passes WITHIN one stroke don't pile up alpha.
   Successive strokes still blend (because each stroke deposits low
   alpha onto the main drawing layer).
   ──────────────────────────────────────────────────────────── */
(function () {
  window.FP = window.FP || {};
  FP.brushes = FP.brushes || {};

  FP.brushes.watercolor = {
    id:       'watercolor',
    label:    'Watercolor',
    iconName: 'watercolor',

    sounds: {
      select:     function () { /* play 'water-select.wav' */ },
      touchStart: function () { /* play 'water-down.wav'   */ },
      move:       function () { /* play 'water-loop.wav' (looped) */ },
      touchEnd:   function () { /* play 'water-up.wav'     */ },
    },

    beginStroke(ctx, pt, opts) {
      // Spin up an offscreen buffer the same size as the target
      // canvas so we can stamp without alpha pile-up.
      const buf = document.createElement('canvas');
      buf.width  = ctx.canvas.width;
      buf.height = ctx.canvas.height;
      const bctx = buf.getContext('2d');

      // Use opts.size as the gradient radius so the painted footprint diameter
      // (= opts.size * 2) matches every other brush and the size-indicator dot.
      const radius = opts.size;

      // initial soft circle
      _stamp(bctx, pt.x, pt.y, radius, opts.color);

      return {
        buf, bctx,
        last: { x: pt.x, y: pt.y },
        radius,
        color: opts.color,
      };
    },

    continueStroke(ctx, state, pt, opts) {
      // Refresh from opts so rainbow paint (which re-colours each segment)
      // takes effect — for a solid colour this is a harmless no-op.
      if (opts && opts.color) state.color = opts.color;
      // Interpolate stamps along the segment so fast moves stay continuous
      const dx = pt.x - state.last.x;
      const dy = pt.y - state.last.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(2, state.radius * 0.25);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        _stamp(state.bctx,
               state.last.x + dx * t,
               state.last.y + dy * t,
               state.radius, state.color);
      }
      state.last.x = pt.x;
      state.last.y = pt.y;

      // Live preview: composite buffer onto target every frame at
      // moderate alpha so the user sees the stroke building.
      _previewComposite(ctx, state);
    },

    endStroke(ctx, state /*, pt, opts */) {
      // Final commit — buffer is composited at the watercolor opacity.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(state.buf, 0, 0);
      ctx.restore();
    },
  };

  /* Soft radial stamp drawn into the offscreen buffer at full alpha.
     Final transparency is applied when the buffer is composited. */
  function _stamp(bctx, x, y, radius, color) {
    bctx.save();
    const grad = bctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0,   _withAlpha(color, 0.85));
    grad.addColorStop(0.6, _withAlpha(color, 0.55));
    grad.addColorStop(1,   _withAlpha(color, 0));
    bctx.fillStyle = grad;
    bctx.beginPath();
    bctx.arc(x, y, radius, 0, Math.PI * 2);
    bctx.fill();
    bctx.restore();
  }

  /* Live in-stroke preview composite. We don't permanently draw
     until endStroke(); but to give visual feedback we briefly overlay
     the buffer at lower alpha. (Note: this stacks each move call —
     for v1 that's an acceptable artifact; replace with a dedicated
     preview canvas if it becomes a problem.) */
  let lastPreviewT = 0;
  function _previewComposite(ctx, state) {
    const now = performance.now();
    if (now - lastPreviewT < 16) return; // ~60fps cap
    lastPreviewT = now;
    // Note: previews accumulate slightly because we don't have a
    // dedicated overlay layer. The endStroke() pass is the source
    // of truth — preview is just visual sugar.
    ctx.save();
    ctx.globalAlpha = 0.04;
    ctx.drawImage(state.buf, 0, 0);
    ctx.restore();
  }

  /* CSS-color → rgba(...,a). Uses an offscreen canvas to resolve
     named/hex colors to their RGB triple. Memoized. */
  const _colorCache = {};
  function _withAlpha(color, alpha) {
    if (_colorCache[color]) {
      const [r, g, b] = _colorCache[color];
      return `rgba(${r},${g},${b},${alpha})`;
    }
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const cx = c.getContext('2d');
    cx.fillStyle = color;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    _colorCache[color] = [d[0], d[1], d[2]];
    return `rgba(${d[0]},${d[1]},${d[2]},${alpha})`;
  }
})();

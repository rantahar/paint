/* ────────────────────────────────────────────────────────────
   Dot brush — a trail of round dots.

   Distance-based spacing (like dash.js): a dot is stamped every
   `size * SPACING_K` painting units of travel, independent of event
   rate. Dot radius = brush size, spacing scales with it, so the
   thickness control tunes both.

   With rainbow paint each colour band runs its own dotted line;
   equal travel distances keep the dots aligned across bands.
   ──────────────────────────────────────────────────────────── */
(function () {
  window.FP = window.FP || {};
  FP.brushes = FP.brushes || {};

  const SPACING_K = 3.2;   // centre-to-centre spacing = size * SPACING_K

  function stamp(ctx, x, y, opts) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = opts.color;
    ctx.beginPath();
    ctx.arc(x, y, opts.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  FP.brushes.dot = {
    id:       'dot',
    label:    'Dotted line',
    iconName: 'dot',

    beginStroke(ctx, pt, opts) {
      stamp(ctx, pt.x, pt.y, opts);
      // `rem` = distance left to travel before the next dot.
      return { last: { x: pt.x, y: pt.y }, rem: opts.size * SPACING_K };
    },

    continueStroke(ctx, state, pt, opts) {
      const dx = pt.x - state.last.x;
      const dy = pt.y - state.last.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0) return;

      let travelled = 0;
      while (travelled + state.rem <= dist) {
        travelled += state.rem;
        stamp(ctx,
              state.last.x + (dx * travelled) / dist,
              state.last.y + (dy * travelled) / dist,
              opts);
        state.rem = opts.size * SPACING_K;
      }
      state.rem -= dist - travelled;
      state.last.x = pt.x;
      state.last.y = pt.y;
    },

    endStroke(/* ctx, state, pt, opts */) { /* no-op */ },
  };
})();

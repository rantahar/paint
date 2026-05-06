/* ────────────────────────────────────────────────────────────
   Crayon brush — grainy, waxy, varying-pressure feel.

   Implementation: along each stroke segment we stamp many tiny
   semi-opaque circles with random offsets and alphas to fake the
   "tooth" of paper. Tunable via GRAIN_DENSITY and GRAIN_JITTER.
   ──────────────────────────────────────────────────────────── */
(function () {
  window.FP = window.FP || {};
  FP.brushes = FP.brushes || {};

  // ── Tweakable constants ────────────────────────────────────────
  const GRAIN_DENSITY = 1.2;   // grains per (radius * 1px) of stroke
  const GRAIN_JITTER  = 0.55;  // 0..1 — fraction of radius to scatter
  const GRAIN_MIN_A   = 0.08;
  const GRAIN_MAX_A   = 0.55;
  const GRAIN_MIN_R   = 0.10;  // each grain dot's radius, fraction of brush radius
  const GRAIN_MAX_R   = 0.30;
  // ───────────────────────────────────────────────────────────────

  FP.brushes.crayon = {
    id:       'crayon',
    label:    'Crayon',
    iconName: 'crayon',

    sounds: {
      select:     function () { /* play 'crayon-select.wav' */ },
      touchStart: function () { /* play 'crayon-down.wav'   */ },
      move:       function () { /* play 'crayon-scratch.wav' (looped, ducked) */ },
      touchEnd:   function () { /* play 'crayon-up.wav'     */ },
    },

    beginStroke(ctx, pt, opts) {
      const state = {
        last: { x: pt.x, y: pt.y },
        radius: opts.size,
        color: opts.color,
      };
      _stampGrains(ctx, pt.x, pt.y, state.radius, state.color, 6);
      return state;
    },

    continueStroke(ctx, state, pt /*, opts */) {
      const dx = pt.x - state.last.x;
      const dy = pt.y - state.last.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.5) return;

      // step along segment, stamping grains
      const step = Math.max(1, state.radius * 0.25);
      const n = Math.max(1, Math.ceil(dist / step));
      const grainsPerStep = Math.max(1, Math.round(state.radius * GRAIN_DENSITY));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const x = state.last.x + dx * t;
        const y = state.last.y + dy * t;
        _stampGrains(ctx, x, y, state.radius, state.color, grainsPerStep);
      }
      state.last.x = pt.x;
      state.last.y = pt.y;
    },

    endStroke(/* ctx, state, pt, opts */) { /* no-op */ },
  };

  function _stampGrains(ctx, cx, cy, radius, color, count) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      // polar offset within the brush footprint
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * GRAIN_JITTER * 1.2;
      const dotR = radius * (GRAIN_MIN_R + Math.random() * (GRAIN_MAX_R - GRAIN_MIN_R));
      const alpha = GRAIN_MIN_A + Math.random() * (GRAIN_MAX_A - GRAIN_MIN_A);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
})();

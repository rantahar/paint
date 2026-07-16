/* ────────────────────────────────────────────────────────────
   Dash brush — marker texture, drawn as dashes.

   Distance-based phase tracking: the on/off pattern advances with
   how far the finger travels (not with event count), so dashes stay
   even regardless of drawing speed. Dash and gap lengths scale with
   brush size, so the thickness control restyles the pattern too.

   Composes with rainbow paint automatically: rainbow strokes run
   this brush once per colour band, and since every band travels the
   same distance the dashes stay aligned across bands — striped
   rainbow dashes for free.
   ──────────────────────────────────────────────────────────── */
(function () {
  window.FP = window.FP || {};
  FP.brushes = FP.brushes || {};

  const ON_K  = 4.5;   // dash length  = size * ON_K
  const OFF_K = 3.0;   // gap length   = size * OFF_K

  FP.brushes.dash = {
    id:       'dash',
    label:    'Dashed line',
    iconName: 'dash',

    beginStroke(ctx, pt, opts) {
      // Starter dot so a single tap leaves a mark (also starts dash #1).
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = opts.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, opts.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return { last: { x: pt.x, y: pt.y }, phase: 0 };
    },

    continueStroke(ctx, state, pt, opts) {
      const on     = opts.size * ON_K;
      const period = on + opts.size * OFF_K;
      const dx = pt.x - state.last.x;
      const dy = pt.y - state.last.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0) return;

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = opts.color;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.lineWidth   = opts.size * 2;

      // Walk the segment, drawing only the parts that fall in the ON
      // phase of the pattern. A segment can span several phases.
      let t = 0;
      while (t < dist) {
        const phasePos = (state.phase + t) % period;
        if (phasePos < on) {
          const runLen = Math.min(on - phasePos, dist - t);
          const x0 = state.last.x + (dx * t) / dist;
          const y0 = state.last.y + (dy * t) / dist;
          const x1 = state.last.x + (dx * (t + runLen)) / dist;
          const y1 = state.last.y + (dy * (t + runLen)) / dist;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          t += runLen;
        } else {
          t += Math.min(period - phasePos, dist - t);
        }
      }
      ctx.restore();

      state.phase = (state.phase + dist) % period;
      state.last.x = pt.x;
      state.last.y = pt.y;
    },

    endStroke(/* ctx, state, pt, opts */) { /* no-op */ },
  };
})();

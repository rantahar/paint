/* ────────────────────────────────────────────────────────────
   Marker brush — clean, opaque, round stroke.

   Stroke pipeline:
     beginStroke()    sets up state for one finger's stroke
     continueStroke() draws a segment from prev → curr point
     endStroke()      tears down (no-op for marker)

   `ctx`  is the 2D canvas context for the DRAWING layer.
   `opts` is { color: '#hex' | named, size: number (radius in canvas px) }.
   `pt`   is { x, y, pressure } in canvas-pixel coords.

   To customise: change LINE_CAP, opacity, or swap drawing primitives.
   ──────────────────────────────────────────────────────────── */
(function () {
  window.FP = window.FP || {};
  FP.brushes = FP.brushes || {};

  FP.brushes.marker = {
    id:       'marker',
    label:    'Marker',
    iconName: 'marker',
    // size is treated as radius; lineWidth=size*2 → diameter=size*2
    strokeScale: 2,

    sounds: {
      // Per-brush placeholders (see sounds.js). Drop in audio later.
      select:     function () { /* play 'marker-select.wav' */ },
      touchStart: function () { /* play 'marker-down.wav'   */ },
      move:       function () { /* play 'marker-loop.wav' (looped, ducked) */ },
      touchEnd:   function () { /* play 'marker-up.wav'     */ },
    },

    beginStroke(ctx, pt, opts) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = opts.color;
      ctx.fillStyle   = opts.color;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.lineWidth   = opts.size * 2;

      // A starter dot so a single tap leaves a mark.
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, opts.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      return { last: { x: pt.x, y: pt.y } };
    },

    continueStroke(ctx, state, pt, opts) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = opts.color;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.lineWidth   = opts.size * 2;

      ctx.beginPath();
      ctx.moveTo(state.last.x, state.last.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.restore();

      state.last.x = pt.x;
      state.last.y = pt.y;
    },

    endStroke(/* ctx, state, pt, opts */) { /* no-op */ },
  };
})();

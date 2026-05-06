/* ────────────────────────────────────────────────────────────
   Eraser brush — removes pixels from the drawing layer.

   Uses globalCompositeOperation = 'destination-out': the eraser
   stroke alpha is subtracted from existing alpha, leaving the
   background canvas (which lives in a separate <canvas>) showing
   through. The background is NOT erased — only the user's strokes.
   ──────────────────────────────────────────────────────────── */
(function () {
  window.FP = window.FP || {};
  FP.brushes = FP.brushes || {};

  FP.brushes.eraser = {
    id:       'eraser',
    label:    'Eraser',
    iconName: 'eraser',

    sounds: {
      select:     function () { /* play 'eraser-select.wav' */ },
      touchStart: function () { /* play 'eraser-down.wav'   */ },
      move:       function () { /* play 'eraser-scrub.wav' (looped) */ },
      touchEnd:   function () { /* play 'eraser-up.wav'     */ },
    },

    beginStroke(ctx, pt, opts) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineCap   = 'round';
      ctx.lineJoin  = 'round';
      ctx.lineWidth = opts.size * 2;
      ctx.strokeStyle = '#000'; // color is irrelevant for destination-out
      ctx.fillStyle   = '#000';

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, opts.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      return { last: { x: pt.x, y: pt.y } };
    },

    continueStroke(ctx, state, pt, opts) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineCap   = 'round';
      ctx.lineJoin  = 'round';
      ctx.lineWidth = opts.size * 2;
      ctx.strokeStyle = '#000';

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

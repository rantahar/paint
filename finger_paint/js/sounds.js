/* ────────────────────────────────────────────────────────────
   sounds.js — placeholder sound system.

   Audio playback is intentionally NOT implemented yet.
   Per design: multi-touch + audio is a known compatibility risk,
   so we only stub out the call sites for now.

   To enable later:
   1. Drop audio files into an assets/ folder.
   2. Replace `playSound()` body with an Audio()-pool implementation
      (or Web Audio API for low-latency multi-touch).
   3. Per-brush overrides live in each brush file's `sounds` object;
      they win over generic events when a brush is active.

   Generic placeholder events (called from app.js / canvas.js):
     • toolSelect    — non-brush tool tapped
     • brushSelect   — brush tool tapped (overridden per-brush)
     • colorPick     — color swatch tapped
     • dialogOpen    — modal popped up
     • dialogClose   — modal dismissed
     • pageTurn      — canvas flipped (load / clear)
     • saveDrawing   — drawing saved
     • deleteDrawing — saved drawing removed
     • bgFill        — background filled with color
     • bgUpload      — background image uploaded
     • sizeChange    — brush size changed
     • scroll        — saved-drawings strip scrolled
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

FP.sounds = {
  enabled: false, // flip on once audio assets exist

  // Generic placeholders. Each is a no-op until you wire it up.
  toolSelect:    function ()      { /* play 'click.wav' */ },
  brushSelect:   function (brush) { /* fallback if brush has no select sound */ },
  colorPick:     function (color) { /* play 'pop.wav' */ },
  dialogOpen:    function ()      { /* play 'whoosh-in.wav' */ },
  dialogClose:   function ()      { /* play 'whoosh-out.wav' */ },
  pageTurn:      function ()      { /* play 'page-flip.wav' */ },
  saveDrawing:   function ()      { /* play 'chime.wav' */ },
  deleteDrawing: function ()      { /* play 'crumple.wav' */ },
  bgFill:        function ()      { /* play 'splash.wav' */ },
  bgUpload:      function ()      { /* play 'shutter.wav' */ },
  sizeChange:    function (delta) { /* play 'tick.wav' (pitched by size) */ },
  scroll:        function ()      { /* play 'tick.wav' */ },
};

/* Dispatcher — call this from anywhere in the code instead of
   reaching into FP.sounds directly. Lets us add logging / muting
   in one place later. */
FP.playSound = function (eventName, ...args) {
  if (!FP.sounds.enabled) return;
  const fn = FP.sounds[eventName];
  if (typeof fn === 'function') fn(...args);
};

/* Brush-specific dispatcher — checks the brush's own sounds first,
   falls back to the generic event if missing. Called from canvas.js
   stroke handlers. */
FP.playBrushSound = function (brush, eventName, ...args) {
  if (!FP.sounds.enabled) return;
  const own = brush && brush.sounds && brush.sounds[eventName];
  if (typeof own === 'function') {
    own(...args);
  } else if (eventName === 'select') {
    FP.playSound('brushSelect', brush);
  }
  // touchStart / move / touchEnd have no generic fallback — only brushes own those.
};

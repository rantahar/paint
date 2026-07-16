/* ────────────────────────────────────────────────────────────
   rainbow.js — the "rainbow" paint.

   Rainbow is not a brush and not a mode: it's a special COLOR
   (the sentinel string 'rainbow') that lives in the palette next
   to the solid swatches. Because it's just a color, it composes
   with everything that already takes a color:

     • Draw with it  → rainbow lines: the classic colours run in
       parallel bands ACROSS the stroke (red on the outer edge of a
       left-to-right arch), so drawing an arc paints an actual rainbow
     • Fill with it  → rainbow background (hue cycles across bands)
     • (later) shape outline → rainbow-edged shapes

   The one knob that ties it all together is brush/line THICKNESS:
     • strokes → total rainbow width (each colour band gets 1/Nth)
     • fills   → the spatial period of the band cycle
   So one swatch × one size slider already makes many different
   effects, in a way a kid can discover by playing.

   All geometry here is in painting units (the canvas's 1000-wide
   coordinate space), matching brush `size` (a radius).
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

(function () {
  const RAINBOW = 'rainbow';

  // Fill: spatial period (painting units) over which the hue completes one
  // full 360° cycle, as a multiple of brush size — thicker brush, wider
  // bands. MIN_PERIOD keeps the bands from collapsing into noise at the
  // smallest sizes.
  const FILL_PERIOD_K = 10;
  const MIN_PERIOD    = 24;

  function fillPeriod(sizePx) { return Math.max(MIN_PERIOD, sizePx * FILL_PERIOD_K); }

  function isRainbow(color) { return color === RAINBOW; }

  // Strokes: the classic 7 rainbow colours, outer (red) → inner (violet).
  const BAND_HUES = [0, 30, 60, 130, 210, 260, 290];

  function bandColors() { return BAND_HUES.map(hueColor); }

  // Centre offset of band i (of n) from the finger, in painting units,
  // measured along the stroke's normal. Band 0 (red) sits on the +normal
  // side (+size − half a band); the last (violet) mirrors it at the −size
  // edge. The n bands tile the stroke's full 2×size footprint exactly.
  function bandOffset(i, n, sizePx) {
    return sizePx * (1 - (2 * i + 1) / n);
  }

  // Saturated, bright hue — reads as a "kid rainbow" rather than a pastel.
  function hueColor(hue) {
    const h = ((hue % 360) + 360) % 360;
    return `hsl(${h}, 90%, 55%)`;
  }

  // Paint a repeating rainbow across a 2D context region [0,0 → w,h].
  // Used for rainbow background fills. The gradient runs along the
  // diagonal and repeats every `periodPx`, so a larger period (thicker
  // brush) yields fewer, wider bands.
  function paintFill(ctx, w, h, periodPx) {
    const len    = Math.hypot(w, h);
    const cycles = Math.max(1, len / periodPx);
    const grad   = ctx.createLinearGradient(0, 0, w, h);
    // 6 stops per cycle traces red→yellow→green→cyan→blue→magenta→red.
    const stops = Math.max(6, Math.ceil(cycles * 6));
    for (let i = 0; i <= stops; i++) {
      const t = i / stops;
      grad.addColorStop(t, hueColor(t * cycles * 360));
    }
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // CSS background for the rainbow swatch / preview tiles — a colour wheel
  // that reads instantly as "rainbow" at any button size.
  function cssGradient() {
    return 'conic-gradient(from 0deg, ' +
      'hsl(0,90%,55%), hsl(60,90%,55%), hsl(120,90%,55%), ' +
      'hsl(180,90%,55%), hsl(240,90%,55%), hsl(300,90%,55%), hsl(360,90%,55%))';
  }

  FP.RAINBOW = RAINBOW;
  FP.rainbow = {
    RAINBOW,
    isRainbow,
    hueColor,
    bandColors,
    bandOffset,
    paintFill,
    cssGradient,
    fillPeriod,
  };
})();

/* ────────────────────────────────────────────────────────────
   canvas.js — the painting surface.

   Two stacked <canvas> elements at fixed 1000×1000 backing res:
     • bg-canvas      → background fills + uploaded images
     • draw-canvas    → user strokes (transparent over bg)

   Composite (bg + draw) is what gets saved / thumbnailed / downloaded.

   Multi-touch via Pointer Events. Each active pointer has its own
   stroke state, so N fingers = N concurrent strokes, each running
   through the currently-selected brush. (All fingers share the
   same brush/color/size; the design has only one selected at a time.)

   Coordinate mapping: pointer client coords are mapped to
   1000-unit painting coords using the displayed bounding rect of
   draw-canvas. The painting is always SQUARE (rendered at
   canvasRect.width × canvasRect.width).
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

const PAINTING_RES = 1000;     // backing resolution (1000×1000 logical units)
const FLIP_HALF_MS = 220;      // page-flip half-duration (must match CSS keyframes)

FP.PaintingCanvas = class {
  constructor(wrapEl) {
    this.wrapEl = wrapEl;
    this.wrapEl.classList.add('painting-wrap');

    // Inner "painting" element — square, holds both canvases
    this.paintingEl = document.createElement('div');
    this.paintingEl.className = 'painting';
    this.wrapEl.appendChild(this.paintingEl);

    // Background canvas (under)
    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width  = PAINTING_RES;
    this.bgCanvas.height = PAINTING_RES;
    this.bgCtx = this.bgCanvas.getContext('2d');
    this.paintingEl.appendChild(this.bgCanvas);

    // Drawing canvas (over)
    this.drawCanvas = document.createElement('canvas');
    this.drawCanvas.width  = PAINTING_RES;
    this.drawCanvas.height = PAINTING_RES;
    this.drawCtx = this.drawCanvas.getContext('2d');
    this.paintingEl.appendChild(this.drawCanvas);

    // Initial light-blue paper
    this._currentBgColor = '#dff0fa';
    this._fillBg(this._currentBgColor);
    this.wrapEl.style.background = this._currentBgColor;

    // State
    this.activeStrokes = new Map();   // pointerId → { brush, state, color, size }
    this.brush = FP.brushes.marker;
    this.color = 'crimson';
    this.size  = 12;                  // in painting units (1000-scale)
    this.dirtySinceLoad = false;      // true once a stroke touches; reset on save/clear/load
    this.onDirtyChange = null;        // callback for app to update Save↔Download button

    // Pointer events
    const dc = this.drawCanvas;
    dc.style.touchAction = 'none';
    dc.addEventListener('pointerdown',   e => this._onDown(e));
    dc.addEventListener('pointermove',   e => this._onMove(e));
    dc.addEventListener('pointerup',     e => this._onUp(e));
    dc.addEventListener('pointercancel', e => this._onUp(e));
    dc.addEventListener('lostpointercapture', e => this._onUp(e));
    // contextmenu suppression (long-press on mobile)
    dc.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ── Layout ──────────────────────────────────────────────────
  setRect({ left, top, width, height }) {
    // Wrap matches the visible rectangle (clips overflow)
    this.wrapEl.style.left   = left   + 'px';
    this.wrapEl.style.top    = top    + 'px';
    this.wrapEl.style.width  = width  + 'px';
    this.wrapEl.style.height = height + 'px';
    this.wrapEl.style.overflow = 'hidden';

    // Inner painting is square: sized to width, top-left aligned
    this.paintingEl.style.left   = '0px';
    this.paintingEl.style.top    = '0px';
    this.paintingEl.style.width  = width + 'px';
    this.paintingEl.style.height = width + 'px';   // square
  }

  // ── Tool state ──────────────────────────────────────────────
  setBrush(brush) { this.brush = brush; }
  setColor(color) { this.color = color; }
  setSize(size)   { this.size  = size; }

  // ── Background ops ──────────────────────────────────────────
  fillBackground(color) {
    this._currentBgColor = color;
    this._fillBg(color);
    // Sync the wrap bg so the area BELOW the painting square (visible
    // when the canvas rect is taller than the painting) matches.
    this.wrapEl.style.background = color;
  }

  /** image: HTMLImageElement (already loaded). cover-fits to 1000×1000. */
  setBackgroundImage(image) {
    const ctx = this.bgCtx;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAINTING_RES, PAINTING_RES);

    // cover-fit
    const ar = image.naturalWidth / image.naturalHeight;
    let dw = PAINTING_RES, dh = PAINTING_RES, dx = 0, dy = 0;
    if (ar > 1) { dw = PAINTING_RES * ar; dx = (PAINTING_RES - dw) / 2; }
    else        { dh = PAINTING_RES / ar; dy = (PAINTING_RES - dh) / 2; }
    ctx.drawImage(image, dx, dy, dw, dh);
    ctx.restore();

    // Sync wrap bg from a corner pixel — overflow area below the
    // painting square (in tall portrait viewports) reads as a soft
    // continuation of the image edge.
    try {
      const sample = this.bgCtx.getImageData(2, PAINTING_RES - 3, 1, 1).data;
      this.wrapEl.style.background =
        `rgb(${sample[0]},${sample[1]},${sample[2]})`;
    } catch (_) { /* tainted canvas — skip */ }
  }

  /** Replaces both layers — drawing wiped, image becomes background. */
  loadCompositeFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.bgCtx.clearRect(0, 0, PAINTING_RES, PAINTING_RES);
        this.bgCtx.drawImage(img, 0, 0, PAINTING_RES, PAINTING_RES);
        this.drawCtx.clearRect(0, 0, PAINTING_RES, PAINTING_RES);
        // Sample a corner pixel for wrap-bg color, since the loaded
        // image may have any solid color outside the painting square.
        try {
          const sample = this.bgCtx.getImageData(2, 2, 1, 1).data;
          this.wrapEl.style.background =
            `rgb(${sample[0]},${sample[1]},${sample[2]})`;
        } catch (_) { /* tainted canvas — skip */ }
        this._setDirty(false);
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // ── Drawing ops ─────────────────────────────────────────────
  clearDrawing() {
    this.drawCtx.clearRect(0, 0, PAINTING_RES, PAINTING_RES);
    this._setDirty(false);
  }

  /** Full reset — bg light blue + empty drawing. */
  reset() {
    this.fillBackground('#dff0fa');
    this.clearDrawing();
  }

  // ── Output ──────────────────────────────────────────────────
  /** Composite both layers into a fresh canvas, return PNG data URL. */
  toCompositeDataURL() {
    const out = document.createElement('canvas');
    out.width  = PAINTING_RES;
    out.height = PAINTING_RES;
    const ox = out.getContext('2d');
    ox.drawImage(this.bgCanvas,   0, 0);
    ox.drawImage(this.drawCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /** Smaller PNG for thumbnails / dialog previews. */
  toThumbnailDataURL(size = 160) {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ox = out.getContext('2d');
    ox.drawImage(this.bgCanvas,   0, 0, size, size);
    ox.drawImage(this.drawCanvas, 0, 0, size, size);
    return out.toDataURL('image/png');
  }

  // ── Page-flip animation ─────────────────────────────────────
  /** Runs `midActionFn` at the midpoint of a 2-stage CSS flip. */
  async pageFlip(midActionFn) {
    FP.playSound('pageTurn');
    const el = this.paintingEl;
    el.classList.remove('flipping-in', 'flipping-out');
    // force reflow so re-adding class re-triggers animation
    void el.offsetWidth;
    el.classList.add('flipping-out');
    await _wait(FLIP_HALF_MS);
    try { await midActionFn(); } catch (e) { console.warn('pageFlip mid action failed', e); }
    el.classList.remove('flipping-out');
    void el.offsetWidth;
    el.classList.add('flipping-in');
    await _wait(FLIP_HALF_MS);
    el.classList.remove('flipping-in');
  }

  // ── Pointer handlers ────────────────────────────────────────
  _onDown(e) {
    e.preventDefault();
    // setPointerCapture can throw on synthetic / non-primary events;
    // the stroke still works without it, just less robust to gestures
    // that move outside the canvas.
    try { this.drawCanvas.setPointerCapture(e.pointerId); } catch (_) {}

    const pt = this._eventToCanvas(e);
    if (!pt) return;

    const opts = { color: this.color, size: this.size };
    const state = this.brush.beginStroke(this.drawCtx, pt, opts);
    this.activeStrokes.set(e.pointerId, {
      brush: this.brush, state, opts,
    });
    this._setDirty(true);

    FP.playBrushSound(this.brush, 'touchStart');
  }

  _onMove(e) {
    if (!this.activeStrokes.has(e.pointerId)) return;
    e.preventDefault();

    // coalesced events for high-frequency move data
    const events = (typeof e.getCoalescedEvents === 'function')
      ? e.getCoalescedEvents()
      : [e];
    const stroke = this.activeStrokes.get(e.pointerId);

    for (const ev of events) {
      const pt = this._eventToCanvas(ev);
      if (!pt) continue;
      stroke.brush.continueStroke(this.drawCtx, stroke.state, pt, stroke.opts);
    }
    FP.playBrushSound(stroke.brush, 'move');
  }

  _onUp(e) {
    const stroke = this.activeStrokes.get(e.pointerId);
    if (!stroke) return;
    e.preventDefault();

    const pt = this._eventToCanvas(e) || { x: 0, y: 0 };
    stroke.brush.endStroke(this.drawCtx, stroke.state, pt, stroke.opts);
    this.activeStrokes.delete(e.pointerId);
    try { this.drawCanvas.releasePointerCapture(e.pointerId); } catch (_) {}

    FP.playBrushSound(stroke.brush, 'touchEnd');
  }

  // ── Helpers ─────────────────────────────────────────────────
  _eventToCanvas(e) {
    const r = this.drawCanvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    // Painting is rendered at canvas-element width × canvas-element height
    // (the element is square); 1000 logical units across.
    const x = (e.clientX - r.left) / r.width  * PAINTING_RES;
    const y = (e.clientY - r.top)  / r.height * PAINTING_RES;
    return { x, y, pressure: e.pressure || 0.5 };
  }

  _fillBg(color) {
    this.bgCtx.save();
    this.bgCtx.fillStyle = color;
    this.bgCtx.fillRect(0, 0, PAINTING_RES, PAINTING_RES);
    this.bgCtx.restore();
  }

  _setDirty(d) {
    if (this.dirtySinceLoad === d) return;
    this.dirtySinceLoad = d;
    if (this.onDirtyChange) this.onDirtyChange(d);
  }
};

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

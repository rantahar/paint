/* ────────────────────────────────────────────────────────────
   canvas.js — the painting surface.

   Two stacked <canvas> elements with a fixed 1000-unit width
   and a dynamic height:
     • bg-canvas      → background fills + uploaded images
     • draw-canvas    → user strokes (transparent over bg)

   Composite (bg + draw) is what gets saved / thumbnailed / downloaded.

   Backing canvas width is always PAINTING_W (1000 units). Height
   (_paintingH) starts at 1000 and expands to fill the visible area
   on each setRect() call. It never shrinks on resize — only on
   explicit load operations (loadCompositeFromDataUrl, setBackgroundImage).

   Coordinate mapping: pointer client coords → painting units via
   isotropic scale (PAINTING_W / cssWidth), same scale for both axes.

   TODO: investigate vector-stroke storage as an alternative to raster
   PNGs. Current brushes (crayon grain, watercolor blend, eraser
   destination-out) are rendered as stamped raster ops; replaying them
   would require each brush to expose a deterministic "render from
   recorded events + seed" path. Vector storage would unlock:
     • Undo/redo via stroke replay (vs. canvas snapshots)
     • Resolution-independent re-rendering
     • Smaller localStorage footprint for stroke-heavy drawings
   Simpler interim: snapshot-based undo (one ImageData per stroke,
   capped ring buffer ≈ 10 entries → ~4-40 MB depending on canvas H).
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

const PAINTING_W   = 1000;     // canonical backing width (painting units)
const FLIP_HALF_MS = 220;      // page-flip half-duration (must match CSS keyframes)

FP.PaintingCanvas = class {
  constructor(wrapEl) {
    this.wrapEl = wrapEl;
    this.wrapEl.classList.add('painting-wrap');

    // Inner "painting" element — fills visible area, holds both canvases
    this.paintingEl = document.createElement('div');
    this.paintingEl.className = 'painting';
    this.wrapEl.appendChild(this.paintingEl);

    // Dynamic height state
    this._paintingH = PAINTING_W;   // current backing canvas height (painting units)
    this._visibleH  = PAINTING_W;   // visible height in painting units (updated by setRect)
    this._bgImageH  = 0;            // bg image extent in painting units (0 = solid fill)

    // Background canvas (under)
    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width  = PAINTING_W;
    this.bgCanvas.height = this._paintingH;
    this.bgCtx = this.bgCanvas.getContext('2d');
    this.paintingEl.appendChild(this.bgCanvas);

    // Drawing canvas (over)
    this.drawCanvas = document.createElement('canvas');
    this.drawCanvas.width  = PAINTING_W;
    this.drawCanvas.height = this._paintingH;
    this.drawCtx = this.drawCanvas.getContext('2d');
    this.paintingEl.appendChild(this.drawCanvas);

    // Initial white paper
    this._currentBgColor = '#ffffff';
    this._fillBg(this._currentBgColor);
    this.wrapEl.style.background = this._currentBgColor;

    // State
    this.activeStrokes = new Map();   // pointerId → { brush, state, opts }
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
    this.wrapEl.style.left    = left   + 'px';
    this.wrapEl.style.top     = top    + 'px';
    this.wrapEl.style.width   = width  + 'px';
    this.wrapEl.style.height  = height + 'px';
    this.wrapEl.style.overflow = 'hidden';

    // Expand backing canvas if visible area needs more height
    const neededH = Math.ceil(height / width * PAINTING_W);
    this._visibleH = neededH;
    if (neededH > this._paintingH) this._expandCanvas(neededH);

    // paintingEl fills the full visible rect
    this.paintingEl.style.left   = '0px';
    this.paintingEl.style.top    = '0px';
    this.paintingEl.style.width  = width  + 'px';
    this.paintingEl.style.height = height + 'px';

    // Canvas CSS width = 100% (from stylesheet); height maintains backing aspect ratio.
    // If _paintingH > neededH (retained from a past tall portrait), the canvas overflows
    // paintingEl below — wrapEl overflow:hidden clips it so only the visible area shows.
    const cssH = width * this._paintingH / PAINTING_W;
    this.bgCanvas.style.height   = cssH + 'px';
    this.drawCanvas.style.height = cssH + 'px';
  }

  // ── Tool state ──────────────────────────────────────────────
  setBrush(brush) { this.brush = brush; }
  setColor(color) { this.color = color; }
  setSize(size)   { this.size  = size; }

  // ── Background ops ──────────────────────────────────────────
  fillBackground(color) {
    this._currentBgColor = color;
    this._bgImageH = 0;   // solid fill — no image-based extent
    this._fillBg(color);
    this.wrapEl.style.background = color;
  }

  /** image: HTMLImageElement (already loaded). Fits to PAINTING_W wide; resizes canvas height. */
  setBackgroundImage(image) {
    const imgH = Math.round(image.naturalHeight / image.naturalWidth * PAINTING_W);
    this._bgImageH = imgH;
    this._resizeCanvas(imgH);

    const ctx = this.bgCtx;
    ctx.clearRect(0, 0, PAINTING_W, this._paintingH);
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAINTING_W, this._paintingH);
    ctx.drawImage(image, 0, 0, PAINTING_W, imgH);
    ctx.restore();

    try {
      const sampleY = Math.min(imgH - 3, this._paintingH - 1);
      const sample  = ctx.getImageData(2, sampleY, 1, 1).data;
      this.wrapEl.style.background = `rgb(${sample[0]},${sample[1]},${sample[2]})`;
    } catch (_) { /* tainted canvas — skip */ }
  }

  /**
   * Two-layer load. Restores bg + draw to their original layers without
   * flattening. `drawUrl` may be null/falsy for entries that have no
   * strokes layer (e.g. v1 migrated entries).
   */
  loadLayersFromDataUrls(bgUrl, drawUrl) {
    const loadOne = (src) => new Promise((resolve, reject) => {
      if (!src) { resolve(null); return; }
      const im = new Image();
      im.onload  = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
    return Promise.all([loadOne(bgUrl), loadOne(drawUrl)]).then(([bgImg, drawImg]) => {
      if (!bgImg) {
        // Nothing to load — leave canvas alone.
        return;
      }
      const bgH    = Math.round(bgImg.naturalHeight / bgImg.naturalWidth * PAINTING_W);
      const drawH  = drawImg
        ? Math.round(drawImg.naturalHeight / drawImg.naturalWidth * PAINTING_W)
        : 0;
      const targetH = Math.max(bgH, drawH);
      this._bgImageH = bgH;
      this._resizeCanvas(targetH);

      // Background layer
      this.bgCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
      this.bgCtx.drawImage(bgImg, 0, 0, PAINTING_W, bgH);
      if (this._paintingH > bgH) {
        this.bgCtx.save();
        this.bgCtx.fillStyle = '#ffffff';
        this.bgCtx.fillRect(0, bgH, PAINTING_W, this._paintingH - bgH);
        this.bgCtx.restore();
      }

      // Drawing layer
      this.drawCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
      if (drawImg) {
        this.drawCtx.drawImage(drawImg, 0, 0, PAINTING_W, drawH);
      }

      try {
        const sample = this.bgCtx.getImageData(2, 2, 1, 1).data;
        this.wrapEl.style.background = `rgb(${sample[0]},${sample[1]},${sample[2]})`;
      } catch (_) { /* tainted canvas — skip */ }

      this._setDirty(false);
    });
  }

  /** Replaces both layers — drawing wiped, image becomes background. */
  loadCompositeFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // Scale to PAINTING_W wide, maintain aspect ratio
        const scaledH = Math.round(img.naturalHeight / img.naturalWidth * PAINTING_W);
        this._bgImageH = scaledH;
        this._resizeCanvas(scaledH);

        this.bgCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
        this.bgCtx.drawImage(img, 0, 0, PAINTING_W, scaledH);
        // If canvas is taller than loaded image (visible area > image), fill remainder
        if (this._paintingH > scaledH) {
          this.bgCtx.save();
          this.bgCtx.fillStyle = '#ffffff';
          this.bgCtx.fillRect(0, scaledH, PAINTING_W, this._paintingH - scaledH);
          this.bgCtx.restore();
        }
        this.drawCtx.clearRect(0, 0, PAINTING_W, this._paintingH);

        try {
          const sample = this.bgCtx.getImageData(2, 2, 1, 1).data;
          this.wrapEl.style.background = `rgb(${sample[0]},${sample[1]},${sample[2]})`;
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
    this.drawCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
    this._setDirty(false);
  }

  /** Full reset — bg white + empty drawing. */
  reset() {
    this.fillBackground('#ffffff');
    this.clearDrawing();
  }

  /** Call after saving — resets dirty so next stroke will re-trigger onDirtyChange. */
  markSaved() {
    this._setDirty(false);
  }

  // ── Output ──────────────────────────────────────────────────
  /** Background layer only, cropped to content extent. PNG data URL. */
  toBackgroundDataURL() {
    const saveH = this._computeSaveHeight();
    const out = document.createElement('canvas');
    out.width  = PAINTING_W;
    out.height = saveH;
    out.getContext('2d').drawImage(this.bgCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /** Drawing layer only (transparent), cropped to content extent. PNG data URL. */
  toDrawingDataURL() {
    const saveH = this._computeSaveHeight();
    const out = document.createElement('canvas');
    out.width  = PAINTING_W;
    out.height = saveH;
    out.getContext('2d').drawImage(this.drawCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /** Composite both layers, cropped to content extent. Returns PNG data URL. */
  toCompositeDataURL() {
    const saveH = this._computeSaveHeight();
    const out = document.createElement('canvas');
    out.width  = PAINTING_W;
    out.height = saveH;
    const ox = out.getContext('2d');
    ox.drawImage(this.bgCanvas,   0, 0);
    ox.drawImage(this.drawCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /** Smaller PNG using the top PAINTING_W×PAINTING_W square for thumbnails. */
  toThumbnailDataURL(size = 160) {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ox = out.getContext('2d');
    ox.drawImage(this.bgCanvas,   0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
    ox.drawImage(this.drawCanvas, 0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
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
    let stroke = this.activeStrokes.get(e.pointerId);

    // If stroke hasn't started but pointer came from a button, start it now
    if (!stroke && FP && FP.state && FP.state.pointerDownOnButton.has(e.pointerId)) {
      this._onDown(e);
      stroke = this.activeStrokes.get(e.pointerId);
      if (!stroke) return;  // failed to start stroke
      FP.state.pointerDownOnButton.delete(e.pointerId);
    }

    if (!stroke) return;
    e.preventDefault();

    // coalesced events for high-frequency move data
    const events = (typeof e.getCoalescedEvents === 'function')
      ? e.getCoalescedEvents()
      : [e];

    for (const ev of events) {
      const pt = this._eventToCanvas(ev);
      if (!pt) continue;
      stroke.brush.continueStroke(this.drawCtx, stroke.state, pt, stroke.opts);
    }
    FP.playBrushSound(stroke.brush, 'move');
  }

  _onUp(e) {
    const stroke = this.activeStrokes.get(e.pointerId);

    // Clean up button tracking
    if (FP && FP.state) {
      FP.state.pointerDownOnButton.delete(e.pointerId);
    }

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
    if (r.width <= 0) return null;
    // Isotropic scale: same factor for both axes so strokes aren't distorted.
    const scale = PAINTING_W / r.width;
    const x = (e.clientX - r.left) * scale;
    const y = (e.clientY - r.top)  * scale;
    return { x, y, pressure: e.pressure || 0.5 };
  }

  _fillBg(color) {
    this.bgCtx.save();
    this.bgCtx.fillStyle = color;
    this.bgCtx.fillRect(0, 0, PAINTING_W, this._paintingH);
    this.bgCtx.restore();
  }

  /** Expand backing canvas to newH, preserving all content. */
  _expandCanvas(newH) {
    const oldH = this._paintingH;

    const snapBg   = document.createElement('canvas');
    const snapDraw = document.createElement('canvas');
    snapBg.width   = snapDraw.width  = PAINTING_W;
    snapBg.height  = snapDraw.height = oldH;
    snapBg.getContext('2d').drawImage(this.bgCanvas,    0, 0);
    snapDraw.getContext('2d').drawImage(this.drawCanvas, 0, 0);

    this._paintingH        = newH;
    this.bgCanvas.height   = newH;
    this.drawCanvas.height = newH;

    this.bgCtx.drawImage(snapBg,    0, 0);
    this.drawCtx.drawImage(snapDraw, 0, 0);

    // Fill the new area below old content with current bg color
    this.bgCtx.save();
    this.bgCtx.fillStyle = this._currentBgColor;
    this.bgCtx.fillRect(0, oldH, PAINTING_W, newH - oldH);
    this.bgCtx.restore();
  }

  /**
   * Resize canvas to targetH (clamped to at least _visibleH and PAINTING_W).
   * Only called during explicit load operations — can shrink unlike setRect.
   * Shrinking discards content below targetH (acceptable: new content is being loaded).
   */
  _resizeCanvas(newH) {
    const targetH = Math.max(newH, this._visibleH, PAINTING_W);
    if (targetH === this._paintingH) return;
    if (targetH > this._paintingH) {
      this._expandCanvas(targetH);
    } else {
      // Truncate — browsers preserve top content when canvas.height decreases
      this._paintingH        = targetH;
      this.bgCanvas.height   = targetH;
      this.drawCanvas.height = targetH;
    }
    // Refresh CSS height on the canvas elements
    const cssW = parseFloat(this.bgCanvas.style.width) || this.bgCanvas.offsetWidth;
    if (cssW > 0) {
      const cssH = cssW * this._paintingH / PAINTING_W;
      this.bgCanvas.style.height   = cssH + 'px';
      this.drawCanvas.style.height = cssH + 'px';
    }
  }

  /**
   * Determine the save height: lowest row with any content (bg image or strokes),
   * minimum PAINTING_W. Falls back to _paintingH if pixel scan fails.
   */
  _computeSaveHeight() {
    const bgBottom = this._bgImageH;   // 0 for solid fills

    let drawBottom = 0;
    try {
      const data = this.drawCtx.getImageData(0, 0, PAINTING_W, this._paintingH).data;
      outer: for (let row = this._paintingH - 1; row >= 0; row--) {
        for (let col = 0; col < PAINTING_W; col++) {
          if (data[(row * PAINTING_W + col) * 4 + 3] > 0) {
            drawBottom = row + 1;
            break outer;
          }
        }
      }
    } catch (_) {
      return this._paintingH;   // tainted canvas — save everything
    }

    return Math.max(drawBottom, bgBottom, PAINTING_W);
  }

  _setDirty(d) {
    if (this.dirtySinceLoad === d) return;
    this.dirtySinceLoad = d;
    if (this.onDirtyChange) this.onDirtyChange(d);
  }
};

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

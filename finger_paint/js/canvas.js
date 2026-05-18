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

    // Coloring page dimensions (aspect ratio aware scaling)
    this._pageWidth  = null;          // natural page width in painting units (or null if no page)
    this._pageHeight = null;          // natural page height in painting units
    this._maxPaintingH = null;        // max height for canvas expansion when a page is loaded

    // Visual frame background (indicates constrained drawing area)
    this._frameBgEl = document.createElement('div');
    this._frameBgEl.className = 'canvas-frame-bg';
    this.wrapEl.insertBefore(this._frameBgEl, this.paintingEl);
    this._frameBgEl.style.display = 'none';

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

  // ── Coloring Page Management ────────────────────────────────
  /**
   * Set the natural dimensions of a coloring page (in painting units).
   * Pass null to clear (revert to blank canvas scaling).
   */
  setPageDimensions(width, height, isFrameMode) {
    this._pageWidth  = width;
    this._pageHeight = height;
    this._maxPaintingH = height || null;
    // Store frame mode for use in setRect
    this._isFrameMode = isFrameMode;
  }

  // ── Layout ──────────────────────────────────────────────────
  setRect({ left, top, width, height }, isFrameMode) {
    // Wrap matches the visible rectangle (clips overflow)
    this.wrapEl.style.left    = left   + 'px';
    this.wrapEl.style.top     = top    + 'px';
    this.wrapEl.style.width   = width  + 'px';
    this.wrapEl.style.height  = height + 'px';
    this.wrapEl.style.overflow = 'hidden';

    // Update frame mode for alignment decisions
    if (isFrameMode !== undefined) this._isFrameMode = isFrameMode;

    // Compute scale and positioning based on coloring page aspect ratio
    let canvasWidth, canvasHeight, paintingElLeft, paintingElTop;
    const hasColoringPage = this._pageWidth !== null && this._pageHeight !== null;

    if (hasColoringPage) {
      const pageAspectRatio = this._pageWidth / this._pageHeight;
      const frameAspectRatio = width / height;

      if (pageAspectRatio >= frameAspectRatio) {
        // Page is wider or equal: fit to width
        canvasWidth = width;
        canvasHeight = width * this._pageHeight / this._pageWidth;
        paintingElLeft = 0;
        // In frame mode, center vertically; in expanded mode, align top
        paintingElTop = this._isFrameMode ? (height - canvasHeight) / 2 : 0;
      } else {
        // Page is taller: fit to height and center horizontally
        canvasHeight = height;
        canvasWidth = height * this._pageWidth / this._pageHeight;
        paintingElLeft = (width - canvasWidth) / 2;
        paintingElTop = 0; // Always top-aligned when fitting to height
      }

      // Update backing canvas height if needed
      const neededH = Math.ceil(canvasHeight / canvasWidth * PAINTING_W);
      this._visibleH = neededH;
      if (neededH > this._paintingH) this._expandCanvas(neededH);
    } else {
      // No coloring page: use current behavior (fill width)
      const neededH = Math.ceil(height / width * PAINTING_W);
      this._visibleH = neededH;
      if (neededH > this._paintingH) this._expandCanvas(neededH);

      canvasWidth = width;
      canvasHeight = width * this._paintingH / PAINTING_W;
      paintingElLeft = 0;
      paintingElTop = 0;
    }

    // paintingEl positioned based on canvas sizing
    this.paintingEl.style.left   = paintingElLeft + 'px';
    this.paintingEl.style.top    = paintingElTop  + 'px';
    this.paintingEl.style.width  = canvasWidth    + 'px';
    this.paintingEl.style.height = canvasHeight   + 'px';

    // Canvas CSS height maintains backing aspect ratio
    const cssH = canvasWidth * this._paintingH / PAINTING_W;
    this.bgCanvas.style.height   = cssH + 'px';
    this.drawCanvas.style.height = cssH + 'px';

    // Update canvas border (always shown to frame the drawing area)
    this._frameBgEl.style.display = 'block';
    this._frameBgEl.style.left     = '0px';
    this._frameBgEl.style.top      = '0px';
    this._frameBgEl.style.width    = width  + 'px';
    this._frameBgEl.style.height   = height + 'px';
  }

  // ── Tool state ──────────────────────────────────────────────
  setBrush(brush) { this.brush = brush; }
  setColor(color) { this.color = color; }
  setSize(size)   { this.size  = size; }

  // ── Background ops ──────────────────────────────────────────
  fillBackground(color) {
    this._currentBgColor = color;
    this._bgImageH = 0;   // solid fill — no image-based extent
    this.setPageDimensions(null, null);  // clear page dimensions
    this._fillBg(color);
    this.wrapEl.style.background = color;
  }

  /** image: HTMLImageElement (already loaded). Fits to PAINTING_W wide; resizes canvas height. */
  setBackgroundImage(image) {
    const imgH = Math.round(image.naturalHeight / image.naturalWidth * PAINTING_W);
    this._bgImageH = imgH;
    // Store page dimensions for aspect-ratio-aware scaling
    this.setPageDimensions(PAINTING_W, imgH);
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
      this.setPageDimensions(null, null);  // clear page dimensions for saved entries
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
        this.setPageDimensions(null, null);  // clear page dimensions for saved entries
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
    this._currentBgColor = '#ffffff';
    this._bgImageH = 0;
    this.setPageDimensions(null, null);  // clear page dimensions
    this._fillBg('#ffffff');
    this.wrapEl.style.background = '#ffffff';
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

  /** Smaller PNG for thumbnails. Fills square with center alignment (like page scaling). */
  toThumbnailDataURL(size = 160) {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ox = out.getContext('2d');

    // If coloring page loaded, use aspect-ratio-aware scaling (center-aligned)
    if (this._pageWidth !== null && this._pageHeight !== null) {
      const pageAspectRatio = this._pageWidth / this._pageHeight;

      // Sample the full page content from the canvas
      const srcX = 0;
      const srcY = 0;
      const srcW = PAINTING_W;
      const srcH = this._pageHeight;

      // Calculate destination dimensions to fit into the square with center alignment
      let destX, destY, destW, destH;

      if (pageAspectRatio >= 1) {
        // Landscape page: fit to height, overflow left/right → center horizontally
        destH = size;
        destW = Math.round(size * pageAspectRatio);
        destY = 0;
        destX = (size - destW) / 2;
      } else {
        // Portrait page: fit to width, overflow top/bottom → center vertically
        destW = size;
        destH = Math.round(size / pageAspectRatio);
        destX = 0;
        destY = (size - destH) / 2;
      }

      // Fill with white background
      ox.fillStyle = '#ffffff';
      ox.fillRect(0, 0, size, size);

      // Draw the page content centered
      ox.drawImage(this.bgCanvas,   srcX, srcY, srcW, srcH, destX, destY, destW, destH);
      ox.drawImage(this.drawCanvas, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
    } else {
      // Blank canvas: use the standard square capture (zoom-to-fill top-left)
      ox.drawImage(this.bgCanvas,   0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
      ox.drawImage(this.drawCanvas, 0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
    }

    return out.toDataURL('image/png');
  }

  // ── Page-flip animation ─────────────────────────────────────
  /** Runs `midActionFn` at the midpoint of a 2-stage CSS flip. */
  /**
   * Page transition animation. Supports multiple styles:
   * - 'flip' (default): 3D page flip
   * - 'fade': Simple fade out/in (resize invisible)
   * - 'crossfade': Simultaneous crossfade between pages
   * - 'slide': Slide up transition
   * - 'wipe': Wipe transition from right
   *
   * @param {Function} midActionFn - Called at animation midpoint to load new page
   * @param {string} style - Animation style
   * @param {Function} postLoadFn - Called after page loaded, before flip-in animation (optional)
   */
  async pageFlip(midActionFn, style = 'flip', postLoadFn = null) {
    FP.playSound('pageTurn');
    const el = this.paintingEl;

    // Map animation style to CSS class prefixes
    const classMap = {
      flip: { out: 'flipping-out', in: 'flipping-in' },
      fade: { out: 'anim-fade-out', in: 'anim-fade-in' },
      crossfade: { out: 'anim-crossfade-out', in: 'anim-crossfade-in' },
      slide: { out: 'anim-slide-out', in: 'anim-slide-in' },
      wipe: { out: 'anim-wipe-out', in: 'anim-wipe-in' },
    };
    const classes = classMap[style] || classMap.flip;

    // Remove all animation classes
    el.classList.remove('flipping-in', 'flipping-out', 'anim-fade-out', 'anim-fade-in',
                        'anim-crossfade-out', 'anim-crossfade-in', 'anim-slide-out',
                        'anim-slide-in', 'anim-wipe-out', 'anim-wipe-in');
    // force reflow so re-adding class re-triggers animation
    void el.offsetWidth;
    el.classList.add(classes.out);
    await _wait(FLIP_HALF_MS);
    try { await midActionFn(); } catch (e) { console.warn('pageFlip mid action failed', e); }
    // Allow post-load callback to apply new rect before flip-in animation starts
    if (postLoadFn) {
      try { await postLoadFn(); } catch (e) { console.warn('pageFlip post-load failed', e); }
    }
    el.classList.remove(classes.out);
    void el.offsetWidth;
    el.classList.add(classes.in);
    await _wait(FLIP_HALF_MS);
    el.classList.remove(classes.in);
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

    // If stroke hasn't started but pointer came from a (color) button, start it
    // now — but only while the pointer is still pressed (mouse button held /
    // finger still down). e.buttons === 0 means the press was released before
    // the pointer reached the canvas, so we must NOT start drawing.
    if (!stroke && FP && FP.state && FP.state.pointerDownOnButton.has(e.pointerId)) {
      if (e.buttons > 0) {
        this._onDown(e);
        stroke = this.activeStrokes.get(e.pointerId);
      }
      FP.state.pointerDownOnButton.delete(e.pointerId);
      if (!stroke) return;
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
    // If a coloring page is loaded, clamp to the page bounds
    if (this._maxPaintingH !== null) {
      newH = Math.min(newH, this._maxPaintingH);
    }

    const oldH = this._paintingH;
    if (newH <= oldH) return;  // No expansion needed

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

  /**
   * Static helper: Generate a thumbnail from an image element.
   * Uses aspect-ratio-aware center alignment (fills square with overflow).
   */
  static generateThumbnailFromImage(image, size = 160) {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ox = out.getContext('2d');

    const imgW = image.naturalWidth;
    const imgH = image.naturalHeight;
    const pageAspectRatio = imgW / imgH;

    // Fill with white background
    ox.fillStyle = '#ffffff';
    ox.fillRect(0, 0, size, size);

    let srcX, srcY, srcW, srcH, destX, destY, destW, destH;

    if (pageAspectRatio >= 1) {
      // Landscape image: fit to height, overflow left/right → center horizontally
      srcH = imgH;
      srcW = Math.round(srcH * pageAspectRatio);
      srcY = 0;
      srcX = Math.max(0, (srcW - imgW) / 2);

      destH = size;
      destW = Math.round(size * pageAspectRatio);
      destY = (size - destH) / 2;
      destX = (size - destW) / 2;
    } else {
      // Portrait image: fit to width, overflow top/bottom → center vertically
      srcW = imgW;
      srcH = Math.round(srcW / pageAspectRatio);
      srcX = 0;
      srcY = Math.max(0, (srcH - imgH) / 2);

      destW = size;
      destH = Math.round(size / pageAspectRatio);
      destX = (size - destW) / 2;
      destY = (size - destH) / 2;
    }

    ox.drawImage(image, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
    return out.toDataURL('image/png');
  }
};

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

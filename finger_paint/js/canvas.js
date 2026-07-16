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
   explicit load operations (loadLayersFromColorAndDraw, setColoringPage).

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

const PAINTING_W      = 1000;  // canonical backing width (painting units)
const FLIP_HALF_MS    = 220;   // page-flip half-duration (must match CSS keyframes)
const OVERLAY_OPACITY = 0.5;   // semi-transparent outline overlay (when no custom _overlay.png)

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

    // Layer 1: solid color background
    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width  = PAINTING_W;
    this.bgCanvas.height = this._paintingH;
    this.bgCanvas.style.pointerEvents = 'none';
    this.bgCtx = this.bgCanvas.getContext('2d');
    this.paintingEl.appendChild(this.bgCanvas);

    // Layer 2: coloring-page outline (opaque, white→transparent)
    this.outlineCanvas = document.createElement('canvas');
    this.outlineCanvas.width  = PAINTING_W;
    this.outlineCanvas.height = this._paintingH;
    this.outlineCanvas.style.pointerEvents = 'none';
    this.outlineCtx = this.outlineCanvas.getContext('2d');
    this.paintingEl.appendChild(this.outlineCanvas);

    // Layer 3: user strokes (only layer that receives pointer events)
    this.drawCanvas = document.createElement('canvas');
    this.drawCanvas.width  = PAINTING_W;
    this.drawCanvas.height = this._paintingH;
    this.drawCtx = this.drawCanvas.getContext('2d');
    this.paintingEl.appendChild(this.drawCanvas);

    // Layer 4: outline overlay (semi-transparent, or custom _overlay.png at full opacity)
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.width  = PAINTING_W;
    this.overlayCanvas.height = this._paintingH;
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this.paintingEl.appendChild(this.overlayCanvas);

    // Cached processed outline bitmaps for re-blitting on resize.
    this._outlineBitmap = null;       // offscreen canvas, processed (white→transparent) outline
    this._overlayBitmap = null;       // offscreen canvas, custom overlay (or null → derive from outline)

    // Initial white paper
    this._currentBgColor = '#ffffff';
    this._rainbowScale   = null;   // brush size captured at rainbow-fill time
    this._fillBg(this._currentBgColor);
    // Wrap stays TRANSPARENT — the page bg color is painted onto bgCanvas
    // inside the painting element only, so it never extends past the page's
    // bounds. The body background (#f5f3ee) shows through the wrap's margin
    // around the page.
    this.wrapEl.style.background = 'transparent';

    // State
    this.activeStrokes = new Map();   // pointerId → { brush, state, opts }
    this.brush = FP.brushes.marker;
    this.color = 'crimson';
    this.size  = 12;                  // in painting units (1000-scale)
    this.dirtySinceLoad = false;      // true once a stroke touches; reset on save/clear/load
    this.onDirtyChange = null;        // callback for app to update Save↔Download button
    this.onStrokeEnd   = null;        // callback fires when the last active stroke ends

    // Coloring page dimensions (aspect ratio aware scaling)
    this._pageWidth  = null;          // natural page width in painting units (or null if no page)
    this._pageHeight = null;          // natural page height in painting units
    this._maxPaintingH = null;        // max height for canvas expansion when a page is loaded

    // Visual frame: grey background fill (indicates constrained drawing area when coloring page loaded)
    // Visual frame: border (always shown to frame the drawing area)
    this._frameBgEl = document.createElement('div');
    this._frameBgEl.className = 'canvas-frame-bg';
    this.wrapEl.appendChild(this._frameBgEl);
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
    this.bgCanvas.style.height      = cssH + 'px';
    this.outlineCanvas.style.height = cssH + 'px';
    this.drawCanvas.style.height    = cssH + 'px';
    this.overlayCanvas.style.height = cssH + 'px';

    // Canvas border hugs the PAINTING element (the actual drawing area),
    // not the outer wrap. For coloring pages in framed mode, this means
    // the border traces the page itself — the dead margins around it
    // (where no drawing happens) are not visually highlighted.
    this._frameBgEl.style.display = 'block';
    this._frameBgEl.style.left   = paintingElLeft + 'px';
    this._frameBgEl.style.top    = paintingElTop  + 'px';
    this._frameBgEl.style.width  = canvasWidth    + 'px';
    this._frameBgEl.style.height = canvasHeight   + 'px';
  }

  // ── Tool state ──────────────────────────────────────────────
  setBrush(brush) { this.brush = brush; }
  setColor(color) { this.color = color; }
  setSize(size)   { this.size  = size; }

  // ── Background ops ──────────────────────────────────────────
  /**
   * Fill the solid-color bg layer. When a coloring page is loaded, this
   * preserves the outline + overlay layers — only the solid color under
   * the outline changes.
   */
  fillBackground(color) {
    const hasPage = this._pageWidth !== null && this._pageHeight !== null;
    this._currentBgColor = color;
    // Capture the brush size at fill time so the band scale stays stable if
    // the canvas later expands (drawing taller than the viewport).
    if (FP.rainbow.isRainbow(color)) this._rainbowScale = this.size;
    if (!hasPage) {
      this._bgImageH = 0;                  // solid fill — no image-based extent
      this.setPageDimensions(null, null);  // clear page dimensions
    }
    this._fillBg(color);
  }

  getBgColor() { return this._currentBgColor; }
  getPageWidth()  { return this._pageWidth; }
  getPageHeight() { return this._pageHeight; }

  /**
   * Load a coloring page as a four-layer composition:
   *   • Layer 1 (bgCanvas):      solid bgColor (default white, or `bgColor` arg)
   *   • Layer 2 (outlineCanvas): processed image (white→transparent)
   *   • Layer 3 (drawCanvas):    cleared (caller may load strokes after)
   *   • Layer 4 (overlayCanvas): either custom `overlayImage` at full opacity,
   *                              or layer 2 redrawn at OVERLAY_OPACITY.
   *
   * @param {HTMLImageElement} image  the page outline source (raw or pre-processed)
   * @param {HTMLImageElement|null} overlayImage optional custom overlay
   * @param {string} bgColor          initial solid bg color (default white)
   */
  setColoringPage(image, overlayImage = null, bgColor = '#ffffff') {
    const imgH = Math.round(image.naturalHeight / image.naturalWidth * PAINTING_W);
    this._bgImageH = imgH;
    this.setPageDimensions(PAINTING_W, imgH);
    this._resizeCanvas(imgH);

    // Layer 1: solid bg
    this._currentBgColor = bgColor;
    this._fillBg(bgColor);

    // Layer 2: outline (cache processed bitmap, then blit)
    this._outlineBitmap = this._processOutlineImage(image, imgH);
    this._blitOutline();

    // Layer 4: overlay
    if (overlayImage) {
      const ovH = Math.round(overlayImage.naturalHeight / overlayImage.naturalWidth * PAINTING_W);
      const off = document.createElement('canvas');
      off.width  = PAINTING_W;
      off.height = ovH;
      off.getContext('2d').drawImage(overlayImage, 0, 0, PAINTING_W, ovH);
      this._overlayBitmap = off;
    } else {
      this._overlayBitmap = null;          // null → derive from outline at OVERLAY_OPACITY
    }
    this._blitOverlay();
    // Wrap stays transparent — see constructor; the page bg color lives only
    // inside the painting element so it never extends past the page itself.
  }

  /** Legacy: bake an image into bgCanvas (used by uploaded-image and saved-drawing flows). */
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

    // Legacy path doesn't use outline/overlay layers — make sure they're clear.
    this._outlineBitmap = null;
    this._overlayBitmap = null;
    this._blitOutline();
    this._blitOverlay();
    // Wrap bg unchanged — see constructor. The image lives on bgCanvas.
  }

  /**
   * Process a coloring-page image into a black-on-transparent bitmap.
   * Algorithm: alpha = (255 - luma) * origAlpha / 255; RGB forced to black.
   *   • Pure black (luma 0)   → fully opaque (anti-aliased lines stay crisp).
   *   • Pure white (luma 255) → fully transparent (paper disappears).
   *   • Grey (luma 160)       → semi-transparent BLACK on bg color (not grey).
   * Colored line art is flattened to a black mask — colored outlines are an
   * authoring concern best handled by supplying a custom `<base>_overlay.png`.
   * Idempotent on already-processed PNGs (build-time output has rgb=0 already).
   */
  _processOutlineImage(image, imgH) {
    const off = document.createElement('canvas');
    off.width  = PAINTING_W;
    off.height = imgH;
    const octx = off.getContext('2d');
    octx.drawImage(image, 0, 0, PAINTING_W, imgH);
    try {
      const id = octx.getImageData(0, 0, PAINTING_W, imgH);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i]     = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = Math.round((255 - luma) * d[i + 3] / 255);
      }
      octx.putImageData(id, 0, 0);
    } catch (_) {
      // Tainted canvas — leave bitmap unprocessed (will still render as full image).
    }
    return off;
  }

  /** Redraw layer 2 from the cached outline bitmap. */
  _blitOutline() {
    this.outlineCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
    if (this._outlineBitmap) {
      this.outlineCtx.drawImage(this._outlineBitmap, 0, 0);
    }
  }

  /** Redraw layer 4: custom overlay at full opacity, or outline at OVERLAY_OPACITY. */
  _blitOverlay() {
    this.overlayCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
    if (this._overlayBitmap) {
      this.overlayCtx.drawImage(this._overlayBitmap, 0, 0);
    } else if (this._outlineBitmap) {
      this.overlayCtx.save();
      this.overlayCtx.globalAlpha = OVERLAY_OPACITY;
      this.overlayCtx.drawImage(this._outlineBitmap, 0, 0);
      this.overlayCtx.restore();
    }
  }

  /**
   * v3 saved-drawing load. Fills the bg with a solid color and applies the
   * transparent draw layer on top. No outline/overlay (saved drawings don't
   * carry coloring-page outlines — those were folded into the draw layer
   * at save time per toDrawingDataURL).
   *
   * `drawUrl` may be null/falsy (bg-only entry).
   */
  loadLayersFromColorAndDraw(bgColor, drawUrl) {
    const loadOne = (src) => new Promise((resolve, reject) => {
      if (!src) { resolve(null); return; }
      const im = new Image();
      im.onload  = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
    return loadOne(drawUrl).then((drawImg) => {
      const drawH  = drawImg
        ? Math.round(drawImg.naturalHeight / drawImg.naturalWidth * PAINTING_W)
        : 0;
      const targetH = Math.max(drawH, PAINTING_W);
      this._bgImageH = 0;
      this._currentBgColor = bgColor;
      this.setPageDimensions(null, null);
      this._resizeCanvas(targetH);

      // Bg: solid fill.
      this._fillBg(bgColor);

      // Outline/overlay: empty for saved drawings.
      this._outlineBitmap = null;
      this._overlayBitmap = null;
      this._blitOutline();
      this._blitOverlay();

      // Drawing layer: load transparent strokes on top.
      this.drawCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
      if (drawImg) {
        this.drawCtx.drawImage(drawImg, 0, 0, PAINTING_W, drawH);
      }
      // Wrap bg unchanged — see constructor. bg color lives on bgCanvas only.
      this._setDirty(false);
    });
  }

  // ── Drawing ops ─────────────────────────────────────────────
  clearDrawing() {
    this.drawCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
    this._setDirty(false);
  }

  /** Load a transparent strokes PNG onto the draw layer (used by coloring-page autosave restore). */
  setDrawingFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      if (!dataUrl) { this.clearDrawing(); resolve(); return; }
      const im = new Image();
      im.onload = () => {
        const h = Math.round(im.naturalHeight / im.naturalWidth * PAINTING_W);
        this.drawCtx.clearRect(0, 0, PAINTING_W, this._paintingH);
        this.drawCtx.drawImage(im, 0, 0, PAINTING_W, h);
        this._setDirty(false);
        resolve();
      };
      im.onerror = reject;
      im.src = dataUrl;
    });
  }

  /** Full reset — bg white + empty drawing + cleared outline/overlay. */
  reset() {
    this._currentBgColor = '#ffffff';
    this._bgImageH = 0;
    this.setPageDimensions(null, null);  // clear page dimensions
    this._fillBg('#ffffff');
    // Wrap bg stays transparent (set once in constructor).
    this._outlineBitmap = null;
    this._overlayBitmap = null;
    this._blitOutline();
    this._blitOverlay();
    this.clearDrawing();
  }

  /** Call after saving — resets dirty so next stroke will re-trigger onDirtyChange. */
  markSaved() {
    this._setDirty(false);
  }

  // ── Output ──────────────────────────────────────────────────
  /**
   * Saved-drawings strip uses a flattened "bg" entry — for coloring pages this
   * is bg + outline so reloading via the legacy path still shows the outline.
   */
  toBackgroundDataURL() {
    const saveH = this._computeSaveHeight();
    const out = document.createElement('canvas');
    out.width  = PAINTING_W;
    out.height = saveH;
    const ox = out.getContext('2d');
    ox.drawImage(this.bgCanvas, 0, 0);
    if (this._outlineBitmap) ox.drawImage(this.outlineCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /**
   * Drawing layer for saved entries. When a coloring page is loaded we also
   * fold the overlay in here so saved drawings still show the top-most lines.
   */
  toDrawingDataURL() {
    const saveH = this._computeSaveHeight();
    const out = document.createElement('canvas');
    out.width  = PAINTING_W;
    out.height = saveH;
    const ox = out.getContext('2d');
    ox.drawImage(this.drawCanvas, 0, 0);
    if (this._overlayBitmap || this._outlineBitmap) ox.drawImage(this.overlayCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /** Drawing strokes only — for coloring-page autosave (outline rebuilt from pageId). */
  toStrokesOnlyDataURL() {
    const saveH = this._computeSaveHeight();
    const out = document.createElement('canvas');
    out.width  = PAINTING_W;
    out.height = saveH;
    out.getContext('2d').drawImage(this.drawCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /** All four layers flattened, cropped to content extent. */
  toCompositeDataURL() {
    const saveH = this._computeSaveHeight();
    const out = document.createElement('canvas');
    out.width  = PAINTING_W;
    out.height = saveH;
    const ox = out.getContext('2d');
    ox.drawImage(this.bgCanvas,      0, 0);
    ox.drawImage(this.outlineCanvas, 0, 0);
    ox.drawImage(this.drawCanvas,    0, 0);
    ox.drawImage(this.overlayCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /**
   * Transparent thumbnail — no bg fill. Used by the page picker's 3-layer
   * compositing (Layer 1 = bgColor or preview color; Layer 3 = this image).
   *
   * For coloring pages: composites outline + draw + overlay (no solid bg).
   * For non-coloring states (blank canvas or saved drawings): just the draw
   * layer (the outline/overlay canvases are empty in that state).
   */
  toTransparentThumbnailDataURL(size = 160) {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ox = out.getContext('2d');

    if (this._pageWidth !== null && this._pageHeight !== null) {
      const pageAspectRatio = this._pageWidth / this._pageHeight;
      const srcW = PAINTING_W;
      const srcH = this._pageHeight;
      let destX, destY, destW, destH;
      if (pageAspectRatio >= 1) {
        destH = size;
        destW = Math.round(size * pageAspectRatio);
        destY = 0;
        destX = (size - destW) / 2;
      } else {
        destW = size;
        destH = Math.round(size / pageAspectRatio);
        destX = 0;
        destY = (size - destH) / 2;
      }
      ox.drawImage(this.outlineCanvas, 0, 0, srcW, srcH, destX, destY, destW, destH);
      ox.drawImage(this.drawCanvas,    0, 0, srcW, srcH, destX, destY, destW, destH);
      ox.drawImage(this.overlayCanvas, 0, 0, srcW, srcH, destX, destY, destW, destH);
    } else {
      ox.drawImage(this.drawCanvas, 0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
    }
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

      // Draw the page content centered (all four layers)
      ox.drawImage(this.bgCanvas,      srcX, srcY, srcW, srcH, destX, destY, destW, destH);
      ox.drawImage(this.outlineCanvas, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
      ox.drawImage(this.drawCanvas,    srcX, srcY, srcW, srcH, destX, destY, destW, destH);
      ox.drawImage(this.overlayCanvas, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
    } else {
      // Blank canvas: use the standard square capture (zoom-to-fill top-left)
      ox.drawImage(this.bgCanvas,      0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
      ox.drawImage(this.outlineCanvas, 0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
      ox.drawImage(this.drawCanvas,    0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
      ox.drawImage(this.overlayCanvas, 0, 0, PAINTING_W, PAINTING_W, 0, 0, size, size);
    }

    return out.toDataURL('image/png');
  }

  // ── Page-flip animation ─────────────────────────────────────
  /** Cancel all active strokes immediately (for interrupt cases like clear mid-draw). */
  _cancelActiveStrokes() {
    for (const [pointerId, stroke] of this.activeStrokes) {
      const pt = { x: 0, y: 0 };
      stroke.brush.endStroke(this.drawCtx, stroke.state, pt, stroke.opts);
      try { this.drawCanvas.releasePointerCapture(pointerId); } catch (_) {}
    }
    this.activeStrokes.clear();
  }

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
    this._cancelActiveStrokes();
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
    // Rainbow paint: the color isn't fixed — it advances through the spectrum
    // as the finger travels. We seed the first segment's hue here and track a
    // per-stroke distance accumulator (rbDist) so _onMove can re-colour each
    // segment. Brushes stay colour-agnostic; they just read opts.color.
    const rainbow = FP.rainbow.isRainbow(this.color);
    if (rainbow) opts.color = FP.rainbow.strokeColor(0, this.size);
    const state = this.brush.beginStroke(this.drawCtx, pt, opts);
    this.activeStrokes.set(e.pointerId, {
      brush: this.brush, state, opts,
      rainbow, rbDist: 0, rbLast: { x: pt.x, y: pt.y }, rbSize: this.size,
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
      if (stroke.rainbow) {
        // Advance the hue by how far this segment moved, then hand the brush
        // the current colour. Each brush reads opts.color fresh per segment.
        stroke.rbDist += Math.hypot(pt.x - stroke.rbLast.x, pt.y - stroke.rbLast.y);
        stroke.rbLast.x = pt.x;
        stroke.rbLast.y = pt.y;
        stroke.opts.color = FP.rainbow.strokeColor(stroke.rbDist, stroke.rbSize);
      }
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

    // Notify app.js that a stroke just completed — used to re-trigger the
    // current-work autosave debounce so every finished stroke gets a write
    // attempt (not just the first one in a session, which is the only one
    // that flips dirtySinceLoad from false -> true).
    if (this.activeStrokes.size === 0 && this.onStrokeEnd) {
      this.onStrokeEnd();
    }
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
    if (FP.rainbow.isRainbow(color)) {
      // Rainbow background — bands scaled by the brush size captured at fill
      // time (falling back to the live size, e.g. when a saved 'rainbow' bg
      // is reloaded and no scale was stored).
      const period = FP.rainbow.fillPeriod(this._rainbowScale || this.size);
      FP.rainbow.paintFill(this.bgCtx, PAINTING_W, this._paintingH, period);
      return;
    }
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

    this._paintingH           = newH;
    this.bgCanvas.height      = newH;
    this.outlineCanvas.height = newH;
    this.drawCanvas.height    = newH;
    this.overlayCanvas.height = newH;

    this.bgCtx.drawImage(snapBg,    0, 0);
    this.drawCtx.drawImage(snapDraw, 0, 0);

    // Fill the new area below old content with current bg color. A rainbow
    // fill can't be extended with a flat fillRect, so repaint the whole bg
    // (cheap) — the band scale is preserved via _rainbowScale.
    if (FP.rainbow.isRainbow(this._currentBgColor)) {
      this._fillBg(this._currentBgColor);
    } else {
      this.bgCtx.save();
      this.bgCtx.fillStyle = this._currentBgColor;
      this.bgCtx.fillRect(0, oldH, PAINTING_W, newH - oldH);
      this.bgCtx.restore();
    }

    // Outline + overlay are derived from cached bitmaps — re-blit cleanly.
    this._blitOutline();
    this._blitOverlay();
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
      this._paintingH           = targetH;
      this.bgCanvas.height      = targetH;
      this.outlineCanvas.height = targetH;
      this.drawCanvas.height    = targetH;
      this.overlayCanvas.height = targetH;
      // Outline + overlay are derived — re-blit cleanly.
      this._blitOutline();
      this._blitOverlay();
    }
    // Refresh CSS height on the canvas elements
    const cssW = parseFloat(this.bgCanvas.style.width) || this.bgCanvas.offsetWidth;
    if (cssW > 0) {
      const cssH = cssW * this._paintingH / PAINTING_W;
      this.bgCanvas.style.height      = cssH + 'px';
      this.outlineCanvas.style.height = cssH + 'px';
      this.drawCanvas.style.height    = cssH + 'px';
      this.overlayCanvas.style.height = cssH + 'px';
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

  /**
   * Static helper: transparent thumbnail from a coloring-page image. Applies
   * the same luma→alpha + RGB→black processing as _processOutlineImage, then
   * scales to the target size with aspect-ratio-aware center alignment. Used
   * by the page picker's Layer 3 when no autosave thumb exists yet.
   * Idempotent on already-processed page PNGs.
   */
  static generateTransparentThumbnailFromImage(image, size = 160) {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ox = out.getContext('2d');
    const imgW = image.naturalWidth;
    const imgH = image.naturalHeight;
    const ar = imgW / imgH;
    let srcX, srcY, srcW, srcH, destX, destY, destW, destH;
    if (ar >= 1) {
      srcH = imgH;
      srcW = Math.round(srcH * ar);
      srcY = 0;
      srcX = Math.max(0, (srcW - imgW) / 2);
      destH = size;
      destW = Math.round(size * ar);
      destY = (size - destH) / 2;
      destX = (size - destW) / 2;
    } else {
      srcW = imgW;
      srcH = Math.round(srcW / ar);
      srcX = 0;
      srcY = Math.max(0, (srcH - imgH) / 2);
      destW = size;
      destH = Math.round(size / ar);
      destX = (size - destW) / 2;
      destY = (size - destH) / 2;
    }
    ox.drawImage(image, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
    try {
      const id = ox.getImageData(0, 0, size, size);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i]     = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = Math.round((255 - luma) * d[i + 3] / 255);
      }
      ox.putImageData(id, 0, 0);
    } catch (_) {
      // Tainted canvas — return as-is (still useful at lower fidelity).
    }
    return out.toDataURL('image/png');
  }
};

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

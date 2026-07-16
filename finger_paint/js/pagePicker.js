/* ────────────────────────────────────────────────────────────
   pagePicker.js — modal grid that opens when a bookshelf book
   is tapped. Each tile is a page (coloring page, saved drawing,
   or the blank-page tile).

   Storage:
     - All UI state lives in this module (open flag, current
       book id, grid-page scroll offset, preview bg color).
     - Pages list comes from FP.coloringBook.switchBook(bookId)
       (live for the saved book; cached for coloring books).
     - Rendering is driven by app.js calling FP.pagePicker.render()
       inside its renderAll(); this module owns DOM construction
       under a single root element appended to #app on open.

   Layout:
     - Backdrop (.page-picker-backdrop) covers the full window at
       z-index 3 (below regular .btn, above canvas + frame border).
     - Grid (.page-picker-grid) is positioned inside layout.canvas
       and fills it with B × B tiles separated by G px.
     - The drawing-tools bar (rightmost column landscape / top row
       portrait) is replaced contextually by prev / X-of-Y / next
       buttons while the picker is open (rendered by app.js, not
       this module — see _renderPickerChrome in app.js).

   Tile model:
     - Saved-drawing tile: shows the entry's existing thumb image.
       Non-Crayon mode adds a × delete badge in the top-right.
     - Coloring-page tile: shows the autosaved thumb if any,
       otherwise generates a thumb from the page image.
     - Blank-page tile: solid white square.
     - Active page (currently loaded) gets the .btn.active blue
       outline.

   Color preview (Stage 4):
     - state.pickerPreviewBgColor lives here; setting it re-tints
       tiles via Layer 2 of the 3-layer compositing.
     - Cleared on close-without-select, book switch, and every
       open() call.
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

FP.pagePicker = (function () {
  let _open         = false;
  let _bookId       = null;
  let _scrollOffset = 0;          // grid-page index (which screen-full of pages)
  let _previewBgColor = null;     // Stage 4 — color-swatch preview override
  let _rootEl       = null;       // backdrop + grid container, appended to #app on open

  // Callbacks injected by app.js so this module stays decoupled.
  let _hooks = {
    onClose:            () => {},
    onTileTap:          (_page) => {},
    onDeleteSavedTile:  (_entry) => {},
    getCurrentLoadedId: () => null,
  };

  function init(hooks) {
    _hooks = Object.assign(_hooks, hooks || {});
  }

  function isOpen()         { return _open; }
  function getBookId()      { return _bookId; }
  function getScrollOffset(){ return _scrollOffset; }
  function setScrollOffset(o) {
    _scrollOffset = Math.max(0, o | 0);
  }
  function getPreviewBgColor() { return _previewBgColor; }
  function setPreviewBgColor(c) { _previewBgColor = c; }

  function open(bookId) {
    _open           = true;
    _bookId         = bookId;
    _scrollOffset   = 0;
    _previewBgColor = null;
    FP.playSound && FP.playSound('dialogOpen');
  }

  function close() {
    if (!_open) return;
    _open           = false;
    _bookId         = null;
    _scrollOffset   = 0;
    _previewBgColor = null;
    _hooks.onClose();
  }

  /**
   * Render the picker into the DOM. Called by app.js renderAll() AFTER it
   * clears its buttonLayer.
   *
   * The PICKER ROOT (backdrop + panel) is kept across renders once the
   * picker is open, so the CSS fade-in animation only fires on the very
   * first render after open() — not on every button tap. Only the inner
   * GRID is rebuilt each render (since tile state changes when preview
   * color changes, when the active tile changes, etc.).
   *
   * @param {HTMLElement} appRoot   the #app element
   * @param {Object} layout         the layout from FP.computeLayout
   * @param {Array}  pages          the book's pages (already includes blank tile
   *                                for the saved book; coloring books pass their pages)
   */
  function render(appRoot, layout, pages) {
    if (!_open) {
      // Picker closed — tear down everything.
      if (_rootEl && _rootEl.parentNode) _rootEl.parentNode.removeChild(_rootEl);
      _rootEl = null;
      return;
    }

    // First render after open: build the persistent root (backdrop + panel).
    if (!_rootEl || !_rootEl.isConnected) {
      _rootEl = document.createElement('div');
      _rootEl.className = 'page-picker';

      const backdrop = document.createElement('div');
      backdrop.className = 'page-picker-backdrop';
      backdrop.addEventListener('pointerdown', (e) => {
        // Only close if the tap landed on the backdrop itself (not a tile,
        // not the panel — the panel is the next child up and is purely
        // decorative; its pointerdown also bubbles here).
        if (e.target === backdrop) {
          e.preventDefault();
          e.stopPropagation();
          closeWithoutSelection();
        }
      });
      _rootEl.appendChild(backdrop);

      // Decorative panel around the grid (Stage 4 polish: visually
      // distinguishes the picker area from the bookshelf below).
      const panel = document.createElement('div');
      panel.className = 'page-picker-panel';
      _rootEl.appendChild(panel);

      appRoot.appendChild(_rootEl);
    }

    // Position the panel to wrap the grid with G/2 padding. Use exact slot
    // positions (pickerSlotXY) so panel edges line up with the tile grid
    // without float drift from pickerGridRect's width/height arithmetic.
    const panel = _rootEl.querySelector('.page-picker-panel');
    if (panel) {
      const B = layout.B;
      const halfG = layout.G / 2;
      const first = layout.pickerSlotXY(0, 0);
      const last  = layout.pickerSlotXY(
        layout.pickerGridCols - 1,
        layout.pickerGridRows - 1);
      Object.assign(panel.style, {
        left:   (first.x - halfG) + 'px',
        top:    (first.y - halfG) + 'px',
        width:  (last.x + B + halfG - (first.x - halfG)) + 'px',
        height: (last.y + B + halfG - (first.y - halfG)) + 'px',
      });
    }

    // Replace the grid every render — tile state may have changed.
    const oldGrid = _rootEl.querySelector('.page-picker-grid');
    if (oldGrid) oldGrid.remove();
    const grid = _buildGrid(layout, pages);
    _rootEl.appendChild(grid);
  }

  function closeWithoutSelection() {
    close();
    // app.js owns the re-render trigger via the onClose hook.
  }

  /**
   * Build the grid container with the visible page tiles for the current
   * grid-page (_scrollOffset). Pagination math: as many tiles as fit in
   * layout.canvas, B per axis with G gaps; user scrolls through grid-pages
   * via the contextual chrome buttons.
   */
  function _buildGrid(layout, pages) {
    const grid = document.createElement('div');
    grid.className = 'page-picker-grid';
    // The grid is a wrapper for stacking-order purposes. Tile positions
    // come straight from layout.pickerSlotXY (absolute window coords) so
    // they share the SAME coordinate space as the rest of the button grid
    // — no float drift from compounding (col * (B + G)) locally.
    Object.assign(grid.style, { left: '0', top: '0', width: '100%', height: '100%' });

    const B = layout.B;
    const cols = layout.pickerGridCols;
    const rows = layout.pickerGridRows;
    const perGridPage = cols * rows;
    const totalGridPages = Math.max(1, Math.ceil(pages.length / perGridPage));
    if (_scrollOffset >= totalGridPages) _scrollOffset = totalGridPages - 1;

    const start = _scrollOffset * perGridPage;
    const end   = Math.min(start + perGridPage, pages.length);
    const isCrayon = !!(window.FP_VARIANT && window.FP_VARIANT.clearOnly);
    const loadedId = _hooks.getCurrentLoadedId();

    for (let i = start; i < end; i++) {
      const page = pages[i];
      const j = i - start;
      const row = Math.floor(j / cols);
      const col = j % cols;
      const { x, y } = layout.pickerSlotXY(col, row);
      const tile = _buildTile(page, x, y, B, loadedId, isCrayon);
      grid.appendChild(tile);
    }
    return grid;
  }

  function _buildTile(page, x, y, B, loadedId, isCrayon) {
    const btn = document.createElement('button');
    btn.className = 'btn thumb';
    if (page.id === loadedId) btn.classList.add('active');
    Object.assign(btn.style, {
      position: 'absolute',
      left:   x + 'px',
      top:    y + 'px',
      width:  B + 'px',
      height: B + 'px',
      borderRadius: Math.max(4, B * 0.12) + 'px',
      pointerEvents: 'auto',
    });
    btn.setAttribute('aria-label', page.name || page.id);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _hooks.onTileTap(page);
    });

    // 3-layer tile model:
    //   Layer 1 (CSS background-color): preview color if set, else the
    //     saved/autosaved bgColor. Blank tile defaults to white.
    //   Layer 3 (transparent <img>): content thumbnail with no bg baked
    //     in — saved drawing strokes, or coloring-page outline+strokes,
    //     or empty for the blank-page tile.
    let bgColor;
    if (page.isBlank) {
      bgColor = '#ffffff';
    } else if (page.isSavedDrawing) {
      bgColor = (page.entry && page.entry.bgColor) || '#ffffff';
    } else {
      const autosave = FP.coloringBook.getAutosave(page.id);
      bgColor = (autosave && autosave.bgColor) || '#ffffff';
    }
    if (_previewBgColor) bgColor = _previewBgColor;
    if (FP.rainbow && FP.rainbow.isRainbow(bgColor)) {
      btn.style.background = FP.rainbow.cssGradient();
    } else {
      btn.style.backgroundColor = bgColor;
    }

    if (page.isBlank) {
      // Bg color is the entire tile.
    } else if (page.isSavedDrawing) {
      const entry = page.entry;
      const src = entry.thumb || entry.png;     // v1 fallback (png is opaque)
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        btn.appendChild(img);
      }
    } else {
      // Coloring page — autosaved thumb (now transparent post-Stage 4) if any,
      // else generate transparent outline thumb from the page image.
      const autosave = FP.coloringBook.getAutosave(page.id);
      if (autosave && autosave.thumb) {
        const img = document.createElement('img');
        img.src = autosave.thumb;
        img.alt = '';
        btn.appendChild(img);
      } else {
        FP.coloringBook.loadImage(page).then((image) => {
          const dataUrl = FP.PaintingCanvas.generateTransparentThumbnailFromImage(image, 160);
          const img = document.createElement('img');
          img.src = dataUrl;
          img.alt = '';
          if (btn.parentNode) btn.appendChild(img);
        }).catch(() => { /* tainted / 404 — leave blank */ });
      }
    }

    // Saved-drawing tiles get a × delete badge (non-Crayon only).
    if (page.isSavedDrawing && !isCrayon) {
      const badge = _buildDeleteBadge(page, B);
      btn.appendChild(badge);
    }

    return btn;
  }

  function _buildDeleteBadge(page, B) {
    const badgeSize = Math.max(20, Math.round(B * 0.3));
    const badge = document.createElement('button');
    badge.className = 'page-tile-delete';
    badge.setAttribute('aria-label', 'Delete this saved drawing');
    Object.assign(badge.style, {
      width:  badgeSize + 'px',
      height: badgeSize + 'px',
      top:    '4px',
      right:  '4px',
    });
    badge.innerHTML = FP.icon('clear', Math.round(badgeSize * 0.55));
    badge.addEventListener('contextmenu', (e) => e.preventDefault());
    badge.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();   // don't load the tile
      _hooks.onDeleteSavedTile(page.entry);
    });
    return badge;
  }

  /** Total grid-page count for the current book (used by chrome for X/Y indicator). */
  function getGridPageCount(layout, pages) {
    if (!pages || pages.length === 0) return 1;
    const perGridPage = layout.pickerGridCols * layout.pickerGridRows;
    return Math.max(1, Math.ceil(pages.length / perGridPage));
  }

  return {
    init,
    open, close, closeWithoutSelection,
    isOpen, getBookId,
    getScrollOffset, setScrollOffset,
    getPreviewBgColor, setPreviewBgColor,
    render, getGridPageCount,
  };
})();

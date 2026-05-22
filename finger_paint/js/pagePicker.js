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
   * Render the backdrop + grid into the DOM. Called by app.js renderAll()
   * AFTER it clears its panelLayer / buttonLayer. The picker manages its
   * own root element; we tear it down and rebuild each frame to stay
   * consistent with the rest of the app's render model.
   *
   * @param {HTMLElement} appRoot   the #app element
   * @param {Object} layout         the layout from FP.computeLayout
   * @param {Array}  pages          the book's pages (already includes blank tile
   *                                for the saved book; coloring books pass their pages)
   */
  function render(appRoot, layout, pages) {
    // Always remove any prior root — even if not open — to avoid stale DOM.
    if (_rootEl && _rootEl.parentNode) _rootEl.parentNode.removeChild(_rootEl);
    _rootEl = null;
    if (!_open) return;

    _rootEl = document.createElement('div');
    _rootEl.className = 'page-picker';
    appRoot.appendChild(_rootEl);

    // Backdrop: catches pointerdown to close-on-empty-space.
    const backdrop = document.createElement('div');
    backdrop.className = 'page-picker-backdrop';
    backdrop.addEventListener('pointerdown', (e) => {
      // Only close if the tap landed on the backdrop itself (not a tile).
      if (e.target === backdrop) {
        e.preventDefault();
        e.stopPropagation();
        closeWithoutSelection();
      }
    });
    _rootEl.appendChild(backdrop);

    // Grid: fills layout.canvas with B × B tiles.
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
    // pickerGridRect is aligned with the button grid (rowY/colX) so tiles
    // line up with the color column / tool column / bookshelf row. It
    // explicitly EXCLUDES the bookshelf row so the bookshelf stays
    // accessible underneath the picker.
    const c = layout.pickerGridRect || layout.canvas;
    Object.assign(grid.style, {
      left:   c.left   + 'px',
      top:    c.top    + 'px',
      width:  c.width  + 'px',
      height: c.height + 'px',
    });

    const G = layout.G;
    const B = layout.B;
    const cols = Math.max(1, Math.floor((c.width  + G) / (B + G)));
    const rows = Math.max(1, Math.floor((c.height + G) / (B + G)));
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
      const x = col * (B + G);
      const y = row * (B + G);
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

    // Tile content — see comment block at top of file for the layered model.
    // Stage 3 keeps this simple: use the entry's existing thumb directly.
    // Stage 4 will split this into 3 layers (saved bg, preview overlay,
    // transparent content) to support the color-swatch preview.
    if (page.isBlank) {
      // Blank-page tile: just a white square. .btn already has white bg.
      // Nothing to append.
    } else if (page.isSavedDrawing) {
      const entry = page.entry;
      const img = document.createElement('img');
      img.src = entry.thumb || entry.png;
      img.alt = '';
      btn.appendChild(img);
    } else {
      // Coloring page — prefer autosaved thumb (shows user's painted state)
      // else generate a smooth thumb from the page image.
      const autosave = FP.coloringBook.getAutosave(page.id);
      if (autosave && autosave.thumb) {
        const img = document.createElement('img');
        img.src = autosave.thumb;
        img.alt = '';
        btn.appendChild(img);
      } else {
        FP.coloringBook.loadImage(page).then((image) => {
          const dataUrl = FP.PaintingCanvas.generateThumbnailFromImage(image, 160);
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
    const G = layout.G, B = layout.B;
    const c = layout.pickerGridRect || layout.canvas;
    const cols = Math.max(1, Math.floor((c.width  + G) / (B + G)));
    const rows = Math.max(1, Math.floor((c.height + G) / (B + G)));
    const perGridPage = cols * rows;
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

/* ────────────────────────────────────────────────────────────
   app.js — main application orchestration.

   Responsibilities:
     • Hold app state (active brush/color/size, saved list, scroll offset, etc.)
     • Render the toolbar buttons absolutely-positioned according to layout.js
     • Wire button taps to canvas / storage / dialog actions
     • Page-flip animation hooks for clear / load
   ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.FP = window.FP || {};
  const CFG = window.FP_VARIANT || {};

  // ── Default palette (configurable later) ──────────────────────
  const DEFAULT_PALETTE = [
    'crimson',     'violet',
    'darkorange',  'saddlebrown',
    'yellow',      'wheat',
    'forestgreen', 'yellowgreen',
    'blue',        'darkturquoise',
    'blueviolet',  'indigo',
    '#444444',     '#bbbbbb',
    '#111111',     '#f5f5f5',
  ];

  const LIGHT_COLORS = new Set([
    'yellow', 'wheat', '#f5f5f5', '#bbbbbb', 'yellowgreen',
  ]);

  // ── Page flip animation style (configurable) ──────────────────
  // Options: 'flip' (default), 'fade', 'crossfade', 'slide', 'wipe'
  const PAGE_FLIP_ANIMATION = CFG.pageFlipAnimation || 'flip';

  // ── Brush size scale (painting units, 1000-scale) ─────────────
  const SIZE_LEVELS = [4, 6, 9, 13, 18, 24, 32, 42, 56, 72];
  const DEFAULT_SIZE_IDX = 3;  // size 13

  const DEFAULT_BG_COLOR = '#ffffff';  // white
  const DEFAULT_COLOR_IDX = 14;  // black (#111111)

  // ── State ─────────────────────────────────────────────────────
  const state = {
    palette:        DEFAULT_PALETTE.slice(),
    activeColorIdx: DEFAULT_COLOR_IDX,        // black
    activeBrushId:  CFG.activeBrushId || 'marker',
    sizeIdx:        DEFAULT_SIZE_IDX,
    saved:          [],                       // from storage, most-recent first
    loadedDrawingId: null,                    // currently loaded saved drawing (id) — flipped to null on any change
    loadedDrawingEntry: null,                 // the full saved-drawing entry (bg/draw/thumb) — used to recompose for download
    savedJustNow:   false,                    // toggled true after Save; false on any change
    frameMode:      CFG.frameMode !== undefined ? CFG.frameMode : true,  // true = Frame Mode (drawing inside toolbars), false = Expanded Mode (buttons hover)
    isFullscreen:   false,                    // actual fullscreen via F11/Ctrl+F
    disabledButtons: new Set(),               // button IDs to disable (e.g., 'upload', 'download' in fullscreen)
    pointerDownOnButton: new Set(),           // tracks pointerIds that had pointerdown on buttons (for tap-drag to canvas)

    // Bookshelf / coloring-book state
    coloringBookOpen:        false,           // true when the bookshelf overlay is open
    currentColoringPageId:   null,            // page currently loaded on canvas (if any)
    currentBookId:           null,            // currently selected book (defaults to '__saved')
    coloringBooks:           [],              // discovered books (from FP.coloringBook.getBooks())
    coloringScrollOffset:    0,               // bookshelf overlay scroll position (in items)
    coloringConfirmReloadId: null,            // page whose tile shows the reload-confirm (Stage 4 will remove this)
    coloringPages:           [],              // pages of the currently-opened book (used by Stage 3's picker)
  };

  // Expose state so canvas.js (and any other FP module) can read pointerDownOnButton
  FP.state = state;

  // Rendered references
  let canvasComp = null;       // FP.PaintingCanvas instance
  let appRoot    = null;
  let buttonLayer = null;      // div holding all toolbar buttons
  let panelLayer  = null;      // div holding panel-bg elements
  let lastLayout  = null;

  // ── Fullscreen ────────────────────────────────────────────────
  function isBrowserFullscreen() {
    // Browser fullscreen (F11): window dimensions match screen dimensions (within 1 pixel tolerance)
    return Math.abs(window.innerWidth - screen.width) < 2 &&
           Math.abs(window.innerHeight - screen.height) < 2;
  }

  function showFullscreenHint() {
    // Remove any existing hint
    const existing = document.querySelector('.fullscreen-hint');
    if (existing) existing.remove();

    // Create hint element
    const hint = document.createElement('div');
    hint.className = 'fullscreen-hint';
    hint.innerHTML = 'To exit full screen, press <kbd>F11</kbd> or press and hold <kbd>Esc</kbd>';
    document.body.appendChild(hint);

    // Remove after 3 seconds
    setTimeout(() => {
      hint.classList.add('fade-out');
      setTimeout(() => hint.remove(), 300);
    }, 3000);
  }

  function toggleFullscreen() {
    const inApiFullscreen = !!document.fullscreenElement;
    const inBrowserFullscreen = isBrowserFullscreen();

    console.log('[toggleFullscreen] inApiFullscreen:', inApiFullscreen, 'inBrowserFullscreen:', inBrowserFullscreen);

    if (inApiFullscreen) {
      // Exit API fullscreen
      console.log('[toggleFullscreen] Exiting API fullscreen');
      document.exitFullscreen();
    } else if (inBrowserFullscreen) {
      // In browser fullscreen (F11) but not API fullscreen
      // Show hint message since we can't exit programmatically
      console.log('[toggleFullscreen] In browser fullscreen only - showing hint');
      showFullscreenHint();
    } else {
      // Not in any fullscreen, enter API fullscreen
      console.log('[toggleFullscreen] Not in fullscreen - entering API fullscreen');
      appRoot.requestFullscreen().catch(err => {
        console.error('Fullscreen request failed:', err);
      });
    }
  }

  function disableBtn(id) {
    state.disabledButtons.add(id);
  }

  function enableBtn(id) {
    state.disabledButtons.delete(id);
  }

  // ── Boot ──────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // Handle ?deletealldrawings=true BEFORE opening any IDB connections.
    // deleteDatabase blocks until all open connections to that DB are closed,
    // so if we opened storage/coloringBook here first the request would hang
    // forever and init() would stall mid-await with a blank canvas on screen.
    const params = new URLSearchParams(window.location.search);
    if (params.get('deletealldrawings') === 'true') {
      try { await _deleteAllDrawings(); }
      catch (err) { console.error('Failed to delete databases', err); }
      // Navigate to the clean URL (strips the param and reloads in one step).
      location.replace(window.location.pathname);
      return;
    }

    appRoot = document.getElementById('app');

    // Layers (back to front): panel bgs → painting → buttons (buttons sit on top)
    panelLayer = document.createElement('div');
    panelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    appRoot.appendChild(panelLayer);

    const paintingWrap = document.createElement('div');
    appRoot.appendChild(paintingWrap);
    canvasComp = new FP.PaintingCanvas(paintingWrap);
    canvasComp.onDirtyChange = onDirtyChange;
    canvasComp.setBrush(FP.brushes[state.activeBrushId]);
    canvasComp.setColor(state.palette[state.activeColorIdx]);
    canvasComp.setSize(SIZE_LEVELS[state.sizeIdx]);

    buttonLayer = document.createElement('div');
    buttonLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    appRoot.appendChild(buttonLayer);

    // Open IndexedDB for both storage modules before first render
    await Promise.all([FP.storage.init(), FP.coloringBook.init()]);

    // Load saved drawings
    state.saved = FP.storage.list();

    if (CFG.toolOrder) FP.toolOrder = CFG.toolOrder;

    // Wire the page picker into our app. The picker owns its own DOM and
    // state (open/closed, current book, grid-page offset, preview color); we
    // provide hooks for the actions it can't perform itself (loading pages,
    // deleting saved drawings, knowing which page is currently loaded).
    FP.pagePicker.init({
      onClose: () => renderAll(),
      onTileTap: handlePickerTileTap,
      onDeleteSavedTile: handlePickerDeleteSavedTile,
      getCurrentLoadedId: () => {
        if (state.loadedDrawingId) return 'saved:' + state.loadedDrawingId;
        return state.currentColoringPageId;
      },
    });

    // Discover coloring books (always includes the synthetic saved book at
    // the front) and migrate any orphaned autosaves — autosaves whose source
    // page is no longer in any coloring book's manifest.
    FP.coloringBook.discover().then(async pages => {
      state.coloringPages = pages;
      state.coloringBooks = FP.coloringBook.getBooks();
      state.currentBookId = FP.coloringBook.getCurrentBookId();
      try {
        const allColoringPageIds = await FP.coloringBook.getAllPageIds();
        migrateOrphanedColoringAutosaves(allColoringPageIds);
      } catch (e) {
        console.warn('orphan-autosave migration skipped', e);
      }
      renderAll();
    }).catch(err => console.warn('coloringBook discover failed', err));

    // First render
    renderAll();

    // Always clear pointer-on-button tracking when the pointer is released
    // anywhere — otherwise releasing over a button (no drag) leaves a stale
    // entry that would auto-start a stroke on a later hover.
    const _clearPointerDown = (e) => state.pointerDownOnButton.delete(e.pointerId);
    window.addEventListener('pointerup',     _clearPointerDown);
    window.addEventListener('pointercancel', _clearPointerDown);

    // Auto-collapse the bookshelf on any pointerdown outside its row's
    // bounding rect. Includes gaps between tiles, so tapping in the gaps
    // does NOT collapse. The close itself is deferred to the next frame
    // (via rAF) — this lets the original event's bubble phase reach the
    // tapped target FIRST. That matters for buttons like Clear that have
    // their own onTap which toggles the bookshelf state: if we close
    // synchronously, Clear's toggle would flip it back to open. Deferring
    // means Clear's handler closes via its own code path; our rAF callback
    // then becomes a no-op (state already closed).
    document.addEventListener('pointerdown', (e) => {
      if (!state.coloringBookOpen) return;
      // While the picker is open, the bookshelf stays open regardless of
      // where the user taps — the picker handles its own dismissal (tap
      // backdrop = close picker; bookshelf doesn't collapse).
      if (FP.pagePicker.isOpen()) return;
      if (!lastLayout || !lastLayout.bookshelfRowRect) return;
      const r = lastLayout.bookshelfRowRect;
      const x = e.clientX;
      const y = e.clientY;
      const inside =
        x >= r.left && x <= r.left + r.width &&
        y >= r.top  && y <= r.top  + r.height;
      if (!inside) {
        requestAnimationFrame(() => {
          if (!state.coloringBookOpen) return;  // already closed by a bubble-phase handler
          state.coloringBookOpen = false;
          renderAll();
        });
      }
    }, true);

    // Resize handler (debounced via rAF)
    let raf = null;
    window.addEventListener('resize', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; renderAll(); });
    });

    // Wire bg upload input
    document.getElementById('bg-upload-input')
      .addEventListener('change', onBgUploadFile);

    // visualViewport changes (mobile keyboard etc) — also re-render
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => renderAll());
    }

    // Ensure app has focus to receive keyboard events
    appRoot.setAttribute('tabindex', '0');
    appRoot.focus();

    // Track fullscreen state changes — handles both Fullscreen API (Ctrl+F) and browser fullscreen (F11)
    function updateFullscreenState() {
      const inApiFullscreen = !!document.fullscreenElement;
      const inBrowserFullscreen = isBrowserFullscreen();
      const entering = inApiFullscreen || inBrowserFullscreen;

      if (entering !== state.isFullscreen) {
        state.isFullscreen = entering;
        if (entering) {
          disableBtn('upload');
          if (state.savedJustNow) disableBtn('save');
        } else {
          enableBtn('upload');
          enableBtn('save');
        }
        renderAll();
      }
    }

    document.addEventListener('fullscreenchange', updateFullscreenState);
    window.addEventListener('resize', updateFullscreenState);

    // Keyboard handling: capture phase to intercept before browser defaults
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key?.toLowerCase() === 'g') {
        e.preventDefault();
        state.frameMode = !state.frameMode;
        renderAll();
        return;
      }
      if (ctrl && e.key?.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      if (ctrl && e.key === ',') {
        e.preventDefault();
        changeSize(-1);
        return;
      }
      if (ctrl && e.key === '.') {
        e.preventDefault();
        changeSize(+1);
        return;
      }
      if (ctrl && !e.shiftKey && e.key?.toLowerCase() === 'b') {
        e.preventDefault();
        cycleBrush();
        return;
      }
      if (ctrl && e.shiftKey && e.key === 'ArrowUp') {
        e.preventDefault();
        if (!state.disabledButtons.has('upload')) handleUploadTap();
        return;
      }
      if (ctrl && e.shiftKey && e.key === 'ArrowDown') {
        e.preventDefault();
        handleSaveOrDownloadAll();
        return;
      }

      // In fullscreen mode, capture all other keys
      if (state.isFullscreen) {
        e.preventDefault();
      }
    }, true);  // capture phase

    document.addEventListener('keyup', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key?.toLowerCase();

      // Prevent default for all handled shortcuts in both modes, and all keys in fullscreen
      if (ctrl && (key === 'g' || key === 'f' || e.key === ',' || e.key === '.' ||
                   key === 'b' || e.key === 'ArrowUp' || e.key === 'ArrowDown') ||
          state.isFullscreen) {
        e.preventDefault();
      }
    }, true);  // capture phase
  }

  // ── Render ────────────────────────────────────────────────────
  function renderAll() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const layout = FP.computeLayout(w, h, state.saved.length);
    lastLayout = layout;

    // Canvas rect: framed view uses layout.canvas (which now extends through
    // the empty strip-line middle in both modes — no more Crayon-specific
    // override needed). Full view fills the window.
    const canvasRect = state.frameMode ? layout.canvas : { left: 0, top: 0, width: w, height: h };
    canvasComp.setRect(canvasRect, state.frameMode);

    // Clear layers
    panelLayer.innerHTML  = '';
    buttonLayer.innerHTML = '';

    // In Crayon mode, never show the toolbar panel backgrounds (buttons float
    // over the canvas, matching the kid-safe minimal aesthetic).
    if (state.frameMode && !CFG.clearOnly) {
      renderPanels(layout);
    }
    renderColorSwatches(layout);
    renderTools(layout);
    renderStrip(layout);

    // Page-picker overlay (modal grid + backdrop). Owns its own DOM under
    // a child of #app; appended LAST so its z-index ordering sits below the
    // regular .btn z-index (the color palette and corner buttons stay
    // clickable above the picker's shadow).
    FP.pagePicker.render(appRoot, layout, state.coloringPages);
  }

  function renderPanels(layout) {
    layout.panels.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'panel-bg';
      if (p.borders) {
        if (p.borders.top)    el.classList.add('with-border-top');
        if (p.borders.bottom) el.classList.add('with-border-bottom');
        if (p.borders.left)   el.classList.add('with-border-left');
        if (p.borders.right)  el.classList.add('with-border-right');
      }
      Object.assign(el.style, {
        left:   p.left   + 'px',
        top:    p.top    + 'px',
        width:  p.width  + 'px',
        height: p.height + 'px',
      });
      panelLayer.appendChild(el);
    });
  }

  function renderColorSwatches(layout) {
    // When the page picker is open, the color palette becomes the BG-COLOR
    // picker for pages: each swatch slot renders a "fan of 3 papers" icon
    // in that swatch's color over a neutral (canvas-bg) button. No active
    // indicator (no border, no checkmark) — selection is shown by the
    // tinting that gets applied to picker tiles (Stage 4).
    if (FP.pagePicker.isOpen()) {
      layout.colors.forEach(s => {
        const color = state.palette[s.idx];
        makeBtn({
          x: s.x, y: s.y, size: layout.B,
          bg: '#f5f3ee',              // matches #app background
          onTap: () => handleBgColorPickerTap(s.idx),
          innerHTML: FP.pageFanIcon(color, layout.B * 0.7),
          ariaLabel: `Page background color ${s.idx + 1}`,
        });
      });
      return;
    }
    layout.colors.forEach(s => {
      const color = state.palette[s.idx];
      const isActive = s.idx === state.activeColorIdx;
      const btn = makeBtn({
        x: s.x, y: s.y, size: layout.B,
        bg: color, color, active: isActive,
        isColorSwatch: true,
        onTap: () => handleColorTap(s.idx),
        ariaLabel: `Color ${s.idx + 1}`,
      });
      if (isActive) {
        btn.insertAdjacentHTML('beforeend', FP.activeMark(layout.B));
      }
    });
  }

  // Picker-only handler: tapping a bg-color icon stores the preview color
  // on the picker. Stage 4 will composite this as Layer 2 on each tile and
  // pass it as a bgColorOverride when a tile is tapped to load a page. For
  // Stage 3 we just store it and re-render; the visual effect lands later.
  function handleBgColorPickerTap(idx) {
    FP.pagePicker.setPreviewBgColor(state.palette[idx]);
    FP.playSound('colorPick', state.palette[idx]);
    renderAll();
  }

  function renderTools(layout) {
    // While the page picker is open, the drawing-tools column is replaced
    // with contextual chrome: prev grid-page, current/total indicator, next
    // grid-page. None of the regular tools are reachable — keeps the user
    // focused on picking a page and prevents stray taps from changing brush.
    if (FP.pagePicker.isOpen()) {
      _renderPickerChrome(layout);
      return;
    }
    layout.tools.forEach(t => {
      let inner = '', accent = false, indicator = false, active = false;
      if (t.kind === 'brush') {
        const brush = FP.brushes[t.id];
        inner = FP.icon(brush.iconName, layout.B * 0.44);
        active = (state.activeBrushId === t.id);
      } else if (t.kind === 'sizeIndicator') {
        indicator = true;
        // In expanded mode the canvas is the full window, not layout.canvas — use
        // the actual canvas width so the dot tracks the painted stroke in either mode.
        const canvasCssW = state.frameMode ? layout.canvas.width : window.innerWidth;
        const dotPercent = _sizeDotPercent(state.sizeIdx, canvasCssW, layout.B);
        inner = `<div class="size-dot" style="width:${dotPercent}%;height:${dotPercent}%;"></div>`;
      } else {
        // sizeUp / sizeDown / bgFill
        inner = FP.icon(t.id, layout.B * 0.44);
      }
      const btn = makeBtn({
        x: t.x, y: t.y, size: layout.B,
        accent, indicator, active,
        onTap: () => handleToolTap(t),
        innerHTML: inner,
        ariaLabel: t.id,
      });
      // Indicator is non-interactive
      if (t.kind === 'sizeIndicator') {
        btn.style.cursor = 'default';
        btn.onclick = null;
      }
    });
  }

  // ── Strip line (Save / Bookshelf-toggle / Clear corners + bookshelf overlay) ─

  // Renders the corner buttons (Save, Bookshelf-toggle, Clear) at the
  // strip-line slots, plus the bookshelf overlay when open. The middle of
  // the strip line is otherwise empty — the canvas extends through it.
  function renderStrip(layout) {
    const B = layout.B;
    const isCrayon = !!CFG.clearOnly;
    const open = state.coloringBookOpen;

    const pickerOpen = FP.pagePicker.isOpen();

    // Slot 0: Save (skipped in Crayon — slot stays empty). When the picker
    // is open, Save drops behind the backdrop (visually darkened) per the
    // redesign — the bookshelf is the active surface.
    if (!isCrayon) {
      const showDl = state.savedJustNow && !state.isFullscreen;
      makeBtn({
        x: layout.saveXY.x, y: layout.saveXY.y, size: B,
        accent: true,
        onTap: handleSaveOrDownloadAll,
        innerHTML: FP.icon(showDl ? 'download' : 'save', B * 0.44),
        ariaLabel: showDl ? 'Download all' : 'Save drawing',
        disabled: state.disabledButtons.has('save'),
        extraClass: pickerOpen ? 'picker-below' : null,
      });
    }

    // Slot 1: Bookshelf-toggle (always rendered — there's always at least the
    // synthetic saved book to navigate to). Stays above the picker backdrop
    // (no .active outline when picker open — the user already sees the
    // picker; an extra outline on the toggle is visual noise).
    makeBtn({
      x: layout.bookToggleXY.x, y: layout.bookToggleXY.y, size: B,
      active: open && !pickerOpen,
      onTap: handleColoringBookToggleTap,
      innerHTML: FP.icon('book', B * 0.44),
      ariaLabel: open ? 'Close bookshelf' : 'Open bookshelf',
    });

    // Slot 2..n-1: bookshelf items (when open) or empty.
    // Returns the highest slot the overlay drew into so we know whether to
    // render Clear in slot n-1 or let an overlay item occlude it.
    let highestSlotUsed = 1;
    if (open) {
      highestSlotUsed = _renderBookshelfOverlay(layout);
    }

    // Slot n-1: Clear. When bookshelf is open and an overlay item reaches
    // slot n-1, Clear is occluded (and tapping that slot does the overlay
    // item's action, not clear). When the overlay is shorter than the
    // available slots, Clear is rendered but `inactive` — looks dimmed but
    // still consumes the tap and closes the bookshelf (so the tap doesn't
    // pass through to the canvas and start a stroke).
    const lastSlot = layout.bookshelfSlotCount - 1;
    if (!open || highestSlotUsed < lastSlot) {
      makeBtn({
        x: layout.clearXY.x, y: layout.clearXY.y, size: B,
        accent: true,
        onTap: open ? handleColoringBookToggleTap : handleClearTap,
        innerHTML: FP.icon('clear', B * 0.44),
        ariaLabel: open ? 'Close bookshelf' : 'Clear drawing',
        inactive: open,
      });
    }

    // Record the actual occupied range of the strip line so the auto-collapse
    // listener treats only THAT as "inside" the bookshelf. The rect extends
    // from slot 0 (Save) to whichever slot the bookshelf overlay last drew
    // into — Clear is NOT included, so tapping Clear (or any space between
    // the last book and Clear) is "outside" and closes the bookshelf.
    // Clear's onTap also closes the bookshelf, so it's covered either way.
    layout.bookshelfRowRect = _computeBookshelfRowRect(layout, highestSlotUsed);
  }

  // Returns the {left,top,width,height} of the contiguous strip-line range
  // [slot 0 .. lastOccupiedSlot]. Used for auto-collapse hit-testing — taps
  // inside this rect (including gaps between tiles) do NOT close the
  // bookshelf; taps outside it DO.
  function _computeBookshelfRowRect(layout, lastOccupiedSlot) {
    const B = layout.B;
    const firstXY = layout.bookshelfSlotXY(0);
    const lastXY  = layout.bookshelfSlotXY(lastOccupiedSlot);
    if (layout.orientation === 'landscape') {
      const left  = Math.min(firstXY.x, lastXY.x);
      const right = Math.max(firstXY.x, lastXY.x) + B;
      return { left, top: firstXY.y, width: right - left, height: B };
    } else {
      // Portrait: slot 0 is at the bottom, higher slots are above.
      const top    = Math.min(firstXY.y, lastXY.y);
      const bottom = Math.max(firstXY.y, lastXY.y) + B;
      return { left: firstXY.x, top, width: B, height: bottom - top };
    }
  }

  // Renders the bookshelf overlay items in slots 2..n-1 of the strip line.
  //
  // Items list:
  //   non-Crayon: [Upload tile, ...books]   (Upload is the "first book";
  //                                          scrolling forward hides it)
  //   Crayon:     [...books]                (no Upload — kid-safe)
  //
  // Layout model: items always occupy slots 2..n-1 (totalVisibleSlots wide).
  // When overflow exists, scroll arrows REPLACE the leftmost / rightmost
  // visible item — they don't insert into a new slot. So each tap of
  // scroll-forward visually shifts every book one slot to the left (the
  // book that was at slot 2 disappears behind the scroll-back arrow that
  // now occupies slot 2).
  //
  // Returns the highest slot the overlay drew into (so renderStrip knows
  // whether to render Clear in slot n-1).
  function _renderBookshelfOverlay(layout) {
    const B = layout.B;
    const n = layout.bookshelfSlotCount;
    const totalVisibleSlots = Math.max(0, n - 2);   // slots 2..n-1

    const items = [];
    if (!CFG.clearOnly) items.push({ kind: 'upload' });
    state.coloringBooks.forEach(book => items.push({ kind: 'book', book }));

    const N = items.length;
    if (N === 0 || totalVisibleSlots === 0) return 1;

    const overflow = N > totalVisibleSlots;
    const maxOffset = Math.max(0, N - totalVisibleSlots);
    const offset = Math.min(state.coloringScrollOffset, maxOffset);

    // Window of items that map to slots 2..(2 + slotCount - 1). With overflow,
    // scroll-back covers items[offset] and/or scroll-forward covers the last
    // visible item — both are still in the window but visually replaced.
    const slotCount = Math.min(totalVisibleSlots, N - offset);
    const visibleItems = items.slice(offset, offset + slotCount);
    const firstSlot = 2;
    const scrollBack    = overflow && offset > 0;
    const scrollForward = overflow && offset < maxOffset;

    // Render each item at its slot, skipping the slot under a scroll arrow
    // (the arrow takes the slot's tap; the underlying item is unreachable
    // until the user scrolls).
    visibleItems.forEach((item, i) => {
      const slot = firstSlot + i;
      if (scrollBack && slot === firstSlot) return;                          // covered by scroll-back
      if (scrollForward && slot === firstSlot + slotCount - 1) return;       // covered by scroll-forward
      const pos = layout.bookshelfSlotXY(slot);
      if (item.kind === 'upload') {
        makeBtn({
          x: pos.x, y: pos.y, size: B,
          onTap: handleUploadTap,
          innerHTML: FP.icon('upload', B * 0.44),
          ariaLabel: 'Upload background',
          disabled: state.disabledButtons.has('upload'),
        });
      } else {
        _renderBookCoverTile(item.book, pos.x, pos.y, B);
      }
    });

    // Scroll-back arrow at slot 2 (replacing items[offset])
    if (scrollBack) {
      const pos = layout.bookshelfSlotXY(firstSlot);
      const icon = layout.orientation === 'landscape' ? 'scrollLeft' : 'scrollDown';
      makeBtn({
        x: pos.x, y: pos.y, size: B,
        onTap: () => scrollBookshelf(-1),
        innerHTML: FP.icon(icon, B * 0.44),
        ariaLabel: 'Scroll books back',
      });
    }

    // Scroll-forward arrow at the rightmost visible slot (replacing the last
    // visible item)
    if (scrollForward) {
      const pos = layout.bookshelfSlotXY(firstSlot + slotCount - 1);
      const icon = layout.orientation === 'landscape' ? 'scrollRight' : 'scrollUp';
      makeBtn({
        x: pos.x, y: pos.y, size: B,
        onTap: () => scrollBookshelf(+1),
        innerHTML: FP.icon(icon, B * 0.44),
        ariaLabel: 'Scroll books forward',
      });
    }

    return slotCount > 0 ? firstSlot + slotCount - 1 : 1;
  }

  function _renderBookCoverTile(book, x, y, B) {
    // Book covers only show the "this one's selected" outline while the
    // picker is open. When the picker is closed, no book is highlighted —
    // the bookshelf is just a chooser, not a state indicator.
    const isActive = FP.pagePicker.isOpen()
      && FP.pagePicker.getBookId() === book.id;
    const btn = makeBtn({
      x, y, size: B,
      active: isActive,
      onTap: () => handleBookTap(book),
      ariaLabel: book.name,
      extraClass: 'thumb',
    });
    // Resolve cover via the manifest→cover.[ext]→first-page chain. The
    // synthetic saved book resolves to its most-recent drawing's thumb (or
    // null when empty — show the book name as a fallback).
    FP.coloringBook.resolveBookCover(book).then(cover => {
      if (!btn.parentNode) return;  // tile was removed by a re-render
      if (cover) {
        const img = document.createElement('img');
        img.src = cover;
        img.alt = '';
        btn.appendChild(img);
      } else {
        const label = document.createElement('span');
        label.textContent = book.name;
        label.style.cssText = 'font-size:' + Math.max(8, B * 0.11) + 'px;text-align:center;padding:4px;line-height:1.1;color:#333;';
        btn.appendChild(label);
      }
    }).catch(err => console.warn('book cover failed', err));
  }

  function renderColoringThumb(page, x, y, B) {
    if (state.coloringConfirmReloadId === page.id && !page.isBlank && !page.isSavedDrawing) {
      // Replace this slot with the reload button (second-tap confirm).
      // (Don't show reload confirm for the blank canvas or saved drawings)
      makeBtn({
        x, y, size: B, accent: true,
        onTap: () => handleColoringPageReloadConfirm(page),
        innerHTML: FP.icon('reload', B * 0.44),
        ariaLabel: 'Reload page (clear all your work)',
      });
      return;
    }
    const isActive = page.isSavedDrawing
      ? (state.loadedDrawingId === (page.entry && page.entry.id))
      : (state.currentColoringPageId === page.id);
    const btn = makeBtn({
      x, y, size: B,
      active: isActive,
      onTap: () => handleColoringPageTap(page),
      ariaLabel: page.name,
      extraClass: 'thumb',
    });

    // Blank canvas entry — render a white thumbnail
    if (page.isBlank) {
      const thumbSize = 160;
      const c = document.createElement('canvas');
      c.width = c.height = thumbSize;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, thumbSize, thumbSize);
      const img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      img.alt = '';
      btn.appendChild(img);
      return;
    }

    // Saved-drawing entry — show the stored composite thumb (v1 png or v2 thumb).
    if (page.isSavedDrawing) {
      const img = document.createElement('img');
      img.src = page.entry.thumb || page.entry.png;
      img.alt = '';
      btn.appendChild(img);
      return;
    }

    // Prefer the autosaved thumbnail (shows the user's painted state on the
    // page) if present; otherwise generate a smooth canvas-based thumbnail.
    const autosave = FP.coloringBook.getAutosave(page.id);
    if (autosave && autosave.thumb) {
      const img = document.createElement('img');
      img.src = autosave.thumb;
      img.alt = '';
      btn.appendChild(img);
    } else {
      // No autosave: generate a smooth canvas thumbnail from the page image
      FP.coloringBook.loadImage(page).then(image => {
        const thumbDataUrl = FP.PaintingCanvas.generateThumbnailFromImage(image, 160);
        const img = document.createElement('img');
        img.src = thumbDataUrl;
        img.alt = '';
        // Only append if the button still exists (it may have been removed by scrolling)
        if (btn.parentNode) {
          btn.appendChild(img);
        }
      }).catch(err => {
        console.warn('Failed to generate coloring page thumbnail', err);
        // Fallback: show the raw image
        const img = document.createElement('img');
        img.src = page.url;
        img.alt = '';
        if (btn.parentNode) btn.appendChild(img);
      });
    }
  }

  function renderThumb(entry, x, y, B) {
    const isLoaded = state.loadedDrawingId === entry.id;
    const onTap = () => handleThumbTap(entry);
    if (isLoaded) {
      // Render as Delete button instead of the thumbnail
      makeBtn({
        x, y, size: B, accent: true,
        onTap,
        innerHTML: FP.icon('delete', B * 0.44),
        ariaLabel: 'Delete this saved drawing',
      });
    } else {
      const btn = makeBtn({
        x, y, size: B,
        onTap,
        ariaLabel: 'Open saved drawing',
        extraClass: 'thumb',
      });
      const img = document.createElement('img');
      // v2 entries have a dedicated thumb; v1 legacy entries store the
      // composite under `png` (the v1→v2 read-shim sets thumb = png).
      img.src = entry.thumb || entry.png;
      img.alt = '';
      btn.appendChild(img);
    }
  }

  // Generic button factory — appended to buttonLayer.
  function makeBtn({ x, y, size, bg, color, active, accent, indicator, disabled, inactive,
                     onTap, innerHTML, ariaLabel, extraClass, isColorSwatch }) {
    const b = document.createElement('button');
    b.className = 'btn';
    if (active)    b.classList.add('active');
    if (accent)    b.classList.add('accent');
    if (indicator) b.classList.add('indicator');
    if (disabled)  b.classList.add('disabled');
    if (inactive)  b.classList.add('inactive');
    if (color && LIGHT_COLORS.has(color)) b.classList.add('light-color');
    if (extraClass) b.classList.add(extraClass);
    if (ariaLabel)  b.setAttribute('aria-label', ariaLabel);

    Object.assign(b.style, {
      left:   x + 'px',
      top:    y + 'px',
      width:  size + 'px',
      height: size + 'px',
      borderRadius: Math.max(4, size * 0.12) + 'px',
    });
    if (bg) b.style.background = bg;
    if (innerHTML) b.innerHTML = innerHTML;
    b.addEventListener('contextmenu', e => e.preventDefault());
    if (onTap && !disabled) {
      b.addEventListener('pointerdown', (e) => {
        // Only color swatches participate in tap-drag-to-canvas: dragging off
        // a color button while still pressed starts a stroke in that color.
        // Other buttons (tools, size, clear, etc.) must never start a stroke.
        if (isColorSwatch) state.pointerDownOnButton.add(e.pointerId);
        // Prevent default button behavior that might interfere with dialogs
        e.preventDefault();
        onTap(e);
      });
    }
    buttonLayer.appendChild(b);
    return b;
  }

  function _sizeDotPercent(sizeIdx, canvasWidth, buttonSize) {
    // Every brush is normalized so `opts.size` is its painted radius — the
    // canonical painted diameter is therefore `size * 2`. The preview dot
    // shows that diameter so a brush stroke never exceeds the dot.
    const currentSize = SIZE_LEVELS[sizeIdx];
    const strokeCssPx = currentSize * 2 * (canvasWidth / 1000);

    // .btn has `box-sizing: border-box` with a 2px border on each side, so a
    // child's `width: N%` is taken from the content area = buttonSize - 4.
    const innerSize = Math.max(1, buttonSize - 4);
    let percent = (strokeCssPx / innerSize) * 100;

    // Cap so the dot doesn't overflow the button visually.
    percent = Math.max(6, Math.min(95, percent));
    return percent;
  }

  // ── Delete all drawings ───────────────────────────────────────
  // Names must match storage.js DB_NAME ('fingerPaint.drawings') and
  // coloringBook.js CB_DB_NAME ('fingerPaint.coloring'). The caller is
  // responsible for navigating to a clean URL afterwards — we don't
  // reload here so the param-strip can be atomic via location.replace().
  function _deleteAllDrawings() {
    const del = (name) => new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = resolve;
      req.onerror   = () => reject(req.error);
      req.onblocked = () => {
        // Should never happen because init() runs the delete BEFORE opening
        // either DB, but log loudly if it does so the next dev finds it.
        console.warn('deleteDatabase blocked: connection still open for ' + name);
      };
    });
    return Promise.all([del('fingerPaint.drawings'), del('fingerPaint.coloring')]);
  }

  // ── Handlers ──────────────────────────────────────────────────
  function handleColorTap(idx) {
    state.activeColorIdx = idx;
    canvasComp.setColor(state.palette[idx]);
    FP.playSound('colorPick', state.palette[idx]);
    renderAll();
  }

  function handleToolTap(t) {
    if (t.kind === 'brush') {
      state.activeBrushId = t.id;
      canvasComp.setBrush(FP.brushes[t.id]);
      FP.playBrushSound(FP.brushes[t.id], 'select');
      renderAll();
    } else if (t.kind === 'sizeUp') {
      changeSize(+1);
    } else if (t.kind === 'sizeDown') {
      changeSize(-1);
    } else if (t.kind === 'bgFill') {
      handleBgFillTap();
    }
    // sizeIndicator is non-interactive
  }

  function changeSize(delta) {
    const next = Math.max(0, Math.min(SIZE_LEVELS.length - 1, state.sizeIdx + delta));
    if (next === state.sizeIdx) return;
    state.sizeIdx = next;
    canvasComp.setSize(SIZE_LEVELS[next]);
    FP.playSound('sizeChange', delta);
    renderAll();
  }

  function cycleBrush() {
    const fromOrder = FP.toolOrder.filter(t => t.kind === 'brush').map(t => t.id);
    const brushIds = fromOrder.length > 0 ? fromOrder : Object.keys(FP.brushes);
    if (brushIds.length === 0) return;
    const cur = brushIds.indexOf(state.activeBrushId);
    const next = brushIds[(cur + 1) % brushIds.length];
    state.activeBrushId = next;
    canvasComp.setBrush(FP.brushes[next]);
    FP.playBrushSound(FP.brushes[next], 'select');
    renderAll();
  }

  function handleBgFillTap() {
    const onColoringPage = !!state.currentColoringPageId;
    // On a coloring page: fill the solid-bg layer (the outline + overlay layers
    // stay intact, so the page lines are preserved over the new color).
    // Elsewhere: keep legacy behavior (leave any loaded saved drawing).
    if (!onColoringPage) _leavingColoringPage();
    const c = state.palette[state.activeColorIdx];
    canvasComp.fillBackground(c);
    // Auto-switch to opposite column color (flip LSB)
    state.activeColorIdx = state.activeColorIdx ^ 1;
    canvasComp.setColor(state.palette[state.activeColorIdx]);
    if (onColoringPage) {
      autosaveCurrentColoringPage();
    } else {
      onCanvasContentChanged();
    }
    renderAll();
    FP.playSound('bgFill');
  }

  async function handleClearTap() {
    // Blank canvas mode: just clear the drawing.
    if (state.currentColoringPageId === '__blank-white') {
      await canvasComp.pageFlip(async () => {
        canvasComp.clearDrawing();
      }, PAGE_FLIP_ANIMATION, () => {
        renderAll();
      });
      FP.playSound('deleteDrawing');
      return;
    }
    // On a coloring page: wipe strokes but preserve the chosen bg color,
    // outline, and overlay. Hard-reset (drop bg color too) is still reachable
    // via double-tap on the thumbnail → handleColoringPageReloadConfirm.
    if (state.currentColoringPageId) {
      await canvasComp.pageFlip(async () => {
        canvasComp.clearDrawing();
      }, PAGE_FLIP_ANIMATION, () => {
        renderAll();
      });
      autosaveCurrentColoringPage();
      return;
    }
    if (!CFG.clearOnly && canvasComp.dirtySinceLoad) {
      const choice = await FP.dialogs.clearDrawing();
      if (choice === 'cancel' || choice == null) return;
      if (choice === 'save') doSave();
    }
    await canvasComp.pageFlip(async () => {
      canvasComp.clearDrawing();
      onCanvasContentChanged();
    }, PAGE_FLIP_ANIMATION, () => {
      renderAll();
    });
  }

  async function handleSaveOrDownloadAll() {
    if (state.savedJustNow && !state.isFullscreen) {
      // Download mode — ask which
      const choice = await FP.dialogs.downloadDrawings(state.saved.length);
      if (choice === 'one') {
        // Prefer the loaded entry's composite (covers v1 png and v2 layers);
        // fall back to the most recent save (already flattened on the fly).
        const target = state.loadedDrawingEntry || state.saved[0];
        if (target) {
          const png = await FP.storage.compositeFromEntry(target);
          _downloadPng(png);
        }
        FP.playSound('saveDrawing');
      } else if (choice === 'all') {
        FP.storage.downloadAll();
        FP.playSound('saveDrawing');
      }
    } else {
      doSave();
    }
  }

  function _downloadPng(pngDataUrl) {
    const a = document.getElementById('download-anchor');
    a.href = pngDataUrl;
    a.download = `painting-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  }

  function doSave() {
    const bg    = canvasComp.toBackgroundDataURL();
    const draw  = canvasComp.toDrawingDataURL();
    const thumb = canvasComp.toThumbnailDataURL();
    FP.storage.add(bg, draw, thumb);
    state.saved = FP.storage.list();
    _refreshSavedBookPagesIfActive();
    state.savedJustNow = true;
    canvasComp.markSaved();  // reset dirty so next stroke re-triggers onDirtyChange
    if (state.isFullscreen) disableBtn('save');  // no re-saving until drawing changes
    FP.playSound('saveDrawing');
    renderAll();
  }

  async function handleThumbTap(entry) {
    if (state.loadedDrawingId === entry.id) {
      // Already loaded — Delete confirmation flow
      const choice = await FP.dialogs.deleteSaved();
      if (choice !== 'delete') return;
      FP.storage.remove(entry.id);
      state.saved = FP.storage.list();
      _refreshSavedBookPagesIfActive();
      state.loadedDrawingId = null;
      state.loadedDrawingEntry = null;
      state.savedJustNow    = false;
      enableBtn('save');  // canvas now has no saved copy — allow saving in fullscreen
      FP.playSound('deleteDrawing');
      renderAll();
    } else {
      // Coloring-page work is autosaved per-page — leaving doesn't lose work,
      // so suppress the dirty dialog when we're inside a coloring page.
      if (state.currentColoringPageId) {
        _leavingColoringPage();
      } else if (canvasComp.dirtySinceLoad) {
        const choice = await FP.dialogs.loadWithDirty();
        if (choice === 'cancel' || choice == null) return;
        if (choice === 'save') doSave();
      }
      // Load this drawing onto the canvas (with page flip)
      await canvasComp.pageFlip(async () => {
        await _loadSavedEntry(entry);
        state.loadedDrawingId = entry.id;
        state.loadedDrawingEntry = entry;
        state.savedJustNow    = true;  // show download button for the loaded drawing
        // Do NOT re-enable save button — loaded drawing is already saved
      }, PAGE_FLIP_ANIMATION, () => {
        renderAll();
      });
    }
  }

  // Loads a saved entry (v1 png or v2 bg+draw) onto the canvas.
  function _loadSavedEntry(entry) {
    if (entry.png) {
      // legacy v1 shape — composite, no separate draw layer
      return canvasComp.loadCompositeFromDataUrl(entry.png);
    }
    return canvasComp.loadLayersFromDataUrls(entry.bg, entry.draw);
  }

  // ── Background upload flow ────────────────────────────────────
  function handleUploadTap() {
    document.getElementById('bg-upload-input').click();
  }

  async function onBgUploadFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                 // allow re-selecting the same file
    if (!file) return;

    // If the picker was open (Upload is reachable from the bookshelf strip
    // while the picker is showing), close it so the uploaded image becomes
    // visible without the picker covering it.
    if (FP.pagePicker.isOpen()) FP.pagePicker.close();

    // Uploading a background means leaving the coloring page; autosave first.
    _leavingColoringPage();

    const dataUrl = await _fileToDataUrl(file);
    const newImg  = await _loadImage(dataUrl);

    // Build "new background only" preview
    const previewSize = 160;
    const replaceCanvas = document.createElement('canvas');
    replaceCanvas.width = replaceCanvas.height = previewSize;
    const rc = replaceCanvas.getContext('2d');
    _coverDraw(rc, newImg, previewSize, previewSize);
    const newBgDataUrl = replaceCanvas.toDataURL('image/png');

    // Build "keep drawing" preview = newBg + current drawing strokes layer
    const keepCanvas = document.createElement('canvas');
    keepCanvas.width = keepCanvas.height = previewSize;
    const kc = keepCanvas.getContext('2d');
    _coverDraw(kc, newImg, previewSize, previewSize);
    kc.drawImage(canvasComp.drawCanvas, 0, 0, previewSize, previewSize);
    const mergedDataUrl = keepCanvas.toDataURL('image/png');

    const choice = await FP.dialogs.uploadBackground({
      newBgDataUrl,
      mergedWithDrawingDataUrl: mergedDataUrl,
    });

    if (choice === 'cancel' || choice == null) return;

    if (choice === 'replace-all') {
      await canvasComp.pageFlip(async () => {
        canvasComp.setBackgroundImage(newImg);
        canvasComp.clearDrawing();
        onCanvasContentChanged();
      }, PAGE_FLIP_ANIMATION, () => {
        renderAll();
      });
    } else if (choice === 'keep-drawing') {
      // Set background image but preserve drawing strokes
      await canvasComp.pageFlip(async () => {
        canvasComp.setBackgroundImage(newImg);
        onCanvasContentChanged();
      }, PAGE_FLIP_ANIMATION, () => {
        renderAll();
      });
    }
    FP.playSound('bgUpload');
  }

  function _coverDraw(ctx, img, w, h) {
    const ar = img.naturalWidth / img.naturalHeight;
    let dw = w, dh = h, dx = 0, dy = 0;
    if (ar > 1) { dw = h * ar; dx = (w - dw) / 2; }
    else        { dh = w / ar; dy = (h - dh) / 2; }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function _fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ── Dirty / saved flag plumbing ───────────────────────────────
  function onDirtyChange(dirty) {
    if (dirty) {
      // In crayon mode the strip occupies the full bottom area; auto-collapse
      // it the moment the user starts drawing so the canvas isn't covered.
      if (CFG.clearOnly && state.coloringBookOpen) {
        state.coloringBookOpen = false;
      }
      // Clear reload-confirm on any dirty draw (not just crayon mode).
      // When the user draws, the page is no longer "clean" so the reload
      // button should disappear and revert to the page thumbnail.
      if (state.currentColoringPageId) {
        state.coloringConfirmReloadId = null;
      }
      onCanvasContentChanged();
      renderAll();
    }
  }

  function onCanvasContentChanged() {
    // Any drawing/bg/clear/load that originates from the user voids the
    // "just-saved" / "loaded" states.
    let needsRender = false;
    if (state.savedJustNow) {
      state.savedJustNow = false;
      enableBtn('save');  // re-enable save button if it was disabled in fullscreen
      needsRender = true;
    }
    if (state.loadedDrawingId) {
      state.loadedDrawingId = null;
      state.loadedDrawingEntry = null;
      needsRender = true;
    }
    if (needsRender) renderAll();
  }

  // ── Coloring book handlers ────────────────────────────────────

  // When viewing the synthetic saved book, the page list is derived from
  // FP.storage.list() and must be re-pulled after any save or delete so the
  // picker (Stage 3) reflects the latest content. The bookshelf-scroll
  // clamping below is independent — it follows the book count, not the
  // page count.
  function _refreshSavedBookPagesIfActive() {
    if (state.currentBookId === '__saved') {
      state.coloringPages = FP.coloringBook.getSavedBookPages();
    }
  }

  // Clamps state.coloringScrollOffset (the bookshelf's scroll position) into
  // a valid range given the current layout and book/upload-tile count. Safe
  // to call any time after lastLayout is set.
  function _clampBookshelfScroll() {
    if (!lastLayout) return;
    state.coloringScrollOffset = Math.max(0, Math.min(
      _maxBookshelfScroll(),
      state.coloringScrollOffset));
  }

  // ── Page picker handlers + chrome ─────────────────────────────

  // Tapping a book cover in the bookshelf: open the picker for that book,
  // or close the picker if it's already open for this book (re-tap toggle).
  async function handleBookTap(book) {
    const bookId = book.id;
    if (FP.pagePicker.isOpen() && FP.pagePicker.getBookId() === bookId) {
      FP.pagePicker.close();
      renderAll();
      return;
    }
    // Switch to this book's pages and open the picker over the canvas.
    const pages = await FP.coloringBook.switchBook(bookId);
    state.currentBookId = bookId;
    state.coloringPages = pages;
    state.coloringConfirmReloadId = null;
    FP.pagePicker.open(bookId);
    renderAll();
  }

  // Tile tap inside the picker — close the picker, then delegate to the
  // existing per-page-type load flow. Closing FIRST means the page-flip
  // animation runs on a clean canvas (no picker-grid still painted on top).
  //
  // If the tapped tile is ALREADY the loaded content, we don't want
  // handleColoringPageTap's existing "second tap" branches firing (which
  // would arm the legacy reload-confirm or open the delete dialog through
  // the wrong path). Just close the picker.
  async function handlePickerTileTap(page) {
    const loadedId = state.loadedDrawingId
      ? 'saved:' + state.loadedDrawingId
      : state.currentColoringPageId;
    if (page.id === loadedId) {
      FP.pagePicker.close();
      renderAll();
      return;
    }
    FP.pagePicker.close();
    renderAll();
    await handleColoringPageTap(page);
  }

  // × badge tap on a saved-drawing tile in the picker.
  async function handlePickerDeleteSavedTile(entry) {
    const choice = await FP.dialogs.deleteSaved();
    if (choice !== 'delete') return;
    FP.storage.remove(entry.id);
    state.saved = FP.storage.list();
    _refreshSavedBookPagesIfActive();
    if (state.loadedDrawingId === entry.id) {
      state.loadedDrawingId = null;
      state.loadedDrawingEntry = null;
      state.savedJustNow = false;
      enableBtn('save');
    }
    FP.playSound('deleteDrawing');
    renderAll();
  }

  // Picker grid-page navigation (prev/next chrome buttons).
  function _pickerGridScroll(delta) {
    if (!FP.pagePicker.isOpen() || !lastLayout) return;
    const total = FP.pagePicker.getGridPageCount(lastLayout, state.coloringPages);
    const cur = FP.pagePicker.getScrollOffset();
    const next = Math.max(0, Math.min(total - 1, cur + delta));
    if (next === cur) return;
    FP.pagePicker.setScrollOffset(next);
    FP.playSound('scroll');
    renderAll();
  }

  // Contextual chrome that replaces the drawing-tools column while the
  // picker is open. Placement:
  //   Landscape (tools in right col, top→bottom): slot 1 = prev,
  //     slot 2 = indicator, slot 3 = next. Slots 0, 4–7 stay empty.
  //   Portrait  (tools in top row, left→right):   slot 3 = prev,
  //     slot 4 = indicator, slot 5 = next. Slots 0–2, 6–7 stay empty.
  //   Crayon (single bgFill slot):                indicator + tap-to-advance
  //     (wraps when more than one grid-page).
  //
  // The remaining tool slots are intentionally blank — keeps the drawing
  // tools fully unreachable so taps can't change the brush mid-pick.
  function _renderPickerChrome(layout) {
    const tools = layout.tools;
    if (!tools.length) return;
    const B = layout.B;
    const total = FP.pagePicker.getGridPageCount(layout, state.coloringPages);
    const cur = FP.pagePicker.getScrollOffset();
    const isLandscape = layout.orientation === 'landscape';
    const prevIcon = isLandscape ? 'scrollUp'   : 'scrollLeft';
    const nextIcon = isLandscape ? 'scrollDown' : 'scrollRight';

    const indicatorHtml =
      `<div style="font-size:${Math.round(B*0.26)}px;font-weight:600;color:#333;text-align:center;line-height:1;">` +
      `${cur+1}<br><span style="font-size:${Math.round(B*0.16)}px;opacity:0.6;">of ${total}</span>` +
      `</div>`;

    // Single-slot variant (Crayon): combine indicator + advance-on-tap.
    if (tools.length === 1) {
      const slot = tools[0];
      makeBtn({
        x: slot.x, y: slot.y, size: B,
        indicator: true,
        onTap: total > 1
          ? () => {
              const next = (FP.pagePicker.getScrollOffset() + 1) % total;
              FP.pagePicker.setScrollOffset(next);
              FP.playSound('scroll');
              renderAll();
            }
          : null,
        innerHTML: indicatorHtml,
        ariaLabel: total > 1
          ? `Grid-page ${cur+1} of ${total} (tap to advance)`
          : `Grid-page ${cur+1} of ${total}`,
        extraClass: 'picker-chrome',
      });
      return;
    }

    // 8-slot variants. Pick the slot indices per orientation; for both, the
    // 3 chrome buttons are CONTIGUOUS (the user wanted prev/indicator/next
    // grouped together, not spread across the tools column/row).
    const prevIdx = isLandscape ? 1 : 3;
    const midIdx  = isLandscape ? 2 : 4;
    const nextIdx = isLandscape ? 3 : 5;
    const prevSlot = tools[prevIdx];
    const midSlot  = tools[midIdx];
    const nextSlot = tools[nextIdx];
    if (!prevSlot || !midSlot || !nextSlot) return;   // tools array too short

    makeBtn({
      x: prevSlot.x, y: prevSlot.y, size: B,
      onTap: () => _pickerGridScroll(-1),
      innerHTML: FP.icon(prevIcon, B * 0.44),
      ariaLabel: 'Previous grid-page',
      disabled: cur === 0,
      extraClass: 'picker-chrome',
    });
    makeBtn({
      x: midSlot.x, y: midSlot.y, size: B,
      indicator: true,
      innerHTML: indicatorHtml,
      ariaLabel: `Grid-page ${cur+1} of ${total}`,
      extraClass: 'picker-chrome',
    });
    makeBtn({
      x: nextSlot.x, y: nextSlot.y, size: B,
      onTap: () => _pickerGridScroll(+1),
      innerHTML: FP.icon(nextIcon, B * 0.44),
      ariaLabel: 'Next grid-page',
      disabled: cur >= total - 1,
      extraClass: 'picker-chrome',
    });
  }

  function handleColoringBookToggleTap() {
    state.coloringBookOpen = !state.coloringBookOpen;
    state.coloringConfirmReloadId = null;
    if (!state.coloringBookOpen && FP.pagePicker.isOpen()) {
      // The bookshelf just closed — close the picker too (the picker is a
      // child surface of the bookshelf and can't outlive it).
      FP.pagePicker.close();
    }
    if (state.coloringBookOpen) {
      // Pages for the saved book are reactive — pull the latest before opening.
      _refreshSavedBookPagesIfActive();
      _clampBookshelfScroll();
    }
    FP.playSound('dialogOpen');
    renderAll();
  }

  async function handleColoringBookSwitch(bookId) {
    const pages = await FP.coloringBook.switchBook(bookId);
    state.currentBookId = bookId;
    state.coloringPages = pages;
    // NOTE: do NOT reset state.coloringScrollOffset — that's the BOOKSHELF
    // scroll position (which book is visible), not the picker's scroll. The
    // picker's grid-page scroll (Stage 3) is a separate variable that will
    // reset on book switch.
    state.coloringConfirmReloadId = null;
    renderAll();
  }

  async function handleColoringPageTap(page) {
    // Saved-drawing entry (when viewing the synthetic saved book) — delegate
    // to the existing load/delete flow so behavior matches the saved-drawings
    // strip exactly.
    if (page.isSavedDrawing) {
      await handleThumbTap(page.entry);
      return;
    }

    // Blank canvas entry — load plain white canvas instead
    if (page.isBlank) {
      if (state.currentColoringPageId === page.id) {
        // Already on blank canvas, nothing to do
        return;
      }
      // Coming from a coloring page or drawing: warn on unsaved changes
      if (state.currentColoringPageId) {
        autosaveCurrentColoringPage();
      } else if (!CFG.clearOnly && canvasComp.dirtySinceLoad) {
        const choice = await FP.dialogs.loadWithDirty();
        if (choice === 'cancel' || choice == null) return;
        if (choice === 'save') doSave();
      }
      await loadBlankCanvas();
      return;
    }

    // A different slot was tapped → cancel any pending reload-confirm.
    if (state.coloringConfirmReloadId && state.coloringConfirmReloadId !== page.id) {
      state.coloringConfirmReloadId = null;
    }
    if (state.currentColoringPageId === page.id) {
      // Second tap on the loaded page → arm the reload confirm.
      state.coloringConfirmReloadId = page.id;
      renderAll();
      return;
    }
    if (state.currentColoringPageId) {
      // Switching coloring pages — autosave the outgoing one silently.
      autosaveCurrentColoringPage();
      await loadColoringPage(page);
      return;
    }
    // Coming from a non-coloring drawing: warn on unsaved changes (matches
    // the saved-thumb flow), unless caller is in clearOnly mode where saving
    // isn't an option.
    if (!CFG.clearOnly && canvasComp.dirtySinceLoad) {
      const choice = await FP.dialogs.loadWithDirty();
      if (choice === 'cancel' || choice == null) return;
      if (choice === 'save') doSave();
    }
    await loadColoringPage(page);
  }

  async function handleColoringPageReloadConfirm(page) {
    state.coloringConfirmReloadId = null;
    FP.coloringBook.removeAutosave(page.id);
    await canvasComp.pageFlip(async () => {
      const [img, overlayImg] = await Promise.all([
        FP.coloringBook.loadImage(page),
        FP.coloringBook.loadOverlay(page),
      ]);
      canvasComp.setColoringPage(img, overlayImg, '#ffffff');
      canvasComp.clearDrawing();
    }, PAGE_FLIP_ANIMATION, () => {
      renderAll();
    });
    FP.playSound('deleteDrawing');
  }

  async function loadColoringPage(page) {
    const autosave = FP.coloringBook.getAutosave(page.id);
    // Load the page image (and overlay companion, if present)
    const [img, overlayImg] = await Promise.all([
      FP.coloringBook.loadImage(page),
      FP.coloringBook.loadOverlay(page),
    ]);
    const imgH = Math.round(img.naturalHeight / img.naturalWidth * 1000);  // PAINTING_W = 1000

    await canvasComp.pageFlip(async () => {
      if (autosave && autosave.bgColor) {
        // New layered format: rebuild outline+overlay from page image, apply saved bg + draw.
        canvasComp.setColoringPage(img, overlayImg, autosave.bgColor);
        await canvasComp.setDrawingFromDataUrl(autosave.draw);
      } else if (autosave && autosave.bg) {
        // Legacy: bg was flattened (page outline baked into bg). Use loadLayersFromDataUrls
        // which wipes our new outline/overlay layers and shows the baked composite.
        await canvasComp.loadLayersFromDataUrls(autosave.bg, autosave.draw);
      } else {
        // Fresh load: clean four-layer setup with default white bg.
        canvasComp.setColoringPage(img, overlayImg, '#ffffff');
        canvasComp.clearDrawing();
      }
      // Set page dimensions for aspect-ratio-aware scaling (even for autosaves)
      canvasComp.setPageDimensions(1000, imgH);

      state.currentColoringPageId   = page.id;
      state.coloringConfirmReloadId = null;
      state.loadedDrawingId         = null;
      state.loadedDrawingEntry      = null;
      state.savedJustNow            = false;
      enableBtn('save');

      // Automatically switch to frame view when loading a coloring page
      state.frameMode = true;
    }, PAGE_FLIP_ANIMATION, () => {
      // After page loaded, update rect during animation (before flip-in starts)
      renderAll();
    });
  }

  async function loadBlankCanvas() {
    await canvasComp.pageFlip(async () => {
      // reset() clears all four layers (bg → white, outline + overlay wiped,
      // strokes wiped) and clears page dimensions in one call. We need the
      // full four-layer cleanup here because the user may be transitioning
      // *from* a coloring page whose outline/overlay would otherwise leak.
      canvasComp.reset();
      state.currentColoringPageId   = '__blank-white';  // Mark as blank canvas mode
      state.coloringConfirmReloadId = null;
      state.loadedDrawingId         = null;
      state.loadedDrawingEntry      = null;
      state.savedJustNow            = false;
      enableBtn('save');
      // Automatically switch to frame view
      state.frameMode = true;
    }, PAGE_FLIP_ANIMATION, () => {
      renderAll();
    });
  }

  function autosaveCurrentColoringPage() {
    if (!state.currentColoringPageId) return;
    // Don't autosave the blank canvas — it's transient
    if (state.currentColoringPageId === '__blank-white') return;
    try {
      const page = state.coloringPages.find(p => p.id === state.currentColoringPageId);
      FP.coloringBook.setAutosave(state.currentColoringPageId, {
        bgColor: canvasComp.getBgColor(),
        draw:    canvasComp.toStrokesOnlyDataURL(),
        thumb:   canvasComp.toThumbnailDataURL(),
        name:    page ? page.name : state.currentColoringPageId,
      });
    } catch (e) {
      // Likely a tainted canvas (cross-origin source) — autosave is a best-effort.
      console.warn('coloring autosave skipped', e);
    }
  }

  function _leavingColoringPage() {
    if (!state.currentColoringPageId) return;
    autosaveCurrentColoringPage();
    state.currentColoringPageId   = null;
    state.coloringConfirmReloadId = null;
    // Clear page dimensions when leaving coloring page
    canvasComp.setPageDimensions(null, null);
  }

  // Scrolls the bookshelf overlay (the books + Upload tile in the strip
  // line). Bookshelf items count = books + 1 for Upload in non-Crayon.
  // The max offset is the one where the last item lands in slot n-1
  // (overlaying Clear), with scroll-back visible but scroll-forward hidden.
  function scrollBookshelf(direction) {
    if (!lastLayout) return;
    state.coloringScrollOffset = Math.max(0, Math.min(
      _maxBookshelfScroll(),
      state.coloringScrollOffset + direction));
    FP.playSound('scroll');
    renderAll();
  }

  function _maxBookshelfScroll() {
    const itemCount = state.coloringBooks.length + (CFG.clearOnly ? 0 : 1);
    const totalVisibleSlots = Math.max(0, lastLayout.bookshelfSlotCount - 2);
    if (itemCount <= totalVisibleSlots) return 0;
    // Items always occupy slots 2..n-1; scroll arrows just cover the
    // leftmost/rightmost ones. Max offset = where items[offset..N-1] are
    // exactly totalVisibleSlots items long → the last item is at slot n-1.
    return itemCount - totalVisibleSlots;
  }

  // Migrates autosaves whose source file is no longer in any coloring book's
  // manifest into the regular saved-drawings list. Runs once at boot after
  // discover(). Takes the union of page IDs across every coloring book so
  // autosaves for pages in non-default books aren't falsely "orphaned".
  function migrateOrphanedColoringAutosaves(allPageIds) {
    const present = new Set(allPageIds);
    const ids = FP.coloringBook.allAutosaveIds();
    let moved = 0;
    for (const id of ids) {
      if (present.has(id)) continue;
      const entry = FP.coloringBook.getAutosave(id);
      if (!entry || !entry.bg) {
        FP.coloringBook.removeAutosave(id);
        continue;
      }
      FP.storage.add(entry.bg, entry.draw, entry.thumb || entry.bg);
      FP.coloringBook.removeAutosave(id);
      moved++;
    }
    if (moved > 0) {
      state.saved = FP.storage.list();
      _refreshSavedBookPagesIfActive();
    }
  }
})();

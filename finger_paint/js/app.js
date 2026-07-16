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
    '#444444',     FP.RAINBOW,   // rainbow replaces the light-grey swatch
    '#111111',     '#f5f5f5',    // (near-white stays — it's how you get a
  ];                             //  white-ish background back after a fill)

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
    coloringPages:           [],              // pages of the currently-opened book (used by the page picker)
    pageBgToggleActive:      false,           // Crayon-only: when true, color swatches are page-bg fan icons
  };

  // Expose state so canvas.js (and any other FP module) can read pointerDownOnButton
  FP.state = state;

  // Rendered references
  let canvasComp = null;       // FP.PaintingCanvas instance
  let appRoot    = null;
  let buttonLayer = null;      // div holding all toolbar buttons
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

    // Layers (back to front): painting → buttons (buttons sit on top). The
    // canvas slots neatly between the side/bottom toolbars; no separate
    // panel background layer is needed.
    const paintingWrap = document.createElement('div');
    appRoot.appendChild(paintingWrap);
    canvasComp = new FP.PaintingCanvas(paintingWrap);
    canvasComp.onDirtyChange = onDirtyChange;
    // Re-trigger the current-work autosave debounce after every completed
    // stroke. _setDirty only fires onDirtyChange on the false→true
    // transition, so without this hook the debounce timer would only be
    // armed by the FIRST stroke in a session — subsequent strokes would
    // sit unsaved until the visibilitychange flush, racing the page kill.
    canvasComp.onStrokeEnd = () => autosaveCurrentWork();
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
    // page is no longer in any coloring book's manifest. Once books are
    // available, try to resume from the current-work autosave so the app
    // boots back to wherever the user left off (Stage 6).
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
      try { await resumeCurrentWork(); }
      catch (e) { console.warn('resume failed', e); }
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

    // Page-exit save: flush the current-work mirror synchronously when the
    // tab becomes hidden or is being unloaded. This catches the case where
    // the user paints something and then closes the tab before the dirty-
    // change debounce timer fires. visibilitychange fires reliably on tab
    // switch / minimize / close on every modern browser; pagehide is the
    // backup for browsers that skip visibilitychange on full-tab close.
    function _flushOnExit() {
      try { autosaveCurrentWork({ immediate: true }); }
      catch (_) { /* best-effort */ }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') _flushOnExit();
    });
    window.addEventListener('pagehide', _flushOnExit);

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

    // Canvas rect: framed view uses layout.canvas, or layout.canvasExtended
    // for coloring pages that would be unnecessarily windowboxed in the
    // normal rect (Crayon variant only — see _selectCanvasRect). Full view
    // fills the window.
    const canvasRect = state.frameMode
      ? _selectCanvasRect(layout)
      : { left: 0, top: 0, width: w, height: h };
    canvasComp.setRect(canvasRect, state.frameMode);

    // Clear layers
    buttonLayer.innerHTML = '';

    renderColorSwatches(layout);
    renderTools(layout);
    renderStrip(layout);

    // Page-picker overlay (modal grid + backdrop). Owns its own DOM under
    // a child of #app; appended LAST so its z-index ordering sits below the
    // regular .btn z-index (the color palette and corner buttons stay
    // clickable above the picker's shadow).
    FP.pagePicker.render(appRoot, layout, state.coloringPages);
  }

  // For framed mode: pick between the normal canvas rect and the extended
  // rect (Crayon variant — when the tools area is empty). Use extended only
  // when a coloring page is loaded AND the page would be "too small" in the
  // normal rect (per user spec: vertically shorter than 8 buttons in
  // landscape, horizontally shorter than 8 buttons in portrait).
  function _selectCanvasRect(layout) {
    const normal = layout.canvas;
    const ext    = layout.canvasExtended;
    if (!ext) return normal;
    const pageW = canvasComp.getPageWidth();
    const pageH = canvasComp.getPageHeight();
    if (!pageW || !pageH) return normal;     // no coloring page loaded
    const pageAR = pageW / pageH;
    const eightButtons = layout.B * 8 + layout.G * 7;
    if (layout.orientation === 'landscape') {
      // Page is fit-to-width in normal: height = normal.width / pageAR.
      // Switch to extended when that height is shorter than 8 buttons.
      const heightInNormal = normal.width / pageAR;
      return heightInNormal < eightButtons ? ext : normal;
    } else {
      // Page is fit-to-height in normal: width = normal.height * pageAR.
      const widthInNormal = normal.height * pageAR;
      return widthInNormal < eightButtons ? ext : normal;
    }
  }

  function renderColorSwatches(layout) {
    // The color palette renders in "page-bg picker" mode (fan-of-papers
    // icons over a neutral button) whenever either:
    //   (a) the page picker is open — taps set the picker's PREVIEW color
    //       (composited as Layer 2 on each tile; applied on tile tap).
    //   (b) Crayon's page-bg toggle is on — taps FILL the current page bg
    //       immediately (the toggle stays on until tapped again).
    // Otherwise, the regular paint-color swatches render.
    const pickerOpen = FP.pagePicker.isOpen();
    const bgMode    = pickerOpen || state.pageBgToggleActive;
    if (bgMode) {
      layout.colors.forEach(s => {
        const color = state.palette[s.idx];
        const isRainbow = FP.rainbow.isRainbow(color);
        const onTap = pickerOpen
          ? () => handleBgColorPickerTap(s.idx)
          : () => handlePageBgDirectTap(s.idx);
        makeBtn({
          x: s.x, y: s.y, size: layout.B,
          bg: '#f5f3ee',              // matches #app background
          onTap,
          innerHTML: isRainbow
            ? FP.pageFanMulticolorIcon(layout.B * 0.7)
            : FP.pageFanIcon(color, layout.B * 0.7),
          ariaLabel: isRainbow ? 'Rainbow page background' : `Page background color ${s.idx + 1}`,
        });
      });
      return;
    }
    layout.colors.forEach(s => {
      const color = state.palette[s.idx];
      const isRainbow = FP.rainbow.isRainbow(color);
      const isActive = s.idx === state.activeColorIdx;
      const btn = makeBtn({
        x: s.x, y: s.y, size: layout.B,
        // Rainbow swatch shows a colour wheel; pass color:null so it isn't
        // treated as a solid (light-colour) swatch.
        bg: isRainbow ? FP.rainbow.cssGradient() : color,
        color: isRainbow ? null : color,
        active: isActive,
        isColorSwatch: true,
        onTap: () => handleColorTap(s.idx),
        ariaLabel: isRainbow ? 'Rainbow' : `Color ${s.idx + 1}`,
      });
      if (isActive) {
        btn.insertAdjacentHTML('beforeend', FP.activeMark(layout.B));
      }
    });
  }

  // Picker-only handler: stores the preview color on the picker. Tile
  // rendering re-tints (Layer 2); on tile tap the preview is passed as a
  // bgColorOverride and applied at load time.
  function handleBgColorPickerTap(idx) {
    FP.pagePicker.setPreviewBgColor(state.palette[idx]);
    FP.playSound('colorPick', state.palette[idx]);
    renderAll();
  }

  // Crayon page-bg toggle: flips swatches between paint mode and bg-color
  // mode. Stays on until tapped again — the user can pick several colors
  // in a row without re-entering the mode.
  function handlePageBgToggleTap() {
    state.pageBgToggleActive = !state.pageBgToggleActive;
    FP.playSound('dialogOpen');
    renderAll();
  }

  // Tap a fan swatch while the Crayon page-bg toggle is on — fills the
  // current page bg with that color (same effect as the old bgFill tool,
  // but with the user picking the color rather than using the active paint
  // color). After setting the background, automatically toggle back to
  // brush color mode.
  function handlePageBgDirectTap(idx) {
    const color = state.palette[idx];
    const onColoringPage = !!state.currentColoringPageId
      && state.currentColoringPageId !== '__blank-white';
    if (!onColoringPage) _leavingColoringPage();
    canvasComp.fillBackground(color);
    if (onColoringPage) autosaveCurrentColoringPage();
    else { onCanvasContentChanged(); autosaveCurrentWork({ immediate: true }); }
    FP.playSound('bgFill');
    state.pageBgToggleActive = false;
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

    // Slot 0: Save (non-Crayon) or page-bg toggle (Crayon).
    //
    // Non-Crayon: standard Save / Download button. Drops behind the picker
    //   backdrop when the picker is open (the bookshelf is the active
    //   surface; Save shouldn't fire while picking).
    //
    // Crayon: this slot replaces the old bgFill tool. Tapping toggles the
    //   color swatches between paint mode and page-bg mode (fan-of-papers
    //   icons that fill the page bg when tapped — same UX as the picker's
    //   bg-color swatches). Hidden when the picker is open since the
    //   picker provides its own bg-color selection.
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
    } else if (!pickerOpen) {
      makeBtn({
        x: layout.saveXY.x, y: layout.saveXY.y, size: B,
        accent: true,
        active: state.pageBgToggleActive,
        onTap: handlePageBgToggleTap,
        innerHTML: FP.pageFanMulticolorIcon(B * 0.6),
        ariaLabel: state.pageBgToggleActive
          ? 'Exit page background mode'
          : 'Choose a page background color',
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
      // When the picker is open, Clear drops behind the lightbox (z 2) so
      // it can't fire — the user shouldn't be able to wipe the canvas
      // mid-pick. The lightbox catches the tap and closes the picker. When
      // only the bookshelf (no picker) is open, Clear stays interactive but
      // dimmed and its tap closes the bookshelf.
      const pickerOpen = FP.pagePicker.isOpen();
      const extras = [];
      if (open && !pickerOpen) extras.push('inactive');
      if (pickerOpen)          extras.push('picker-below');
      makeBtn({
        x: layout.clearXY.x, y: layout.clearXY.y, size: B,
        accent: true,
        onTap: open ? handleColoringBookToggleTap : handleClearTap,
        innerHTML: FP.icon('clear', B * 0.44),
        ariaLabel: open ? 'Close bookshelf' : 'Clear drawing',
        extraClass: extras.length ? extras.join(' ') : null,
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
    if (extraClass) extraClass.split(/\s+/).filter(Boolean).forEach(c => b.classList.add(c));
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
    // Auto-switch to opposite column color (flip LSB) for drawing contrast —
    // but keep Rainbow selected so a rainbow fill flows straight into rainbow
    // drawing (flipping to a solid neighbour would break the combo).
    if (!FP.rainbow.isRainbow(c)) {
      state.activeColorIdx = state.activeColorIdx ^ 1;
      canvasComp.setColor(state.palette[state.activeColorIdx]);
    }
    if (onColoringPage) {
      autosaveCurrentColoringPage();
    } else {
      onCanvasContentChanged();
      autosaveCurrentWork();
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
      // Plain-canvas Clear → wipe the current-work mirror so a reload boots
      // fresh (not back into the cleared strokes).
      clearCurrentWork();
      FP.playSound('deleteDrawing');
      return;
    }
    // On a coloring page: wipe strokes but preserve the chosen bg color,
    // outline, and overlay. (Stage 4: the old double-tap-to-reset path is
    // gone — users can erase + bgFill to clean up.) The per-page autosave
    // is updated to mirror the cleared state; current-work just tracks the
    // pointer (which page we're on) so reload re-loads this page.
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
    // Reached when we cleared a loaded saved drawing or a plain dirty
    // canvas — either way the live state is now empty; clear the mirror.
    clearCurrentWork();
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
    // v3 entry shape: { bgColor, draw, thumb }. The bg layer is the canvas's
    // current solid fill (uploaded image backgrounds collapse to their corner
    // color — accepted loss). The draw layer is full transparent content
    // (strokes + overlay for coloring pages). The thumb is the transparent
    // version so the picker's 3-layer compositing can swap the bg under
    // preview color.
    const bgColor = canvasComp.getBgColor();
    const draw    = canvasComp.toDrawingDataURL();
    const thumb   = canvasComp.toTransparentThumbnailDataURL();
    FP.storage.add(bgColor, draw, thumb);
    state.saved = FP.storage.list();
    _refreshSavedBookPagesIfActive();
    state.savedJustNow = true;
    canvasComp.markSaved();  // reset dirty so next stroke re-triggers onDirtyChange
    if (state.isFullscreen) disableBtn('save');  // no re-saving until drawing changes
    // Per the redesign plan: explicit Save UPDATES the current-work mirror
    // (does NOT clear it) — reload-resume should pick up where the user is.
    autosaveCurrentWork({ immediate: true });
    FP.playSound('saveDrawing');
    renderAll();
  }

  async function handleThumbTap(entry, bgColorOverride) {
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
      // Live canvas still shows the (now-deleted) drawing's content; mirror
      // it to current-work so reload boots into the same view.
      autosaveCurrentWork({ immediate: true });
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
      // Load this drawing onto the canvas (with page flip). The
      // bgColorOverride (Stage 4 preview color, if set) replaces the entry's
      // stored bgColor for this load only — the stored row is unchanged.
      await canvasComp.pageFlip(async () => {
        await _loadSavedEntry(entry, bgColorOverride);
        state.loadedDrawingId = entry.id;
        state.loadedDrawingEntry = entry;
        state.savedJustNow    = true;  // show download button for the loaded drawing
        // Saved drawings load in full view (canvas fills the available
        // area) — frameMode unified per Stage 4.
        state.frameMode = false;
        // Do NOT re-enable save button — loaded drawing is already saved
      }, PAGE_FLIP_ANIMATION, () => {
        renderAll();
      });
      autosaveCurrentWork({ immediate: true });
    }
  }

  // Loads a v3 saved entry onto the canvas. v1/v2 entries are auto-migrated
  // to v3 during FP.storage.init() (corner-sampled bgColor, draw layer
  // preserved as-is) so by the time we get here every entry has a bgColor
  // and (usually) a draw layer.
  //
  // `bgColorOverride` (Stage 4 preview): if set, replaces the entry's stored
  // bgColor for this load only. The stored entry is unchanged.
  function _loadSavedEntry(entry, bgColorOverride) {
    const bgColor = bgColorOverride || entry.bgColor || '#ffffff';
    return canvasComp.loadLayersFromColorAndDraw(bgColor, entry.draw);
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
    // Mirror to current-work so a reload comes back with the uploaded bg
    // (or as much as v3 storage's bgColor-only field can capture — uploaded
    // image bgs collapse to a sampled color, accepted loss per the plan).
    autosaveCurrentWork({ immediate: true });
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
      // (The bookshelf is auto-collapsed by the document-level pointerdown
      // listener in init() — any pointerdown outside the bookshelf row
      // closes it. The first stroke's pointerdown on the canvas triggers
      // that listener BEFORE onDirtyChange fires, so we don't need a
      // mode-specific close here.)
      onCanvasContentChanged();
      // Debounced mirror of the live canvas to the current-work autosave.
      autosaveCurrentWork();
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
    // Autosave the current coloring page (if any) BEFORE opening the picker
    // so its tile thumbnail reflects the user's current state. Cheap; no-op
    // when not on a coloring page or when on the blank canvas. Also flush
    // the current-work mirror so reload-resume captures pre-pick state.
    autosaveCurrentColoringPage();
    autosaveCurrentWork({ immediate: true });
    // Switch to this book's pages and open the picker over the canvas.
    const pages = await FP.coloringBook.switchBook(bookId);
    state.currentBookId = bookId;
    state.coloringPages = pages;
    FP.pagePicker.open(bookId);
    renderAll();
  }

  // Tile tap inside the picker — close the picker, then delegate to the
  // existing per-page-type load flow. Closing FIRST means the page-flip
  // animation runs on a clean canvas (no picker-grid still painted on top).
  //
  // If the tapped tile is ALREADY the loaded content, just close the picker
  // (no reload, no delete dialog — the × badge is the delete affordance).
  //
  // The picker's preview color (set by tapping a bg-color fan icon while
  // the picker is open) is passed through as `bgColorOverride` to the load
  // path — for coloring pages it wins over the autosaved bgColor and gets
  // written back; for saved drawings it replaces the bg for this load only.
  async function handlePickerTileTap(page) {
    const loadedId = state.loadedDrawingId
      ? 'saved:' + state.loadedDrawingId
      : state.currentColoringPageId;
    const bgColorOverride = FP.pagePicker.getPreviewBgColor();
    if (page.id === loadedId && !bgColorOverride) {
      FP.pagePicker.close();
      renderAll();
      return;
    }
    FP.pagePicker.close();
    renderAll();
    await handleColoringPageTap(page, bgColorOverride);
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
  //   Crayon (tools column empty — bgFill is replaced by the page-bg
  //          toggle in Save's slot): a single combined indicator at the
  //          MIDDLE chrome position (right side / top-middle), same place
  //          the non-Crayon indicator would sit.
  //
  // Chrome positions come from layout (pickerChromePrev/Mid/NextXY) not
  // from layout.tools[i], so Crayon's empty toolOrder doesn't move them.
  function _renderPickerChrome(layout) {
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

    const isCrayon = !!CFG.clearOnly;

    // Crayon: single combined indicator (tap-to-advance, wraps) at the
    // middle chrome slot. Right side in landscape, top-middle in portrait.
    if (isCrayon) {
      const p = layout.pickerChromeMidXY;
      makeBtn({
        x: p.x, y: p.y, size: B,
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

    // Non-Crayon: prev / indicator / next at three contiguous chrome slots.
    const prev = layout.pickerChromePrevXY;
    const mid  = layout.pickerChromeMidXY;
    const next = layout.pickerChromeNextXY;
    makeBtn({
      x: prev.x, y: prev.y, size: B,
      onTap: () => _pickerGridScroll(-1),
      innerHTML: FP.icon(prevIcon, B * 0.44),
      ariaLabel: 'Previous grid-page',
      disabled: cur === 0,
      extraClass: 'picker-chrome',
    });
    makeBtn({
      x: mid.x, y: mid.y, size: B,
      indicator: true,
      innerHTML: indicatorHtml,
      ariaLabel: `Grid-page ${cur+1} of ${total}`,
      extraClass: 'picker-chrome',
    });
    makeBtn({
      x: next.x, y: next.y, size: B,
      onTap: () => _pickerGridScroll(+1),
      innerHTML: FP.icon(nextIcon, B * 0.44),
      ariaLabel: 'Next grid-page',
      disabled: cur >= total - 1,
      extraClass: 'picker-chrome',
    });
  }

  function handleColoringBookToggleTap() {
    state.coloringBookOpen = !state.coloringBookOpen;
    if (!state.coloringBookOpen && FP.pagePicker.isOpen()) {
      // The bookshelf just closed — close the picker too (the picker is a
      // child surface of the bookshelf and can't outlive it).
      FP.pagePicker.close();
    }
    if (state.coloringBookOpen) {
      // Autosave current state so picker thumbnails reflect what's on canvas
      // (for coloring pages) and so the current-work mirror is up-to-date
      // (for everything else) before the user starts navigating.
      autosaveCurrentColoringPage();
      autosaveCurrentWork({ immediate: true });
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
    // scroll position (which book is visible), not the picker's grid-page
    // scroll (those are separate variables; the picker resets its own
    // offset on switch via open()).
    renderAll();
  }

  // Called from the picker when the user taps a tile (the picker already
  // short-circuits same-tile taps so we know `page` is something new). The
  // `bgColorOverride` is the picker's preview color (Stage 4): if set, it
  // replaces the saved bgColor at load time. For coloring pages, the
  // override is also written back to the page's autosave so the next reload
  // remembers it.
  async function handleColoringPageTap(page, bgColorOverride) {
    if (page.isSavedDrawing) {
      await handleThumbTap(page.entry, bgColorOverride);
      return;
    }
    if (page.isBlank) {
      // Coming from a coloring page or drawing: autosave or prompt.
      if (state.currentColoringPageId) {
        autosaveCurrentColoringPage();
      } else if (!CFG.clearOnly && canvasComp.dirtySinceLoad) {
        const choice = await FP.dialogs.loadWithDirty();
        if (choice === 'cancel' || choice == null) return;
        if (choice === 'save') doSave();
      }
      await loadBlankCanvas(bgColorOverride);
      return;
    }
    if (state.currentColoringPageId) {
      // Switching coloring pages — autosave the outgoing one silently.
      autosaveCurrentColoringPage();
      await loadColoringPage(page, bgColorOverride);
      return;
    }
    // Coming from a non-coloring drawing: warn on unsaved changes.
    if (!CFG.clearOnly && canvasComp.dirtySinceLoad) {
      const choice = await FP.dialogs.loadWithDirty();
      if (choice === 'cancel' || choice == null) return;
      if (choice === 'save') doSave();
    }
    await loadColoringPage(page, bgColorOverride);
  }

  async function loadColoringPage(page, bgColorOverride) {
    const autosave = FP.coloringBook.getAutosave(page.id);
    // Load the page image (and overlay companion, if present)
    const [img, overlayImg] = await Promise.all([
      FP.coloringBook.loadImage(page),
      FP.coloringBook.loadOverlay(page),
    ]);
    const imgH = Math.round(img.naturalHeight / img.naturalWidth * 1000);  // PAINTING_W = 1000

    // Bg color precedence: explicit override (preview) > autosave > white.
    const bgColor = bgColorOverride
      || (autosave && autosave.bgColor)
      || '#ffffff';

    await canvasComp.pageFlip(async () => {
      canvasComp.setColoringPage(img, overlayImg, bgColor);
      if (autosave && autosave.draw) {
        await canvasComp.setDrawingFromDataUrl(autosave.draw);
      } else {
        canvasComp.clearDrawing();
      }
      // Set page dimensions for aspect-ratio-aware scaling (even for autosaves)
      canvasComp.setPageDimensions(1000, imgH);

      state.currentColoringPageId   = page.id;
      state.loadedDrawingId         = null;
      state.loadedDrawingEntry      = null;
      state.savedJustNow            = false;
      enableBtn('save');

      // Coloring pages always load in framed view (regardless of mode) —
      // the framing matches the page's aspect ratio.
      state.frameMode = true;
    }, PAGE_FLIP_ANIMATION, () => {
      // After page loaded, update rect during animation (before flip-in starts)
      renderAll();
    });

    // If the user previewed a different bg color, persist it into the
    // autosave so the next reload of this page remembers it. Otherwise
    // still mirror the pointer to current-work so resume-on-reload re-loads
    // this page.
    if (bgColorOverride) autosaveCurrentColoringPage();
    else                 autosaveCurrentWork({ immediate: true });
  }

  async function loadBlankCanvas(bgColorOverride) {
    const bgColor = bgColorOverride || '#ffffff';
    await canvasComp.pageFlip(async () => {
      // reset() clears all four layers and page dimensions. We need the
      // full four-layer cleanup here because the user may be transitioning
      // *from* a coloring page whose outline/overlay would otherwise leak.
      canvasComp.reset();
      if (bgColor !== '#ffffff') canvasComp.fillBackground(bgColor);
      state.currentColoringPageId = '__blank-white';
      state.loadedDrawingId       = null;
      state.loadedDrawingEntry    = null;
      state.savedJustNow          = false;
      enableBtn('save');
      // Blank canvas loads in full view (canvas fills the available area).
      // frameMode unified per Stage 4 — only coloring pages go framed.
      state.frameMode = false;
    }, PAGE_FLIP_ANIMATION, () => {
      renderAll();
    });
    autosaveCurrentWork({ immediate: true });
  }

  // Synchronous writer for the per-coloring-page autosave (called from the
  // unified _writeCurrentWork below when the canvas is showing a coloring
  // page). Captures bgColor + strokes + thumb directly from the canvas.
  function _writeColoringPageAutosave() {
    if (!state.currentColoringPageId) return;
    if (state.currentColoringPageId === '__blank-white') return;
    try {
      const page = state.coloringPages.find(p => p.id === state.currentColoringPageId);
      FP.coloringBook.setAutosave(state.currentColoringPageId, {
        bgColor: canvasComp.getBgColor(),
        draw:    canvasComp.toStrokesOnlyDataURL(),
        // Transparent thumb (outline + draw + overlay, no bg fill) so the
        // page picker's 3-layer compositing can swap bg under preview color.
        thumb:   canvasComp.toTransparentThumbnailDataURL(),
        name:    page ? page.name : state.currentColoringPageId,
      });
    } catch (e) {
      // Likely a tainted canvas (cross-origin source) — autosave is a best-effort.
      console.warn('coloring autosave skipped', e);
    }
  }

  // Backward-compat shim — callers that want to "save the current coloring
  // page right now" just flush the unified autosave. Both the per-page
  // store and the current-work mirror get written.
  function autosaveCurrentColoringPage() {
    if (!state.currentColoringPageId) return;
    if (state.currentColoringPageId === '__blank-white') return;
    autosaveCurrentWork({ immediate: true });
  }

  function _leavingColoringPage() {
    if (!state.currentColoringPageId) return;
    autosaveCurrentColoringPage();
    state.currentColoringPageId   = null;
    // Clear page dimensions when leaving coloring page
    canvasComp.setPageDimensions(null, null);
  }

  // ── Current-work autosave (Stage 6: resume-on-reload) ──────────

  // Build the current-work payload from live state + canvas. For coloring
  // pages we record only the pointer (currentColoringPageId) — the per-
  // coloring-page autosave already has the content layers. For everything
  // else (blank canvas, loaded saved drawing, dirty plain canvas) we also
  // capture bgColor + draw + thumb so the modified state survives reload.
  function _buildCurrentWorkEntry() {
    const onColoringPage = !!state.currentColoringPageId
      && state.currentColoringPageId !== '__blank-white';
    if (onColoringPage) {
      return {
        frameMode: state.frameMode,
        currentColoringPageId: state.currentColoringPageId,
        loadedDrawingId: null,
        bgColor: null, draw: null, thumb: null,
      };
    }
    let bgColor = null, draw = null, thumb = null;
    try {
      bgColor = canvasComp.getBgColor();
      draw    = canvasComp.toDrawingDataURL();
      thumb   = canvasComp.toTransparentThumbnailDataURL();
    } catch (_) { /* tainted canvas — leave null */ }
    return {
      frameMode: state.frameMode,
      currentColoringPageId: state.currentColoringPageId,   // may be '__blank-white' or null
      loadedDrawingId: state.loadedDrawingId || null,
      bgColor, draw, thumb,
    };
  }

  // Debounced write of the current-work mirror. Pass `immediate: true` to
  // bypass the timer (e.g. just before opening the bookshelf/picker so the
  // mirror reflects the freshest state).
  let _currentWorkTimer = null;
  // Short debounce: long enough to coalesce a flurry of quick strokes into
  // a single IDB write, short enough that the gap between "last stroke
  // ended" and "write committed" is small — so the visibilitychange flush
  // rarely has work to do (the page-kill race is real even for sync IDB).
  const CURRENT_WORK_DEBOUNCE_MS = 500;
  function autosaveCurrentWork(opts) {
    const immediate = !!(opts && opts.immediate);
    if (immediate) {
      if (_currentWorkTimer) { clearTimeout(_currentWorkTimer); _currentWorkTimer = null; }
      _writeCurrentWork();
      return;
    }
    if (_currentWorkTimer) clearTimeout(_currentWorkTimer);
    _currentWorkTimer = setTimeout(() => {
      _currentWorkTimer = null;
      _writeCurrentWork();
    }, CURRENT_WORK_DEBOUNCE_MS);
  }
  function _writeCurrentWork() {
    // For coloring pages the per-page autosave is the authoritative store
    // for the content (strokes + bgColor); the current-work mirror just
    // tracks the pointer. Both writes happen on the same debounced flush
    // so a single onStrokeEnd persists everything reload-resume needs.
    if (state.currentColoringPageId && state.currentColoringPageId !== '__blank-white') {
      _writeColoringPageAutosave();
    }
    try { FP.storage.currentWork.write(_buildCurrentWorkEntry()); }
    catch (e) { console.warn('current-work write skipped', e); }
  }
  function clearCurrentWork() {
    if (_currentWorkTimer) { clearTimeout(_currentWorkTimer); _currentWorkTimer = null; }
    try { FP.storage.currentWork.clear(); }
    catch (_) { /* best-effort */ }
  }

  // Restore the canvas + state from the current-work mirror. Called once at
  // boot after coloring books have been discovered. Returns true if the
  // canvas was actually restored to something non-default; false otherwise
  // (boot continues with the default fresh canvas).
  async function resumeCurrentWork() {
    let entry;
    try { entry = await FP.storage.currentWork.read(); }
    catch (_) { return false; }
    if (!entry) return false;

    // Case 1: a coloring page was loaded — re-load it; the per-page
    // autosave has the content (strokes + bgColor).
    const pid = entry.currentColoringPageId;
    if (pid && pid !== '__blank-white') {
      const page = await FP.coloringBook.findPageById(pid);
      if (page) {
        try {
          // Direct load (no page-flip animation — boot should feel instant).
          await _directLoadColoringPage(page);
          // findPageById may have switched the book; sync state so the
          // bookshelf highlights it correctly when the user opens it.
          state.currentBookId = page.bookId || FP.coloringBook.getCurrentBookId();
          state.coloringPages = FP.coloringBook.list();
          return true;
        } catch (_) { /* fall through to default boot */ }
      }
    }

    // Case 2: a saved drawing was loaded (possibly with unsaved edits).
    // Prefer the current-work content (the edits) over the entry's stored
    // content; fall back to the entry's stored content if we don't have
    // current-work layers.
    if (entry.loadedDrawingId) {
      const savedEntry = FP.storage.get(entry.loadedDrawingId);
      if (savedEntry) {
        const bgColor = entry.bgColor || savedEntry.bgColor || '#ffffff';
        const draw    = entry.draw    || savedEntry.draw    || null;
        try {
          await canvasComp.loadLayersFromColorAndDraw(bgColor, draw);
          state.loadedDrawingId    = savedEntry.id;
          state.loadedDrawingEntry = savedEntry;
          state.savedJustNow       = true;       // show Download in non-Crayon
          state.currentColoringPageId = null;
          state.frameMode = !!entry.frameMode;
          return true;
        } catch (_) { /* fall through */ }
      }
    }

    // Case 3: blank canvas (possibly with strokes the user hadn't saved).
    if (entry.bgColor || entry.draw) {
      try {
        await canvasComp.loadLayersFromColorAndDraw(entry.bgColor || '#ffffff', entry.draw);
        state.currentColoringPageId = '__blank-white';
        state.loadedDrawingId    = null;
        state.loadedDrawingEntry = null;
        state.savedJustNow       = false;
        state.frameMode = !!entry.frameMode;
        return true;
      } catch (_) { /* fall through */ }
    }

    return false;
  }

  // Direct (no page-flip animation) load of a coloring page. Used by the
  // boot-time resume path; shares its core logic with loadColoringPage.
  async function _directLoadColoringPage(page, bgColorOverride) {
    const autosave = FP.coloringBook.getAutosave(page.id);
    const [img, overlayImg] = await Promise.all([
      FP.coloringBook.loadImage(page),
      FP.coloringBook.loadOverlay(page),
    ]);
    const imgH = Math.round(img.naturalHeight / img.naturalWidth * 1000);
    const bgColor = bgColorOverride || (autosave && autosave.bgColor) || '#ffffff';
    canvasComp.setColoringPage(img, overlayImg, bgColor);
    if (autosave && autosave.draw) await canvasComp.setDrawingFromDataUrl(autosave.draw);
    else canvasComp.clearDrawing();
    canvasComp.setPageDimensions(1000, imgH);
    state.currentColoringPageId   = page.id;
    state.loadedDrawingId         = null;
    state.loadedDrawingEntry      = null;
    state.savedJustNow            = false;
    enableBtn('save');
    state.frameMode               = true;
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

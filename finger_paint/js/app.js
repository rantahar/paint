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
    scrollOffset:   0,                        // index of first visible thumbnail
    loadedDrawingId: null,                    // currently loaded saved drawing (id) — flipped to null on any change
    loadedDrawingEntry: null,                 // the full saved-drawing entry (bg/draw/thumb) — used to recompose for download
    savedJustNow:   false,                    // toggled true after Save; false on any change
    frameMode:      CFG.frameMode !== undefined ? CFG.frameMode : true,  // true = Frame Mode (drawing inside toolbars), false = Expanded Mode (buttons hover)
    isFullscreen:   false,                    // actual fullscreen via F11/Ctrl+F
    disabledButtons: new Set(),               // button IDs to disable (e.g., 'upload', 'download' in fullscreen)
    pointerDownOnButton: new Set(),           // tracks pointerIds that had pointerdown on buttons (for tap-drag to canvas)

    // Coloring-book state
    coloringBookOpen:        false,           // strip rendered in place of save bar
    currentColoringPageId:   null,            // page currently loaded on canvas (if any)
    coloringScrollOffset:    0,
    coloringConfirmReloadId: null,            // page whose slot is showing "reload" confirm
    coloringPages:           [],              // discovered pages (from coloringBook.discover())
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

    // Handle ?deletealldrawings=true URL parameter
    const params = new URLSearchParams(window.location.search);
    if (params.get('deletealldrawings') === 'true') {
      await _deleteAllDrawings();
      // Remove the query param and reload
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    // Load saved drawings
    state.saved = FP.storage.list();

    if (CFG.toolOrder) FP.toolOrder = CFG.toolOrder;

    // Discover coloring pages and migrate any orphaned autosaves
    // (autosaves whose source PNG is no longer in coloring-pages/).
    FP.coloringBook.discover().then(pages => {
      state.coloringPages = pages;
      migrateOrphanedColoringAutosaves(pages);
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

    // Reposition canvas based on frame mode
    let canvasRect = state.frameMode ? layout.canvas : { left: 0, top: 0, width: w, height: h };

    // In Crayon mode, use full window in one axis (applies to all content: coloring pages, blank, etc)
    // Landscape: full height, constrained width. Portrait: full width, constrained height
    if (CFG.clearOnly && state.frameMode) {
      if (layout.orientation === 'landscape') {
        canvasRect = { left: layout.canvas.left, top: layout.canvas.top, width: layout.canvas.width, height: h };
      } else {
        canvasRect = { left: layout.canvas.left, top: layout.canvas.top, width: w, height: layout.canvas.height };
      }
    }

    canvasComp.setRect(canvasRect, state.frameMode);

    // Clear layers
    panelLayer.innerHTML  = '';
    buttonLayer.innerHTML = '';

    // In Crayon mode, never show the toolbar panel backgrounds
    if (state.frameMode && !CFG.clearOnly) {
      renderPanels(layout);
    }
    renderColorSwatches(layout);
    renderTools(layout);
    if (layout.orientation === 'landscape') renderBottomRow(layout);
    else                                    renderRightCol(layout);
  }

  function renderPanels(layout) {
    layout.panels.forEach((p, idx) => {
      // In Crayon mode, always skip the save bar panel background (last panel in layout.panels)
      // This applies to all content types (coloring pages, regular backgrounds, blank canvas)
      if (CFG.clearOnly && idx === layout.panels.length - 1) return;

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

  function renderTools(layout) {
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

  function renderBottomRow(layout) {
    const r = layout.bottomRow;
    const B = layout.B;
    const bookToggleVisible = _bookToggleVisible();

    if (state.coloringBookOpen) {
      // Strip mode: book toggle at col 0, coloring strip across the middle,
      // clear at the rightmost col. Save/upload/regular thumbs hidden.
      _renderBookToggle({ x: r.uploadXY.x, y: r.uploadXY.y, size: B, active: true });
      _renderColoringStripLandscape(layout);
    } else if (!CFG.clearOnly) {
      // Upload (col 0) — or book toggle if fullscreen
      if (bookToggleVisible) {
        _renderBookToggle({ x: r.uploadXY.x, y: r.uploadXY.y, size: B, active: false });
      } else {
        makeBtn({
          x: r.uploadXY.x, y: r.uploadXY.y, size: B,
          onTap: handleUploadTap,
          innerHTML: FP.icon('upload', B * 0.44),
          ariaLabel: 'Upload background',
          disabled: state.disabledButtons.has('upload'),
        });
      }

      // Save / Download-All (col 1)
      // In fullscreen: always show save, disable when already saved (no re-saving, no download)
      const showDl = state.savedJustNow && !state.isFullscreen;
      makeBtn({
        x: r.saveXY.x, y: r.saveXY.y, size: B,
        accent: true,
        onTap: handleSaveOrDownloadAll,
        innerHTML: FP.icon(showDl ? 'download' : 'save', B * 0.44),
        ariaLabel: showDl ? 'Download all' : 'Save drawing',
        disabled: state.disabledButtons.has('save'),
      });

      // Scroll arrows (if overflow)
      if (r.hasOverflow) {
        makeBtn({
          x: r.scrollLeftXY.x, y: r.scrollLeftXY.y, size: B,
          onTap: () => scrollSaved(-1),
          innerHTML: FP.icon('scrollLeft', B * 0.44),
          ariaLabel: 'Scroll left',
        });
        makeBtn({
          x: r.scrollRightXY.x, y: r.scrollRightXY.y, size: B,
          onTap: () => scrollSaved(+1),
          innerHTML: FP.icon('scrollRight', B * 0.44),
          ariaLabel: 'Scroll right',
        });
      }

      // Thumbnails
      const visibleSaved = state.saved.slice(state.scrollOffset,
                                              state.scrollOffset + r.maxVisible);
      visibleSaved.forEach((entry, i) => {
        const x = r.thumbXs[i];
        if (x == null) return;
        renderThumb(entry, x, r.uploadXY.y, B);
      });
    } else {
      // clearOnly (crayon mode), strip closed: just the book toggle.
      if (bookToggleVisible) {
        _renderBookToggle({ x: r.uploadXY.x, y: r.uploadXY.y, size: B, active: false });
      }
    }

    // Clear (rightmost)
    makeBtn({
      x: r.clearXY.x, y: r.clearXY.y, size: B,
      accent: true,
      onTap: handleClearTap,
      innerHTML: FP.icon('clear', B * 0.44),
      ariaLabel: 'Clear drawing',
    });
  }

  function renderRightCol(layout) {
    const r = layout.rightCol;
    const B = layout.B;
    const bookToggleVisible = _bookToggleVisible();

    // Clear (top)
    makeBtn({
      x: r.clearXY.x, y: r.clearXY.y, size: B,
      accent: true,
      onTap: handleClearTap,
      innerHTML: FP.icon('clear', B * 0.44),
      ariaLabel: 'Clear drawing',
    });

    if (state.coloringBookOpen) {
      _renderBookToggle({ x: r.uploadXY.x, y: r.uploadXY.y, size: B, active: true });
      _renderColoringStripPortrait(layout);
    } else if (!CFG.clearOnly) {
      // Save / Download-All
      const showDl = state.savedJustNow && !state.isFullscreen;
      makeBtn({
        x: r.saveXY.x, y: r.saveXY.y, size: B,
        accent: true,
        onTap: handleSaveOrDownloadAll,
        innerHTML: FP.icon(showDl ? 'download' : 'save', B * 0.44),
        ariaLabel: showDl ? 'Download all' : 'Save drawing',
        disabled: state.disabledButtons.has('save'),
      });

      // Upload (bottom) — or book toggle if fullscreen
      if (bookToggleVisible) {
        _renderBookToggle({ x: r.uploadXY.x, y: r.uploadXY.y, size: B, active: false });
      } else {
        makeBtn({
          x: r.uploadXY.x, y: r.uploadXY.y, size: B,
          onTap: handleUploadTap,
          innerHTML: FP.icon('upload', B * 0.44),
          ariaLabel: 'Upload background',
          disabled: state.disabledButtons.has('upload'),
        });
      }

      // Scroll arrows — up (near Clear) shows older; down (near Save) shows newer
      if (r.hasOverflow) {
        makeBtn({
          x: r.scrollUpXY.x, y: r.scrollUpXY.y, size: B,
          onTap: () => scrollSaved(+1),
          innerHTML: FP.icon('scrollUp', B * 0.44),
          ariaLabel: 'Scroll up',
        });
        makeBtn({
          x: r.scrollDownXY.x, y: r.scrollDownXY.y, size: B,
          onTap: () => scrollSaved(-1),
          innerHTML: FP.icon('scrollDown', B * 0.44),
          ariaLabel: 'Scroll down',
        });
      }

      // Thumbnails — thumb[0] is most-recent at the BOTTOM of strip
      const visibleSaved = state.saved.slice(state.scrollOffset,
                                              state.scrollOffset + r.maxVisible);
      visibleSaved.forEach((entry, i) => {
        const y = r.thumbYs[i];
        if (y == null) return;
        renderThumb(entry, r.uploadXY.x, y, B);
      });
    } else {
      // clearOnly (crayon mode), strip closed: just the book toggle.
      if (bookToggleVisible) {
        _renderBookToggle({ x: r.uploadXY.x, y: r.uploadXY.y, size: B, active: false });
      }
    }
  }

  function _bookToggleVisible() {
    // Visible whenever there are pages to choose from AND:
    //   • crayon mode (always)
    //   • fullscreen (replaces upload, which is disabled there)
    //   • the strip is currently open
    if (state.coloringBookOpen) return state.coloringPages.length > 0;
    if (state.coloringPages.length === 0) return false;
    return CFG.clearOnly || state.isFullscreen;
  }

  function _renderBookToggle({ x, y, size, active }) {
    makeBtn({
      x, y, size,
      active,
      onTap: handleColoringBookToggleTap,
      innerHTML: FP.icon('book', size * 0.44),
      ariaLabel: active ? 'Close coloring book' : 'Open coloring book',
    });
  }

  /**
   * Coloring strip layout for landscape: cols 1..numCols-2 inclusive.
   * Total slots = numCols - 2. With overflow we reserve cols 1 and
   * numCols-2 for scroll arrows; thumbs occupy cols 2..numCols-3.
   */
  function _renderColoringStripLandscape(layout) {
    const G = layout.G, B = layout.B, n = layout.numCols;
    const colX = (c) => G + c * (B + G);
    const y = layout.bottomRow.y;
    const totalSlots = Math.max(0, n - 2);
    const pages = state.coloringPages;

    let maxVisible, firstThumbCol, hasOverflow;
    if (pages.length <= totalSlots) {
      hasOverflow   = false;
      maxVisible    = totalSlots;
      firstThumbCol = 1;
    } else {
      hasOverflow   = true;
      maxVisible    = Math.max(0, totalSlots - 2);
      firstThumbCol = 2;
    }

    if (hasOverflow) {
      makeBtn({
        x: colX(1), y, size: B,
        onTap: () => scrollColoring(-1),
        innerHTML: FP.icon('scrollLeft', B * 0.44),
        ariaLabel: 'Scroll coloring pages left',
      });
      makeBtn({
        x: colX(n - 2), y, size: B,
        onTap: () => scrollColoring(+1),
        innerHTML: FP.icon('scrollRight', B * 0.44),
        ariaLabel: 'Scroll coloring pages right',
      });
    }

    const visible = pages.slice(state.coloringScrollOffset,
                                 state.coloringScrollOffset + maxVisible);
    visible.forEach((page, i) => {
      renderColoringThumb(page, colX(firstThumbCol + i), y, B);
    });
  }

  /**
   * Coloring strip for portrait: rows 1..numRows-2 inclusive.
   * Total slots = numRows - 2. With overflow we reserve rows 1 and
   * numRows-2 for scroll arrows; thumbs in rows 2..numRows-3.
   * thumb[0] is most-recent at the BOTTOM (matching saved-strip ordering).
   */
  function _renderColoringStripPortrait(layout) {
    const G = layout.G, B = layout.B, n = layout.numRows;
    const rowY = (r) => G + r * (B + G);
    const x = layout.rightCol.x;
    const totalSlots = Math.max(0, n - 2);
    const pages = state.coloringPages;

    let maxVisible, firstThumbRow, lastThumbRow, hasOverflow;
    if (pages.length <= totalSlots) {
      hasOverflow   = false;
      maxVisible    = totalSlots;
      firstThumbRow = 1;
      lastThumbRow  = n - 2;
    } else {
      hasOverflow   = true;
      maxVisible    = Math.max(0, totalSlots - 2);
      firstThumbRow = 2;
      lastThumbRow  = n - 3;
    }

    if (hasOverflow) {
      makeBtn({
        x, y: rowY(1), size: B,
        onTap: () => scrollColoring(+1),
        innerHTML: FP.icon('scrollUp', B * 0.44),
        ariaLabel: 'Scroll coloring pages up',
      });
      makeBtn({
        x, y: rowY(n - 2), size: B,
        onTap: () => scrollColoring(-1),
        innerHTML: FP.icon('scrollDown', B * 0.44),
        ariaLabel: 'Scroll coloring pages down',
      });
    }

    // Display newest-first at the top (consistent with how the page list is ordered).
    // We're not matching the saved-strip's bottom-newest order here because
    // coloring pages don't have a "newest" — they're a stable catalog.
    const visible = pages.slice(state.coloringScrollOffset,
                                 state.coloringScrollOffset + maxVisible);
    visible.forEach((page, i) => {
      renderColoringThumb(page, x, rowY(firstThumbRow + i), B);
    });
  }

  function renderColoringThumb(page, x, y, B) {
    if (state.coloringConfirmReloadId === page.id) {
      // Replace this slot with the reload button (second-tap confirm).
      makeBtn({
        x, y, size: B, accent: true,
        onTap: () => handleColoringPageReloadConfirm(page),
        innerHTML: FP.icon('reload', B * 0.44),
        ariaLabel: 'Reload page (clear all your work)',
      });
      return;
    }
    const btn = makeBtn({
      x, y, size: B,
      active: state.currentColoringPageId === page.id,
      onTap: () => handleColoringPageTap(page),
      ariaLabel: page.name,
      extraClass: 'thumb',
    });

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
  function makeBtn({ x, y, size, bg, color, active, accent, indicator, disabled,
                     onTap, innerHTML, ariaLabel, extraClass, isColorSwatch }) {
    const b = document.createElement('button');
    b.className = 'btn';
    if (active)    b.classList.add('active');
    if (accent)    b.classList.add('accent');
    if (indicator) b.classList.add('indicator');
    if (disabled)  b.classList.add('disabled');
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
  async function _deleteAllDrawings() {
    // Delete both regular drawings and coloring book autosaves
    return Promise.all([
      new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('fingerPaint.drawings');
        req.onsuccess = resolve;
        req.onerror   = () => reject(req.error);
      }),
      new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('fingerPaint.coloringBook');
        req.onsuccess = resolve;
        req.onerror   = () => reject(req.error);
      }),
    ]).then(() => {
      console.log('All drawings and coloring pages cleared');
      location.reload();
    }).catch(err => {
      console.error('Failed to delete databases', err);
      location.reload();
    });
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
    _leavingColoringPage();
    const c = state.palette[state.activeColorIdx];
    canvasComp.fillBackground(c);
    // Auto-switch to opposite column color (flip LSB)
    state.activeColorIdx = state.activeColorIdx ^ 1;
    canvasComp.setColor(state.palette[state.activeColorIdx]);
    onCanvasContentChanged();
    renderAll();
    FP.playSound('bgFill');
  }

  async function handleClearTap() {
    // If a coloring page is loaded, the user's work is autosaved per-page;
    // clearing means "leave this page and return to blank paper" — no
    // confirmation dialog because nothing is lost.
    if (state.currentColoringPageId) {
      _leavingColoringPage();
      await canvasComp.pageFlip(async () => {
        canvasComp.reset();
        onCanvasContentChanged();
      }, PAGE_FLIP_ANIMATION, () => {
        renderAll();
      });
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
    state.savedJustNow = true;
    state.scrollOffset = 0;  // scroll to show new drawing at front
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
      state.loadedDrawingId = null;
      state.loadedDrawingEntry = null;
      state.savedJustNow    = false;
      enableBtn('save');  // canvas now has no saved copy — allow saving in fullscreen
      // Clamp scrollOffset
      state.scrollOffset = Math.max(0, Math.min(
        state.scrollOffset, Math.max(0, state.saved.length - 1)));
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

  function scrollSaved(direction) {
    if (!lastLayout) return;
    const r = lastLayout.bottomRow || lastLayout.rightCol;
    const max  = Math.max(0, state.saved.length - r.maxVisible);
    state.scrollOffset = Math.max(0, Math.min(max, state.scrollOffset + direction));
    FP.playSound('scroll');
    renderAll();
  }

  // ── Background upload flow ────────────────────────────────────
  function handleUploadTap() {
    document.getElementById('bg-upload-input').click();
  }

  async function onBgUploadFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                 // allow re-selecting the same file
    if (!file) return;

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
  function handleColoringBookToggleTap() {
    state.coloringBookOpen = !state.coloringBookOpen;
    state.coloringConfirmReloadId = null;
    if (state.coloringBookOpen) {
      // Clamp scroll into valid range any time we open.
      state.coloringScrollOffset = Math.max(0, Math.min(
        state.coloringScrollOffset,
        Math.max(0, state.coloringPages.length - 1)));
    }
    FP.playSound('dialogOpen');
    renderAll();
  }

  async function handleColoringPageTap(page) {
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
      const img = await FP.coloringBook.loadImage(page);
      canvasComp.setBackgroundImage(img);
      canvasComp.clearDrawing();
    }, PAGE_FLIP_ANIMATION, () => {
      renderAll();
    });
    FP.playSound('deleteDrawing');
  }

  async function loadColoringPage(page) {
    const autosave = FP.coloringBook.getAutosave(page.id);
    // Load the page image to get dimensions for aspect-ratio-aware scaling
    const img = await FP.coloringBook.loadImage(page);
    const imgH = Math.round(img.naturalHeight / img.naturalWidth * 1000);  // PAINTING_W = 1000

    await canvasComp.pageFlip(async () => {
      if (autosave && autosave.bg) {
        await canvasComp.loadLayersFromDataUrls(autosave.bg, autosave.draw);
      } else {
        canvasComp.setBackgroundImage(img);
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

  function autosaveCurrentColoringPage() {
    if (!state.currentColoringPageId) return;
    try {
      const page = state.coloringPages.find(p => p.id === state.currentColoringPageId);
      FP.coloringBook.setAutosave(state.currentColoringPageId, {
        bg:    canvasComp.toBackgroundDataURL(),
        draw:  canvasComp.toDrawingDataURL(),
        thumb: canvasComp.toThumbnailDataURL(),
        name:  page ? page.name : state.currentColoringPageId,
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

  function scrollColoring(direction) {
    const pages = state.coloringPages.length;
    if (pages === 0 || !lastLayout) return;
    // Determine how many fit in the strip given the current layout.
    let totalSlots;
    if (lastLayout.orientation === 'landscape') {
      totalSlots = Math.max(0, lastLayout.numCols - 2);
    } else {
      totalSlots = Math.max(0, lastLayout.numRows - 2);
    }
    const visibleCount = (pages > totalSlots) ? Math.max(0, totalSlots - 2) : totalSlots;
    const max = Math.max(0, pages - visibleCount);
    state.coloringScrollOffset = Math.max(0, Math.min(max, state.coloringScrollOffset + direction));
    FP.playSound('scroll');
    renderAll();
  }

  // Migrates autosaves whose source file is no longer in coloring-pages/
  // into the regular saved-drawings list. Runs once at boot after discover().
  function migrateOrphanedColoringAutosaves(pages) {
    const present = new Set(pages.map(p => p.id));
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
    }
  }
})();

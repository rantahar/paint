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

  // ── Brush size scale (painting units, 1000-scale) ─────────────
  const SIZE_LEVELS = [4, 6, 9, 13, 18, 24, 32, 42, 56, 72];
  const DEFAULT_SIZE_IDX = 3;  // size 13

  const DEFAULT_BG_COLOR = '#ffffff';  // white
  const DEFAULT_COLOR_IDX = 14;  // black (#111111)

  // ── State ─────────────────────────────────────────────────────
  const state = {
    palette:        DEFAULT_PALETTE.slice(),
    activeColorIdx: DEFAULT_COLOR_IDX,        // black
    activeBrushId:  'marker',
    sizeIdx:        DEFAULT_SIZE_IDX,
    saved:          [],                       // from storage, most-recent first
    scrollOffset:   0,                        // index of first visible thumbnail
    loadedDrawingId: null,                    // currently loaded saved drawing (id) — flipped to null on any change
    loadedDrawingPng: null,                   // PNG data of currently loaded drawing — used for download
    savedJustNow:   false,                    // toggled true after Save; false on any change
    frameMode:      true,                     // true = Frame Mode (drawing inside toolbars), false = Expanded Mode (buttons hover)
    isFullscreen:   false,                    // actual fullscreen via F11/Ctrl+F
    disabledButtons: new Set(),               // button IDs to disable (e.g., 'upload', 'download' in fullscreen)
    pointerDownOnButton: new Set(),           // tracks pointerIds that had pointerdown on buttons (for tap-drag to canvas)
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

  function init() {
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

    // Load saved drawings
    state.saved = FP.storage.list();

    // First render
    renderAll();

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
    // Ctrl+G and Ctrl+F work in both modes; other keys only captured in fullscreen
    document.addEventListener('keydown', (e) => {
      const isCtrlG = (e.ctrlKey || e.metaKey) && e.key?.toLowerCase() === 'g';
      const isCtrlF = (e.ctrlKey || e.metaKey) && e.key?.toLowerCase() === 'f';

      if (isCtrlG) {
        e.preventDefault();
        state.frameMode = !state.frameMode;
        renderAll();
        return;
      } else if (isCtrlF) {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      // In fullscreen mode, capture all other keys
      if (state.isFullscreen) {
        e.preventDefault();
      }
    }, true);  // capture phase

    document.addEventListener('keyup', (e) => {
      const isCtrlG = (e.ctrlKey || e.metaKey) && e.key?.toLowerCase() === 'g';
      const isCtrlF = (e.ctrlKey || e.metaKey) && e.key?.toLowerCase() === 'f';

      // Prevent default for Ctrl+G/F in both modes, and all keys in fullscreen
      if (isCtrlG || isCtrlF || state.isFullscreen) {
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
    const canvasRect = state.frameMode ? layout.canvas : { left: 0, top: 0, width: w, height: h };
    canvasComp.setRect(canvasRect);

    // Clear layers
    panelLayer.innerHTML  = '';
    buttonLayer.innerHTML = '';

    if (state.frameMode) {
      renderPanels(layout);
    }
    renderColorSwatches(layout);
    renderTools(layout);
    if (layout.orientation === 'landscape') renderBottomRow(layout);
    else                                    renderRightCol(layout);
  }

  function renderPanels(layout) {
    layout.panels.forEach(p => {
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
        const dotPercent = _sizeDotPercent(state.sizeIdx, layout.canvas.width, layout.B);
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

    // Upload (col 0)
    makeBtn({
      x: r.uploadXY.x, y: r.uploadXY.y, size: B,
      onTap: handleUploadTap,
      innerHTML: FP.icon('upload', B * 0.44),
      ariaLabel: 'Upload background',
      disabled: state.disabledButtons.has('upload'),
    });

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

    // Clear (top)
    makeBtn({
      x: r.clearXY.x, y: r.clearXY.y, size: B,
      accent: true,
      onTap: handleClearTap,
      innerHTML: FP.icon('clear', B * 0.44),
      ariaLabel: 'Clear drawing',
    });

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

    // Upload (bottom)
    makeBtn({
      x: r.uploadXY.x, y: r.uploadXY.y, size: B,
      onTap: handleUploadTap,
      innerHTML: FP.icon('upload', B * 0.44),
      ariaLabel: 'Upload background',
      disabled: state.disabledButtons.has('upload'),
    });

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
      img.src = entry.png;
      img.alt = '';
      btn.appendChild(img);
    }
  }

  // Generic button factory — appended to buttonLayer.
  function makeBtn({ x, y, size, bg, color, active, accent, indicator, disabled,
                     onTap, innerHTML, ariaLabel, extraClass }) {
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
    if (onTap && !disabled) {
      b.addEventListener('pointerdown', (e) => {
        // Track that this pointer started on a button (for tap-drag to canvas)
        state.pointerDownOnButton.add(e.pointerId);
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

  function handleBgFillTap() {
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
    if (canvasComp.dirtySinceLoad) {
      const choice = await FP.dialogs.clearDrawing();
      if (choice === 'cancel' || choice == null) return;
      if (choice === 'save') doSave();
    }
    await canvasComp.pageFlip(async () => {
      canvasComp.clearDrawing();
      onCanvasContentChanged();
    });
  }

  async function handleSaveOrDownloadAll() {
    if (state.savedJustNow && !state.isFullscreen) {
      // Download mode — ask which
      const choice = await FP.dialogs.downloadDrawings(state.saved.length);
      if (choice === 'one') {
        // Download the loaded drawing (if one is loaded) or the most recent save
        const pngToDownload = state.loadedDrawingPng || state.saved[0]?.png;
        if (pngToDownload) _downloadPng(pngToDownload);
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
    const png = canvasComp.toCompositeDataURL();
    FP.storage.add(png);
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
      state.savedJustNow    = false;
      enableBtn('save');  // canvas now has no saved copy — allow saving in fullscreen
      // Clamp scrollOffset
      state.scrollOffset = Math.max(0, Math.min(
        state.scrollOffset, Math.max(0, state.saved.length - 1)));
      FP.playSound('deleteDrawing');
      renderAll();
    } else {
      // Warn if unsaved changes would be lost
      if (canvasComp.dirtySinceLoad) {
        const choice = await FP.dialogs.loadWithDirty();
        if (choice === 'cancel' || choice == null) return;
        if (choice === 'save') doSave();
      }
      // Load this drawing onto the canvas (with page flip)
      await canvasComp.pageFlip(async () => {
        await canvasComp.loadCompositeFromDataUrl(entry.png);
        state.loadedDrawingId = entry.id;
        state.loadedDrawingPng = entry.png;
        state.savedJustNow    = true;  // show download button for the loaded drawing
        // Do NOT re-enable save button — loaded drawing is already saved
      });
      renderAll();
    }
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
      });
    } else if (choice === 'keep-drawing') {
      // Set background image but preserve drawing strokes
      await canvasComp.pageFlip(async () => {
        canvasComp.setBackgroundImage(newImg);
        onCanvasContentChanged();
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
    if (dirty) onCanvasContentChanged();
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
      state.loadedDrawingPng = null;
      needsRender = true;
    }
    if (needsRender) renderAll();
  }
})();

/* ────────────────────────────────────────────────────────────
   layout.js — pure geometry. Given the frame size, produce all
   button positions plus the canvas rect. No DOM, no state.

   The grid:
     • Landscape (W > H): G = H/100, B = 10G, 9 rows fit exactly.
       numCols depends on width.
     • Portrait  (W < H): G = W/100, B = 10G, 9 cols fit exactly.
       numRows depends on height.
     • Each cell sits at  G + n*(B+G)  along its axis.

   Output shape (same in both orientations):
   {
     orientation: 'landscape' | 'portrait',
     G, B, frameW, frameH,
     canvas:   { left, top, width, height },
     colors:   [ { idx, x, y, color, kind: 'primary'|'neighbor' }, ... ]   // 16 entries
     tools:    [ { id, x, y, kind: 'brush'|'sizeUp'|'sizeDown'|'sizeIndicator'|'bgFill' }, ... ]
     bottomRow:{                                  // landscape only — saved-drawings strip
                 uploadXY, saveXY, clearXY,
                 scrollLeftXY, scrollRightXY,
                 thumbXs:[...], maxVisible
               }
     rightCol: {                                  // portrait only
                 uploadXY, saveXY, clearXY,
                 scrollUpXY, scrollDownXY,
                 thumbYs:[...], maxVisible        // thumb[0] sits at last entry (bottom-most)
               }
     panels:   [ { left, top, width, height, borders: {top,bottom,left,right} } ]   // bg fills
   }

   `nSaved` is needed only to know which scroll arrows to reserve space for.
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

FP.computeLayout = function (frameW, frameH, nSaved) {
  return frameW >= frameH
    ? _landscape(frameW, frameH, nSaved)
    : _portrait (frameW, frameH, nSaved);
};

/* The 8 non-clear tools, in display order. Clear lives in the
   bottom-right (landscape) or top-right (portrait) corner instead. */
FP.toolOrder = [
  { id: 'marker',        kind: 'brush'         },
  { id: 'watercolor',    kind: 'brush'         },
  { id: 'crayon',        kind: 'brush'         },
  { id: 'eraser',        kind: 'brush'         },
  { id: 'sizeUp',        kind: 'sizeUp'        },
  { id: 'sizeIndicator', kind: 'sizeIndicator' },
  { id: 'sizeDown',      kind: 'sizeDown'      },
  { id: 'bgFill',        kind: 'bgFill'        },
];

// ───────────────────────────────────────────────────────────────
// LANDSCAPE
// ───────────────────────────────────────────────────────────────
function _landscape(frameW, frameH, nSaved) {
  const G = frameH / 100;
  const B = G * 10;

  const numCols = Math.max(4, Math.floor((frameW - G) / (B + G)));
  const colX = c => G + c * (B + G);
  const rowY = r => G + r * (B + G);

  // Color swatches: cols 0 (primary) and 1 (neighbor), rows 0..7
  const colors = [];
  for (let r = 0; r < 8; r++) {
    colors.push({ idx: r * 2,     x: colX(0), y: rowY(r), kind: 'primary'  });
    colors.push({ idx: r * 2 + 1, x: colX(1), y: rowY(r), kind: 'neighbor' });
  }

  // Tools: rightmost col (numCols-1), rows 0..7
  const toolColX = colX(numCols - 1);
  const tools = FP.toolOrder.map((t, i) => ({
    ...t, x: toolColX, y: rowY(i),
  }));

  // Bottom row: saved-drawings strip
  // col 0: upload, col 1: save, [scroll-left], thumbs..., [scroll-right], col numCols-1: clear
  const bottomY = rowY(8);
  const uploadXY = { x: colX(0), y: bottomY };
  const saveXY   = { x: colX(1), y: bottomY };
  const clearXY  = { x: colX(numCols - 1), y: bottomY };

  // Available thumb cols: 2..(numCols-2), inclusive → (numCols - 3) cells
  const totalThumbCells = Math.max(0, numCols - 3);
  let needScroll, maxVisible, thumbStartCol, scrollLeftXY = null, scrollRightXY = null;

  if (nSaved <= totalThumbCells) {
    needScroll    = false;
    maxVisible    = totalThumbCells;
    thumbStartCol = 2;
  } else {
    needScroll    = true;
    // Scroll-left occupies col 2, scroll-right occupies col numCols-2
    scrollLeftXY  = { x: colX(2),            y: bottomY };
    scrollRightXY = { x: colX(numCols - 2),  y: bottomY };
    maxVisible    = Math.max(0, totalThumbCells - 2);
    thumbStartCol = 3;
  }

  const thumbXs = [];
  for (let i = 0; i < maxVisible; i++) thumbXs.push(colX(thumbStartCol + i));

  // Canvas: from col 2 left edge to (numCols-1) col left edge, full height
  const canvas = {
    left:   colX(2),
    top:    0,
    width:  colX(numCols - 1) - colX(2),
    height: frameH,
  };

  // Translucent panel backgrounds (so toolbars read against the canvas).
  // We outline the regions that contain buttons.
  const panels = [
    // Left color column (cols 0–1, rows 0..8 — covers top section + bottom row col 0,1)
    { left: 0,            top: 0,
      width: colX(2),     height: frameH,
      borders: { right: true } },
    // Right tool column (col numCols-1, full height — covers tools + clear)
    { left: colX(numCols - 1) - G, top: 0,
      width: B + 2 * G,            height: frameH,
      borders: { left: true } },
    // Bottom strip (between the two side panels, row 8 area)
    { left: colX(2),                                    top: bottomY - G,
      width: colX(numCols - 1) - colX(2),               height: B + 2 * G,
      borders: { top: true } },
  ];

  return {
    orientation: 'landscape',
    G, B, frameW, frameH, numCols,
    canvas, colors, tools, panels,
    bottomRow: {
      uploadXY, saveXY, clearXY,
      scrollLeftXY, scrollRightXY,
      thumbXs, maxVisible, hasOverflow: needScroll,
      y: bottomY,
    },
  };
}

// ───────────────────────────────────────────────────────────────
// PORTRAIT
// ───────────────────────────────────────────────────────────────
function _portrait(frameW, frameH, nSaved) {
  const G = frameW / 100;
  const B = G * 10;

  const numRows = Math.max(5, Math.floor((frameH - G) / (B + G)));
  const colX = c => G + c * (B + G);
  const rowY = r => G + r * (B + G);

  // Top tool row: row 0, cols 0..7 (tools), col 8 = clear
  const tools = FP.toolOrder.map((t, i) => ({
    ...t, x: colX(i), y: rowY(0),
  }));

  // Color swatches: bottom 2 rows (numRows-2 = primary/top, numRows-1 = neighbor/bottom)
  // cols 0..7
  const colors = [];
  const primaryRowY  = rowY(numRows - 2);
  const neighborRowY = rowY(numRows - 1);
  for (let c = 0; c < 8; c++) {
    colors.push({ idx: c * 2,     x: colX(c), y: primaryRowY,  kind: 'primary'  });
    colors.push({ idx: c * 2 + 1, x: colX(c), y: neighborRowY, kind: 'neighbor' });
  }

  // Right column (col 8): clear top, scrollUp, …thumbs going down (newest at bottom)…, scrollDown, save, upload
  const rightX = colX(8);
  const clearXY  = { x: rightX, y: rowY(0) };
  const uploadXY = { x: rightX, y: rowY(numRows - 1) };
  const saveXY   = { x: rightX, y: rowY(numRows - 2) };

  // Saved-drawings vertical strip: rows 1..(numRows - 3) inclusive when no overflow.
  // With overflow: scrollUp at row 1, scrollDown at row numRows-3.
  const stripFirstRow = 1;          // just below clear
  const stripLastRow  = numRows - 3; // just above save
  const totalStripRows = Math.max(0, stripLastRow - stripFirstRow + 1);

  let needScroll, maxVisible, scrollUpXY = null, scrollDownXY = null, thumbRowSpan;
  if (nSaved <= totalStripRows) {
    needScroll   = false;
    maxVisible   = totalStripRows;
    thumbRowSpan = { firstRow: stripFirstRow, lastRow: stripLastRow };
  } else {
    needScroll   = true;
    scrollUpXY   = { x: rightX, y: rowY(stripFirstRow) };
    scrollDownXY = { x: rightX, y: rowY(stripLastRow)  };
    maxVisible   = Math.max(0, totalStripRows - 2);
    thumbRowSpan = { firstRow: stripFirstRow + 1, lastRow: stripLastRow - 1 };
  }

  // thumb[0] = most recent at the BOTTOM of strip (closest to save)
  const thumbYs = [];
  for (let i = 0; i < maxVisible; i++) {
    thumbYs.push(rowY(thumbRowSpan.lastRow - i)); // i=0 → bottom-most
  }

  // Canvas: left=0, top below top tool row, right at col 8 left edge, bottom = frameH (overflows behind colors)
  const canvas = {
    left:   0,
    top:    rowY(0) + B + G,
    width:  colX(8) - 0,
    height: frameH - (rowY(0) + B + G),
  };

  const panels = [
    // Top toolbar (row 0)
    { left: 0,                                top: 0,
      width: frameW,                          height: rowY(0) + B + G,
      borders: { bottom: true } },
    // Bottom color rows
    { left: 0,                                top: primaryRowY - G,
      width: frameW,                          height: frameH - (primaryRowY - G),
      borders: { top: true } },
    // Right column (between top toolbar and color rows)
    { left: rightX - G,                       top: rowY(0) + B + G,
      width: B + 2 * G,                       height: primaryRowY - G - (rowY(0) + B + G),
      borders: { left: true } },
  ];

  return {
    orientation: 'portrait',
    G, B, frameW, frameH, numRows,
    canvas, colors, tools, panels,
    rightCol: {
      uploadXY, saveXY, clearXY,
      scrollUpXY, scrollDownXY,
      thumbYs, maxVisible, hasOverflow: needScroll,
      x: rightX,
    },
  };
};

/* ────────────────────────────────────────────────────────────
   layout.js — pure geometry. Given the frame size, produce all
   button positions plus the canvas rect. No DOM, no state.

   The grid:
     • Landscape (W > H): G = H/100, B = 10G, 9 rows fit exactly.
       numCols depends on width.
     • Portrait  (W < H): G = W/100, B = 10G, 9 cols fit exactly.
       numRows depends on height.
     • Each cell sits at  G + n*(B+G)  along its axis.

   The persistent toolbars are the color palette and TWO tool lines:
     • the PRIMARY line (outermost column in landscape / top row in
       portrait): the tools themselves — Draw, Fill, Shape, Eraser —
       plus the size controls, and
     • the OPTIONS line next to it (one column inward / one row
       down): a dynamic strip whose buttons depend on the active
       tool (line styles for Draw, fill modes for Fill, shape
       choices for Shape). app.js renders it via optionSlotXY().
   The "strip line" (last row in landscape / col 8 in portrait)
   carries just three corner buttons — Save, Bookshelf-toggle, Clear —
   and is otherwise empty (the canvas extends through it). When the
   bookshelf is opened it overlays the strip line with book covers
   plus contextual upload/scroll arrows, painted on top of the canvas.

   Slot convention for the bookshelf overlay:
     slot 0      → Save (or empty in Crayon)
     slot 1      → Bookshelf-toggle
     slot 2..n-1 → Scrollable strip (Upload as "first book" non-Crayon,
                   then book covers, with scroll arrows when overflow)
     slot n-1    → Clear when bookshelf is closed
   In landscape, slot k → colX(k); in portrait, slot k → rowY(numRows-1-k)
   so slot 0 is at the bottom (matching landscape's "leftmost = first").

   Output shape:
   {
     orientation: 'landscape' | 'portrait',
     G, B, frameW, frameH,
     numCols | numRows,
     canvas:   { left, top, width, height },
     colors:   [ { idx, x, y, color, kind } × 16 ]
     tools:    [ { id, x, y, kind } × 7 ]     // PRIMARY line
     optionSlotCount: 8                        // OPTIONS line capacity
     optionSlotXY(slot): { x, y }              // position for option slot
     // Persistent corner buttons (always rendered):
     saveXY:        { x, y }   // slot 0 of the strip line
     bookToggleXY:  { x, y }   // slot 1
     clearXY:       { x, y }   // slot n-1
     // Bookshelf overlay helpers:
     bookshelfSlotCount: <int>            // numCols (landscape) / numRows (portrait)
     bookshelfSlotXY(slot): { x, y }      // position for any slot index
     bookshelfRowRect: { left, top, width, height }  // for outside-tap hit-testing
   }
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

// Pixels of margin between the canvas border and the frame edges where the
// canvas would otherwise sit flush — small gap so the canvas's 1px border
// doesn't blend into the browser's chrome edge (bookmark-bar separator etc).
// Applied on the FLUSH sides only: top/bottom in landscape; left/right in
// portrait. Sides bordered by toolbars don't need it.
const CANVAS_EDGE_MARGIN = 2;
// Landscape bottom gets +1px on top of CANVAS_EDGE_MARGIN — the browser's
// bottom chrome benefits from a touch more breathing room.
const CANVAS_BOTTOM_EXTRA_LANDSCAPE = 1;

FP.computeLayout = function (frameW, frameH, nSaved) {
  return frameW >= frameH
    ? _landscape(frameW, frameH, nSaved)
    : _portrait (frameW, frameH, nSaved);
};

/* The PRIMARY tool line, in display order. Clear lives at the strip-line
   corner (slot n-1) instead. Variants can override via CFG.toolOrder
   (an empty array = no tool lines at all, e.g. Crayon mode). */
FP.primaryTools = [
  { id: 'draw',          kind: 'tool'          },
  { id: 'fill',          kind: 'tool'          },
  { id: 'shape',         kind: 'tool'          },
  { id: 'eraser',        kind: 'tool'          },
  { id: 'sizeUp',        kind: 'sizeUp'        },
  { id: 'sizeIndicator', kind: 'sizeIndicator' },
  { id: 'sizeDown',      kind: 'sizeDown'      },
];

/* The OPTIONS line contents per primary tool. Draw options are brush ids
   (line styles); fill options are fill modes; shape options come from the
   shapes registry. An empty list (eraser) leaves the line blank —
   thickness already covers eraser sizing. */
FP.toolOptions = {
  draw:   ['marker', 'watercolor', 'crayon', 'dash', 'dot'],
  fill:   ['bucket', 'page'],
  shape:  (window.FP.shapes ? FP.shapes.ORDER.slice() : []),
  eraser: [],
};

// ───────────────────────────────────────────────────────────────
// LANDSCAPE
// ───────────────────────────────────────────────────────────────
function _landscape(frameW, frameH/*, nSaved (unused — no more saved strip) */) {
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

  // Tool lines: PRIMARY in the rightmost col (numCols-1), OPTIONS one col
  // inward (numCols-2), both rows 0..7. With no tools (Crayon variant)
  // neither column is reserved and the canvas keeps its full width.
  const hasTools  = FP.primaryTools.length > 0;
  const toolColX  = colX(numCols - 1);
  const optionColX = colX(numCols - 2);
  const tools = FP.primaryTools.map((t, i) => ({
    ...t, x: toolColX, y: rowY(i),
  }));

  // Strip-line corners (row 8): Save / Bookshelf-toggle / Clear.
  // Save is at slot 0 (was Upload pre-redesign); Bookshelf-toggle at slot 1
  // (was Save). Clear is unchanged at slot numCols-1.
  const stripY = rowY(8);
  const saveXY       = { x: colX(0),           y: stripY };
  const bookToggleXY = { x: colX(1),           y: stripY };
  const clearXY      = { x: colX(numCols - 1), y: stripY };

  // Canvas extends through the empty middle of the strip line. The corner
  // buttons float in the side columns at z 4 (above the canvas at z 2); the
  // strip-line middle (cols 2..n-2) is empty unless the bookshelf overlay
  // opens on top.
  //
  // The right edge stops left of the OPTIONS column (or the primary column
  // when there are no tools — Crayon keeps the wider canvas).
  //
  // Top + bottom are flush with the frame edges, so we shrink the canvas by
  // CANVAS_EDGE_MARGIN px on each (plus an extra px at the bottom) so its 1px
  // border doesn't blend with the browser chrome edge.
  const canvasRightX = hasTools ? optionColX : colX(numCols - 1);
  const canvas = {
    left:   colX(2),
    top:    CANVAS_EDGE_MARGIN,
    width:  canvasRightX - G - colX(2),
    height: frameH - 2 * CANVAS_EDGE_MARGIN - CANVAS_BOTTOM_EXTRA_LANDSCAPE,
  };

  // Extended canvas (Crayon variant — tools column empty). Used for coloring
  // pages where the page would otherwise be too small in `canvas`: extends
  // right to the viewport edge (gaining width) but stops above the strip
  // line (= 8 button rows + 7 gaps tall). app.js picks between `canvas` and
  // `canvasExtended` per page aspect so a wide page gets the extra width
  // without windowboxing a tall page.
  const canvasExtended = (!hasTools)
    ? {
        left:   colX(2),
        top:    CANVAS_EDGE_MARGIN,
        width:  frameW - colX(2) - CANVAS_EDGE_MARGIN,
        height: rowY(8) - G - CANVAS_EDGE_MARGIN,
      }
    : null;

  // Page-picker grid rect — where the picker tiles live when the picker is
  // open. Aligned with the button grid (rowY(0), colX(2)) so tiles line up
  // with the color column and tools column. Stops above the bookshelf row
  // (rowY(8) - G) so the bookshelf stays accessible underneath, and stops
  // LEFT of the tools column so the picker chrome (right-column middle row)
  // stays visible regardless of variant.
  //
  // pickerGridCols / pickerGridRows are exact INTEGER counts (not derived
  // from width/(B+G) which drifts under float rounding). pickerSlotXY(col,
  // row) returns the absolute pixel position for tile (col, row) using the
  // layout's own colX/rowY — bypassing any float compounding the picker
  // would otherwise do internally.
  const pickerGridRect = {
    left:   colX(2),
    top:    rowY(0),
    width:  colX(numCols - 1) - G - colX(2),
    height: rowY(8) - G - rowY(0),
  };
  const pickerGridCols = numCols - 3;   // slots 2..numCols-2
  const pickerGridRows = 8;             // rows 0..7 (above strip)

  // Page-picker chrome (prev/indicator/next) lives at fixed slots independent
  // of FP.toolOrder so that Crayon (toolOrder = []) still has somewhere to
  // put them. Landscape: right column, rows 1/2/3. The Crayon single-button
  // variant uses the middle (rowY(2)) only.
  const chromeColX = colX(numCols - 1);
  const pickerChromePrevXY = { x: chromeColX, y: rowY(1) };
  const pickerChromeMidXY  = { x: chromeColX, y: rowY(2) };
  const pickerChromeNextXY = { x: chromeColX, y: rowY(3) };

  return {
    orientation: 'landscape',
    G, B, frameW, frameH, numCols,
    canvas, canvasExtended, colors, tools,
    optionSlotCount: 8,
    optionSlotXY(slot) { return { x: optionColX, y: rowY(slot) }; },
    saveXY, bookToggleXY, clearXY,
    bookshelfSlotCount: numCols,
    bookshelfSlotXY(slot) { return { x: colX(slot), y: stripY }; },
    bookshelfRowRect: { left: 0, top: stripY, width: frameW, height: B },
    pickerGridRect, pickerGridCols, pickerGridRows,
    pickerSlotXY(col, row) { return { x: colX(2 + col), y: rowY(row) }; },
    pickerChromePrevXY, pickerChromeMidXY, pickerChromeNextXY,
  };
}

// ───────────────────────────────────────────────────────────────
// PORTRAIT
// ───────────────────────────────────────────────────────────────
function _portrait(frameW, frameH/*, nSaved (unused) */) {
  const G = frameW / 100;
  const B = G * 10;

  const numRows = Math.max(5, Math.floor((frameH - G) / (B + G)));
  const colX = c => G + c * (B + G);
  const rowY = r => G + r * (B + G);

  // Tool lines: PRIMARY in row 0, OPTIONS in row 1, cols 0..7. Col 8 holds
  // Clear at the corner. With no tools (Crayon variant) neither row is
  // reserved and the canvas keeps its full height.
  const hasTools = FP.primaryTools.length > 0;
  const tools = FP.primaryTools.map((t, i) => ({
    ...t, x: colX(i), y: rowY(0),
  }));

  // Color swatches: bottom 2 rows (numRows-2 primary, numRows-1 neighbor),
  // cols 0..7. Col 8 of these rows holds Bookshelf-toggle + Save.
  const colors = [];
  const primaryRowY  = rowY(numRows - 2);
  const neighborRowY = rowY(numRows - 1);
  for (let c = 0; c < 8; c++) {
    colors.push({ idx: c * 2,     x: colX(c), y: primaryRowY,  kind: 'primary'  });
    colors.push({ idx: c * 2 + 1, x: colX(c), y: neighborRowY, kind: 'neighbor' });
  }

  // Strip-line corners (col 8): Clear at top (slot n-1 visually), Bookshelf-
  // toggle just above Save at the bottom. Slot 0 (bottom) = Save matches the
  // landscape convention of "Save = leftmost/bottommost = first."
  const stripX = colX(8);
  const clearXY       = { x: stripX, y: rowY(0)       };  // slot numRows-1 (top)
  const bookToggleXY  = { x: stripX, y: primaryRowY   };  // slot 1
  const saveXY        = { x: stripX, y: neighborRowY  };  // slot 0 (bottom)

  // Canvas: top below the tool lines (primary + options rows), bottom above
  // the color rows. Extends horizontally to frameW (through col 8's empty
  // middle); col 8's corner buttons float at z 4 above the canvas. With no
  // tools only row 0 is skipped (Crayon keeps the taller canvas via
  // canvasExtended anyway).
  //
  // Left + right are flush with the frame edges, so we shrink the canvas by
  // CANVAS_EDGE_MARGIN px on each so its 1px border doesn't blend with the
  // browser chrome edge.
  const canvasTop = rowY(hasTools ? 1 : 0) + B + G;
  const canvas = {
    left:   CANVAS_EDGE_MARGIN,
    top:    canvasTop,
    width:  frameW - 2 * CANVAS_EDGE_MARGIN,
    height: primaryRowY - G - canvasTop,
  };

  // Extended canvas (Crayon variant — top tool row empty). Used for coloring
  // pages where the page would otherwise be too narrow in `canvas`: extends
  // up to the viewport edge (gaining height) but stops left of the bookshelf
  // column. Width is bounded by "8 buttons" since Clear at col 8 row 0 must
  // stay accessible. app.js picks per page aspect so a tall page gets the
  // extra height without windowboxing a wide page.
  const canvasExtended = (!hasTools)
    ? {
        left:   CANVAS_EDGE_MARGIN,
        top:    CANVAS_EDGE_MARGIN,
        width:  colX(8) - G - CANVAS_EDGE_MARGIN,
        height: primaryRowY - G - CANVAS_EDGE_MARGIN,
      }
    : null;

  // Page-picker grid rect — where picker tiles live when the picker is open.
  // Aligned with the button grid (rowY(1), colX(0)) so tiles line up with
  // the top tool row's first column. Stops left of the bookshelf column
  // (col 8 - G) so the bookshelf stays accessible alongside, and stops
  // BELOW the top tool row so the picker chrome (top-middle) stays visible
  // regardless of variant.
  //
  // pickerGridCols / pickerGridRows are exact INTEGER counts (see landscape
  // comments). pickerSlotXY uses colX/rowY so positions match the rest of
  // the button grid without float compounding.
  const pickerGridRect = {
    left:   colX(0),
    top:    rowY(1),
    width:  colX(8) - G - colX(0),
    height: primaryRowY - G - rowY(1),
  };
  const pickerGridCols = 8;             // cols 0..7
  const pickerGridRows = numRows - 3;   // rows 1..numRows-3

  // Picker chrome positions (see landscape comments). Portrait: top row,
  // cols 3/4/5 — Crayon's single button uses colX(4), top-middle.
  const chromeRowY = rowY(0);
  const pickerChromePrevXY = { x: colX(3), y: chromeRowY };
  const pickerChromeMidXY  = { x: colX(4), y: chromeRowY };
  const pickerChromeNextXY = { x: colX(5), y: chromeRowY };

  return {
    orientation: 'portrait',
    G, B, frameW, frameH, numRows,
    canvas, canvasExtended, colors, tools,
    optionSlotCount: 8,
    optionSlotXY(slot) { return { x: colX(slot), y: rowY(1) }; },
    saveXY, bookToggleXY, clearXY,
    bookshelfSlotCount: numRows,
    // slot 0 = bottom of strip → newer-to-older feels right
    bookshelfSlotXY(slot) { return { x: stripX, y: rowY(numRows - 1 - slot) }; },
    bookshelfRowRect: { left: stripX, top: 0, width: B, height: frameH },
    pickerGridRect, pickerGridCols, pickerGridRows,
    pickerSlotXY(col, row) { return { x: colX(col), y: rowY(1 + row) }; },
    pickerChromePrevXY, pickerChromeMidXY, pickerChromeNextXY,
  };
}

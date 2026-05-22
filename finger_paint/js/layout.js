/* ────────────────────────────────────────────────────────────
   layout.js — pure geometry. Given the frame size, produce all
   button positions plus the canvas rect. No DOM, no state.

   The grid:
     • Landscape (W > H): G = H/100, B = 10G, 9 rows fit exactly.
       numCols depends on width.
     • Portrait  (W < H): G = W/100, B = 10G, 9 cols fit exactly.
       numRows depends on height.
     • Each cell sits at  G + n*(B+G)  along its axis.

   The persistent toolbars are only the color palette and the tools
   column. The "strip line" (row 8 in landscape / col 8 in portrait)
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
     tools:    [ { id, x, y, kind } × 8 ]
     panels:   [ { left, top, width, height, borders } ]
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

/* The 8 non-clear tools, in display order. Clear lives at the strip-line
   corner of the tools column (slot n-1) instead. */
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

  // Tools: rightmost col (numCols-1), rows 0..7
  const toolColX = colX(numCols - 1);
  const tools = FP.toolOrder.map((t, i) => ({
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
  // buttons sit on the left/right column panels (which now extend full height)
  // and stay above the canvas via z-index; the strip-line middle (cols 2..n-2)
  // is empty unless the bookshelf overlay opens on top.
  //
  // Top + bottom are flush with the frame edges, so we shrink the canvas by
  // CANVAS_EDGE_MARGIN px on each (plus an extra px at the bottom) so its 1px
  // border doesn't blend with the browser chrome edge.
  const canvas = {
    left:   colX(2),
    top:    CANVAS_EDGE_MARGIN,
    width:  colX(numCols - 1) - G - colX(2),
    height: frameH - 2 * CANVAS_EDGE_MARGIN - CANVAS_BOTTOM_EXTRA_LANDSCAPE,
  };

  const panels = [
    // Left color column (cols 0–1) — full height now (was bottom strip part).
    { left: 0, top: 0,
      width: colX(2), height: frameH,
      borders: { right: true } },
    // Right tool column (col numCols-1) — full height.
    { left: colX(numCols - 1) - G, top: 0,
      width: B + 2 * G,            height: frameH,
      borders: { left: true } },
  ];

  // Page-picker grid rect — where the picker tiles live when the picker is
  // open. Aligned with the button grid (rowY(0), colX(2)) so tiles line up
  // with the color column and tools column. Stops above the bookshelf row
  // (rowY(8) - G) so the bookshelf stays accessible underneath.
  const pickerGridRect = {
    left:   colX(2),
    top:    rowY(0),
    width:  colX(numCols - 1) - G - colX(2),
    height: rowY(8) - G - rowY(0),
  };

  return {
    orientation: 'landscape',
    G, B, frameW, frameH, numCols,
    canvas, colors, tools, panels,
    saveXY, bookToggleXY, clearXY,
    bookshelfSlotCount: numCols,
    bookshelfSlotXY(slot) { return { x: colX(slot), y: stripY }; },
    bookshelfRowRect: { left: 0, top: stripY, width: frameW, height: B },
    pickerGridRect,
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

  // Top tool row: row 0, cols 0..7 (tools), col 8 holds Clear at the corner
  const tools = FP.toolOrder.map((t, i) => ({
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

  // Canvas: top below the top tool row, bottom above the color rows. Extends
  // horizontally to frameW (through col 8's empty middle); col 8's corners
  // sit on the top/bottom panels.
  //
  // Left + right are flush with the frame edges, so we shrink the canvas by
  // CANVAS_EDGE_MARGIN px on each so its 1px border doesn't blend with the
  // browser chrome edge.
  const canvasTop = rowY(0) + B + G;
  const canvas = {
    left:   CANVAS_EDGE_MARGIN,
    top:    canvasTop,
    width:  frameW - 2 * CANVAS_EDGE_MARGIN,
    height: primaryRowY - G - canvasTop,
  };

  const panels = [
    // Top toolbar (row 0)
    { left: 0,                top: 0,
      width: frameW,          height: rowY(0) + B + G,
      borders: { bottom: true } },
    // Bottom color rows
    { left: 0,                top: primaryRowY - G,
      width: frameW,          height: frameH - (primaryRowY - G),
      borders: { top: true } },
  ];

  // Page-picker grid rect — where picker tiles live when the picker is open.
  // Aligned with the button grid (rowY(1), colX(0)) so tiles line up with
  // the top tool row's first column. Stops left of the bookshelf column
  // (col 8 - G) so the bookshelf stays accessible alongside.
  const pickerGridRect = {
    left:   colX(0),
    top:    rowY(1),
    width:  colX(8) - G - colX(0),
    height: primaryRowY - G - rowY(1),
  };

  return {
    orientation: 'portrait',
    G, B, frameW, frameH, numRows,
    canvas, colors, tools, panels,
    saveXY, bookToggleXY, clearXY,
    bookshelfSlotCount: numRows,
    // slot 0 = bottom of strip → newer-to-older feels right
    bookshelfSlotXY(slot) { return { x: stripX, y: rowY(numRows - 1 - slot) }; },
    bookshelfRowRect: { left: stripX, top: 0, width: B, height: frameH },
    pickerGridRect,
  };
}

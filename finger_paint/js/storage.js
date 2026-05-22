/* ────────────────────────────────────────────────────────────
   storage.js — IndexedDB persistence of saved drawings.

   Entry shape (v3):
     { id: '<uuid>', t: <unix-ms>,
       bgColor: '<hex>',       // background color (solid fill)
       draw:    '<dataURL>',   // transparent strokes / overlay layer (may be null)
       thumb:   '<dataURL>' }  // small transparent preview (~160px)

   On init(), entries from the old v2 shape (which used a `bg`/`png`
   dataURL instead of `bgColor`) are migrated in-place: the bg's
   corner pixel is sampled to derive `bgColor`, the `draw` layer is
   used to regenerate a transparent `thumb`, and the v2 `bg` field
   is dropped. Uploaded image backgrounds collapse to a flat color
   (the corner sample) — a known one-time loss accepted by the
   redesign plan.

   Listing order: most-recent first (sorted by t descending).

   In-memory cache: _list is populated from IDB at init() and kept
   in sync on every write. list() reads from _list synchronously so
   callers in app.js need no changes.

   Writes (add/remove) update _list synchronously then fire-and-forget
   to IDB. If IDB is unavailable (_db null), writes update _list only
   — the app works for the session but data does not survive a reload.
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

const DB_NAME    = 'fingerPaint.drawings';
const DB_VERSION = 1;
const STORE      = 'drawings';

let _db   = null;
let _list = [];   // in-memory, most-recent-first

function _openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('t', 't', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function _idbGetAll() {
  return new Promise((resolve, reject) => {
    const tx  = _db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function _idbPut(entry) {
  if (!_db) return;
  _db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry);
}

function _idbDelete(id) {
  if (!_db) return;
  _db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
}

FP.storage = {
  async init() {
    try {
      _db   = await _openDb();
      const all = await _idbGetAll();
      // Migrate any pre-v3 entries (in-place; replaces old IDB rows).
      const migrated = await Promise.all(all.map(_migrateToV3));
      _list = migrated.sort((a, b) => b.t - a.t);
    } catch (e) {
      console.error('IDB unavailable — drawings will not persist this session', e);
      _db   = null;
      _list = [];
    }
  },

  list() {
    return _list.slice();
  },

  add(bgColor, drawDataUrl, thumbDataUrl) {
    const entry = {
      id:      _uuid(),
      t:       Date.now(),
      bgColor: bgColor || '#ffffff',
      draw:    drawDataUrl  || null,
      thumb:   thumbDataUrl || null,
    };
    _list.unshift(entry);
    _idbPut(entry);
    return entry;
  },

  remove(id) {
    _list = _list.filter(e => e.id !== id);
    _idbDelete(id);
  },

  get(id) {
    return _list.find(e => e.id === id) || null;
  },

  // Build a full-size composite PNG dataURL from an entry. v3 entries:
  // bgColor rectangle + transparent draw on top. v1/v2 fallback paths
  // are gone — _migrateToV3 in init() upgrades any old rows first.
  compositeFromEntry(entry) {
    return _composeV3(entry.bgColor, entry.draw);
  },

  async downloadOne(entry) {
    const a = document.getElementById('download-anchor');
    a.href = await this.compositeFromEntry(entry);
    a.download = `painting-${_filenameTimestamp(entry.t)}.png`;
    a.click();
  },

  downloadAll() {
    const list = this.list();
    list.forEach((entry, i) => {
      setTimeout(() => this.downloadOne(entry), i * 200);
    });
  },
};

function _uuid() {
  return 'd-' + Math.random().toString(36).slice(2, 10) +
         '-' + Date.now().toString(36);
}

function _filenameTimestamp(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}` +
         `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function _flattenLayers(bgUrl, drawUrl) {
  if (!drawUrl) return Promise.resolve(bgUrl);
  return Promise.all([_loadImg(bgUrl), _loadImg(drawUrl)]).then(([bg, draw]) => {
    const w = Math.max(bg.naturalWidth,  draw.naturalWidth);
    const h = Math.max(bg.naturalHeight, draw.naturalHeight);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(bg,   0, 0);
    ctx.drawImage(draw, 0, 0);
    return c.toDataURL('image/png');
  });
}

/**
 * v3 composite: solid bg color rectangle, then transparent draw on top.
 * Used by downloads. For entries with no draw layer, returns just the bg.
 */
function _composeV3(bgColor, drawUrl) {
  if (!drawUrl) {
    // Bg-only entry — return a small solid PNG.
    const c = document.createElement('canvas');
    c.width = c.height = 100;
    const ctx = c.getContext('2d');
    ctx.fillStyle = bgColor || '#ffffff';
    ctx.fillRect(0, 0, 100, 100);
    return Promise.resolve(c.toDataURL('image/png'));
  }
  return _loadImg(drawUrl).then(draw => {
    const c = document.createElement('canvas');
    c.width  = draw.naturalWidth;
    c.height = draw.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.fillStyle = bgColor || '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(draw, 0, 0);
    return c.toDataURL('image/png');
  });
}

/**
 * Migrate an IDB row to v3 in-place. v1 entries used a single `png` field
 * (composite); v2 entries had `bg` (background layer) + `draw` + `thumb`.
 * v3 replaces the dataURL bg with a sampled `bgColor` hex and regenerates
 * the thumb from the (transparent) draw layer so the picker's 3-layer
 * compositing works correctly. Uploaded image backgrounds collapse to a
 * flat color sample — accepted loss per the redesign plan.
 *
 * No-op for entries already in v3 shape.
 */
async function _migrateToV3(entry) {
  if (entry.bgColor !== undefined) return entry;       // already v3

  const oldBgUrl = entry.bg || entry.png;
  let bgColor = '#ffffff';
  if (oldBgUrl) {
    try {
      const img = await _loadImg(oldBgUrl);
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 4, 4);
      const px = ctx.getImageData(0, 0, 1, 1).data;
      bgColor = '#' + [px[0], px[1], px[2]]
        .map(v => v.toString(16).padStart(2, '0')).join('');
    } catch (_) { /* keep default white */ }
  }

  // Regenerate transparent thumb from the existing draw layer (v2's draw
  // is already transparent strokes; v1 has no draw, so fall back to the
  // old composite thumb in that case — best we can do).
  let thumb = entry.thumb || entry.png || null;
  if (entry.draw) {
    try {
      const drawImg = await _loadImg(entry.draw);
      const t = document.createElement('canvas');
      const size = 160;
      t.width = t.height = size;
      const tx = t.getContext('2d');
      tx.drawImage(drawImg, 0, 0, drawImg.naturalWidth, drawImg.naturalHeight,
                              0, 0, size, size);
      thumb = t.toDataURL('image/png');
    } catch (_) { /* keep existing thumb */ }
  }

  const v3 = {
    id:      entry.id,
    t:       entry.t,
    bgColor,
    draw:    entry.draw || null,
    thumb,
  };
  // Write the v3 row back; this replaces the v2 row at the same keyPath.
  _idbPut(v3);
  return v3;
}

function _loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload  = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

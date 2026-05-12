/* ────────────────────────────────────────────────────────────
   storage.js — IndexedDB persistence of saved drawings.

   Entry shape (v2):
     { id: '<uuid>', t: <unix-ms>,
       bg:    '<dataURL>',     // background layer
       draw:  '<dataURL>',     // transparent strokes layer (may be null)
       thumb: '<dataURL>' }    // small composite preview (~160px)

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
      _list = all.sort((a, b) => b.t - a.t);
    } catch (e) {
      console.error('IDB unavailable — drawings will not persist this session', e);
      _db   = null;
      _list = [];
    }
  },

  list() {
    return _list.slice();
  },

  add(bgDataUrl, drawDataUrl, thumbDataUrl) {
    const entry = {
      id:    _uuid(),
      t:     Date.now(),
      bg:    bgDataUrl,
      draw:  drawDataUrl  || null,
      thumb: thumbDataUrl || bgDataUrl,
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

  // Build a full-size composite PNG dataURL from an entry.
  compositeFromEntry(entry) {
    return _flattenLayers(entry.bg, entry.draw);
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

function _loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload  = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

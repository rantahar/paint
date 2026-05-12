/* ────────────────────────────────────────────────────────────
   coloringBook.js — discovery and per-page autosave for the
   coloring-book strip.

   Page discovery (in priority order):
     1. fetch('coloring-pages/manifest.json') — primary path on
        static-CDN hosting (GitHub Pages, Netlify, Vercel, S3...).
        Format:  { "pages": [ { "file": "kitten.png", "name": "Kitten" }, ... ] }
     2. fetch('coloring-pages/') as HTML and scrape <a href> links
        matching an image-extension regex. Works on dev servers with
        autoindex (e.g. `python -m http.server`, nginx autoindex)
        but NOT on GitHub Pages, which never serves directory listings.
     3. Empty list (no folder, no manifest, no autoindex).

   Per-page autosave: IndexedDB database 'fingerPaint.coloring',
   object store 'autosaves', keyPath 'pageId'.
   Entry shape:
     { pageId, bg, draw, thumb, name, t }
     • bg / draw: two-layer canvas state (image + transparent strokes)
     • thumb:     small composite preview for the strip
     • name:      preserved so orphans can be migrated with a name
     • t:         last-modified epoch ms
   Storing the bg layer means we don't depend on the source file
   surviving in the folder — coloring-page sources can be deleted at
   any time without losing the user's saved work.

   In-memory cache (_cache) is populated from IDB at init() and kept
   in sync on every write. getAutosave/allAutosaveIds read from cache
   synchronously so callers in app.js need no changes.

   Writes (setAutosave/removeAutosave) update _cache synchronously
   then fire-and-forget to IDB. If IDB is unavailable (_cbDb null),
   writes update _cache only — app works for the session.
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

const COLORING_DIR_NAME = 'coloring-pages';
const IMG_EXT_RE        = /\.(png|jpe?g|gif|webp|svg)$/i;

const CB_DB_NAME = 'fingerPaint.coloring';
const CB_DB_VER  = 1;
const CB_STORE   = 'autosaves';

function _coloringDir() {
  // crayon-mode lives one level down — walk up to reach the shared folder.
  const inCrayon = location.pathname.includes('/crayon-mode/');
  return (inCrayon ? '../' : '') + COLORING_DIR_NAME + '/';
}

let _discoverPromise = null;
let _cachedPages     = [];
const _imageCache    = new Map();   // id → HTMLImageElement promise

let _cbDb  = null;
let _cache = {};   // pageId → { pageId, bg, draw, thumb, name, t }

function _cbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CB_DB_NAME, CB_DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CB_STORE)) {
        db.createObjectStore(CB_STORE, { keyPath: 'pageId' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function _cbGetAll() {
  return new Promise((resolve, reject) => {
    const tx  = _cbDb.transaction(CB_STORE, 'readonly');
    const req = tx.objectStore(CB_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function _cbPut(entry) {
  if (!_cbDb) return;
  _cbDb.transaction(CB_STORE, 'readwrite').objectStore(CB_STORE).put(entry);
}

function _cbDelete(pageId) {
  if (!_cbDb) return;
  _cbDb.transaction(CB_STORE, 'readwrite').objectStore(CB_STORE).delete(pageId);
}

FP.coloringBook = {
  async init() {
    try {
      _cbDb = await _cbOpen();
      const all = await _cbGetAll();
      _cache = Object.fromEntries(all.map(e => [e.pageId, e]));
    } catch (e) {
      console.error('IDB unavailable for coloringBook — autosaves will not persist', e);
      _cbDb = null;
    }
  },

  /**
   * Discovers available coloring pages. Returns a cached promise on
   * subsequent calls. The resolved array has shape:
   *   [ { id, name, url } ]
   * `id` is stable across sessions (used as the autosave key).
   */
  discover() {
    if (_discoverPromise) return _discoverPromise;
    _discoverPromise = (async () => {
      const dir = _coloringDir();

      // 1. manifest.json (primary)
      try {
        const r = await fetch(dir + 'manifest.json', { cache: 'no-cache' });
        if (r.ok) {
          const data = await r.json();
          if (data && Array.isArray(data.pages)) {
            _cachedPages = data.pages.map(p => ({
              id:   p.file,
              name: p.name || _filenameToName(p.file),
              url:  dir + p.file,
            }));
            return _cachedPages;
          }
        }
      } catch (e) { /* fall through to autoindex */ }

      // 2. directory autoindex (dev only)
      try {
        const r = await fetch(dir, { headers: { Accept: 'text/html' } });
        if (r.ok) {
          const ct = r.headers.get('content-type') || '';
          if (ct.includes('text/html')) {
            const html = await r.text();
            const files = _parseAutoindex(html);
            _cachedPages = files.map(f => ({
              id:   f,
              name: _filenameToName(f),
              url:  dir + f,
            }));
            return _cachedPages;
          }
        }
      } catch (e) { /* fall through */ }

      _cachedPages = [];
      return _cachedPages;
    })();
    return _discoverPromise;
  },

  list() { return _cachedPages.slice(); },

  /** Returns a cached HTMLImageElement (loaded). */
  loadImage(page) {
    if (_imageCache.has(page.id)) return _imageCache.get(page.id);
    const p = new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload  = () => resolve(im);
      im.onerror = reject;
      im.src = page.url;
    });
    _imageCache.set(page.id, p);
    return p;
  },

  // ── Autosave persistence (IDB-backed, cache-first) ────────

  getAutosave(pageId) {
    return _cache[pageId] || null;
  },

  setAutosave(pageId, payload) {
    const entry = { ...payload, pageId, t: Date.now() };
    _cache[pageId] = entry;
    _cbPut(entry);
  },

  removeAutosave(pageId) {
    delete _cache[pageId];
    _cbDelete(pageId);
  },

  allAutosaveIds() {
    return Object.keys(_cache);
  },
};

// ── Helpers ──────────────────────────────────────────────────

function _filenameToName(file) {
  const base = file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _parseAutoindex(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    // Skip absolute paths, parent links, query strings
    if (/^(https?:|\/|\?|\.\.)/i.test(href)) continue;
    const decoded = decodeURIComponent(href);
    if (!IMG_EXT_RE.test(decoded)) continue;
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    out.push(decoded);
  }
  return out;
}

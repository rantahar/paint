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
let _cachedBooks     = [];         // { id, name, manifest, pageCount }
let _cachedPages     = [];         // pages from current book
let _currentBookId   = null;       // id of the currently selected book
const _imageCache    = new Map();   // id → HTMLImageElement promise
const _overlayCache  = new Map();   // id → HTMLImageElement|null promise

let _cbDb  = null;
let _cache = {};   // pageId (or bookId:pageId) → { pageId, bgColor?, draw, thumb, name, t }

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
   * Discovers available coloring pages/books. Returns a cached promise on
   * subsequent calls. If books are found, loads the first book by default.
   * For backward compatibility, also handles flat page manifests.
   * Returns an array of pages from the active book (or all pages if flat manifest).
   */
  discover() {
    if (_discoverPromise) return _discoverPromise;
    _discoverPromise = (async () => {
      const dir = _coloringDir();

      // 1. manifest.json (primary) — check for books or flat pages
      try {
        const r = await fetch(dir + 'manifest.json', { cache: 'no-cache' });
        if (r.ok) {
          const data = await r.json();

          // New format: books-based manifest
          if (data && Array.isArray(data.books)) {
            // Load thumbnail for each book from its manifest
            _cachedBooks = await Promise.all(data.books.map(async (book) => {
              try {
                const bookManifest = await fetch(dir + book.manifest, { cache: 'no-cache' }).then(r => r.json());
                return { ...book, thumbnail: bookManifest.thumbnail || null };
              } catch (e) {
                return { ...book, thumbnail: null };
              }
            }));
            if (_cachedBooks.length > 0) {
              _currentBookId = _cachedBooks[0].id;
              return await _loadBook(_currentBookId);
            }
          }

          // Old format: flat pages manifest
          if (data && Array.isArray(data.pages)) {
            const pages = data.pages.map(p => ({
              id:         p.file,
              name:       p.name || _filenameToName(p.file),
              url:        dir + p.file,
              overlayUrl: p.overlay ? dir + p.overlay : null,
            }));
            _cachedPages = _prependBlankEntry(pages);
            return _cachedPages;
          }
        }
      } catch (e) { /* fall through to autoindex */ }

      // 2. directory autoindex (dev only) — use processed/ subdirectory
      try {
        const processedDir = dir + 'processed/';
        const r = await fetch(processedDir, { headers: { Accept: 'text/html' } });
        if (r.ok) {
          const ct = r.headers.get('content-type') || '';
          if (ct.includes('text/html')) {
            const html = await r.text();
            const files = _parseAutoindex(html);
            // Pair "<base>_overlay.<ext>" with "<base>.<ext>" if both present.
            const fileSet = new Set(files);
            const pageFiles = files.filter(f => !/_overlay\.[^.]+$/i.test(f));
            const pages = pageFiles.map(f => {
              const overlayName = _overlayCompanion(f);
              return {
                id:         f,
                name:       _filenameToName(f),
                url:        processedDir + f,
                overlayUrl: fileSet.has(overlayName) ? processedDir + overlayName : null,
              };
            });
            _cachedPages = _prependBlankEntry(pages);
            return _cachedPages;
          }
        }
      } catch (e) { /* fall through */ }

      _cachedPages = _prependBlankEntry([]);
      return _cachedPages;
    })();
    return _discoverPromise;
  },

  /**
   * Switch to a different book by ID. Returns promise that resolves
   * with the pages in that book. Only works if books are available.
   */
  async switchBook(bookId) {
    if (_cachedBooks.length === 0) return _cachedPages;
    const book = _cachedBooks.find(b => b.id === bookId);
    if (!book) return _cachedPages;
    _currentBookId = bookId;
    return await _loadBook(bookId);
  },

  getBooks() { return _cachedBooks.slice(); },
  getCurrentBookId() { return _currentBookId; },

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

  /**
   * Returns a cached HTMLImageElement for the custom overlay companion file
   * (`<base>_overlay.<ext>`), or null if the page has no overlay. A 404 also
   * resolves to null so callers can treat "no overlay" uniformly.
   */
  loadOverlay(page) {
    if (!page.overlayUrl) return Promise.resolve(null);
    if (_overlayCache.has(page.id)) return _overlayCache.get(page.id);
    const p = new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload  = () => resolve(im);
      im.onerror = () => resolve(null);   // missing overlay is not an error
      im.src = page.overlayUrl;
    });
    _overlayCache.set(page.id, p);
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

/**
 * Load a book manifest and return its pages.
 * Caches the result in _cachedPages.
 */
async function _loadBook(bookId) {
  const dir = _coloringDir();
  const book = _cachedBooks.find(b => b.id === bookId);
  if (!book) return [];

  try {
    const r = await fetch(dir + book.manifest, { cache: 'no-cache' });
    if (r.ok) {
      const data = await r.json();
      if (data && Array.isArray(data.pages)) {
        const pages = data.pages.map(p => ({
          id:         bookId + ':' + p.file,  // Include book ID in page ID
          name:       p.name || _filenameToName(p.file),
          url:        dir + p.file,
          overlayUrl: p.overlay ? dir + p.overlay : null,
          bookId:     bookId,
        }));
        _cachedPages = _prependBlankEntry(pages);
        return _cachedPages;
      }
    }
  } catch (e) {
    console.error('Failed to load book manifest:', bookId, e);
  }
  return [];
}

const BLANK_PAGE_ID = '__blank-white';

function _prependBlankEntry(pages) {
  return [
    {
      id: BLANK_PAGE_ID,
      name: 'Blank Canvas',
      isBlank: true,
    },
    ...pages,
  ];
}

function _filenameToName(file) {
  const base = file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** "Garden-01.png" → "Garden-01_overlay.png" (matching extension). */
function _overlayCompanion(file) {
  return file.replace(/(\.[^.]+)$/, '_overlay$1');
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

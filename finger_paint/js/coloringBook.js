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

// Synthetic book containing the user's saved drawings. Always first in
// _cachedBooks. Pages are derived live from FP.storage.list() so they reflect
// post-save / post-delete changes without manual cache invalidation.
const SAVED_BOOK_ID = '__saved';

// Synthetic book containing a flat manifest's pages (or autoindex pages).
// Only created when manifest.json had no `books` array.
const FLAT_BOOK_ID = '__flat';

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
const _coverCache    = new Map();   // bookId → resolved cover URL (skipped for the synthetic saved book — its cover is reactive)

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
   * Discovers available coloring books and pages. Returns a cached promise on
   * subsequent calls. Always prepends the synthetic "Saved Drawings" book as
   * the first entry in the book list, and defaults the current book to it
   * (so the initial page list is the user's saved drawings).
   *
   * Resolution order for coloring books:
   *   1. manifest.json with `{ books: [...] }` — books-based (primary).
   *   2. manifest.json with `{ pages: [...] }` — flat manifest is wrapped in
   *      a synthetic "__flat" book.
   *   3. directory autoindex of `processed/` — same wrapping.
   *   4. No coloring books — only the saved book remains.
   *
   * Returns the pages of the default current book (saved drawings).
   */
  discover() {
    if (_discoverPromise) return _discoverPromise;
    _discoverPromise = (async () => {
      const dir = _coloringDir();
      let coloringBooks = [];
      let flatPages = null;

      // 1. manifest.json (primary) — books or flat pages
      try {
        const r = await fetch(dir + 'manifest.json', { cache: 'no-cache' });
        if (r.ok) {
          const data = await r.json();
          if (data && Array.isArray(data.books)) {
            coloringBooks = await Promise.all(data.books.map(async (book) => {
              try {
                const bookManifest = await fetch(dir + book.manifest, { cache: 'no-cache' }).then(r => r.json());
                return { ...book, thumbnail: bookManifest.thumbnail || null };
              } catch (e) {
                return { ...book, thumbnail: null };
              }
            }));
          } else if (data && Array.isArray(data.pages)) {
            flatPages = data.pages.map(p => ({
              id:         p.file,
              name:       p.name || _filenameToName(p.file),
              url:        dir + p.file,
              overlayUrl: p.overlay ? dir + p.overlay : null,
            }));
          }
        }
      } catch (e) { /* fall through to autoindex */ }

      // 2. directory autoindex (dev only) — only if no manifest produced books or flat pages
      if (coloringBooks.length === 0 && !flatPages) {
        try {
          const processedDir = dir + 'processed/';
          const r = await fetch(processedDir, { headers: { Accept: 'text/html' } });
          if (r.ok) {
            const ct = r.headers.get('content-type') || '';
            if (ct.includes('text/html')) {
              const html = await r.text();
              const files = _parseAutoindex(html);
              const fileSet = new Set(files);
              const pageFiles = files.filter(f => !/_overlay\.[^.]+$/i.test(f));
              flatPages = pageFiles.map(f => {
                const overlayName = _overlayCompanion(f);
                return {
                  id:         f,
                  name:       _filenameToName(f),
                  url:        processedDir + f,
                  overlayUrl: fileSet.has(overlayName) ? processedDir + overlayName : null,
                };
              });
            }
          }
        } catch (e) { /* fall through */ }
      }

      // Wrap flat pages in a synthetic flat book so callers can treat
      // everything as a "book". manifest is null — page list is baked in.
      if (flatPages && coloringBooks.length === 0) {
        coloringBooks = [{
          id:        FLAT_BOOK_ID,
          name:      'Coloring Pages',
          manifest:  null,
          thumbnail: null,
          pages:     flatPages,
        }];
      }

      // Always prepend the synthetic saved book. It owns the blank-canvas
      // tile (no other book carries one anymore — see _loadBook).
      _cachedBooks = [
        {
          id:        SAVED_BOOK_ID,
          name:      'Saved Drawings',
          manifest:  null,
          thumbnail: null,
          synthetic: true,
        },
        ...coloringBooks,
      ];

      _currentBookId = SAVED_BOOK_ID;
      _cachedPages = _computeSavedBookPages();
      return _cachedPages;
    })();
    return _discoverPromise;
  },

  /**
   * Switch to a different book by ID. Returns promise that resolves
   * with the pages in that book. Only works if books are available.
   *
   * Special-cased:
   *   • SAVED_BOOK_ID: pages are recomputed live from FP.storage.list(),
   *     prepended with the blank-canvas tile.
   *   • FLAT_BOOK_ID: pages were baked into the book at discover() time.
   */
  async switchBook(bookId) {
    if (_cachedBooks.length === 0) return _cachedPages;
    const book = _cachedBooks.find(b => b.id === bookId);
    if (!book) return _cachedPages;
    _currentBookId = bookId;
    if (book.id === SAVED_BOOK_ID) {
      _cachedPages = _computeSavedBookPages();
      return _cachedPages;
    }
    if (Array.isArray(book.pages) && !book.manifest) {
      // Synthetic flat book (or any future "pages baked in" book)
      _cachedPages = book.pages.slice();
      return _cachedPages;
    }
    return await _loadBook(bookId);
  },

  getBooks() { return _cachedBooks.slice(); },
  getCurrentBookId() { return _currentBookId; },

  list() { return _cachedPages.slice(); },

  /**
   * Returns the live page list for the synthetic saved book. The list is
   * derived from FP.storage.list() on each call, so callers can re-invoke
   * after a save/delete without going through switchBook().
   */
  getSavedBookPages() { return _computeSavedBookPages(); },

  /**
   * Returns the resolved cover-image URL for the book (or a dataURL for the
   * synthetic saved book), following the chain:
   *   1. book.thumbnail (from manifest)
   *   2. <book-dir>/cover.[png|jpg|webp] if it exists
   *   3. first page of the book
   * Returns null if no cover could be resolved (caller handles fallback).
   */
  resolveBookCover(book) { return _resolveBookCover(book); },

  /**
   * Returns a Promise<string[]> of every coloring-page ID across every book
   * (excluding the synthetic saved book). Used by app.js to detect orphaned
   * autosaves — autosaves whose source page no longer exists in any book.
   *
   * Loads each book's manifest on demand; result is computed fresh each call.
   */
  async getAllPageIds() {
    const ids = [];
    for (const book of _cachedBooks) {
      if (book.id === SAVED_BOOK_ID) continue;
      if (Array.isArray(book.pages) && !book.manifest) {
        ids.push(...book.pages.map(p => p.id));
        continue;
      }
      if (book.manifest) {
        try {
          const r = await fetch(_coloringDir() + book.manifest, { cache: 'no-cache' });
          if (r.ok) {
            const data = await r.json();
            if (data && Array.isArray(data.pages)) {
              for (const p of data.pages) ids.push(book.id + ':' + p.file);
            }
          }
        } catch (e) { /* skip this book */ }
      }
    }
    return ids;
  },

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
 * Load a book manifest and return its pages. Coloring books no longer carry
 * a blank-canvas tile — the saved book owns the only blank-canvas entry.
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
        _cachedPages = pages;
        return _cachedPages;
      }
    }
  } catch (e) {
    console.error('Failed to load book manifest:', bookId, e);
  }
  return [];
}

const BLANK_PAGE_ID = '__blank-white';

function _blankPageTile() {
  return { id: BLANK_PAGE_ID, name: 'Blank Canvas', isBlank: true };
}

function _prependBlankEntry(pages) {
  return [_blankPageTile(), ...pages];
}

// Live page list for the saved book: [blank-tile, ...saved-drawings].
function _computeSavedBookPages() {
  const saved = (window.FP && FP.storage && FP.storage.list) ? FP.storage.list() : [];
  const pages = saved.map(entry => ({
    id:              'saved:' + entry.id,
    name:            entry.name || ('Saved drawing ' + new Date(entry.t).toLocaleString()),
    isSavedDrawing:  true,
    entry:           entry,
  }));
  return _prependBlankEntry(pages);
}

// Cover-image resolution: manifest.thumbnail → cover.[ext] → first page.
// For the synthetic saved book: most-recent saved thumb, or null.
async function _resolveBookCover(book) {
  if (book.id !== SAVED_BOOK_ID && _coverCache.has(book.id)) {
    return _coverCache.get(book.id);
  }

  let cover = null;

  if (book.id === SAVED_BOOK_ID) {
    const list = (window.FP && FP.storage && FP.storage.list) ? FP.storage.list() : [];
    if (list.length > 0) cover = list[0].thumb || list[0].png || null;
  } else if (book.thumbnail) {
    // Step 1: manifest's thumbnail field
    cover = _coloringDir() + book.thumbnail;
  } else if (book.manifest) {
    // Step 2: probe <book-dir>/cover.[ext]
    const bookDir = _coloringDir() + book.manifest.replace(/[^/]+$/, '');
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const url = bookDir + 'cover.' + ext;
      if (await _imageExists(url)) { cover = url; break; }
    }
    // Step 3: first page of the book (load manifest if not cached)
    if (!cover) {
      try {
        const r = await fetch(_coloringDir() + book.manifest, { cache: 'no-cache' });
        if (r.ok) {
          const data = await r.json();
          if (data && Array.isArray(data.pages) && data.pages.length > 0) {
            cover = _coloringDir() + data.pages[0].file;
          }
        }
      } catch (e) { /* leave cover null */ }
    }
  } else if (Array.isArray(book.pages) && book.pages.length > 0) {
    // Synthetic flat book — first baked page's URL
    cover = book.pages[0].url;
  }

  if (book.id !== SAVED_BOOK_ID) _coverCache.set(book.id, cover);
  return cover;
}

function _imageExists(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
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

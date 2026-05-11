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

   Per-page autosave: localStorage key
     fingerPaint.coloringPages.v2
   shape:
     { [pageId]: { bg, draw, thumb, name, t } }
     • bg / draw: two-layer canvas state (image + transparent strokes)
     • thumb:     small composite preview for the strip
     • name:      preserved so orphans can be migrated with a name
     • t:         last-modified epoch ms (used to drop oldest on quota)
   Storing the bg layer means we don't depend on the source file
   surviving in the folder — coloring-page sources can be deleted at
   any time without losing the user's saved work.
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

const COLORING_DIR_NAME = 'coloring-pages';
const AUTOSAVE_KEY      = 'fingerPaint.coloringPages.v2';
const IMG_EXT_RE        = /\.(png|jpe?g|gif|webp|svg)$/i;

function _coloringDir() {
  // crayon-mode lives one level down — walk up to reach the shared folder.
  const inCrayon = location.pathname.includes('/crayon-mode/');
  return (inCrayon ? '../' : '') + COLORING_DIR_NAME + '/';
}

let _discoverPromise = null;
let _cachedPages     = [];
const _imageCache    = new Map();   // id → HTMLImageElement promise

FP.coloringBook = {
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

  // ── Autosave persistence ──────────────────────────────────
  _readAll() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
      console.warn('coloringBook autosave parse failed', e);
      return {};
    }
  },

  _writeAll(obj) {
    let entries = Object.entries(obj);
    while (true) {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(Object.fromEntries(entries)));
        return true;
      } catch (e) {
        if (entries.length === 0) {
          console.error('coloringBook autosave failed even when empty', e);
          return false;
        }
        // Drop the oldest entry (smallest .t)
        let oldestIdx = 0;
        for (let i = 1; i < entries.length; i++) {
          if ((entries[i][1].t || 0) < (entries[oldestIdx][1].t || 0)) oldestIdx = i;
        }
        entries.splice(oldestIdx, 1);
      }
    }
  },

  getAutosave(pageId) {
    const all = this._readAll();
    return all[pageId] || null;
  },

  setAutosave(pageId, payload) {
    const all = this._readAll();
    all[pageId] = Object.assign({}, payload, { t: Date.now() });
    this._writeAll(all);
  },

  removeAutosave(pageId) {
    const all = this._readAll();
    if (pageId in all) {
      delete all[pageId];
      this._writeAll(all);
    }
  },

  allAutosaveIds() {
    return Object.keys(this._readAll());
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

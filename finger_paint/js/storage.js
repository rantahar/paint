/* ────────────────────────────────────────────────────────────
   storage.js — localStorage persistence of saved drawings.

   v2 envelope (current):
     { id: '<uuid>', t: <unix-ms>,
       bg:    '<dataURL>',     // background layer (image baked in)
       draw:  '<dataURL>',     // transparent strokes layer (may be null)
       thumb: '<dataURL>' }    // small composite preview (~160px)

   v1 envelope (legacy, read-only fallback):
     { id, t, png }   where png is the flat composite.
   On list() we transparently surface v1 entries shaped as v2
     (bg = png, draw = null, thumb = png).
   v1 data is left intact in localStorage until a subsequent add()
   writes v2 — at which point the v1 key is ignored.

   Listing order: most-recent first. (Newest unshifted to index 0.)
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

const STORAGE_KEY_V1 = 'fingerPaint.savedDrawings.v1';
const STORAGE_KEY    = 'fingerPaint.savedDrawings.v2';

FP.storage = {
  list() {
    // Prefer v2
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (e) {
      console.warn('storage.list: v2 parse failed', e);
    }
    // Fallback: migrate v1 shape on read
    try {
      const raw = localStorage.getItem(STORAGE_KEY_V1);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          return arr.map(e => ({
            id: e.id, t: e.t,
            bg: e.png, draw: null, thumb: e.png,
          }));
        }
      }
    } catch (e) {
      console.warn('storage.list: v1 fallback parse failed', e);
    }
    return [];
  },

  add(bgDataUrl, drawDataUrl, thumbDataUrl) {
    const list = this.list();
    const entry = {
      id: _uuid(),
      t:  Date.now(),
      bg:    bgDataUrl,
      draw:  drawDataUrl || null,
      thumb: thumbDataUrl || bgDataUrl,
    };
    list.unshift(entry);
    this._writeWithFallback(list);
    return entry;
  },

  remove(id) {
    const list = this.list().filter(e => e.id !== id);
    this._writeWithFallback(list);
  },

  get(id) {
    return this.list().find(e => e.id === id) || null;
  },

  // ── Quota-aware writer ─────────────────────────────────────
  // localStorage caps around 5 MB. If we hit quota, drop the OLDEST
  // entries until the write succeeds. Returns true on success.
  _writeWithFallback(list) {
    let attempt = list.slice();
    while (attempt.length >= 0) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
        return true;
      } catch (e) {
        if (attempt.length === 0) {
          console.error('storage write failed even when empty', e);
          return false;
        }
        // drop the oldest (highest index) entry
        attempt.pop();
      }
    }
  },

  // Build a full-size composite PNG dataURL from a v2 entry.
  // Used by downloadOne when the entry has no flat `png` field.
  compositeFromEntry(entry) {
    if (entry.png) return Promise.resolve(entry.png);  // v1 shape
    return _flattenLayers(entry.bg, entry.draw);
  },

  // Download helper — invoked from the Download-All flow.
  // Triggers a single PNG download via a hidden anchor.
  async downloadOne(entry) {
    const a = document.getElementById('download-anchor');
    a.href = await this.compositeFromEntry(entry);
    a.download = `painting-${_filenameTimestamp(entry.t)}.png`;
    a.click();
  },

  // Bulk download — kicks off N download events sequentially.
  // Browsers may consolidate or rate-limit these; that's acceptable.
  downloadAll() {
    const list = this.list();
    list.forEach((entry, i) => {
      // Stagger by 200ms so the browser's "multiple downloads" prompt
      // shows once and individual files don't clobber each other.
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

// Flatten a (bg, draw) pair into a single composite PNG dataURL.
// Returns the bg dataURL unchanged if draw is null/empty.
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

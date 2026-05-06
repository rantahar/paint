/* ────────────────────────────────────────────────────────────
   storage.js — localStorage persistence of saved drawings.

   Each drawing is stored as a JSON envelope:
     { id: '<uuid>', t: <unix-ms>, png: '<dataURL>' }
   The PNG data URL contains the FULL composite (background + strokes)
   at painting resolution (1000×1000).

   Listing order: most-recent first. (Newest unshifted to index 0.)
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

const STORAGE_KEY = 'fingerPaint.savedDrawings.v1';

FP.storage = {
  list() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn('storage.list: parse failed, resetting', e);
      return [];
    }
  },

  add(pngDataUrl) {
    const list = this.list();
    const entry = {
      id: _uuid(),
      t:  Date.now(),
      png: pngDataUrl,
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

  // Download helper — invoked from the Download-All flow.
  // Triggers a single PNG download via a hidden anchor.
  downloadOne(entry) {
    const a = document.getElementById('download-anchor');
    a.href = entry.png;
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
  // Cheap UUID — good enough for client-side IDs
  return 'd-' + Math.random().toString(36).slice(2, 10) +
         '-' + Date.now().toString(36);
}

function _filenameTimestamp(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}` +
         `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/* ────────────────────────────────────────────────────────────
   dialogs.js — modal confirmation popups.

   Three dialog flavours:
     • confirm({ title, message, choices: [{label, value, kind}] })
         → resolves with the selected choice's `value` (or null on backdrop click)
     • clearDrawing()  → 'clear' | 'save' | 'cancel'
     • deleteSaved()   → 'delete' | 'cancel'
     • uploadBackground({ newBgDataUrl, currentDrawingDataUrl })
         → 'replace-all' | 'keep-drawing' | 'cancel'
   ──────────────────────────────────────────────────────────── */
window.FP = window.FP || {};

FP.dialogs = {

  confirm({ title, message, choices }) {
    return new Promise(resolve => {
      const back = document.createElement('div');
      back.className = 'dialog-backdrop';
      back.tabIndex = -1;

      const dlg = document.createElement('div');
      dlg.className = 'dialog';
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');

      if (title) {
        const h = document.createElement('div');
        h.className = 'dialog-title';
        h.textContent = title;
        dlg.appendChild(h);
      }
      if (message) {
        const m = document.createElement('div');
        m.className = 'dialog-message';
        m.textContent = message;
        dlg.appendChild(m);
      }

      const row = document.createElement('div');
      row.className = 'dialog-row';
      choices.forEach(c => {
        const b = document.createElement('button');
        b.className = 'dialog-btn' + (c.kind ? ' ' + c.kind : '');
        // Compose icon + label
        if (c.icon) {
          b.innerHTML = FP.icon(c.icon, 22) + `<span>${_escape(c.label)}</span>`;
        } else if (c.thumb) {
          b.classList.add('thumb-btn');
          const img = c.thumb;            // dataURL or HTMLImageElement
          if (typeof img === 'string') {
            b.innerHTML = `<img class="thumb-preview" src="${img}" alt="">` +
                          `<span class="thumb-label">${_escape(c.label)}</span>`;
          } else {
            const wrap = document.createElement('div');
            wrap.appendChild(img);
            img.classList.add('thumb-preview');
            const lbl = document.createElement('span');
            lbl.className = 'thumb-label';
            lbl.textContent = c.label;
            b.appendChild(wrap);
            b.appendChild(lbl);
          }
        } else {
          b.textContent = c.label;
        }
        b.addEventListener('click', () => close(c.value));
        row.appendChild(b);
      });
      dlg.appendChild(row);
      back.appendChild(dlg);
      document.body.appendChild(back);

      // Backdrop click → cancel (counts as null, never a choice)
      back.addEventListener('click', e => {
        if (e.target === back) close(null);
      });

      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      };
      document.addEventListener('keydown', onKey);

      FP.playSound('dialogOpen');

      function close(value) {
        document.removeEventListener('keydown', onKey);
        FP.playSound('dialogClose');
        back.remove();
        resolve(value);
      }
    });
  },

  // Convenience wrappers — these match the user-spec flows.

  clearDrawing() {
    return this.confirm({
      title: 'Clear your drawing?',
      message: 'This will erase what you painted.',
      choices: [
        { label: 'Save first', value: 'save',   kind: 'primary', icon: 'save'   },
        { label: 'Clear',      value: 'clear',  kind: 'danger',  icon: 'clear'  },
        { label: 'Cancel',     value: 'cancel',                  icon: 'cancel' },
      ],
    });
  },

  deleteSaved() {
    return this.confirm({
      title: 'Delete this drawing?',
      message: 'You can\'t undo this.',
      choices: [
        { label: 'Delete', value: 'delete', kind: 'danger',  icon: 'delete' },
        { label: 'Cancel', value: 'cancel',                  icon: 'cancel' },
      ],
    });
  },

  uploadBackground({ newBgDataUrl, mergedWithDrawingDataUrl }) {
    return this.confirm({
      title: 'New background',
      message: 'How should we use this image?',
      choices: [
        { label: 'Replace everything', value: 'replace-all',
          thumb: newBgDataUrl,           kind: 'danger' },
        { label: 'Keep my drawing',    value: 'keep-drawing',
          thumb: mergedWithDrawingDataUrl, kind: 'primary' },
        { label: 'Cancel',             value: 'cancel', icon: 'cancel' },
      ],
    });
  },

  downloadDrawings(savedCount) {
    return this.confirm({
      title: 'Download drawings',
      message: savedCount > 1
        ? `You have ${savedCount} saved drawings.`
        : 'You have 1 saved drawing.',
      choices: [
        { label: 'This one', value: 'one',
          kind: 'primary', icon: 'download' },
        savedCount > 1 && { label: 'Download all', value: 'all',
          kind: 'primary', icon: 'download' },
        { label: 'Cancel',             value: 'cancel', icon: 'cancel' },
      ].filter(Boolean),
    });
  },
};

function _escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

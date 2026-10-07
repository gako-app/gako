// A question before something that can't be undone: "Revert sidebar.ts?". Escape or a click
// outside cancels; Cancel has the focus, so Enter alone never confirms.

import { h } from './dom';

export function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      done(false);
    };
    const cancel = h('button', { type: 'button', onclick: () => done(false) }, 'Cancel');
    const backdrop = h('div', { class: 'dialog-backdrop', onmousedown: (e: MouseEvent) => { if (e.target === backdrop) done(false); } },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('div', { class: 'dialog-title' }, title),
        h('div', { class: 'dialog-message' }, message),
        h('div', { class: 'dialog-buttons' },
          cancel,
          h('button', { type: 'button', class: 'danger', onclick: () => done(true) }, action))));
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    cancel.focus();
  });
}

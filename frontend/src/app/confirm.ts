// Gako: a workspace app for reviewing and supervising coding agents across many repositories.
// Copyright (C) 2026 João Sena Ribeiro
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU Affero General Public License as published by the Free Software Foundation, either version 3
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along with this program.
// If not, see <https://www.gnu.org/licenses/>.

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

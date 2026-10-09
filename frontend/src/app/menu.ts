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

// A popup menu, for "open in editor" choices, the file tree's context menu and the search's repo
// picker. One menu is open at a time; a click elsewhere or Escape closes it.

import { h } from './dom';

export interface MenuItem {
  label: string;
  title?: string;
  checked?: boolean;
  /** Clicking it leaves the menu open, drawn again (a list of checkboxes, say). */
  keep?: boolean;
  run: () => void;
}

type Items = (MenuItem | 'separator')[];

let open: HTMLElement | null = null;

export function closeMenu(): void {
  open?.remove();
  open = null;
}

document.addEventListener('mousedown', (e) => {
  if (open && !open.contains(e.target as Node)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (open && e.key === 'Escape') closeMenu();
});

/** Shows a menu below `at` (an element) or at a point (a context menu). Given a function, the items
 * are asked for again after an item that keeps the menu open is clicked. */
export function showMenu(at: HTMLElement | { x: number; y: number }, items: Items | (() => Items)): void {
  closeMenu();
  const list = h('div', { class: 'menu-list' });
  const draw = () => list.replaceChildren(...(typeof items === 'function' ? items() : items).map((item) => item === 'separator'
    ? h('div', { class: 'menu-separator' })
    : h('button', {
      class: `menu-item ${item.checked ? 'selected' : ''} ${item.keep ? 'check' : ''}`, title: item.title,
      onclick: () => {
        if (!item.keep) closeMenu();
        item.run();
        if (item.keep) draw();
      },
    }, item.label)));
  draw();
  const el = h('div', { class: 'menu' }, list);
  const p = at instanceof HTMLElement ? (() => { const r = at.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })() : at;
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  document.body.append(el);
  // Kept on screen: flipped left or up when it would overflow.
  const r = el.getBoundingClientRect();
  if (r.right > innerWidth - 4) el.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight - 4) el.style.top = `${Math.max(4, p.y - r.height - (at instanceof HTMLElement ? at.offsetHeight + 8 : 0))}px`;
  open = el;
}

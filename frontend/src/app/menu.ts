// A popup menu, for "open in editor" choices and the file tree's context menu. One menu is open at
// a time; a click elsewhere or Escape closes it.

import { h } from './dom';

export interface MenuItem {
  label: string;
  title?: string;
  checked?: boolean;
  run: () => void;
}

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

/** Shows a menu below `at` (an element) or at a point (a context menu). */
export function showMenu(at: HTMLElement | { x: number; y: number }, items: (MenuItem | 'separator')[]): void {
  closeMenu();
  const el = h('div', { class: 'menu' },
    h('div', { class: 'menu-list' }, items.map((item) => item === 'separator'
      ? h('div', { class: 'menu-separator' })
      : h('button', {
        class: `menu-item ${item.checked ? 'selected' : ''}`, title: item.title,
        onclick: () => { closeMenu(); item.run(); },
      }, item.label))));
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

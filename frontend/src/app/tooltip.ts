// Tooltips for anything with a `data-tip` attribute.
//
// The browser's own `title` tooltips need the element under the pointer to stay put for a moment,
// but the sidebar and the file tree redraw on every status update while agents work, so they rarely
// appeared. These follow the text under the pointer instead of the element: a redraw that puts the
// same tip back under the pointer keeps it showing.

import { h } from './dom';

const DELAY_MS = 450;
const el = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
let shown = '';
let pending = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let x = 0;
let y = 0;

function tipAt(px: number, py: number): HTMLElement | null {
  return (document.elementFromPoint(px, py) as HTMLElement | null)?.closest?.('[data-tip]') ?? null;
}

function hide(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = '';
  shown = '';
  el.hidden = true;
}

function show(target: HTMLElement, text: string): void {
  shown = text;
  el.textContent = text;
  el.hidden = false;
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4));
  const below = r.bottom + 6 + hgt < innerHeight - 4;
  el.style.left = `${left}px`;
  el.style.top = `${below ? r.bottom + 6 : r.top - hgt - 6}px`;
}

export function installTooltips(): void {
  document.body.append(el);
  document.addEventListener('mousemove', (e) => {
    x = e.clientX;
    y = e.clientY;
    const text = (e.target as HTMLElement).closest?.('[data-tip]')?.getAttribute('data-tip') ?? '';
    if (text === shown || text === pending) return;
    hide();
    if (!text) return;
    pending = text;
    timer = setTimeout(() => {
      // Whatever is under the pointer now, after any redraw.
      const target = tipAt(x, y);
      if (target?.getAttribute('data-tip') === pending) show(target, pending);
      pending = '';
    }, DELAY_MS);
  });
  for (const ev of ['mousedown', 'wheel', 'keydown'] as const) document.addEventListener(ev, hide, true);
  document.addEventListener('mouseleave', hide);
}

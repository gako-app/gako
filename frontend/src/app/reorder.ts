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

// Dragging the entries of a bar (the documents' tabs, the agent bar) into a new order. A press turns
// into a drag only once the pointer has moved a few pixels, so clicks and double clicks work as
// before. The entry then follows the pointer along the bar while the others make room, and the new
// order is applied on release; Escape puts everything back. Pointer events rather than HTML drag and
// drop, so it looks and behaves the same on every platform.

/** How far, in pixels, the pointer moves before a press becomes a drag. */
const THRESHOLD = 5;

export class Reorder {
  /** An entry is pressed, or being dragged. */
  private busy = false;
  /** A redraw was held back meanwhile. */
  private stale = false;

  /** `list` holds the entries as its children, laid out along `axis`; `redraw` draws it again. */
  constructor(private list: HTMLElement, private axis: 'x' | 'y', private redraw: () => void) {}

  /** False while an entry is pressed or dragged: the list mustn't be redrawn under it (which would
   * take the entry away), and is redrawn once it's released. */
  canDraw(): boolean {
    if (this.busy) this.stale = true;
    return !this.busy;
  }

  /** Lets `item`, one of the list's children, be dragged; `drop` is told where it was dropped. */
  attach(item: HTMLElement, drop: (to: number) => void): void {
    item.addEventListener('pointerdown', (down: PointerEvent) => {
      if (down.button === 0 && !this.busy) this.press(item, down, drop);
    });
  }

  private press(item: HTMLElement, down: PointerEvent, drop: (to: number) => void): void {
    const x = this.axis === 'x';
    const at = (e: PointerEvent) => (x ? e.clientX : e.clientY);
    const lo = (r: DOMRect) => (x ? r.left : r.top);
    const hi = (r: DOMRect) => (x ? r.right : r.bottom);
    const shiftBy = (el: HTMLElement, d: number) => { el.style.transform = d ? `translate${x ? 'X' : 'Y'}(${d}px)` : ''; };
    const start = at(down);
    let dragging = false;
    let cancelled = false;
    let items: HTMLElement[] = [];
    let rects: DOMRect[] = [];
    let from = -1;
    let to = -1;
    /** How far the others move to make room: the entry's size and the gap after it. */
    let room = 0;
    this.busy = true;
    this.stale = false;

    const reset = () => {
      for (const el of items) shiftBy(el, 0);
      this.list.classList.remove('reordering');
      item.classList.remove('dragging');
    };
    const begin = () => {
      dragging = true;
      items = [...this.list.children] as HTMLElement[];
      rects = items.map((el) => el.getBoundingClientRect());
      from = to = items.indexOf(item);
      const gap = items.length > 1 ? lo(rects[1]) - hi(rects[0]) : 0;
      room = hi(rects[from]) - lo(rects[from]) + gap;
      item.setPointerCapture(down.pointerId);
      this.list.classList.add('reordering');
      item.classList.add('dragging');
    };
    const move = (e: PointerEvent) => {
      if (cancelled) return;
      if (!dragging) {
        if (Math.abs(at(e) - start) < THRESHOLD) return;
        begin();
      }
      // The entry stays within the bar, and lands where its middle is.
      const r = rects[from];
      const d = Math.min(hi(rects[rects.length - 1]) - hi(r), Math.max(lo(rects[0]) - lo(r), at(e) - start));
      shiftBy(item, d);
      const middle = (lo(r) + hi(r)) / 2 + d;
      to = rects.filter((q, i) => i !== from && (lo(q) + hi(q)) / 2 < middle).length;
      items.forEach((el, i) => {
        if (i !== from) shiftBy(el, from < i && i <= to ? -room : to <= i && i < from ? room : 0);
      });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragging || cancelled) return;
      e.preventDefault();
      e.stopPropagation();
      cancelled = true;
      reset();
    };
    const end = (e: PointerEvent) => {
      if (e.type === 'pointercancel') cancelled = true;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      removeEventListener('keydown', key, true);
      this.busy = false;
      const stale = this.stale;
      this.stale = false;
      if (!dragging) {
        // After the click, which goes to the entry pressed.
        if (stale) setTimeout(() => this.redraw());
        return;
      }
      reset();
      // The click that ends a drag isn't one.
      const swallow = (e: Event) => e.stopPropagation();
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true));
      if (!cancelled && to !== from) drop(to);
      else if (stale) this.redraw();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
    addEventListener('keydown', key, true);
  }
}

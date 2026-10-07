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

// Single or dual pane: whether an agent's terminal shows in place of the documents (single) or in a
// pane of its own to their right (dual), for wide screens; and, in the dual layout, how much of the
// main area the terminal pane takes, set by dragging the separator. Both are remembered on this
// machine.

import { h } from './dom';
import { iconButton } from './icons';

const KEY = 'gako.panes';
/** Neither pane gets narrower than this. */
const MIN_PX = 280;

export class Panes {
  readonly toggle: HTMLButtonElement;
  readonly handle = h('div', { class: 'pane-handle', hidden: true, 'data-tip': 'Drag to resize' });
  private dual = false;
  /** The terminal pane's share of the main area's width. */
  private fraction = 0.5;

  constructor(private main: HTMLElement, private terminals: { setDual(dual: boolean): void }) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (s) {
        this.dual = s.dual === true;
        if (typeof s.fraction === 'number') this.fraction = s.fraction;
      }
    } catch { /* storage unavailable */ }
    this.toggle = iconButton('panes', '', () => {
      this.dual = !this.dual;
      this.apply();
      this.save();
    }, { class: 'pane-toggle' });
    this.handle.addEventListener('pointerdown', (down: PointerEvent) => this.drag(down));
    this.apply();
  }

  private apply(): void {
    this.main.classList.toggle('dual', this.dual);
    this.main.style.setProperty('--term-frac', String(this.fraction));
    this.handle.hidden = !this.dual;
    const tip = this.dual ? 'Show agents in place of the files (single pane)' : 'Show agents beside the files (dual pane)';
    this.toggle.setAttribute('data-tip', tip);
    this.toggle.setAttribute('aria-label', tip);
    this.toggle.setAttribute('aria-pressed', String(this.dual));
    this.toggle.classList.toggle('on', this.dual);
    this.terminals.setDual(this.dual);
  }

  private save(): void {
    try { localStorage.setItem(KEY, JSON.stringify({ dual: this.dual, fraction: this.fraction })); } catch { /* storage unavailable */ }
  }

  private drag(down: PointerEvent): void {
    down.preventDefault();
    this.handle.setPointerCapture(down.pointerId);
    document.body.classList.add('resizing');
    const move = (e: PointerEvent) => {
      const r = this.main.getBoundingClientRect();
      const min = Math.min(0.5, MIN_PX / r.width);
      this.fraction = Math.min(1 - min, Math.max(min, (r.right - e.clientX) / r.width));
      this.main.style.setProperty('--term-frac', String(this.fraction));
    };
    const up = () => {
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
      this.handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      this.save();
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
    this.handle.addEventListener('pointercancel', up);
  }
}

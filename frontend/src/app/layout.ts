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

// The widths of the two sidebars: the left one (repos, files, search) and the agent bar on the
// right. Both are resized by dragging their inner edge, and collapse when dragged narrower than a
// threshold (dragging out again brings them back). Sizes are remembered on this machine.

import { h } from './dom';

const KEY = 'gako.layout';

interface Saved {
  left: number;
  leftCollapsed: boolean;
  right: number;
}

const LEFT = { initial: 300, min: 220, collapseBelow: 150 };
/** The activity bar's width, left of the sidebar (style.css). */
const RAIL = 44;
const RIGHT = { initial: 220, min: 160, collapseBelow: 110 };

export interface RightBar {
  el: HTMLElement;
  collapsed: boolean;
  setCollapsed(collapsed: boolean): void;
}

export class Layout {
  /** Called when the left sidebar is shown or hidden. */
  onLeft?: () => void;
  private saved: Saved = { left: LEFT.initial, leftCollapsed: false, right: RIGHT.initial };

  constructor(private app: HTMLElement, private left: HTMLElement, private right: RightBar) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (s) this.saved = { ...this.saved, ...s };
    } catch { /* storage unavailable */ }
    // Sizes saved under older limits.
    this.saved.left = Math.max(LEFT.min, this.saved.left);
    this.saved.right = Math.max(RIGHT.min, this.saved.right);
    // The handles belong to the app, not the bars, so a bar collapsing mid-drag doesn't end it.
    this.app.append(this.handle('left'), this.handle('right'));
    this.apply();
  }

  get leftCollapsed(): boolean {
    return this.saved.leftCollapsed;
  }

  setLeftCollapsed(collapsed: boolean): void {
    this.saved.leftCollapsed = collapsed;
    if (!collapsed && this.saved.left < LEFT.min) this.saved.left = LEFT.initial;
    this.apply();
    this.save();
  }

  /** Call when the agent bar collapses or expands by its own button. */
  apply(): void {
    this.app.style.setProperty('--left-w', `${this.saved.left}px`);
    this.app.style.setProperty('--right-w', `${this.saved.right}px`);
    // Where the handles sit: the visible widths.
    this.app.style.setProperty('--left-edge', `${RAIL + (this.saved.leftCollapsed ? 0 : this.saved.left)}px`);
    this.app.style.setProperty('--right-edge', this.right.collapsed ? '48px' : `${this.saved.right}px`);
    const changed = this.left.hidden !== this.saved.leftCollapsed;
    this.left.hidden = this.saved.leftCollapsed;
    if (changed) this.onLeft?.();
  }

  private save(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.saved)); } catch { /* storage unavailable */ }
  }

  /** A drag handle on a sidebar's inner edge. */
  private handle(side: 'left' | 'right'): HTMLElement {
    const el = h('div', { class: `resize-handle ${side}`, 'data-tip': 'Drag to resize; drag narrow to hide' });
    el.addEventListener('pointerdown', (down: PointerEvent) => {
      down.preventDefault();
      el.setPointerCapture(down.pointerId);
      document.body.classList.add('resizing');
      const limits = side === 'left' ? LEFT : RIGHT;
      const move = (e: PointerEvent) => {
        const max = Math.round(innerWidth * 0.5);
        const width = side === 'left' ? e.clientX - RAIL : innerWidth - e.clientX;
        const collapsed = width < limits.collapseBelow;
        if (side === 'left') {
          this.saved.leftCollapsed = collapsed;
          if (!collapsed) this.saved.left = Math.min(max, Math.max(limits.min, width));
        } else {
          if (collapsed !== this.right.collapsed) this.right.setCollapsed(collapsed);
          if (!collapsed) this.saved.right = Math.min(max, Math.max(limits.min, width));
        }
        this.apply();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing');
        this.save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    return el;
  }
}

// The widths of the two sidebars: the left one (repos, files, search) and the agent bar on the
// right. Both are resized by dragging their inner edge, and collapse when dragged narrower than a
// threshold (dragging out again brings them back). Sizes are remembered on this machine.

import { h } from './dom';
import { iconButton } from './icons';

const KEY = 'gako.layout';

interface Saved {
  left: number;
  leftCollapsed: boolean;
  right: number;
}

const LEFT = { initial: 300, min: 200, collapseBelow: 140 };
const RIGHT = { initial: 220, min: 160, collapseBelow: 110 };

export interface RightBar {
  el: HTMLElement;
  collapsed: boolean;
  setCollapsed(collapsed: boolean): void;
}

export class Layout {
  /** Shown in place of the left sidebar when it's collapsed. */
  readonly leftRail = h('div', { class: 'left-rail', hidden: true });
  private saved: Saved = { left: LEFT.initial, leftCollapsed: false, right: RIGHT.initial };

  constructor(private app: HTMLElement, private left: HTMLElement, private right: RightBar) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (s) this.saved = { ...this.saved, ...s };
    } catch { /* storage unavailable */ }
    this.leftRail.append(iconButton('right', 'Show the sidebar', () => this.setLeftCollapsed(false), { class: 'bar-toggle' }));
    // The handles belong to the app, not the bars, so a bar collapsing mid-drag doesn't end it.
    this.app.append(this.handle('left'), this.handle('right'));
    this.apply();
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
    this.app.style.setProperty('--left-edge', this.saved.leftCollapsed ? '28px' : `${this.saved.left}px`);
    this.app.style.setProperty('--right-edge', this.right.collapsed ? '44px' : `${this.saved.right}px`);
    this.left.hidden = this.saved.leftCollapsed;
    this.leftRail.hidden = !this.saved.leftCollapsed;
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
        const width = side === 'left' ? e.clientX : innerWidth - e.clientX;
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

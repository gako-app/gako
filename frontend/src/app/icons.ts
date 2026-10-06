// Icons (Lucide's, ISC licence) and icon buttons that carry a tooltip. Only the icons named here
// are bundled.

import {
  ArrowDown, ArrowUp, ChevronDown, ChevronUp, createElement, FileText, History, type IconNode,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw, SquareArrowOutUpRight,
} from 'lucide';
import { h } from './dom';

const ICONS = {
  file: FileText,
  history: History,
  refresh: RefreshCw,
  push: ArrowUp,
  pull: ArrowDown,
  external: SquareArrowOutUpRight,
  'sidebar-hide': PanelLeftClose,
  'sidebar-show': PanelLeftOpen,
  'agents-hide': PanelRightClose,
  'agents-show': PanelRightOpen,
  plus: Plus,
  prev: ChevronUp,
  next: ChevronDown,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGElement {
  return createElement(ICONS[name], { class: 'svg-icon', 'aria-hidden': 'true' });
}

/** A button showing an icon (and an optional label), with a tooltip. */
export function iconButton(name: IconName, tip: string, onclick: (e: MouseEvent) => void, opts: { label?: string; class?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', {
    class: `icon-btn ${opts.class ?? ''}`, 'data-tip': tip, 'aria-label': tip, disabled: opts.disabled,
    onclick: (e: MouseEvent) => { e.stopPropagation(); onclick(e); },
  }, icon(name), opts.label ? h('span', { class: 'icon-label' }, opts.label) : null);
}

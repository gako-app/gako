// Icons (Lucide's, ISC licence) and icon buttons that carry a tooltip. Only the icons named here
// are bundled.

import {
  ArrowDown, ArrowUp, Braces, ChevronDown, ChevronUp, Columns2, createElement, FileDiff, FilePen, FileText, Folder, FolderOpen,
  GitBranch, History, type IconNode, LoaderCircle, Proportions, PanelLeftClose, PanelLeftOpen, PanelRightClose,
  PanelRightOpen, Plus, RefreshCw, Rows2, Undo2,
} from 'lucide';
import { h } from './dom';

const ICONS = {
  file: FileText,
  diff: FileDiff,
  editor: FilePen,
  revert: Undo2,
  history: History,
  refresh: RefreshCw,
  push: ArrowUp,
  pull: ArrowDown,
  'sidebar-hide': PanelLeftClose,
  'sidebar-show': PanelLeftOpen,
  'agents-hide': PanelRightClose,
  'agents-show': PanelRightOpen,
  plus: Plus,
  prev: ChevronUp,
  next: ChevronDown,
  'side-by-side': Columns2,
  inline: Rows2,
  'layout-auto': Proportions,
  folder: Folder,
  'folder-open': FolderOpen,
  repos: GitBranch,
  branch: GitBranch,
  symbols: Braces,
  busy: LoaderCircle,
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

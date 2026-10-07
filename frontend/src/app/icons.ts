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

// Icons (Lucide's, ISC licence) and icon buttons that carry a tooltip. Only the icons named here
// are bundled.

import {
  ArrowDown, ArrowUp, Braces, ChevronDown, ChevronUp, Columns2, createElement, FileDiff, FilePen, FileText, Folder, FolderOpen,
  GitBranch, History, type IconNode, LoaderCircle, Proportions, PanelLeftClose, PanelLeftOpen, PanelRightClose,
  PanelRightOpen, Plus, RefreshCw, RotateCcw, Rows2, SquareSplitHorizontal, Undo2,
} from 'lucide';
import { h } from './dom';

const ICONS = {
  file: FileText,
  diff: FileDiff,
  editor: FilePen,
  revert: Undo2,
  restart: RotateCcw,
  panes: SquareSplitHorizontal,
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

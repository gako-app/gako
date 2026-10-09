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
  ArrowDown, ArrowUp, Braces, Bug, Check, ChevronDown, ChevronRight, ChevronUp, Code, Columns2, Copy, CornerDownRight, createElement,
  ExternalLink, File, FileArchive, Files, FileBraces, FileCode, FileCog, FileDiff, FileImage, FileLock, FilePen, FileTerminal, FileText,
  FileType, Folder, FolderGit2, FolderOpen, SquareTerminal, GitBranch, Globe, History, type IconNode, Info,
  LoaderCircle, Proportions, PanelLeftClose, PanelRightClose, PanelRightOpen, Plus, RefreshCw,
  RotateCcw, Rows2, Search, Settings, SquareSplitHorizontal, TriangleAlert, Undo2, X,
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
  files: Files,
  'agents-hide': PanelRightClose,
  'agents-show': PanelRightOpen,
  plus: Plus,
  agent: SquareTerminal,
  prev: ChevronUp,
  next: ChevronDown,
  'side-by-side': Columns2,
  inline: Rows2,
  'layout-auto': Proportions,
  folder: Folder,
  'folder-open': FolderOpen,
  nested: CornerDownRight,
  repos: GitBranch,
  branch: GitBranch,
  symbols: Braces,
  busy: LoaderCircle,
  // The About window.
  info: Info,
  warning: TriangleAlert,
  settings: Settings,
  remove: X,
  copy: Copy,
  done: Check,
  external: ExternalLink,
  search: Search,
  website: Globe,
  source: Code,
  issue: Bug,
  expand: ChevronRight,
  close: X,
  'repo-folder': FolderGit2,
  // Files, by kind (fileIcon).
  'file-plain': File,
  'file-code': FileCode,
  'file-data': FileBraces,
  'file-text': FileText,
  'file-image': FileImage,
  'file-shell': FileTerminal,
  'file-config': FileCog,
  'file-lock': FileLock,
  'file-font': FileType,
  'file-archive': FileArchive,
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

/** A chevron that points right, and down once `open` (turned by the stylesheet). */
export function chevron(open: boolean): SVGElement {
  const el = icon('expand');
  el.classList.add('chevron');
  if (open) el.classList.add('open');
  return el;
}

type FileKind = 'code' | 'data' | 'text' | 'image' | 'shell' | 'config' | 'lock' | 'font' | 'archive' | 'plain';

const KIND_BY_EXT: Record<string, FileKind> = {};
const kinds: [FileKind, string][] = [
  ['code', 'ts tsx js jsx mjs cjs rs go py rb java kt kts swift c h cc cpp hpp cs php lua dart scala ex exs erl hs ml zig vue svelte css scss less html htm sql'],
  ['data', 'json jsonc json5 yaml yml toml xml csv tsv graphql proto'],
  ['text', 'md mdx markdown txt rst adoc org log'],
  ['image', 'png jpg jpeg gif webp avif bmp ico svg pdf'],
  ['shell', 'sh bash zsh fish ps1 bat cmd'],
  ['config', 'ini cfg conf env editorconfig gitignore gitattributes gitmodules dockerignore npmrc nvmrc'],
  ['lock', 'lock'],
  ['font', 'ttf otf woff woff2'],
  ['archive', 'zip tar gz tgz bz2 xz 7z rar'],
];
for (const [kind, exts] of kinds) for (const ext of exts.split(' ')) KIND_BY_EXT[ext] = kind;
const KIND_BY_NAME: Record<string, FileKind> = {
  dockerfile: 'config', makefile: 'shell', 'go.mod': 'data', 'go.sum': 'lock', 'package-lock.json': 'lock', 'cargo.lock': 'lock',
  license: 'text', licence: 'text',
};

/** The icon for a file, by its name: a few broad kinds (code, data, text, images…), each with a
 * colour of its own in the stylesheet, as in VS Code's file icons. */
export function fileIcon(name: string): SVGElement {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const kind = KIND_BY_NAME[lower] ?? (dot >= 0 ? KIND_BY_EXT[lower.slice(dot + 1)] : undefined) ?? 'plain';
  const el = icon(`file-${kind}`);
  el.classList.add('file-icon', `fk-${kind}`);
  return el;
}

/** A folder's icon: open or closed, or a repository's own. */
export function folderIcon(open: boolean, repo = false): SVGElement {
  const el = icon(repo ? 'repo-folder' : open ? 'folder-open' : 'folder');
  el.classList.add('file-icon', repo ? 'fk-repo' : 'fk-folder');
  return el;
}

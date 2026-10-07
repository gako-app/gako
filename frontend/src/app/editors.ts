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

// "Open in editor": the editors the core found, the one in use, and the button that opens a file in
// it. The chosen editor is remembered on this machine; the settings' `editor` decides only until the
// user picks another one from the file tree's context menu.

import type { monaco } from '../monaco';
import type { Transport } from '../transport';
import { iconButton } from './icons';

interface Editor {
  id: string;
  name: string;
}

const CHOSEN = 'gako.editor';

/** Where to open: a line and column in a file, or a folder. */
export interface Spot {
  path: string;
  line?: number;
  column?: number;
}

export class Editors {
  private list: Editor[] = [];
  private current: string | null = null;

  constructor(private t: Transport, private toast: (message: string) => void) {}

  async load(): Promise<void> {
    const r = await this.t.request<{ editors: Editor[]; default: string | null }>('editors');
    this.list = r.editors;
    let chosen: string | null = null;
    try { chosen = localStorage.getItem(CHOSEN); } catch { /* storage unavailable */ }
    this.current = this.list.some((e) => e.id === chosen) ? chosen : r.default;
  }

  /** "Open in VS Code", or the generic label before the editors are known or when none is. */
  label(id = this.current): string {
    const e = this.list.find((x) => x.id === id);
    return e ? `Open in ${e.name}` : 'Open in editor';
  }

  open(spot: Spot, editor = this.current): void {
    this.t.request('openInEditor', { path: spot.path, line: spot.line ?? 1, column: spot.column ?? 1, editor: editor ?? undefined })
      .catch((e) => this.toast(String(e.message ?? e)));
  }

  private choose(id: string): void {
    this.current = id;
    try { localStorage.setItem(CHOSEN, id); } catch { /* storage unavailable */ }
  }

  /** Menu items opening `spot` in each editor ("Open in VS Code"); picking another one makes it
   * the default. */
  items(spot: Spot): { label: string; checked: boolean; run: () => void }[] {
    return this.list.map((e) => ({
      label: this.label(e.id),
      checked: this.list.length > 1 && e.id === this.current,
      run: () => {
        this.choose(e.id);
        this.open(spot, e.id);
      },
    }));
  }

  /** "Open in VS Code" (the editor in use), at the cursor or the top of the view. */
  button(spot: () => Spot | null): HTMLElement {
    return iconButton('editor', this.label(), () => {
      const s = spot();
      if (s) this.open(s);
    }, { class: 'framed' });
  }
}

/** The line to open at: the cursor's if it's on screen, else the top of what's shown. */
export function spotIn(editor: monaco.editor.ICodeEditor, path: string): Spot {
  const pos = editor.getPosition();
  const visible = editor.getVisibleRanges();
  const onScreen = pos && visible.some((r) => pos.lineNumber >= r.startLineNumber && pos.lineNumber <= r.endLineNumber);
  if (pos && onScreen) return { path, line: pos.lineNumber, column: pos.column };
  return { path, line: visible[0]?.startLineNumber ?? 1, column: 1 };
}

// "Open in editor": the editors the core found, the one in use, and the button that opens a file in
// it. The chosen editor is remembered on this machine; the settings' `editor` decides only until the
// user picks one.

import type { monaco } from '../monaco';
import type { Transport } from '../transport';
import { h } from './dom';
import { showMenu } from './menu';

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
    for (const el of document.querySelectorAll('.open-editor-label')) el.textContent = this.label();
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
    for (const el of document.querySelectorAll('.open-editor-label')) el.textContent = this.label();
  }

  /** Menu items opening `spot` in each editor; picking another one makes it the default. */
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

  /** The header button, with a menu of the other editors when there are several. */
  button(spot: () => Spot | null): HTMLElement {
    const go = () => {
      const s = spot();
      if (s) this.open(s);
    };
    const main = h('button', { onclick: go, title: 'Open at the cursor, or at the top of the view' },
      h('span', { class: 'open-editor-label' }, this.label()));
    if (this.list.length < 2) return main;
    const more = h('button', {
      class: 'split-more', title: 'Choose the editor',
      onclick: () => {
        const s = spot();
        if (s) showMenu(more, this.items(s));
      },
    }, '▾');
    return h('span', { class: 'split' }, main, more);
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

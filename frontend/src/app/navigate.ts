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

// Navigation by name: go to definition (F12, ⌘/Ctrl-click), find references (Shift+F12)
// and go to symbol (⌘T, Ctrl+T), backed by the core's symbol index. The index resolves by name,
// not by binding (docs/navigation.md), so several definitions are offered as a list.

import { monaco } from '../monaco';
import type { Transport } from '../transport';
import { h } from './dom';

export interface Symbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface NavHost {
  open(path: string, line: number, column: number): void;
  references(name: string): void;
  relative(path: string): string;
  toast(message: string): void;
}

// Monaco's own definition and reference commands have no provider here; ours take their keys.
monaco.editor.addKeybindingRules([
  { keybinding: monaco.KeyCode.F12, command: '-editor.action.revealDefinition' },
  { keybinding: monaco.KeyMod.Shift | monaco.KeyCode.F12, command: '-editor.action.goToReferences' },
]);

function wordAt(editor: monaco.editor.ICodeEditor, pos?: monaco.IPosition | null): string | undefined {
  const p = pos ?? editor.getPosition();
  return p ? editor.getModel()?.getWordAtPosition(p)?.word : undefined;
}

export class Navigator {
  private picker: Picker;
  /** Which file each attached editor shows (for ranking definitions near it). */
  private paths = new WeakMap<monaco.editor.ICodeEditor, () => string | null>();

  constructor(private t: Transport, private host: NavHost) {
    this.picker = new Picker(host);
    // Registered once for all editors (a diff editor's two sides aren't standalone editors).
    monaco.editor.addEditorAction({
      id: 'gako.definition', label: 'Go to Definition', keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation', contextMenuOrder: 1,
      run: (ed) => this.definition(wordAt(ed), this.paths.get(ed)?.() ?? null),
    });
    monaco.editor.addEditorAction({
      id: 'gako.references', label: 'Find References (by name)', keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation', contextMenuOrder: 2,
      run: (ed) => { const w = wordAt(ed); if (w) this.host.references(w); },
    });
  }

  /** Tells the navigator which file an editor shows, and adds ⌘/Ctrl-click to it. */
  attach(editor: monaco.editor.ICodeEditor, path: () => string | null): void {
    this.paths.set(editor, path);
    editor.onMouseDown((e) => {
      const mod = navigator.platform.startsWith('Mac') ? e.event.metaKey : e.event.ctrlKey;
      if (mod && e.target.position && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
        this.definition(wordAt(editor, e.target.position), path());
      }
    });
  }

  async definition(name: string | undefined, from: string | null): Promise<void> {
    if (!name) return;
    const r = await this.t.request<{ ready: boolean; symbols: Symbol[] }>('symbolDefinitions', { name, path: from });
    if (!r.ready) this.host.toast('The symbol index is still being built.');
    else if (r.symbols.length === 0) this.host.toast(`No definition of ${name} found (definitions are found by name; variables often aren't indexed).`);
    else if (r.symbols.length === 1) this.host.open(r.symbols[0].path, r.symbols[0].line, r.symbols[0].column);
    else this.picker.list(`${r.symbols.length} definitions of ${name}`, r.symbols);
  }

  goToSymbol(): void {
    this.picker.search(async (q) => {
      const r = await this.t.request<{ ready: boolean; symbols: { symbol: Symbol; positions: number[] }[] }>('symbolSearch', { query: q });
      return r.ready ? r.symbols : null;
    });
  }
}

/** A picker over symbols: a fixed list (several definitions) or a search (go to symbol). */
class Picker {
  private el: HTMLElement | null = null;
  private input = h('input', { class: 'goto-input', type: 'text', spellcheck: false });
  private list_ = h('div', { class: 'goto-list' });
  private items: { symbol: Symbol; positions: number[] }[] = [];
  private index = 0;
  private query: ((q: string) => Promise<{ symbol: Symbol; positions: number[] }[] | null>) | null = null;
  private ticket = 0;

  constructor(private host: NavHost) {
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.index = Math.max(0, Math.min(this.items.length - 1, this.index + (e.key === 'ArrowDown' ? 1 : -1)));
        this.render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.choose(this.items[this.index]?.symbol);
      } else if (e.key === 'Escape') {
        this.hide();
      }
    });
  }

  list(title: string, symbols: Symbol[]): void {
    this.query = null;
    this.items = symbols.map((symbol) => ({ symbol, positions: [] }));
    this.open(title);
  }

  search(query: (q: string) => Promise<{ symbol: Symbol; positions: number[] }[] | null>): void {
    this.query = query;
    this.items = [];
    this.open('Go to symbol');
  }

  private open(placeholder: string): void {
    this.hide();
    this.index = 0;
    this.input.value = '';
    this.input.placeholder = placeholder;
    this.el = h('div', { class: 'goto-backdrop', onmousedown: (e: Event) => { if (e.target === this.el) this.hide(); } },
      h('div', { class: 'goto' }, this.input, this.list_));
    document.body.append(this.el);
    this.render();
    this.input.focus();
  }

  private hide(): void {
    this.el?.remove();
    this.el = null;
  }

  private async run(): Promise<void> {
    if (!this.query) {
      this.render();
      return;
    }
    const ticket = ++this.ticket;
    const q = this.input.value;
    const found = q.trim() ? await this.query(q) : [];
    if (ticket !== this.ticket) return;
    if (found === null) this.host.toast('The symbol index is still being built.');
    this.items = found ?? [];
    this.index = 0;
    this.render();
  }

  private choose(s: Symbol | undefined): void {
    if (!s) return;
    this.hide();
    this.host.open(s.path, s.line, s.column);
  }

  private render(): void {
    // A fixed list filters by what's typed; a search shows what the core found.
    const filter = this.query ? '' : this.input.value.toLowerCase();
    const shown = this.items.filter((i) => !filter || this.host.relative(i.symbol.path).toLowerCase().includes(filter));
    this.list_.replaceChildren(...shown.map((item, i) => {
      const s = item.symbol;
      const name = h('span', { class: 'fname' });
      let at = 0;
      for (const p of item.positions) {
        name.append(s.name.slice(at, p), h('mark', {}, s.name.slice(p, p + 1)));
        at = p + 1;
      }
      name.append(s.name.slice(at));
      return h('div', { class: `goto-item ${i === this.index ? 'selected' : ''}`, onmousedown: () => this.choose(s), title: s.text },
        h('span', { class: 'kind dim' }, s.kind), name,
        h('span', { class: 'fdir dim' }, `${this.host.relative(s.path)}:${s.line}`));
    }));
    if (!shown.length && (this.input.value || !this.query)) this.list_.append(h('div', { class: 'goto-item dim' }, 'Nothing found'));
  }
}

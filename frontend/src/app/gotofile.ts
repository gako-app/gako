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

// Go to file (⌘P or Ctrl+P): fuzzy file-name search across the workspace, answered by the core.

import type { Transport } from '../transport';
import { basename, h } from './dom';
import { fileIcon } from './icons';

interface Hit {
  path: string;
  score: number;
  positions: number[];
}

export class GoToFile {
  private el: HTMLElement | null = null;
  private input = h('input', { class: 'goto-input', type: 'text', placeholder: 'Go to file', spellcheck: false });
  private list = h('div', { class: 'goto-list' });
  private hits: Hit[] = [];
  private index = 0;
  private ticket = 0;

  constructor(
    private t: Transport,
    private base: () => string,
    private open: (path: string) => void,
  ) {
    this.input.addEventListener('input', () => this.query());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.index = Math.max(0, Math.min(this.hits.length - 1, this.index + (e.key === 'ArrowDown' ? 1 : -1)));
        this.render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.choose(this.hits[this.index]);
      } else if (e.key === 'Escape') {
        this.hide();
      }
    });
  }

  show(): void {
    if (this.el) return;
    this.el = h('div', { class: 'goto-backdrop', onmousedown: (e: Event) => { if (e.target === this.el) this.hide(); } },
      h('div', { class: 'goto' }, this.input, this.list));
    document.body.append(this.el);
    this.input.value = '';
    this.hits = [];
    this.render();
    this.input.focus();
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  private async query(): Promise<void> {
    const ticket = ++this.ticket;
    const q = this.input.value;
    const hits = q.trim() ? await this.t.request<Hit[]>('findFiles', { query: q }) : [];
    if (ticket !== this.ticket) return;
    this.hits = hits;
    this.index = 0;
    this.render();
  }

  private choose(hit: Hit | undefined): void {
    if (!hit) return;
    this.hide();
    this.open(hit.path);
  }

  private render(): void {
    const base = this.base();
    this.list.replaceChildren(...this.hits.map((hit, i) => {
      const rel = hit.path.startsWith(base) ? hit.path.slice(base.length + 1).replaceAll('\\', '/') : hit.path;
      const marked = h('span', {});
      let at = 0;
      for (const p of hit.positions) {
        marked.append(rel.slice(at, p), h('mark', {}, rel.slice(p, p + 1)));
        at = p + 1;
      }
      marked.append(rel.slice(at));
      return h('div', { class: `goto-item ${i === this.index ? 'selected' : ''}`, onmousedown: () => this.choose(hit) },
        fileIcon(basename(rel)), h('span', { class: 'fname' }, basename(rel)), h('span', { class: 'fdir dim' }, marked));
    }));
    if (this.input.value.trim() && !this.hits.length) this.list.append(h('div', { class: 'goto-item dim' }, 'No matching files'));
  }
}

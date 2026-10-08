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

// The tab bar above the main area: the diffs, files and histories open for review. As in VS Code, a
// single click opens a preview tab (in italics) that the next single click replaces; a double click,
// on the tab or on what opened it, keeps it open. Agents live in their own bar (terminals.ts); while
// one is in front, no tab here is active.
//
// There is one diff panel and one viewer: a tab holds what to show and its saved scroll position,
// not an editor of its own, so open tabs cost next to nothing.

import { h } from './dom';

export type DocKind = 'diff' | 'file' | 'history' | 'settings';

export interface DocSpec {
  /** What the tab shows: opening the same key again goes to the same tab. */
  key: string;
  kind: DocKind;
  title: string;
  /** Shown dimmed after the title. */
  detail: string;
  tooltip: string;
  /** Draws it in the main area, with the scroll position saved when it was last left, if any. */
  show(saved: unknown): void;
  /** What reopens it after a restart (plain data, kept with the session). */
  persist: unknown;
}

/** The open tabs, as kept between runs. */
export interface DocsSnapshot {
  docs: { persist: unknown; pinned: boolean }[];
  active: number;
}

interface Doc extends DocSpec {
  pinned: boolean;
  /** Undefined until the tab is first left. */
  saved: unknown;
}

const GLYPH: Record<DocKind, string> = { diff: '±', file: '', history: '⏱', settings: '⚙' };

export interface DocHooks {
  /** The scroll position of what's shown for `kind`. */
  save(kind: DocKind): unknown;
  /** Brings the documents to the front (in place of a terminal). */
  front(): void;
  /** Nothing is open any more. */
  empty(): void;
}

export class DocTabs {
  readonly bar = h('nav', { class: 'doc-tabs' });
  private docs: Doc[] = [];
  active: Doc | null = null;
  /** False while a terminal is in front. */
  private inFront = true;

  /** Told whenever the set of tabs or the active one changes, so the session can be saved. */
  onChange: (() => void) | null = null;

  constructor(private hooks: DocHooks) {}

  snapshot(): DocsSnapshot {
    return { docs: this.docs.map((d) => ({ persist: d.persist, pinned: d.pinned })), active: this.active ? this.docs.indexOf(this.active) : -1 };
  }

  /** Puts back tabs from a snapshot (only the active one is drawn). */
  restore(docs: { spec: DocSpec; pinned: boolean }[], active: number): void {
    this.docs = docs.map(({ spec, pinned }) => ({ ...spec, pinned, saved: undefined }));
    const doc = this.docs[active] ?? this.docs[0];
    if (doc) this.activate(doc, true);
    else this.render();
  }

  /** Opens `spec` in its tab, in the preview tab, or in a new tab with `pin`. */
  open(spec: DocSpec, pin = false): void {
    let doc = this.docs.find((d) => d.key === spec.key);
    if (doc) {
      Object.assign(doc, spec, { pinned: doc.pinned || pin });
    } else {
      doc = { ...spec, pinned: pin, saved: undefined };
      const preview = this.docs.findIndex((d) => !d.pinned);
      if (preview >= 0) {
        if (this.docs[preview] === this.active) this.active = null;
        this.docs.splice(preview, 1, doc);
      } else {
        const at = this.active ? this.docs.indexOf(this.active) + 1 : this.docs.length;
        this.docs.splice(at, 0, doc);
      }
    }
    this.activate(doc, true);
  }

  /** Keeps the active tab open (as a double click on it does). */
  pinActive(): void {
    if (this.active && !this.active.pinned) {
      this.active.pinned = true;
      this.render();
    }
  }

  /** A terminal came to the front, or went. */
  setFront(inFront: boolean): void {
    this.inFront = inFront;
    this.render();
  }

  /** The active tab's key, when the documents are in front. */
  get activeKey(): string | null {
    return this.inFront ? this.active?.key ?? null : null;
  }

  /** Closes the active tab (⌘W); false if there's none. */
  closeActive(): boolean {
    if (!this.active) return false;
    this.close(this.active);
    return true;
  }

  /** Shows the next (1) or previous (-1) tab, wrapping round (Ctrl+Tab). */
  cycle(delta: number): void {
    if (!this.docs.length) return;
    const i = this.active ? this.docs.indexOf(this.active) : -1;
    this.activate(this.docs[(i + delta + this.docs.length) % this.docs.length]);
  }

  private activate(doc: Doc, fresh = false): void {
    if (doc === this.active && this.inFront && !fresh) return;
    const back = !this.inFront && doc === this.active && !fresh;
    // The panels show the active tab even while a terminal is in front, so its place can be saved.
    if (this.active && this.active !== doc) this.active.saved = this.hooks.save(this.active.kind);
    const same = doc === this.active;
    this.active = doc;
    this.inFront = true;
    this.hooks.front();
    this.render();
    // Back from a terminal, the panel still shows this tab as it was left.
    if (!back) doc.show(fresh && same ? undefined : doc.saved);
  }

  private close(doc: Doc): void {
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    if (doc === this.active) {
      this.active = null;
      const next = this.docs[i] ?? this.docs[i - 1];
      if (next) this.activate(next);
      else this.hooks.empty();
    }
    this.render();
  }

  private render(): void {
    this.onChange?.();
    this.bar.replaceChildren(...this.docs.map((d) => h('div', {
      class: `doc-tab ${d === this.active && this.inFront ? 'active' : ''} ${d.pinned ? '' : 'preview'}`,
      title: `${d.tooltip}${d.pinned ? '' : '\nPreview: double-click to keep it open'}`,
      onclick: () => this.activate(d),
      ondblclick: () => { d.pinned = true; this.render(); },
      onauxclick: (e: MouseEvent) => { if (e.button === 1) this.close(d); },
    },
    GLYPH[d.kind] ? h('span', { class: 'doc-glyph' }, GLYPH[d.kind]) : null,
    h('span', { class: 'doc-title' }, d.title),
    d.detail ? h('span', { class: 'doc-detail' }, d.detail) : null,
    h('span', { class: 'close', title: 'Close', onclick: (e: Event) => { e.stopPropagation(); this.close(d); } }, '×'))));
    this.bar.querySelector('.doc-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

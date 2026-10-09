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

// The Search view: search in files across all repos, the base repo only, or chosen repos. Results
// stream in from the core, grouped by repo and file; clicking a line opens the file at the match.

import type { Transport } from '../transport';
import { basename, dirname, fill, h } from './dom';
import { chevron, fileIcon, icon } from './icons';
import { showMenu } from './menu';
import type { Repo } from './model';

interface LineMatch {
  line: number;
  text: string;
  ranges: [number, number][];
  columns: [number, number][];
}

interface FileMatches {
  path: string;
  matches: LineMatch[];
}

interface Stats {
  files: number;
  matches: number;
  searched: number;
  limitHit: boolean;
  cancelled: boolean;
  ms: number;
}

export interface Reveal {
  line: number;
  /** Match columns in the full line, UTF-16 units from its start. */
  columns: [number, number][];
  /** Where to put the cursor when there's nothing to highlight (1-based). */
  column?: number;
}


export class SearchView {
  readonly el = h('div', { class: 'search' });
  private input = h('input', { class: 'search-input', type: 'text', placeholder: 'Search', spellcheck: false });
  private include = h('input', { class: 'search-glob', type: 'text', placeholder: 'Files to include, e.g. *.ts, src/**', spellcheck: false });
  private exclude = h('input', { class: 'search-glob', type: 'text', placeholder: 'Files to exclude', spellcheck: false });
  private ignored = h('input', { type: 'checkbox' });
  private toggles = { caseSensitive: false, wholeWord: false, regex: false, includeIgnored: false };
  private toggleButtons = new Map<string, HTMLButtonElement>();
  /** The repos to search, by root; none chosen means all of them. */
  private chosen = new Set<string>();
  private filtersOpen = false;
  private filtersToggle = h('button', { class: 'search-more', onclick: () => { this.filtersOpen = !this.filtersOpen; this.renderFilters(); } });
  private filters = h('div', { class: 'search-filters' });
  private scopeButton = h('button', { class: 'search-scope-button', onclick: () => this.pickRepos() });
  private results = h('div', { class: 'search-results' });
  private summary = h('div', { class: 'search-summary dim' });
  private files: FileMatches[] = [];
  private collapsed = new Set<string>();
  private searchId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  repos: Repo[] = [];
  base = '';

  constructor(
    private t: Transport,
    /** Opens a match; `pin` keeps its tab open (a double click). */
    private open: (path: string, reveal: Reveal, pin?: boolean) => void,
  ) {
    const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', label: string | HTMLElement, tip: string) => {
      const b = h('button', {
        class: 'toggle', 'data-tip': tip, 'aria-label': tip, 'aria-pressed': 'false',
        onclick: () => { this.toggles[key] = !this.toggles[key]; this.renderToggles(); this.schedule(0); },
      }, label);
      this.toggleButtons.set(key, b);
      return b;
    };
    this.ignored.addEventListener('change', () => { this.toggles.includeIgnored = this.ignored.checked; this.renderFilters(); this.schedule(0); });
    // The field and its three toggles, inside one box as in VS Code; then the filters, folded away
    // until wanted; then where to search.
    this.filters.append(this.include, this.exclude,
      h('label', { class: 'search-check' }, this.ignored, 'Include files Git ignores'));
    this.el.append(
      h('div', { class: 'search-form' },
        h('div', { class: 'search-box' }, this.input,
          toggle('caseSensitive', 'Aa', 'Match case'),
          toggle('wholeWord', h('span', { class: 'whole-word' }, 'ab'), 'Match whole word'),
          toggle('regex', '.*', 'Use regular expression')),
        h('div', { class: 'search-options' }, this.filtersToggle, h('span', { class: 'spacer' }), h('span', { class: 'dim' }, 'In'), this.scopeButton),
        this.filters),
      this.summary, this.results);
    for (const el of [this.include, this.exclude]) el.addEventListener('input', () => this.renderFilters());
    this.renderFilters();
    this.renderScope();
    for (const el of [this.input, this.include, this.exclude]) {
      el.addEventListener('input', () => this.schedule(250));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.schedule(0); });
    }
    t.onEvent((ev) => {
      if (ev.t !== 'searchResults' || ev.search !== this.searchId) return;
      this.files.push(...(ev.files as FileMatches[]));
      this.queueRender();
    });
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /** References by name: the word, whole and case-sensitive, in every repo. */
  references(name: string): void {
    this.toggles = { ...this.toggles, caseSensitive: true, wholeWord: true, regex: false };
    this.renderToggles();
    this.chosen.clear();
    this.renderScope();
    this.input.value = name;
    this.schedule(0);
  }

  /** Starts a search for `text` (from a selection, say). */
  searchFor(text: string): void {
    this.input.value = text;
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), ms);
  }

  private async run(): Promise<void> {
    const id = ++this.searchId;
    this.files = [];
    this.collapsed.clear();
    const pattern = this.input.value;
    if (!pattern) {
      this.t.request('searchCancel', {}).catch(() => {});
      this.summary.textContent = '';
      this.results.replaceChildren();
      return;
    }
    this.summary.textContent = 'Searching…';
    this.renderResults();
    const globs = (v: string) => v.split(',').map((g) => g.trim()).filter(Boolean);
    try {
      const stats = await this.t.request<Stats>('search', {
        search: id,
        query: { pattern, ...this.toggles, include: globs(this.include.value), exclude: globs(this.exclude.value) },
        scope: this.picked().length ? { kind: 'repos', repos: this.picked() } : { kind: 'all', repos: [] },
      });
      if (id !== this.searchId) return;
      this.summary.textContent = stats.cancelled
        ? ''
        : `${stats.matches.toLocaleString()} result${stats.matches === 1 ? '' : 's'} in ${stats.files.toLocaleString()} file${stats.files === 1 ? '' : 's'}` +
          ` · ${Math.round(stats.ms)} ms${stats.limitHit ? ' · stopped at the limit; narrow the search' : ''}`;
    } catch (e) {
      if (id === this.searchId) this.summary.textContent = String((e as Error).message ?? e);
    }
    this.renderResults();
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderResults();
    });
  }

  /** The repo a path belongs to: the innermost root containing it. */
  private repoOf(path: string): Repo | undefined {
    let best: Repo | undefined;
    for (const r of this.repos) {
      if ((path.startsWith(r.root + '/') || path.startsWith(r.root + '\\')) && (!best || r.root.length > best.root.length)) best = r;
    }
    return best;
  }

  private name(r: Repo | undefined): string {
    return r ? r.rel || basename(this.base) : basename(this.base);
  }

  private renderToggles(): void {
    for (const [k, b] of this.toggleButtons) {
      const on = this.toggles[k as keyof SearchView['toggles']];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  /** The filters' toggle, with how many are set (so filters folded away still show they're in
   * force), and the filters themselves when open. */
  private renderFilters(): void {
    const set = [this.include.value.trim(), this.exclude.value.trim(), this.toggles.includeIgnored].filter(Boolean).length;
    fill(this.filtersToggle, chevron(this.filtersOpen), 'Filters', set ? h('span', { class: 'count on' }, String(set)) : null);
    this.filtersToggle.dataset.tip = this.filtersOpen ? 'Hide the filters' : 'Files to include or exclude, and files Git ignores';
    this.filters.hidden = !this.filtersOpen;
  }

  /** The chosen repos that are still in the workspace. */
  private picked(): string[] {
    return this.repos.filter((r) => this.chosen.has(r.root)).map((r) => r.root);
  }

  /** The scope button's label: every repo, the one chosen, or how many. */
  renderScope(): void {
    const picked = this.picked();
    const one = picked.length === 1 ? this.repos.find((r) => r.root === picked[0]) : undefined;
    fill(this.scopeButton,
      h('span', { class: 'search-scope-label' }, one ? this.name(one) : picked.length ? `${picked.length} repositories` : 'All repositories'),
      icon('next'));
    this.scopeButton.dataset.tip = picked.length ? picked.map((root) => this.name(this.repos.find((r) => r.root === root))).join('\n') : 'Every repository';
  }

  /** The repos, ticked on and off in a menu that stays open. */
  private pickRepos(): void {
    const changed = () => { this.renderScope(); this.schedule(0); };
    showMenu(this.scopeButton, () => [
      { label: 'All repositories', checked: !this.picked().length, keep: true, run: () => { this.chosen.clear(); changed(); } },
      'separator',
      ...this.repos.map((r) => ({
        label: this.name(r), checked: this.chosen.has(r.root), keep: true,
        run: () => { if (this.chosen.has(r.root)) this.chosen.delete(r.root); else this.chosen.add(r.root); changed(); },
      })),
    ]);
  }

  private renderResults(): void {
    const groups = new Map<string, FileMatches[]>();
    for (const f of this.files) {
      const key = this.repoOf(f.path)?.root ?? this.base;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    const out: HTMLElement[] = [];
    for (const [root, files] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const repo = this.repos.find((r) => r.root === root);
      out.push(h('div', { class: 'search-repo' }, this.name(repo), h('span', { class: 'count' }, String(files.length))));
      for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
        const rel = f.path.slice(root.length + 1).replaceAll('\\', '/');
        const open = !this.collapsed.has(f.path);
        out.push(h('div', { class: 'search-file', title: f.path, onclick: () => {
          if (open) this.collapsed.add(f.path); else this.collapsed.delete(f.path);
          this.renderResults();
        } }, h('span', { class: 'twist' }, chevron(open)), fileIcon(basename(rel)), h('span', { class: 'fname' }, basename(rel)),
        h('span', { class: 'fdir dim' }, dirname(rel)), h('span', { class: 'count' }, String(f.matches.length))));
        if (!open) continue;
        for (const m of f.matches) {
          out.push(h('div', { class: 'search-line', onclick: () => this.open(f.path, { line: m.line, columns: m.columns }), ondblclick: () => this.open(f.path, { line: m.line, columns: m.columns }, true) },
            h('span', { class: 'lineno dim' }, String(m.line)), highlight(m.text, m.ranges)));
        }
      }
    }
    this.results.replaceChildren(...out);
  }
}

/** The line with its matches marked. Ranges are in UTF-16 units, as JavaScript strings index. */
function highlight(text: string, ranges: [number, number][]): HTMLElement {
  const el = h('span', { class: 'search-text' });
  let at = 0;
  for (const [s, e] of ranges) {
    if (s < at) continue;
    el.append(text.slice(at, s), h('mark', {}, text.slice(s, e)));
    at = e;
  }
  el.append(text.slice(at));
  return el;
}

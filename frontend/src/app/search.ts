// The Search view: search in files across all repos, the base repo only, or chosen repos. Results
// stream in from the core, grouped by repo and file; clicking a line opens the file at the match.

import type { Transport } from '../transport';
import { basename, dirname, fill, h } from './dom';
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

type ScopeKind = 'all' | 'base' | 'repos';

export class SearchView {
  readonly el = h('div', { class: 'search' });
  private input = h('input', { class: 'search-input', type: 'text', placeholder: 'Search', spellcheck: false });
  private include = h('input', { class: 'search-glob', type: 'text', placeholder: 'files to include, e.g. *.ts, src/**', spellcheck: false });
  private exclude = h('input', { class: 'search-glob', type: 'text', placeholder: 'files to exclude', spellcheck: false });
  private toggles = { caseSensitive: false, wholeWord: false, regex: false, includeIgnored: false };
  private toggleButtons = new Map<string, HTMLButtonElement>();
  private scope: ScopeKind = 'all';
  private chosen = new Set<string>();
  private results = h('div', { class: 'search-results' });
  private summary = h('div', { class: 'search-summary dim' });
  private scopeEl = h('div', { class: 'search-scope' });
  private files: FileMatches[] = [];
  private collapsed = new Set<string>();
  private searchId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  repos: Repo[] = [];
  base = '';

  constructor(
    private t: Transport,
    private open: (path: string, reveal: Reveal) => void,
  ) {
    const toggle = (key: keyof SearchView['toggles'], label: string, title: string) => {
      const b = h('button', { class: 'toggle', title, onclick: () => { this.toggles[key] = !this.toggles[key]; b.classList.toggle('on'); this.schedule(0); } }, label);
      this.toggleButtons.set(key, b);
      return b;
    };
    this.el.append(
      h('div', { class: 'search-form' },
        h('div', { class: 'search-row' }, this.input,
          toggle('caseSensitive', 'Aa', 'Match case'), toggle('wholeWord', 'ab', 'Match whole word'), toggle('regex', '.*', 'Regular expression')),
        this.include, this.exclude,
        h('label', { class: 'dim small' }, (() => {
          const c = h('input', { type: 'checkbox', onchange: () => { this.toggles.includeIgnored = c.checked; this.schedule(0); } });
          return c;
        })(), ' Search ignored files too'),
        this.scopeEl),
      this.summary, this.results);
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
    for (const [k, b] of this.toggleButtons) b.classList.toggle('on', this.toggles[k as keyof SearchView['toggles']]);
    this.scope = 'all';
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
        scope: { kind: this.scope, repos: [...this.chosen] },
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

  renderScope(): void {
    const kinds: [ScopeKind, string][] = [['all', 'All repos'], ['base', 'Base repo only'], ['repos', 'Chosen repos']];
    fill(this.scopeEl,
      h('div', { class: 'scope-kinds' }, kinds.map(([k, label]) =>
        h('button', { class: `toggle wide ${this.scope === k ? 'on' : ''}`, onclick: () => { this.scope = k; this.renderScope(); this.schedule(0); } }, label))),
      this.scope === 'repos'
        ? h('div', { class: 'scope-repos' }, this.repos.map((r) => {
            const c = h('input', { type: 'checkbox', checked: this.chosen.has(r.root), onchange: () => {
              if (c.checked) this.chosen.add(r.root); else this.chosen.delete(r.root);
              this.schedule(0);
            } });
            return h('label', { class: 'small' }, c, ' ', this.name(r));
          }))
        : null,
    );
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
        } }, h('span', { class: 'twist' }, open ? '▾' : '▸'), h('span', { class: 'fname' }, basename(rel)),
        h('span', { class: 'fdir dim' }, dirname(rel)), h('span', { class: 'count' }, String(f.matches.length))));
        if (!open) continue;
        for (const m of f.matches) {
          out.push(h('div', { class: 'search-line', onclick: () => this.open(f.path, { line: m.line, columns: m.columns }) },
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

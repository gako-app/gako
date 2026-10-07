// The Files view: the base folder as a tree, loaded folder by folder, with Git state on files and
// ignored entries dimmed. Expanded folders reload when the core reports changes in them. Any entry
// opens in the user's editor from its hover button or its context menu; a changed file's diff opens
// from its hover button too.

import type { Transport } from '../transport';
import { h } from './dom';
import type { Repo } from './model';
import { LETTER } from './model';
import type { Editors } from './editors';
import { type MenuItem, showMenu } from './menu';
import { iconButton } from './icons';

interface Entry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symlink';
  ignored: boolean;
  repo: boolean;
}

interface Listing {
  entries: Entry[];
  omitted: number;
}

interface Row {
  entry: Entry;
  depth: number;
}

export class Explorer {
  readonly el = h('div', { class: 'explorer' });
  private listings = new Map<string, Listing>();
  private expanded = new Set<string>();
  private loading = new Set<string>();
  private rows: Row[] = [];
  private selected: string | null = null;
  private base = '';
  /** Absolute path → status letter, from the repos' statuses. */
  private letters = new Map<string, string>();
  /** Folders holding changed files. */
  private dirty = new Set<string>();
  private sep = '/';
  private repos: Repo[] = [];
  private decorationsStale = true;

  constructor(
    private t: Transport,
    private editors: Editors,
    /** Opens a file; `pin` keeps its tab open (a double click). */
    private openFile: (path: string, pin?: boolean) => void,
    private onError: (message: string) => void,
    private relative: (path: string) => string,
    /** What opens a changed file's diff; null if it has none to show. */
    private diffOf: (path: string) => (() => void) | null,
  ) {
    t.onEvent((ev) => {
      if (ev.t !== 'filesChanged') return;
      const stale = (ev.dirs as string[]).filter((d) => this.listings.has(d));
      for (const d of stale) this.load(d);
    });
  }

  setBase(base: string): void {
    if (base === this.base) return;
    this.base = base;
    this.sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    this.listings.clear();
    this.expanded = new Set([base]);
    this.load(base);
  }

  /** New statuses: decorations are recomputed when the tree is next drawn, not on every update. */
  setRepos(repos: Repo[]): void {
    this.repos = repos;
    this.decorationsStale = true;
    this.render();
  }

  private decorate(): void {
    if (!this.decorationsStale) return;
    this.decorationsStale = false;
    const repos = this.repos;
    this.letters.clear();
    this.dirty.clear();
    for (const r of repos) {
      for (const e of r.status?.entries ?? []) {
        const abs = r.root + this.sep + e.path.replaceAll('/', this.sep);
        const letter = e.conflict ? '!' : e.untracked ? 'U' : LETTER[(e.worktree ?? e.index)!] ?? 'M';
        this.letters.set(abs, letter);
        // Mark every folder up to the repo root as holding changes.
        let i = abs.lastIndexOf(this.sep);
        while (i > r.root.length - 1) {
          this.dirty.add(abs.slice(0, i));
          i = abs.lastIndexOf(this.sep, i - 1);
        }
      }
    }
  }

  private async load(dir: string): Promise<void> {
    if (this.loading.has(dir)) return;
    this.loading.add(dir);
    try {
      this.listings.set(dir, await this.t.request<Listing>('filesList', { path: dir }));
    } catch (e) {
      // A folder that went away just drops out of the tree.
      this.listings.delete(dir);
      this.expanded.delete(dir);
      if (dir === this.base) this.onError(String((e as Error).message ?? e));
    } finally {
      this.loading.delete(dir);
    }
    this.render();
  }

  private toggle(entry: Entry): void {
    if (this.expanded.has(entry.path)) this.expanded.delete(entry.path);
    else {
      this.expanded.add(entry.path);
      if (!this.listings.has(entry.path)) this.load(entry.path);
    }
    this.render();
  }

  private activate(row: Row): void {
    this.selected = row.entry.path;
    if (row.entry.kind === 'dir') this.toggle(row.entry);
    else {
      this.openFile(row.entry.path);
      this.render();
    }
  }

  private contextMenu(e: MouseEvent, entry: Entry): void {
    e.preventDefault();
    this.selected = entry.path;
    this.render();
    const spot = { path: entry.path };
    const editors: MenuItem[] = this.editors.items(spot);
    // With no editor found, the one item explains why when it's used.
    if (editors.length === 0) editors.push({ label: this.editors.label(), run: () => this.editors.open(spot) });
    const copy = (text: string) => navigator.clipboard.writeText(text).catch((err) => this.onError(String(err.message ?? err)));
    showMenu({ x: e.clientX, y: e.clientY }, [
      ...editors,
      'separator',
      { label: 'Copy path', run: () => copy(entry.path) },
      { label: 'Copy relative path', run: () => copy(this.relative(entry.path)) },
    ]);
  }

  /** ↑ ↓ move, → opens a folder, ← closes it (or goes to its parent), Enter opens. */
  key(e: KeyboardEvent): boolean {
    const i = this.rows.findIndex((r) => r.entry.path === this.selected);
    const row = this.rows[i];
    const go = (j: number) => {
      const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, j))];
      if (!r) return;
      this.selected = r.entry.path;
      if (r.entry.kind !== 'dir') this.openFile(r.entry.path);
      this.render();
      this.el.querySelector('.tree-row.selected')?.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown': go(i + 1); return true;
      case 'ArrowUp': go(i - 1); return true;
      case 'ArrowRight':
        if (row?.entry.kind === 'dir' && !this.expanded.has(row.entry.path)) this.toggle(row.entry);
        return true;
      case 'ArrowLeft':
        if (row?.entry.kind === 'dir' && this.expanded.has(row.entry.path)) this.toggle(row.entry);
        else if (row) go(this.rows.findLastIndex((r, j) => j < i && r.depth < row.depth));
        return true;
      case 'Enter':
        if (row) this.activate(row);
        return true;
    }
    return false;
  }

  render(): void {
    // Only a tree on screen is worth drawing (status updates arrive all the time).
    if (!this.el.isConnected) return;
    this.decorate();
    this.rows = [];
    const out: HTMLElement[] = [];
    const walk = (dir: string, depth: number) => {
      const listing = this.listings.get(dir);
      if (!listing) {
        out.push(h('div', { class: 'tree-row dim', style: `padding-left:${12 + depth * 12}px` }, 'Loading…'));
        return;
      }
      for (const entry of listing.entries) {
        const row: Row = { entry, depth };
        this.rows.push(row);
        const isDir = entry.kind === 'dir';
        const open = isDir && this.expanded.has(entry.path);
        const letter = this.letters.get(entry.path);
        const diff = letter && !isDir ? this.diffOf(entry.path) : null;
        out.push(h('div', {
          // A nested repo the base repo ignores is still a repo of its own: not dimmed.
          class: `tree-row ${entry.ignored && !entry.repo ? 'ignored' : ''} ${letter ? `st-${letter}` : ''} ${this.dirty.has(entry.path) ? 'dirty' : ''} ${entry.path === this.selected ? 'selected' : ''}`,
          style: `padding-left:${8 + depth * 12}px`,
          'data-tip': entry.path,
          onclick: () => this.activate(row),
          ondblclick: () => { if (entry.kind !== 'dir') this.openFile(entry.path, true); },
          oncontextmenu: (e: MouseEvent) => this.contextMenu(e, entry),
        },
        h('span', { class: 'twist' }, isDir ? (open ? '▾' : '▸') : ''),
        h('span', { class: 'fname' }, entry.name),
        entry.repo ? h('span', { class: 'badge repo' }, 'repo') : null,
        entry.kind === 'symlink' ? h('span', { class: 'dim' }, ' ↗') : null,
        h('span', { class: 'spacer' }),
        diff ? iconButton('diff', 'Show diff', diff, { class: 'hover' }) : null,
        isDir ? null : iconButton('file', 'Open file', () => this.activate(row), { class: 'hover' }),
        iconButton('editor', this.editors.label(), () => this.editors.open({ path: entry.path }), { class: 'hover' }),
        letter ? h('span', { class: 'letter' }, letter) : this.dirty.has(entry.path) ? h('span', { class: 'dirty-dot' }, '•') : null));
        if (open) walk(entry.path, depth + 1);
      }
      if (listing.omitted) {
        out.push(h('div', { class: 'tree-row dim', style: `padding-left:${20 + depth * 12}px` },
          `${listing.omitted.toLocaleString()} more not listed`));
      }
    };
    if (this.base) walk(this.base, 0);
    this.el.replaceChildren(...out);
  }
}

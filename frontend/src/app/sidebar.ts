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

// The sidebar: the repos view (changed repos with their staged, unstaged, untracked and conflicted
// files; clean repos collapsed at the bottom), the file tree and search.
//
// Staging and committing are left to the agents; each repo offers its history, a fetch, and a pull
// or push when its branch is behind or ahead of its upstream. A bar at the top fetches them all,
// and pulls them all while any are behind.

import { basename, dirname, fill, h } from './dom';
import type { Explorer } from './explorer';
import type { SearchView } from './search';
import type { DiffTarget, Entry, Repo } from './model';
import { changeCount, diffTarget, LETTER } from './model';
import { chevron, fileIcon, icon, iconButton, type IconName } from './icons';

export type View = 'repos' | 'files' | 'search';

/** A file row the user can select; the order of these is the order of ↑ and ↓. */
export interface Item {
  key: string;
  repo: Repo;
  entry: Entry;
  target: DiffTarget;
  staged: boolean;
}

export type RemoteAction = 'fetch' | 'pull' | 'push';

export interface SidebarHooks {
  /** Opens an item's diff; `pin` keeps its tab open (a double click). */
  open(item: Item, pin?: boolean): void;
  /** Opens the whole file an item names, not its diff. */
  openFile(item: Item): void;
  /** Opens the file an item names in the user's editor. */
  openInEditor(item: Item): void;
  /** What that button says: "Open in VS Code". */
  editorLabel(): string;
  /** Throws away the changes an item shows, once the user confirms. */
  revert(item: Item): void;
  /** Offers the repo's branches to switch to, in a menu under `at`. */
  branches(repo: Repo, at: HTMLElement): void;
  history(repo: Repo): void;
  /** Runs a fetch, pull or push; resolves to git's error, if any. With `quiet`, the error isn't
   * shown (the caller reports it). */
  remote(repo: Repo, action: RemoteAction, quiet?: boolean): Promise<string | null>;
  /** Shows a message. */
  toast(message: string): void;
  /** Whether the sidebar is shown (not collapsed). */
  shown(): boolean;
  /** Shows or hides the sidebar. */
  show(shown: boolean): void;
}

interface Section {
  el: HTMLElement;
  header: HTMLElement;
  files: HTMLElement;
}

const GROUP_LABEL = { conflicts: 'Merge conflicts', staged: 'Staged changes', changes: 'Changes', untracked: 'Untracked' };
const REMOTE_BUSY = { fetch: 'Fetching…', pull: 'Pulling…', push: 'Pushing…' };
/** How many fetches or pulls "Fetch all" and "Pull all" run at once. */
const ALL_AT_ONCE = 4;
/** Where a repo's branch stands against its upstream: level with it (or none to compare with),
 * behind it, ahead of it, or both. */
function sync(r: Repo): 'even' | 'behind' | 'ahead' | 'diverged' {
  const s = r.status;
  if (!s?.upstream || s.upstreamGone) return 'even';
  if (s.behind && s.ahead) return 'diverged';
  return s.behind ? 'behind' : s.ahead ? 'ahead' : 'even';
}

/** The views, as the activity bar lists them. */
const VIEWS: { view: View; label: string; icon: IconName }[] = [
  { view: 'repos', label: 'Repositories', icon: 'repos' },
  { view: 'files', label: 'Files', icon: 'files' },
  { view: 'search', label: 'Search', icon: 'search' },
];

export class Sidebar {
  readonly el = h('aside', { class: 'sidebar' });
  /** The activity bar, at the window's left edge: a button per view, and the one shown again hides
   * the sidebar, as in VS Code. Always shown, the sidebar or not. */
  readonly rail = h('nav', { class: 'activity-bar', 'aria-label': 'Views' });
  /** The header, built once and updated in place, so "Fetch all"'s icon spins on undisturbed while
   * the fetches run. */
  private title = h('span', { class: 'sidebar-title' });
  private fetchAll = iconButton('refresh', '', () => this.runAll('fetch'));
  private header = h('div', { class: 'sidebar-header' },
    this.title,
    h('span', { class: 'spacer' }),
    this.fetchAll,
    iconButton('sidebar-hide', 'Hide the sidebar', () => { this.hooks.show(false); this.renderRail(); }, { class: 'bar-toggle' }));
  private list = h('div', { class: 'sidebar-list', tabIndex: 0 });
  private sections = new Map<string, Section>();
  private collapsed = new Set<string>();
  private cleanOpen = false;
  private items: Item[] = [];
  /** Repos with a fetch, pull or push running. */
  private busy = new Map<string, RemoteAction>();
  /** "Fetch all" or "Pull all" in progress: how many are done of how many. */
  private batch: { action: 'fetch' | 'pull'; done: number; total: number } | null = null;
  /** Repos waiting for their turn in "Fetch all" or "Pull all" (they run a few at a time). */
  private queued = new Set<string>();
  view: View = 'repos';
  selected: string | null = null;
  repos: Repo[] = [];
  baseName = '';
  explorer: Explorer | null = null;
  search: SearchView | null = null;

  constructor(private hooks: SidebarHooks) {
    this.el.append(this.header, this.list);
    this.list.addEventListener('keydown', (e) => {
      if (this.key(e)) e.preventDefault();
    });
  }

  /** Keyboard navigation in the current view; true if the key was used. */
  key(e: KeyboardEvent): boolean {
    if (this.view === 'files') return this.explorer?.key(e) ?? false;
    if (this.view === 'search') return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.step(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    return false;
  }

  /** Shows `view`, and the sidebar if it was hidden. */
  setView(view: View): void {
    this.view = view;
    if (!this.hooks.shown()) this.hooks.show(true);
    this.render();
  }

  /** The activity bar's button for `view` was clicked: shows it, or hides the sidebar if it was the
   * one shown. */
  private choose(view: View): void {
    if (this.view === view && this.hooks.shown()) {
      this.hooks.show(false);
      this.renderRail();
      return;
    }
    this.setView(view);
    if (view === 'search') this.search?.focus();
  }

  /** Draws the activity bar: the view shown (if the sidebar is), and a count of the changed files on
   * Repositories. */
  renderRail(): void {
    const shown = this.hooks.shown();
    const changed = this.repos.reduce((n, r) => n + (r.status ? changeCount(r.status) : 0), 0);
    this.rail.replaceChildren(...VIEWS.map(({ view, label, icon: name }) => {
      const active = shown && this.view === view;
      const badge = view === 'repos' && changed ? h('span', { class: 'activity-badge' }, changed > 999 ? '999+' : String(changed)) : null;
      return h('button', {
        class: `activity ${active ? 'active' : ''}`, 'aria-label': label, 'aria-pressed': String(active),
        'data-tip': active ? `${label}\nClick again to hide the sidebar` : label,
        onclick: () => this.choose(view),
      }, icon(name), badge);
    }));
  }

  /** The item `delta` places from the selected one, opened. */
  step(delta: number): void {
    if (!this.items.length) return;
    const i = this.items.findIndex((it) => it.key === this.selected);
    const next = this.items[Math.min(this.items.length - 1, Math.max(0, i < 0 ? 0 : i + delta))];
    if (next) this.select(next);
  }

  neighbours(): { prev?: Item; next?: Item } {
    const i = this.items.findIndex((it) => it.key === this.selected);
    if (i < 0) return {};
    return { prev: this.items[i - 1], next: this.items[i + 1] };
  }

  /** The item a key names, from the repos' current status whichever view is shown; undefined once
   * the file has no changes of that kind. */
  resolve(key: string): Item | undefined {
    const [root, group, path] = key.split('\x1f');
    const repo = this.repos.find((r) => r.root === root);
    const e = repo?.status?.entries.find((x) => x.path === path);
    if (!repo || !e) return undefined;
    switch (group) {
      case 'conflicts': return e.conflict ? { key, repo, entry: e, target: diffTarget(root, 'conflict', e), staged: false } : undefined;
      case 'staged': return e.index ? { key, repo, entry: e, target: diffTarget(root, 'staged', e), staged: true } : undefined;
      case 'changes': return e.worktree ? { key, repo, entry: e, target: diffTarget(root, 'unstaged', e), staged: false } : undefined;
      case 'untracked': return e.untracked ? { key, repo, entry: e, target: diffTarget(root, 'unstaged', e), staged: false } : undefined;
    }
    return undefined;
  }

  /** Marks an item as the selected one without opening it (its tab was shown). */
  mark(key: string | null): void {
    this.selected = key;
    for (const el of this.list.querySelectorAll('.file.selected')) el.classList.remove('selected');
    if (key) this.list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.classList.add('selected');
  }

  private select(item: Item, pin = false): void {
    this.mark(item.key);
    this.list.querySelector('.file.selected')?.scrollIntoView({ block: 'nearest' });
    this.hooks.open(item, pin);
  }

  render(): void {
    // Out of sync with its upstream counts as changed: commits to pull or push stay in sight.
    const listed = (r: Repo) => !!r.error || (!!r.status && (changeCount(r.status) > 0 || sync(r) !== 'even'));
    const changed = this.repos.filter(listed);
    const clean = this.repos.filter((r) => r.status && !listed(r));
    this.renderRail();
    const fetching = this.batch?.action === 'fetch';
    const tip = fetching ? 'Fetching every repository…' : 'Fetch all: every repository that tracks a remote branch, to see which are behind';
    this.fetchAll.dataset.tip = tip;
    this.fetchAll.setAttribute('aria-label', tip);
    this.fetchAll.classList.toggle('spinning', fetching);
    this.fetchAll.disabled = !!this.batch;
    this.title.textContent = VIEWS.find((v) => v.view === this.view)!.label;
    this.fetchAll.hidden = !(this.view === 'repos' && this.tracking().length);
    this.items = [];
    if (this.view === 'repos') this.renderRepos(changed, clean);
    else {
      const view = this.view === 'files' ? this.explorer?.el : this.search?.el;
      if (view && (this.list.firstChild !== view || this.list.childNodes.length !== 1)) {
        this.list.replaceChildren(view);
        if (this.view === 'files') this.explorer?.render();
      }
      return;
    }
    this.list.querySelector(`[data-key="${CSS.escape(this.selected ?? '')}"]`)?.classList.add('selected');
  }

  private name(r: Repo): string {
    return r.rel || this.baseName;
  }

  /** The branch, which switches to another one when clicked. */
  private branch(r: Repo): HTMLElement {
    const s = r.status;
    if (!s) return h('span', { class: 'dim' }, '…');
    const name = s.branch ?? (s.oid ? `detached at ${s.oid.slice(0, 7)}` : '');
    const button: HTMLButtonElement = h('button', {
      class: 'branch-name', 'data-tip': 'Switch branch',
      onclick: (e: MouseEvent) => { e.stopPropagation(); this.hooks.branches(r, button); },
    }, icon('branch'), s.oid === null && s.branch ? `${s.branch} (no commits yet)` : name);
    return h('span', { class: 'branch' },
      button,
      s.upstreamGone ? h('span', { class: 'warn', 'data-tip': 'The upstream branch no longer exists on the remote' }, ' upstream gone') : null,
      s.operation ? h('span', { class: 'badge' }, s.operation.replace('cherryPick', 'cherry-pick').toUpperCase()) : null);
  }

  /** Runs a fetch, pull or push on a repo, showing it busy meanwhile; resolves to git's error. */
  private run(r: Repo, action: RemoteAction, quiet = false): Promise<string | null> {
    if (this.busy.has(r.root)) return Promise.resolve(null);
    this.queued.delete(r.root);
    this.busy.set(r.root, action);
    this.render();
    return this.hooks.remote(r, action, quiet).finally(() => {
      this.busy.delete(r.root);
      this.render();
    });
  }

  /** Repos whose branch is only behind its upstream: the ones a fast-forward pull can bring up to
   * date (a diverged one needs a merge or a rebase, left to a terminal). */
  private behind(): Repo[] {
    return this.repos.filter((r) => sync(r) === 'behind');
  }

  /** Repos whose branch tracks an upstream that still exists: the ones a fetch can say are behind. */
  private tracking(): Repo[] {
    return this.repos.filter((r) => r.status?.upstream && !r.status.upstreamGone);
  }

  /** Fetches every repo that tracks an upstream, or pulls every one that's behind (fast-forward
   * only), a few at a time; then reports the ones git refused in one message. */
  private async runAll(action: 'fetch' | 'pull'): Promise<void> {
    if (this.batch) return;
    const repos = (action === 'fetch' ? this.tracking() : this.behind()).filter((r) => !this.busy.has(r.root));
    if (!repos.length) return;
    this.batch = { action, done: 0, total: repos.length };
    for (const r of repos) this.queued.add(r.root);
    this.render();
    const failed: string[] = [];
    const queue = [...repos];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const error = await this.run(r, action, true);
        if (error) failed.push(`${this.name(r)}: ${error}`);
        this.batch!.done++;
        this.render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(ALL_AT_ONCE, repos.length) }, worker));
    this.batch = null;
    this.render();
    if (failed.length) {
      this.hooks.toast(`Couldn't ${action} ${failed.length} of ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}:\n${failed.join('\n')}`);
    }
  }

  /** Atop the repos: Fetch all, and Pull all while any repo is behind, with how it's going. */
  /** A line over the repos while there's something to say: "Fetch all" or "Pull all" under way, or
   * how many repos are behind, ahead or diverged, with "Pull all" for the ones behind. ("Fetch all"
   * itself is in the header.) */
  private reposBar(): HTMLElement | null {
    const counts = { behind: 0, ahead: 0, diverged: 0 };
    for (const r of this.repos) {
      const state = sync(r);
      if (state !== 'even') counts[state]++;
    }
    const n = counts.behind;
    const b = this.batch;
    if (!b && !counts.behind && !counts.ahead && !counts.diverged) return null;
    const text = b
      ? `${b.action === 'fetch' ? 'Fetching' : 'Pulling'}… ${b.done} of ${b.total} done`
      : (['behind', 'ahead', 'diverged'] as const).filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(' · ');
    const tip = b ? '' : [
      counts.behind ? `${counts.behind} with commits to pull` : '',
      counts.ahead ? `${counts.ahead} with commits to push` : '',
      counts.diverged ? `${counts.diverged} diverged: commits both to pull and to push, which need a merge or a rebase in a terminal` : '',
    ].filter(Boolean).join('\n');
    return h('div', { class: 'repos-bar' },
      h('span', { class: 'dim', 'data-tip': tip || undefined }, text),
      h('span', { class: 'spacer' }),
      n && !b ? iconButton('pull', `Pull every repository that's behind (fast-forward only)`, () => this.runAll('pull'), { label: 'Pull all', class: 'sync' }) : null);
  }

  /** The repo's buttons: fetch and history on hover, then pull and push when behind or ahead (with
   * the counts), last so they stay put when the others appear. */
  private repoActions(r: Repo): HTMLElement {
    const s = r.status;
    const busy = this.busy.get(r.root);
    const upstream = s?.upstream && !s.upstreamGone ? s.upstream : null;
    const plural = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
    // Waiting its turn in "Fetch all" or "Pull all": its buttons show, greyed out.
    const queued = this.queued.has(r.root);
    const waiting = queued ? `Waiting for ${this.batch?.action === 'fetch' ? 'Fetch' : 'Pull'} all` : '';
    return h('span', { class: 'repo-actions' },
      busy || queued ? null : iconButton('refresh', upstream ? `Fetch from ${upstream.split('/')[0]} and refresh` : 'Fetch from the remote and refresh', () => this.run(r, 'fetch'), { class: 'hover' }),
      iconButton('history', 'Show the history', () => this.hooks.history(r), { class: 'hover' }),
      busy ? h('span', { class: 'busy dim' }, REMOTE_BUSY[busy]) : null,
      // Diverged: neither a fast-forward pull nor a push can go through, so no buttons, only the
      // counts.
      !busy && sync(r) === 'diverged' ? h('span', {
        class: 'badge diverged',
        'data-tip': `Diverged from ${upstream}: ${plural(s!.behind)} to pull and ${plural(s!.ahead)} to push. Merge or rebase in a terminal.`,
      }, icon('pull'), String(s!.behind), icon('push'), String(s!.ahead)) : null,
      !busy && sync(r) === 'behind' ? iconButton('pull', waiting || `Pull ${plural(s!.behind)} from ${upstream} (fast-forward only)`, () => this.run(r, 'pull'), { label: String(s!.behind), class: 'sync', disabled: queued }) : null,
      !busy && sync(r) === 'ahead' ? iconButton('push', waiting || `Push ${plural(s!.ahead)} to ${upstream}`, () => this.run(r, 'push'), { label: String(s!.ahead), class: 'sync', disabled: queued }) : null);
  }

  private renderRepos(changed: Repo[], clean: Repo[]): void {
    const wanted: HTMLElement[] = [];
    for (const r of changed) {
      const sec = this.section(r);
      this.fillSection(sec, r);
      wanted.push(sec.el);
    }
    if (clean.length) {
      wanted.push(h('div', { class: 'clean' },
        h('button', { class: 'group-toggle', onclick: () => { this.cleanOpen = !this.cleanOpen; this.render(); } },
          chevron(this.cleanOpen), 'Clean repositories', h('span', { class: 'count' }, String(clean.length))),
        this.cleanOpen ? clean.map((r) => h('div', { class: 'clean-repo', 'data-tip': r.root },
          h('span', { class: 'repo-name' }, this.name(r)), ' ', this.branch(r),
          h('span', { class: 'spacer' }),
          this.repoActions(r))) : null));
    }
    if (!changed.length && !clean.length) wanted.push(h('div', { class: 'empty dim' }, 'Looking for repositories…'));
    else if (!changed.length) wanted.unshift(h('div', { class: 'empty dim' }, 'No changes in any repository.'));
    const bar = this.reposBar();
    if (bar) wanted.unshift(bar);
    // Move nodes only where the order changed.
    const current = [...this.list.children];
    if (current.length !== wanted.length || current.some((c, i) => c !== wanted[i])) {
      wanted.forEach((el, i) => {
        if (this.list.children[i] !== el) this.list.insertBefore(el, this.list.children[i] ?? null);
      });
      while (this.list.children.length > wanted.length) this.list.lastElementChild!.remove();
    }
  }

  private section(r: Repo): Section {
    let sec = this.sections.get(r.root);
    if (sec) return sec;
    const header = h('div', { class: 'repo-header' });
    const files = h('div', { class: 'files' });
    sec = { el: h('section', { class: 'repo' }, header, files), header, files };
    this.sections.set(r.root, sec);
    return sec;
  }

  private fillSection(sec: Section, r: Repo): void {
    const s = r.status;
    const open = !this.collapsed.has(r.root);
    const n = s ? changeCount(s) : 0;
    fill(sec.header,
      // A repo listed only for its commits to pull or push has no files to fold away.
      n || r.error
        ? h('button', { class: 'twisty', 'data-tip': open ? 'Collapse' : 'Expand', onclick: () => { open ? this.collapsed.add(r.root) : this.collapsed.delete(r.root); this.render(); } },
          chevron(open))
        : h('span', { class: 'twisty' }),
      h('span', { class: 'repo-name', 'data-tip': r.root }, this.name(r)),
      r.kind !== 'normal' ? h('span', { class: 'badge' }, r.kind) : null,
      ' ', this.branch(r),
      h('span', { class: 'spacer' }),
      this.repoActions(r),
      s && n ? h('span', { class: 'count', 'data-tip': `${n} changed file${n === 1 ? '' : 's'}` }, String(n)) : null,
    );
    sec.files.hidden = !open;
    if (r.error) {
      sec.files.replaceChildren(h('div', { class: 'error' }, r.error));
      return;
    }
    if (!s) return;
    const groups: [keyof typeof GROUP_LABEL, Entry[]][] = [
      ['conflicts', s.entries.filter((e) => e.conflict)],
      ['staged', s.entries.filter((e) => e.index)],
      ['changes', s.entries.filter((e) => e.worktree)],
      ['untracked', s.entries.filter((e) => e.untracked)],
    ];
    const out: HTMLElement[] = [];
    for (const [group, entries] of groups) {
      if (!entries.length && !(group === 'untracked' && s.untrackedOmitted)) continue;
      out.push(h('div', { class: 'group' }, h('span', {}, GROUP_LABEL[group]), h('span', { class: 'spacer' }),
        h('span', { class: 'count' }, String(entries.length + (group === 'untracked' ? s.untrackedOmitted : 0)))));
      for (const e of entries) {
        const kind = group === 'staged' ? 'staged' : group === 'conflicts' ? 'conflict' : 'unstaged';
        const item: Item = { key: `${r.root}\x1f${group}\x1f${e.path}`, repo: r, entry: e, target: diffTarget(r.root, kind, e), staged: group === 'staged' };
        this.items.push(item);
        const letter = group === 'staged' ? LETTER[e.index!] : group === 'changes' ? LETTER[e.worktree!] : group === 'untracked' ? 'U' : '!';
        // A deleted file has no whole file to open.
        const gone = (group === 'staged' ? e.index : e.worktree) === 'deleted';
        out.push(this.fileRow(item, letter, gone, group !== 'conflicts'));
      }
      if (group === 'untracked' && s.untrackedOmitted) {
        out.push(h('div', { class: 'more dim' }, `${s.untrackedOmitted.toLocaleString()} more untracked files not listed`));
      }
    }
    sec.files.replaceChildren(...out);
  }

  /** A file: its name, its folder, then the buttons on hover and its status letter, pinned to the
   * row's right edge (over the end of a long name) so they're always in reach. */
  private fileRow(item: Item, letter: string, gone: boolean, revertible: boolean): HTMLElement {
    const e = item.entry;
    return h('div', {
      class: `file st-${letter}`, 'data-key': item.key, 'data-tip': e.path,
      onclick: () => this.select(item), ondblclick: () => this.select(item, true),
    },
    fileIcon(basename(e.path)),
    h('span', { class: 'fname' }, basename(e.path)),
    h('span', { class: 'fdir dim' }, dirname(e.path)),
    h('span', { class: 'row-end' },
      iconButton('diff', 'Show diff', () => this.select(item), { class: 'hover' }),
      gone ? null : iconButton('file', 'Open file', () => this.hooks.openFile(item), { class: 'hover' }),
      gone ? null : iconButton('editor', this.hooks.editorLabel(), () => this.hooks.openInEditor(item), { class: 'hover' }),
      revertible ? iconButton('revert', 'Revert changes', () => this.hooks.revert(item), { class: 'hover' }) : null,
      h('span', { class: 'letter' }, letter)));
  }

  focus(): void {
    this.list.focus();
  }
}

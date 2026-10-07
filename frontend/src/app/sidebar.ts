// The sidebar: the repos view (changed repos with their staged, unstaged, untracked and conflicted
// files; clean repos collapsed at the bottom), the file tree and search.
//
// Staging and committing are left to the agents; each repo offers its history, a fetch, and a pull
// or push when its branch is behind or ahead of its upstream. When any are behind, a bar at the
// top pulls them all.

import { basename, dirname, fill, h } from './dom';
import type { Explorer } from './explorer';
import type { SearchView } from './search';
import type { DiffTarget, Entry, Repo } from './model';
import { changeCount, diffTarget, LETTER } from './model';
import { icon, iconButton } from './icons';

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
  /** Hides the sidebar. */
  collapse(): void;
}

interface Section {
  el: HTMLElement;
  header: HTMLElement;
  files: HTMLElement;
}

const GROUP_LABEL = { conflicts: 'Merge conflicts', staged: 'Staged changes', changes: 'Changes', untracked: 'Untracked' };
const REMOTE_BUSY = { fetch: 'Fetching…', pull: 'Pulling…', push: 'Pushing…' };
/** How many pulls "Pull all" runs at once. */
const PULL_ALL_AT_ONCE = 4;

export class Sidebar {
  readonly el = h('aside', { class: 'sidebar' });
  private tabs = h('div', { class: 'sidebar-tabs' });
  private list = h('div', { class: 'sidebar-list', tabIndex: 0 });
  private sections = new Map<string, Section>();
  private collapsed = new Set<string>();
  private cleanOpen = false;
  private items: Item[] = [];
  /** Repos with a fetch, pull or push running. */
  private busy = new Map<string, RemoteAction>();
  /** "Pull all" in progress: how many are done of how many. */
  private pullingAll: { done: number; total: number } | null = null;
  /** Repos waiting for their turn in "Pull all" (it runs a few at a time). */
  private queued = new Set<string>();
  view: View = 'repos';
  selected: string | null = null;
  repos: Repo[] = [];
  baseName = '';
  explorer: Explorer | null = null;
  search: SearchView | null = null;

  constructor(private hooks: SidebarHooks) {
    this.el.append(this.tabs, this.list);
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

  setView(view: View): void {
    this.view = view;
    this.render();
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
    const changed = this.repos.filter((r) => r.error || (r.status && changeCount(r.status) > 0));
    const clean = this.repos.filter((r) => r.status && !r.error && changeCount(r.status) === 0);
    const tab = (view: View, label: string, extra?: () => void) =>
      h('button', { class: this.view === view ? 'active' : '', onclick: () => { this.setView(view); extra?.(); } }, label);
    this.tabs.replaceChildren(
      tab('repos', 'Repositories'),
      tab('files', 'Files'),
      tab('search', 'Search', () => this.search?.focus()),
      h('span', { class: 'spacer' }),
      iconButton('sidebar-hide', 'Hide the sidebar', () => this.hooks.collapse(), { class: 'bar-toggle' }),
    );
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

  /** Repos whose branch is behind an upstream that still exists. */
  private behind(): Repo[] {
    return this.repos.filter((r) => r.status?.upstream && !r.status.upstreamGone && r.status.behind > 0);
  }

  /** Pulls every repo that's behind (fast-forward only), a few at a time, then reports the ones
   * git refused in one message. */
  private async pullAll(): Promise<void> {
    if (this.pullingAll) return;
    const repos = this.behind().filter((r) => !this.busy.has(r.root));
    if (!repos.length) return;
    this.pullingAll = { done: 0, total: repos.length };
    for (const r of repos) this.queued.add(r.root);
    const failed: string[] = [];
    const queue = [...repos];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const error = await this.run(r, 'pull', true);
        if (error) failed.push(`${this.name(r)}: ${error}`);
        this.pullingAll!.done++;
        this.render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PULL_ALL_AT_ONCE, repos.length) }, worker));
    this.pullingAll = null;
    this.render();
    if (failed.length) {
      this.hooks.toast(`Couldn't pull ${failed.length} of ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}:\n${failed.join('\n')}`);
    }
  }

  /** "N repositories are behind" and Pull all, while any are. */
  private pullAllBar(): HTMLElement | null {
    const n = this.behind().length;
    if (this.pullingAll) {
      return h('div', { class: 'pull-all' }, h('span', { class: 'dim' }, `Pulling… ${this.pullingAll.done} of ${this.pullingAll.total} done`));
    }
    if (!n) return null;
    return h('div', { class: 'pull-all' },
      h('span', { class: 'dim' }, `${n} repositor${n === 1 ? 'y is' : 'ies are'} behind`),
      h('span', { class: 'spacer' }),
      iconButton('pull', `Pull every repository that's behind (fast-forward only)`, () => this.pullAll(), { label: 'Pull all', class: 'sync' }));
  }

  /** The repo's buttons: fetch and history on hover, then pull and push when behind or ahead (with
   * the counts), last so they stay put when the others appear. */
  private repoActions(r: Repo): HTMLElement {
    const s = r.status;
    const busy = this.busy.get(r.root);
    const upstream = s?.upstream && !s.upstreamGone ? s.upstream : null;
    const plural = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
    // Waiting its turn in "Pull all": its buttons show, greyed out.
    const queued = this.queued.has(r.root);
    const waiting = queued ? 'Waiting to be pulled by Pull all' : '';
    return h('span', { class: 'repo-actions' },
      busy || queued ? null : iconButton('refresh', upstream ? `Fetch from ${upstream.split('/')[0]} and refresh` : 'Fetch from the remote and refresh', () => this.run(r, 'fetch'), { class: 'hover' }),
      iconButton('history', 'Show the history', () => this.hooks.history(r), { class: 'hover' }),
      busy ? h('span', { class: 'busy dim' }, REMOTE_BUSY[busy]) : null,
      !busy && upstream && s!.behind ? iconButton('pull', waiting || `Pull ${plural(s!.behind)} from ${upstream} (fast-forward only)`, () => this.run(r, 'pull'), { label: String(s!.behind), class: 'sync', disabled: queued }) : null,
      !busy && upstream && s!.ahead ? iconButton('push', waiting || `Push ${plural(s!.ahead)} to ${upstream}`, () => this.run(r, 'push'), { label: String(s!.ahead), class: 'sync', disabled: queued }) : null);
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
          `${this.cleanOpen ? '▾' : '▸'} Clean repositories (${clean.length})`),
        this.cleanOpen ? clean.map((r) => h('div', { class: 'clean-repo', 'data-tip': r.root },
          h('span', { class: 'repo-name' }, this.name(r)), ' ', this.branch(r),
          h('span', { class: 'spacer' }),
          this.repoActions(r))) : null));
    }
    if (!changed.length && !clean.length) wanted.push(h('div', { class: 'empty dim' }, 'Looking for repositories…'));
    else if (!changed.length) wanted.unshift(h('div', { class: 'empty dim' }, 'No changes in any repository.'));
    const bar = this.pullAllBar();
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
      h('button', { class: 'twisty', 'data-tip': open ? 'Collapse' : 'Expand', onclick: () => { open ? this.collapsed.add(r.root) : this.collapsed.delete(r.root); this.render(); } },
        open ? '▾' : '▸'),
      h('span', { class: 'repo-name', 'data-tip': r.root }, this.name(r)),
      r.kind !== 'normal' ? h('span', { class: 'badge' }, r.kind) : null,
      ' ', this.branch(r),
      h('span', { class: 'spacer' }),
      this.repoActions(r),
      s ? h('span', { class: 'count', 'data-tip': `${n} changed file${n === 1 ? '' : 's'}` }, String(n)) : null,
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

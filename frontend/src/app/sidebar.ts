// The sidebar: the repos view (changed repos with their staged, unstaged, untracked and conflicted
// files and a commit box each; clean repos collapsed at the bottom) and the review queue (every
// changed file in every repo, in one list).
//
// Status events arrive whenever an agent touches a file, so nothing the user is typing may be
// rebuilt: each repo has a persistent section whose commit box survives every update.

import { basename, dirname, fill, h } from './dom';
import type { Explorer } from './explorer';
import type { SearchView } from './search';
import type { DiffTarget, Entry, Repo, Status } from './model';
import { changeCount, diffTarget, LETTER, reviewLetter } from './model';

export type View = 'repos' | 'review' | 'files' | 'search';

/** A file row the user can select; the order of these is the order of ↑ and ↓. */
export interface Item {
  key: string;
  repo: Repo;
  entry: Entry;
  target: DiffTarget;
  staged: boolean;
}

export interface SidebarHooks {
  open(item: Item): void;
  stage(repo: Repo, paths: string[]): void;
  unstage(repo: Repo, paths: string[]): void;
  commit(repo: Repo, message: string, amend: boolean): Promise<boolean>;
  lastMessage(repo: Repo): Promise<string>;
  history(repo: Repo): void;
}

interface Section {
  el: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  files: HTMLElement;
  commit: HTMLElement;
  message: HTMLTextAreaElement;
  amend: HTMLInputElement;
  button: HTMLButtonElement;
}

const GROUP_LABEL = { conflicts: 'Merge conflicts', staged: 'Staged changes', changes: 'Changes', untracked: 'Untracked' };

export class Sidebar {
  readonly el = h('aside', { class: 'sidebar' });
  private tabs = h('div', { class: 'sidebar-tabs' });
  private list = h('div', { class: 'sidebar-list', tabIndex: 0 });
  private sections = new Map<string, Section>();
  private collapsed = new Set<string>();
  private cleanOpen = false;
  private items: Item[] = [];
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

  /** The item that matches what's open, after a status change (its key may have moved groups). */
  find(key: string): Item | undefined {
    return this.items.find((it) => it.key === key);
  }

  private select(item: Item): void {
    this.selected = item.key;
    for (const el of this.list.querySelectorAll('.file.selected')) el.classList.remove('selected');
    this.list.querySelector(`[data-key="${CSS.escape(item.key)}"]`)?.classList.add('selected');
    this.list.querySelector('.file.selected')?.scrollIntoView({ block: 'nearest' });
    this.hooks.open(item);
  }

  render(): void {
    const changed = this.repos.filter((r) => r.error || (r.status && changeCount(r.status) > 0));
    const clean = this.repos.filter((r) => r.status && !r.error && changeCount(r.status) === 0);
    const files = changed.reduce((n, r) => n + (r.status ? changeCount(r.status) : 0), 0);
    this.tabs.replaceChildren(
      h('button', { class: this.view === 'repos' ? 'active' : '', onclick: () => this.setView('repos') }, 'Repositories'),
      h('button', { class: this.view === 'review' ? 'active' : '', onclick: () => this.setView('review') },
        `Review queue${files ? ` (${files})` : ''}`),
      h('button', { class: this.view === 'files' ? 'active' : '', onclick: () => this.setView('files') }, 'Files'),
      h('button', { class: this.view === 'search' ? 'active' : '', onclick: () => { this.setView('search'); this.search?.focus(); } }, 'Search'),
    );
    this.items = [];
    if (this.view === 'repos') this.renderRepos(changed, clean);
    else if (this.view === 'review') this.renderReview(changed);
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

  private branch(s: Status | undefined): HTMLElement {
    if (!s) return h('span', { class: 'dim' }, '…');
    const name = s.branch ?? (s.oid ? `detached at ${s.oid.slice(0, 7)}` : '');
    return h('span', { class: 'branch' },
      s.oid === null && s.branch ? `${s.branch} (no commits yet)` : name,
      s.upstream && !s.upstreamGone && (s.ahead || s.behind) ? h('span', { class: 'ab' }, ` ↑${s.ahead} ↓${s.behind}`) : null,
      s.upstreamGone ? h('span', { class: 'warn' }, ' upstream gone') : null,
      s.operation ? h('span', { class: 'badge' }, s.operation.replace('cherryPick', 'cherry-pick').toUpperCase()) : null);
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
        this.cleanOpen ? clean.map((r) => h('div', { class: 'clean-repo', onclick: () => this.hooks.history(r), title: 'Show history' },
          h('span', { class: 'repo-name' }, this.name(r)), ' ', this.branch(r.status))) : null));
    }
    if (!changed.length && !clean.length) wanted.push(h('div', { class: 'empty dim' }, 'Looking for repositories…'));
    else if (!changed.length) wanted.unshift(h('div', { class: 'empty dim' }, 'No changes in any repository.'));
    // Move nodes only where the order changed, so a focused commit box keeps its focus.
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
    const message = h('textarea', { class: 'commit-message', rows: 1, placeholder: 'Message (⌘⏎ or Ctrl+⏎ to commit)' });
    const amend = h('input', { type: 'checkbox' });
    const button = h('button', { class: 'primary' }, 'Commit');
    const doCommit = async () => {
      button.disabled = true;
      if (await this.hooks.commit(r, message.value, amend.checked)) {
        message.value = '';
        amend.checked = false;
        commit.classList.remove('has-text');
      }
      button.disabled = false;
    };
    button.addEventListener('click', doCommit);
    message.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        doCommit();
      }
    });
    amend.addEventListener('change', async () => {
      if (amend.checked && !message.value.trim()) {
        message.value = await this.hooks.lastMessage(r);
        commit.classList.toggle('has-text', message.value !== '');
      }
    });
    const commit = h('div', { class: 'commit-box' }, h('div', { class: 'commit-line' }, message, button),
      h('div', { class: 'commit-row' }, h('label', { class: 'dim' }, amend, ' Amend last commit')));
    // A message being written keeps the box open even without focus.
    message.addEventListener('input', () => commit.classList.toggle('has-text', message.value !== ''));
    const header = h('div', { class: 'repo-header' });
    const files = h('div', { class: 'files' });
    const body = h('div', { class: 'repo-body' }, commit, files);
    sec = { el: h('section', { class: 'repo' }, header, body), header, body, files, commit, message, amend, button };
    this.sections.set(r.root, sec);
    return sec;
  }

  private fillSection(sec: Section, r: Repo): void {
    const s = r.status;
    const open = !this.collapsed.has(r.root);
    fill(sec.header,
      h('button', { class: 'twisty', onclick: () => { open ? this.collapsed.add(r.root) : this.collapsed.delete(r.root); this.render(); } },
        open ? '▾' : '▸'),
      h('span', { class: 'repo-name', title: r.root }, this.name(r)),
      r.kind !== 'normal' ? h('span', { class: 'badge' }, r.kind) : null,
      ' ', this.branch(s),
      h('span', { class: 'spacer' }),
      s ? h('span', { class: 'count' }, String(changeCount(s))) : null,
      h('button', { class: 'icon', title: 'History', onclick: () => this.hooks.history(r) }, '⏱'),
    );
    sec.body.hidden = !open;
    if (r.error) {
      sec.files.replaceChildren(h('div', { class: 'error' }, r.error));
      return;
    }
    if (!s) return;
    const staged = s.entries.filter((e) => e.index);
    sec.button.disabled = false;
    sec.message.placeholder = staged.length ? 'Message (⌘⏎ or Ctrl+⏎ to commit)' : 'Stage files to commit';
    const groups: [keyof typeof GROUP_LABEL, Entry[]][] = [
      ['conflicts', s.entries.filter((e) => e.conflict)],
      ['staged', staged],
      ['changes', s.entries.filter((e) => e.worktree)],
      ['untracked', s.entries.filter((e) => e.untracked)],
    ];
    const out: HTMLElement[] = [];
    for (const [group, entries] of groups) {
      if (!entries.length && !(group === 'untracked' && s.untrackedOmitted)) continue;
      const paths = entries.map((e) => e.path);
      const all = group === 'staged'
        ? h('button', { class: 'icon', title: 'Unstage all', onclick: () => this.hooks.unstage(r, paths) }, '−')
        : h('button', { class: 'icon', title: 'Stage all', onclick: () => this.hooks.stage(r, paths) }, '+');
      out.push(h('div', { class: 'group' }, h('span', {}, GROUP_LABEL[group]), h('span', { class: 'spacer' }),
        h('span', { class: 'count' }, String(entries.length + (group === 'untracked' ? s.untrackedOmitted : 0))), all));
      for (const e of entries) {
        const kind = group === 'staged' ? 'staged' : group === 'conflicts' ? 'conflict' : 'unstaged';
        const item: Item = { key: `${r.root}\x1f${group}\x1f${e.path}`, repo: r, entry: e, target: diffTarget(r.root, kind, e), staged: group === 'staged' };
        this.items.push(item);
        const letter = group === 'staged' ? LETTER[e.index!] : group === 'changes' ? LETTER[e.worktree!] : group === 'untracked' ? 'U' : '!';
        out.push(this.fileRow(item, letter,
          group === 'staged'
            ? h('button', { class: 'icon', title: 'Unstage', onclick: (ev: Event) => { ev.stopPropagation(); this.hooks.unstage(r, [e.path]); } }, '−')
            : h('button', { class: 'icon', title: 'Stage', onclick: (ev: Event) => { ev.stopPropagation(); this.hooks.stage(r, [e.path]); } }, '+')));
      }
      if (group === 'untracked' && s.untrackedOmitted) {
        out.push(h('div', { class: 'more dim' }, `${s.untrackedOmitted.toLocaleString()} more untracked files not listed`));
      }
    }
    sec.files.replaceChildren(...out);
  }

  private fileRow(item: Item, letter: string, action: HTMLElement | null): HTMLElement {
    const e = item.entry;
    return h('div', { class: `file st-${letter}`, 'data-key': item.key, onclick: () => this.select(item), title: e.path },
      h('span', { class: 'letter' }, letter),
      h('span', { class: 'fname' }, basename(e.path)),
      h('span', { class: 'fdir dim' }, dirname(e.path)),
      action);
  }

  private renderReview(changed: Repo[]): void {
    const out: HTMLElement[] = [];
    for (const r of changed) {
      const s = r.status;
      if (!s) continue;
      out.push(h('div', { class: 'review-repo' }, h('span', { class: 'repo-name' }, this.name(r)), ' ', this.branch(s),
        h('span', { class: 'spacer' }), h('span', { class: 'count' }, String(changeCount(s)))));
      if (r.error) out.push(h('div', { class: 'error' }, r.error));
      for (const e of s.entries) {
        const item: Item = {
          key: `${r.root}\x1freview\x1f${e.path}`, repo: r, entry: e,
          target: diffTarget(r.root, e.conflict ? 'conflict' : 'review', e), staged: !!e.index && !e.worktree,
        };
        this.items.push(item);
        out.push(this.fileRow(item, reviewLetter(e), null));
      }
      if (s.untrackedOmitted) out.push(h('div', { class: 'more dim' }, `${s.untrackedOmitted.toLocaleString()} more untracked files not listed`));
    }
    if (!out.length) out.push(h('div', { class: 'empty dim' }, 'Nothing to review: no changes in any repository.'));
    this.list.replaceChildren(...out);
  }

  focus(): void {
    this.list.focus();
  }
}

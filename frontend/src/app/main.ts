import './style.css';

import { boot } from '../boot';
import { connect, type Transport } from '../transport';
import { DiffPanel } from './diff';
import { basename, h } from './dom';
import { Git, type Opened } from './git';
import { HistoryPanel } from './history';
import type { DiffTarget, Repo, RepoInfo, Status } from './model';
import { type Item, Sidebar } from './sidebar';

const LAST_BASE = 'gako.lastBase';

class App {
  private git: Git;
  private sidebar: Sidebar;
  private diff: DiffPanel;
  private history: HistoryPanel;
  private main = h('main', { class: 'main' });
  private statusbar = h('footer', { class: 'statusbar' });
  private toasts = h('div', { class: 'toasts' });
  private repos: Repo[] = [];
  private opened: Opened | null = null;
  private scanInfo = '';
  private renderQueued = false;
  private mode: 'welcome' | 'diff' | 'history' = 'welcome';
  private historyRepo: Repo | null = null;
  private log: (ev: string, data?: Record<string, unknown>) => void;

  constructor(t: Transport, env: Record<string, string>) {
    this.git = new Git(t);
    this.log = env.GAKO_LOG
      ? (ev, data = {}) => t.send({ t: 'log', rec: { ev, epochMs: performance.timeOrigin + performance.now(), ...data } })
      : () => {};
    this.sidebar = new Sidebar({
      open: (item) => this.openItem(item),
      stage: (r, paths) => this.act(() => this.git.stage(r.root, paths)),
      unstage: (r, paths) => this.act(() => this.git.unstage(r.root, paths)),
      commit: (r, message, amend) => this.commit(r, message, amend),
      lastMessage: async (r) => (r.status?.oid ? (await this.git.details(r.root, 'HEAD')).message : ''),
      history: (r) => this.showHistory(r),
    });
    this.diff = new DiffPanel(this.git);
    this.history = new HistoryPanel(this.git, (target, repo) => this.openCommitDiff(target, repo), (r) => this.name(r));
    document.getElementById('app')!.replaceChildren(this.sidebar.el, this.main, this.statusbar, this.toasts);
    this.showWelcome();
    t.onEvent((ev) => {
      if (ev.t === 'repoStatus') this.onStatus(ev.repo, ev.status as Status | undefined, ev.error);
      else if (ev.t === 'repoTouched') this.refreshOpenDiff([ev.repo]);
      else if (ev.t === 'repos') this.onRepos(ev.repos as RepoInfo[]);
      else if (ev.t === 'scanDone') {
        this.scanInfo = `scanned ${ev.repos} repositories in ${Math.round(ev.ms)} ms`;
        this.log('scanDone', { ms: ev.ms, repos: ev.repos });
        this.renderStatusbar();
      }
    });
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(e.target as HTMLElement).closest('.monaco-editor')) {
        e.preventDefault();
        this.sidebar.step(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
  }

  private name(r: Repo): string {
    return r.rel || basename(this.opened?.base ?? r.root);
  }

  async open(base?: string): Promise<void> {
    try {
      const opened = await this.git.open(base);
      this.opened = opened;
      try { localStorage.setItem(LAST_BASE, opened.base); } catch { /* storage unavailable */ }
      document.title = `${basename(opened.base)} — Gako`;
      this.sidebar.baseName = basename(opened.base);
      this.scanInfo = 'scanning…';
      this.repos = opened.repos.map((r) => ({ ...r }));
      for (const s of opened.statuses) this.onStatus(s.repo, 'status' in s ? s.status : undefined, 'error' in s ? s.error : undefined);
      this.sidebar.repos = this.repos;
      this.sidebar.render();
      this.renderStatusbar();
      this.showWelcome();
      this.sidebar.focus();
      this.log('workspaceOpened', { repos: this.repos.length });
    } catch (e) {
      this.showOpenForm(base, String((e as Error).message ?? e));
    }
  }

  private onRepos(infos: RepoInfo[]): void {
    const old = new Map(this.repos.map((r) => [r.root, r]));
    this.repos = infos.map((i) => ({ ...i, status: old.get(i.root)?.status, error: old.get(i.root)?.error }));
    this.sidebar.repos = this.repos;
    this.queueRender();
  }

  private onStatus(root: string, status: Status | undefined, error: string | undefined): void {
    const r = this.repos.find((x) => x.root === root);
    if (!r) return;
    r.status = status ?? r.status;
    r.error = error;
    this.queueRender(root);
  }

  private pendingRepos = new Set<string>();

  /** Status events come in bursts while agents work: draw at most once per frame. */
  private queueRender(root?: string): void {
    if (root) this.pendingRepos.add(root);
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      const changed = [...this.pendingRepos];
      this.pendingRepos.clear();
      this.sidebar.render();
      this.log('statusRendered', { repos: changed });
      this.refreshOpenDiff(changed);
    });
  }

  /** The open diff follows the file: refreshed in place, or cleared once the file has no changes. */
  private refreshOpenDiff(changedRepos: string[]): void {
    const target = this.diff.target;
    if (this.mode !== 'diff' || !target || target.kind === 'commit' || !changedRepos.includes(target.repo)) return;
    const key = this.sidebar.selected;
    const item = key ? this.sidebar.find(key) : undefined;
    if (item) this.openItem(item, true);
    else this.diff.clear(`${target.path} has no more changes here.`);
  }

  private openItem(item: Item, keepView = false): void {
    this.setMode('diff');
    const { prev, next } = this.sidebar.neighbours();
    const r = item.repo;
    const canStage = item.target.kind !== 'commit' && !item.staged && (item.entry.worktree || item.entry.untracked || item.entry.conflict);
    this.diff.show(item.target, {
      repoName: this.name(r),
      prev: prev ? () => this.sidebar.step(-1) : undefined,
      next: next ? () => this.sidebar.step(1) : undefined,
      stage: canStage ? () => this.act(() => this.git.stage(r.root, [item.entry.path])) : undefined,
      unstage: item.entry.index && !item.entry.conflict ? () => this.act(() => this.git.unstage(r.root, [item.entry.path])) : undefined,
    }, keepView).catch((e) => this.toast(String(e.message ?? e)));
  }

  private openCommitDiff(target: DiffTarget, repo: Repo): void {
    this.setMode('diff');
    this.diff.show(target, { repoName: this.name(repo), back: () => this.showHistory(repo) })
      .catch((e) => this.toast(String(e.message ?? e)));
  }

  private showHistory(r: Repo): void {
    this.historyRepo = r;
    this.setMode('history');
    this.history.show(r).catch((e) => this.toast(String(e.message ?? e)));
  }

  private setMode(mode: App['mode']): void {
    if (this.mode === mode) return;
    this.mode = mode;
    const view = mode === 'diff' ? this.diff.el : mode === 'history' ? this.history.el : this.welcome();
    this.main.replaceChildren(view);
  }

  private showWelcome(): void {
    this.mode = 'diff'; // force setMode to redraw
    this.setMode('welcome');
  }

  private welcome(): HTMLElement {
    const n = this.repos.length;
    return h('div', { class: 'welcome' },
      h('h1', {}, this.opened ? basename(this.opened.base) : 'Gako'),
      this.opened ? h('p', { class: 'dim' }, `${n} repositor${n === 1 ? 'y' : 'ies'} in ${this.opened.base}`) : null,
      h('p', { class: 'dim' }, 'Select a file to see its diff. ↑ and ↓ move between files; the review queue lists every change in every repository.'));
  }

  private async act(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      this.toast(String((e as Error).message ?? e));
      return false;
    }
  }

  private async commit(r: Repo, message: string, amend: boolean): Promise<boolean> {
    if (!message.trim()) {
      this.toast('Write a commit message first.');
      return false;
    }
    const ok = await this.act(() => this.git.commit(r.root, message, amend));
    if (ok && this.mode === 'history' && this.historyRepo?.root === r.root) this.history.refresh(r);
    return ok;
  }

  private renderStatusbar(): void {
    this.statusbar.replaceChildren(
      h('span', {}, this.opened?.base ?? ''),
      h('span', { class: 'dim' }, this.scanInfo),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link', onclick: () => this.showOpenForm(this.opened?.base) }, 'Open folder…'),
    );
  }

  private toast(message: string): void {
    const el = h('div', { class: 'toast', onclick: () => el.remove() }, message);
    this.toasts.append(el);
    setTimeout(() => el.remove(), 8000);
  }

  private showOpenForm(value?: string, error?: string): void {
    this.mode = 'welcome';
    const input = h('input', { type: 'text', class: 'path', value: value ?? '', placeholder: '/path/to/your/base/folder', spellcheck: false });
    const submit = (e: Event) => {
      e.preventDefault();
      if (input.value.trim()) this.open(input.value.trim());
    };
    this.main.replaceChildren(h('form', { class: 'welcome', onsubmit: submit },
      h('h1', {}, 'Open a folder'),
      h('p', { class: 'dim' }, 'The base folder holding your repositories. Gako finds the repos inside it.'),
      input,
      error ? h('p', { class: 'error' }, error) : null,
      h('button', { class: 'primary', type: 'submit' }, 'Open')));
    input.focus();
  }
}

async function main(): Promise<void> {
  const b = boot();
  const t = await connect(b);
  const hello = await t.request<{ env: Record<string, string> }>('hello');
  const app = new App(t, hello.env);
  let last: string | undefined;
  try { last = localStorage.getItem(LAST_BASE) ?? undefined; } catch { /* storage unavailable */ }
  // The folder given on the command line, then the last one opened, then the settings file's.
  await app.open(hello.env.GAKO_BASE || last);
}

main().catch((e) => {
  document.body.textContent = String(e?.stack ?? e);
});

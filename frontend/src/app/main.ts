import './style.css';

import { boot } from '../boot';
import { connect, type Transport } from '../transport';
import { DiffPanel } from './diff';
import { basename, dirname, fill, h } from './dom';
import { Git, type Opened } from './git';
import { HistoryPanel } from './history';
import type { DiffTarget, Repo, RepoInfo, Status } from './model';
import { type Item, Sidebar } from './sidebar';
import { type Folder, Terminals } from './terminals';
import { Explorer } from './explorer';
import { Viewer } from './viewer';
import { type Reveal, SearchView } from './search';
import { GoToFile } from './gotofile';
import { Navigator } from './navigate';
import type { FileContent } from './model';
import { Editors } from './editors';
import { DocTabs } from './doctabs';
import { Layout } from './layout';
import { installTooltips } from './tooltip';

const LAST_BASE = 'gako.lastBase';

class App {
  private git: Git;
  private sidebar: Sidebar;
  private diff: DiffPanel;
  private history: HistoryPanel;
  private main = h('main', { class: 'main' });
  private body = h('div', { class: 'main-body' });
  private review = h('div', { class: 'review' });
  private terminals: Terminals;
  private statusbar = h('footer', { class: 'statusbar' });
  private toasts = h('div', { class: 'toasts' });
  private repos: Repo[] = [];
  private opened: Opened | null = null;
  private scanInfo = '';
  private renderQueued = false;
  private mode: 'welcome' | 'diff' | 'history' | 'file' = 'welcome';
  private explorer: Explorer;
  private viewer: Viewer;
  private search: SearchView;
  private goto: GoToFile;
  private nav: Navigator;
  private indexInfo = '';
  private historyRepo: Repo | null = null;
  private editors: Editors;
  private docs: DocTabs;
  private layout: Layout;
  private openedAt = 0;
  private log: (ev: string, data?: Record<string, unknown>) => void;

  constructor(private t: Transport, env: Record<string, string>) {
    this.git = new Git(t);
    this.log = env.GAKO_LOG
      ? (ev, data = {}) => t.send({ t: 'log', rec: { ev, epochMs: performance.timeOrigin + performance.now(), ...data } })
      : () => {};
    this.sidebar = new Sidebar({
      open: (item, pin) => this.openItem(item, pin),
      openFile: (item) => this.openFile(this.join(item.repo.root, item.entry.path)),
      history: (r) => this.showHistory(r),
      remote: async (r, action) => {
        await this.act(() => this.git.remote(r.root, action));
        if (this.mode === 'history' && this.historyRepo?.root === r.root) this.history.refresh(r);
      },
      collapse: () => this.layout.setLeftCollapsed(true),
    });
    this.editors = new Editors(t, (m) => this.toast(m));
    this.diff = new DiffPanel(this.git, this.editors, (spot) => this.openFile(spot.path, { line: spot.line ?? 1, columns: [], column: spot.column }));
    this.explorer = new Explorer(t, this.editors, (path, pin) => this.openFile(path, undefined, pin), (m) => this.toast(m), (path) => this.relative(path));
    this.sidebar.explorer = this.explorer;
    this.search = new SearchView(t, (path, reveal, pin) => this.openFile(path, reveal, pin));
    this.sidebar.search = this.search;
    this.goto = new GoToFile(t, () => this.opened?.base ?? '', (path) => this.openFile(path));
    this.nav = new Navigator(t, {
      open: (path, line, column) => this.openFile(path, { line, columns: [], column }),
      references: (name) => {
        if (!this.terminals.reviewActive) this.terminals.select(null);
        this.sidebar.setView('search');
        this.search.references(name);
      },
      relative: (path) => this.relative(path),
      toast: (m) => this.toast(m),
    });
    this.viewer = new Viewer(
      (path) => this.t.request<FileContent>('fileRead', { path }),
      this.editors,
      (path) => this.relative(path),
    );
    this.history = new HistoryPanel(this.git, (target, repo) => this.openCommitDiff(target, repo), (r) => this.name(r));
    this.viewer.attachNavigation(this.nav);
    this.diff.attachNavigation(this.nav, (repo, path) => this.join(repo, path));
    this.docs = new DocTabs({
      save: (kind) => (kind === 'diff' ? this.diff.saveView() : kind === 'file' ? this.viewer.saveView() : null),
      front: () => { if (!this.terminals.reviewActive) this.terminals.select(null); },
      empty: () => this.showWelcome(),
    });
    this.terminals = new Terminals(t, this.body, this.review, () => this.folders(), this.log, (m) => this.toast(m),
      (terminal) => this.docs.setFront(!terminal));
    this.body.append(this.review);
    this.main.append(this.docs.bar, this.body);
    const app = document.getElementById('app')!;
    this.layout = new Layout(app, this.sidebar.el, this.terminals);
    this.terminals.onCollapse = () => this.layout.apply();
    app.prepend(this.sidebar.el, this.layout.leftRail, this.main, this.terminals.el, this.statusbar, this.toasts);
    installTooltips();
    this.showWelcome();
    t.onEvent((ev) => {
      if (ev.t === 'repoStatus') this.onStatus(ev.repo, ev.status as Status | undefined, ev.error);
      else if (ev.t === 'repoTouched') this.refreshOpenDiff([ev.repo]);
      else if (ev.t === 'filesChanged') {
        const open = this.viewer.path;
        if (this.mode === 'file' && open && ev.dirs.some((d) => open.startsWith(d) && /^[\\/][^\\/]*$/.test(open.slice(d.length)))) {
          this.viewer.show(open, true).catch(() => this.toast(`${this.relative(open)} can't be read any more.`));
        }
      }
      else if (ev.t === 'repos') this.onRepos(ev.repos as RepoInfo[]);
      else if (ev.t === 'indexReady') {
        this.indexInfo = `${ev.symbols.toLocaleString()} symbols indexed`;
        this.log('indexReady', { files: ev.files, symbols: ev.symbols, ms: ev.ms });
        this.renderStatusbar();
      } else if (ev.t === 'scanDone') {
        // From asking for the workspace to every repo's status: discovery and the first scan.
        const sinceOpen = performance.now() - this.openedAt;
        this.scanInfo = `scanned ${ev.repos} repositories in ${Math.round(sinceOpen)} ms`;
        this.log('scanDone', { ms: ev.ms, sinceOpenMs: sinceOpen, repos: ev.repos });
        this.renderStatusbar();
      }
    });
    // Measurements depend on drawing; the log records when the window is hidden (and stops drawing).
    document.addEventListener('visibilitychange', () => this.log('visibility', { state: document.visibilityState }));
    const mac = navigator.platform.startsWith('Mac');
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      const inTerminal = !!(e.target as HTMLElement).closest?.('.xterm');
      const mod = mac ? e.metaKey : e.ctrlKey;
      // Shortcuts that shells use (Ctrl+P, Ctrl+Shift+F) stay with the terminal off macOS.
      if (mod && !e.altKey && (mac || !inTerminal)) {
        if (e.key.toLowerCase() === 'p' && !e.shiftKey) {
          e.preventDefault();
          this.goto.show();
          return;
        }
        if (e.key.toLowerCase() === 't' && !e.shiftKey) {
          e.preventDefault();
          this.nav.goToSymbol();
          return;
        }
        if (e.key.toLowerCase() === 'f' && e.shiftKey) {
          e.preventDefault();
          if (!this.terminals.reviewActive) this.terminals.select(null);
          this.sidebar.setView('search');
          this.search.focus();
          return;
        }
      }
      if (!typing && this.terminals.reviewActive && !(e.target as HTMLElement).closest('.monaco-editor, .sidebar-list')) {
        if (this.sidebar.key(e)) e.preventDefault();
      }
    });
  }

  private name(r: Repo): string {
    return r.rel || basename(this.opened?.base ?? r.root);
  }

  async open(base?: string): Promise<void> {
    try {
      this.openedAt = performance.now();
      const opened = await this.git.open(base);
      this.opened = opened;
      try { localStorage.setItem(LAST_BASE, opened.base); } catch { /* storage unavailable */ }
      document.title = `${basename(opened.base)} — Gako`;
      this.sidebar.baseName = basename(opened.base);
      this.explorer.setBase(opened.base);
      this.search.base = opened.base;
      this.scanInfo = 'scanning…';
      this.repos = opened.repos.map((r) => ({ ...r }));
      for (const s of opened.statuses) this.onStatus(s.repo, 'status' in s ? s.status : undefined, 'error' in s ? s.error : undefined);
      this.sidebar.repos = this.repos;
      this.sidebar.render();
      this.renderStatusbar();
      this.showWelcome();
      this.sidebar.focus();
      this.editors.load().catch((e) => this.toast(String(e.message ?? e)));
      this.log('workspaceOpened', { repos: this.repos.length });
      const agents = await this.t.request<{ shell: string; agents: { name: string; command: string[]; path: string | null }[] }>('agents');
      await this.terminals.configure(opened.settings, agents.shell, agents.agents);
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
      this.explorer.setRepos(this.repos);
      if (this.search.repos.length !== this.repos.length) {
        this.search.repos = this.repos;
        this.search.renderScope();
      }
      this.log('statusRendered', { repos: changed });
      this.refreshOpenDiff(changed);
    });
  }

  /** The open diff follows the file: refreshed in place, or cleared once the file has no changes. */
  private refreshOpenDiff(changedRepos: string[]): void {
    const target = this.diff.target;
    const key = this.docs.active?.key;
    if (this.mode !== 'diff' || !target || target.kind === 'commit' || !key?.startsWith('diff:') || !changedRepos.includes(target.repo)) return;
    this.showItem(key.slice(5), undefined, true);
  }

  /** Opens an item's diff in the preview tab, or in a tab of its own with `pin`. */
  private openItem(item: Item, pin = false): void {
    const kind = item.target.kind;
    this.docs.open({
      key: `diff:${item.key}`,
      kind: 'diff',
      title: basename(item.entry.path),
      detail: `${this.name(item.repo)}${kind === 'staged' ? ' · staged' : kind === 'conflict' ? ' · conflict' : ''}`,
      tooltip: `${this.name(item.repo)} › ${item.entry.path}`,
      show: (saved) => this.showItem(item.key, saved),
    }, pin);
  }

  /** Draws the diff for a sidebar key, as the file stands now. */
  private showItem(key: string, saved?: unknown, keepView = false): void {
    this.setMode('diff');
    const item = this.sidebar.resolve(key);
    if (!item) {
      this.sidebar.mark(null);
      this.diff.clear(`${key.split('\x1f')[2] ?? 'This file'} has no more changes here.`);
      return;
    }
    this.sidebar.mark(key);
    const { prev, next } = this.sidebar.neighbours();
    const r = item.repo;
    const worktree = item.target.right?.rev === 'worktree' ? item.target.right.path : null;
    this.diff.show(item.target, {
      repoName: this.name(r),
      file: worktree ? this.join(r.root, worktree) : undefined,
      prev: prev ? () => this.sidebar.step(-1) : undefined,
      next: next ? () => this.sidebar.step(1) : undefined,
    }, keepView, saved).catch((e) => this.toast(String(e.message ?? e)));
  }

  private openCommitDiff(target: DiffTarget, repo: Repo): void {
    this.docs.open({
      key: `commit:${repo.root}\x1f${target.hash}\x1f${target.path}`,
      kind: 'diff',
      title: basename(target.path),
      detail: `${this.name(repo)} @ ${target.hash?.slice(0, 7)}`,
      tooltip: `${this.name(repo)} › ${target.path} in commit ${target.hash?.slice(0, 7)}`,
      show: (saved) => {
        this.setMode('diff');
        this.diff.show(target, { repoName: this.name(repo), back: () => this.showHistory(repo) }, false, saved)
          .catch((e) => this.toast(String(e.message ?? e)));
      },
    });
  }

  private showHistory(r: Repo): void {
    this.docs.open({
      key: `history:${r.root}`,
      kind: 'history',
      title: 'History',
      detail: this.name(r),
      tooltip: `The commits of ${this.name(r)}`,
      show: () => {
        this.historyRepo = r;
        this.setMode('history');
        this.history.show(r).catch((e) => this.toast(String(e.message ?? e)));
      },
    });
  }

  private setMode(mode: App['mode']): void {
    if (this.terminals && !this.terminals.reviewActive) this.terminals.select(null);
    if (this.mode === mode) return;
    this.mode = mode;
    const view = mode === 'diff' ? this.diff.el : mode === 'history' ? this.history.el : mode === 'file' ? this.viewer.el : this.welcome();
    this.review.replaceChildren(view);
  }

  /** Opens a file in the preview tab (or its own with `pin`), at `reveal` if given. */
  private openFile(path: string, reveal?: Reveal, pin = false): void {
    const rel = this.relative(path).replaceAll('\\', '/');
    this.docs.open({
      key: `file:${path}`,
      kind: 'file',
      title: basename(path),
      detail: dirname(rel),
      tooltip: rel,
      show: (saved) => {
        this.setMode('file');
        // A reveal applies when the file is opened, not when its tab is shown again.
        this.viewer.show(path, false, saved === undefined ? reveal : undefined, saved ?? undefined)
          .catch((e) => this.toast(String(e.message ?? e)));
      },
    }, pin);
  }

  private join(root: string, rel: string): string {
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    return root + sep + rel.replaceAll('/', sep);
  }

  /** A path relative to the base folder, for display. */
  private relative(path: string): string {
    const base = this.opened?.base ?? '';
    return path.startsWith(base) ? path.slice(base.length).replace(/^[\\/]/, '') : path;
  }

  /** Where a new terminal can run: the repo of the selected file first, then the base folder and the rest. */
  private folders(): Folder[] {
    const base = this.opened?.base;
    const selected = this.diff.target?.repo;
    const repos = this.repos.filter((r) => r.root !== base).map((r) => ({ path: r.root, name: this.name(r) }));
    const all: Folder[] = [...(base ? [{ path: base, name: basename(base) }] : []), ...repos];
    const i = all.findIndex((f) => f.path === selected);
    if (i > 0) all.unshift(...all.splice(i, 1));
    return all;
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
      h('p', { class: 'dim' }, 'Select a file to see its diff; ↑ and ↓ move between files. A double click keeps a file open in its own tab.'));
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

  private renderStatusbar(): void {
    fill(this.statusbar,
      h('span', {}, this.opened?.base ?? ''),
      h('span', { class: 'dim' }, this.scanInfo),
      this.indexInfo ? h('span', { class: 'dim' }, this.indexInfo) : null,
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
    if (!this.terminals.reviewActive) this.terminals.select(null);
    this.mode = 'welcome';
    const input = h('input', { type: 'text', class: 'path', value: value ?? '', placeholder: '/path/to/your/base/folder', spellcheck: false });
    const submit = (e: Event) => {
      e.preventDefault();
      if (input.value.trim()) this.open(input.value.trim());
    };
    this.review.replaceChildren(h('form', { class: 'welcome', onsubmit: submit },
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

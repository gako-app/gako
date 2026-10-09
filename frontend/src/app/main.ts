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

import './style.css';

import { type Boot, boot } from '../boot';
import { connect, type Transport } from '../transport';
import { DiffPanel } from './diff';
import { basename, delay, fill, freeze, h } from './dom';
import { Git, type Opened } from './git';
import { HistoryPanel } from './history';
import type { DiffTarget, Repo, RepoInfo, Settings, Status } from './model';
import { type Item, Sidebar } from './sidebar';
import { type Folder, Terminals } from './terminals';
import { Explorer } from './explorer';
import { Viewer } from './viewer';
import { SettingsView } from './settingsview';
import { type Reveal, SearchView } from './search';
import { GoToFile } from './gotofile';
import { Navigator } from './navigate';
import type { FileContent } from './model';
import { Editors } from './editors';
import { type DocSpec, DocTabs } from './doctabs';
import type { Folder as TermFolder, Program } from './terminals';
import { Layout } from './layout';
import { Panes } from './panes';
import { installTooltips } from './tooltip';
import { icon } from './icons';
import { confirmAction } from './confirm';
import { showMenu } from './menu';
import { tabKey } from './tabkeys';

const LAST_BASE = 'gako.lastBase';
/** Settings the open folder was opened with: a change opens it again. */
const REPO_SETTINGS: (keyof Settings)[] = ['scanDepth', 'scanIgnore', 'extraFolders', 'maxGitProcesses', 'debounceMs', 'untrackedLimit', 'gitTimeoutSecs'];
/** The open tabs and terminals, per base folder: `gako.session:<base>`. */
const SESSION = 'gako.session:';

/** What reopens a tab after a restart. */
type Persist =
  | { diff: string }
  | { file: string }
  | { history: string }
  | { settings: true }
  | { commit: { root: string; target: DiffTarget } };

interface Session {
  docs: { persist: Persist; pinned: boolean }[];
  active: number;
  terms: { program: Program; folder: TermFolder }[];
  activeTerm: number;
}

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
  private mode: 'welcome' | 'diff' | 'history' | 'file' | 'settings' = 'welcome';
  private explorer: Explorer;
  private viewer: Viewer;
  private settingsView: SettingsView;
  private search: SearchView;
  private goto: GoToFile;
  private nav: Navigator;
  private indexInfo = '';
  private historyRepo: Repo | null = null;
  private editors: Editors;
  private docs: DocTabs;
  private layout: Layout;
  private panes: Panes;
  private openedAt = 0;
  /** Why the settings file can't be read, while it can't (the last good settings stay in use). */
  private settingsError: string | null = null;
  private log: (ev: string, data?: Record<string, unknown>) => void;

  constructor(private t: Transport, env: Record<string, string>, private pickFolder?: Boot['pickFolder'], private showAbout?: Boot['showAbout']) {
    this.git = new Git(t);
    this.log = env.GAKO_LOG
      ? (ev, data = {}) => t.send({ t: 'log', rec: { ev, epochMs: performance.timeOrigin + performance.now(), ...data } })
      : () => {};
    this.sidebar = new Sidebar({
      open: (item, pin) => this.openItem(item, pin),
      openFile: (item) => this.openFile(this.join(item.repo.root, item.entry.path)),
      openInEditor: (item) => this.editors.open({ path: this.join(item.repo.root, item.entry.path) }),
      editorLabel: () => this.editors.label(),
      revert: (item) => this.revertItem(item),
      branches: (r, at) => this.branchMenu(r, at),
      history: (r) => this.showHistory(r),
      remote: async (r, action, quiet) => {
        let error: string | null = null;
        try {
          await this.git.remote(r.root, action);
        } catch (e) {
          error = String((e as Error).message ?? e);
          if (!quiet) this.toast(error);
        }
        if (this.mode === 'history' && this.historyRepo?.root === r.root) this.history.refresh(r);
        return error;
      },
      toast: (m) => this.toast(m),
      // Asked before the layout exists (it comes later), the sidebar counts as shown.
      shown: () => !this.layout?.leftCollapsed,
      show: (shown) => this.layout.setLeftCollapsed(!shown),
    });
    this.editors = new Editors(t, (m) => this.toast(m));
    this.diff = new DiffPanel(this.git, this.editors, (spot) => this.openFile(spot.path, { line: spot.line ?? 1, columns: [], column: spot.column }));
    this.explorer = new Explorer(t, this.editors, (path, pin) => this.openFile(path, undefined, pin), (m) => this.toast(m), (path) => this.relative(path),
      (path) => this.diffOf(path));
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
      (path, raw) => this.t.request<FileContent>('fileRead', { path, raw: !!raw }),
      this.editors,
      (path) => this.relative(path),
      (path) => this.baseline(path),
      (path) => this.diffOf(path),
    );
    this.settingsView = new SettingsView(t, {
      pickFolder,
      editorSaved: () => this.editors.forget().catch((e) => this.toast(String(e.message ?? e))),
    });
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
    // The documents (their tabs, with the single/dual pane switch, over what's shown), and the
    // terminal pane beside them in the dual layout. Using either side gives it the keyboard's
    // shortcuts there.
    this.panes = new Panes(this.main, this.terminals);
    const docsCol = h('div', { class: 'docs-col' }, h('div', { class: 'main-top' }, this.docs.bar, this.panes.toggle), this.body);
    docsCol.addEventListener('mousedown', () => this.terminals.paneFocus(false));
    docsCol.addEventListener('focusin', () => this.terminals.paneFocus(false));
    this.main.append(docsCol, this.panes.handle, this.terminals.pane);
    const app = document.getElementById('app')!;
    this.layout = new Layout(app, this.sidebar.el, this.terminals);
    this.terminals.onCollapse = () => this.layout.apply();
    this.layout.onLeft = () => this.sidebar.renderRail();
    this.docs.onChange = () => this.saveSession();
    this.terminals.onChange = () => this.saveSession();
    // The last change before the window goes is saved at once.
    window.addEventListener('pagehide', () => this.saveSession(true));
    app.prepend(this.sidebar.rail, this.sidebar.el, this.main, this.terminals.el, this.statusbar, this.toasts);
    installTooltips();
    // Asked by the shell before the window closes (it warns when agents would be stopped). Only
    // information goes out this way; the frontend still calls no shell APIs.
    (window as unknown as { gakoRunning: () => string[] }).gakoRunning = () => this.terminals.running();
    // The main area stays empty until a folder is open (or the form to choose one is up): a welcome
    // for no folder in particular would only flash.
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
      else if (ev.t === 'settings') this.onSettings(ev.settings as Settings | undefined, ev.error);
      else if (ev.t === 'indexReady') {
        this.indexInfo = `${ev.symbols.toLocaleString()} symbols indexed`;
        this.log('indexReady', { files: ev.files, symbols: ev.symbols, ms: ev.ms });
        this.renderStatusbar();
      } else if (ev.t === 'scanDone') {
        this.onScanned?.();
        this.onScanned = null;
        // From asking for the workspace to every repo's status: discovery and the first scan.
        const sinceOpen = performance.now() - this.openedAt;
        this.scanInfo = `${ev.repos.toLocaleString()} repositor${ev.repos === 1 ? 'y' : 'ies'} scanned (${Math.round(sinceOpen).toLocaleString()} ms)`;
        this.log('scanDone', { ms: ev.ms, sinceOpenMs: sinceOpen, repos: ev.repos });
        this.renderStatusbar();
      }
    });
    // Measurements depend on drawing; the log records when the window is hidden (and stops drawing).
    document.addEventListener('visibilitychange', () => this.log('visibility', { state: document.visibilityState }));
    const mac = navigator.platform.startsWith('Mac');
    // Tab shortcuts (tabkeys.ts), caught before Monaco and xterm.js see them. They act on the file
    // tabs, or on the terminals when one is in front.
    document.addEventListener('keydown', (e) => {
      const inTerminal = !this.terminals.reviewActive;
      const action = tabKey(e, mac, inTerminal);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'close') {
        if (inTerminal) this.terminals.closeActive();
        else this.docs.closeActive();
      } else if (inTerminal) this.terminals.cycle(action === 'prev' ? -1 : 1);
      else this.docs.cycle(action === 'prev' ? -1 : 1);
    }, true);
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
        if (e.key === ',' && !e.shiftKey) {
          e.preventDefault();
          this.showSettings();
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
        // Find in the file or diff in front from anywhere else (the sidebar, say); in an editor,
        // Monaco takes it first.
        if (e.key.toLowerCase() === 'f' && !e.shiftKey && !inTerminal && this.terminals.reviewActive
          && !(e.target as HTMLElement).closest?.('.monaco-editor')) {
          const found = this.mode === 'file' ? this.viewer.find() : this.mode === 'diff' ? this.diff.find() : false;
          if (found) e.preventDefault();
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

  /** Opens a folder. `again`: the folder open now, opened again for new settings, keeping what's
   * showing. */
  async open(base?: string, again = false): Promise<void> {
    let cover: (() => void) | null = null;
    try {
      this.openedAt = performance.now();
      this.scanned = new Promise((resolve) => { this.onScanned = resolve; });
      const opened = await this.git.open(base);
      this.opened = opened;
      this.settingsError = null;
      try { localStorage.setItem(LAST_BASE, opened.base); } catch { /* storage unavailable */ }
      document.title = `${basename(opened.base)} — Gako`;
      this.sidebar.baseName = basename(opened.base);
      this.explorer.setBase(opened.base);
      this.search.base = opened.base;
      this.viewer.configure(opened.settings);
      this.diff.configure(opened.settings);
      this.scanInfo = 'Scanning…';
      this.repos = opened.repos.map((r) => ({ ...r }));
      for (const s of opened.statuses) this.onStatus(s.repo, 'status' in s ? s.status : undefined, 'error' in s ? s.error : undefined);
      this.sidebar.repos = this.repos;
      this.sidebar.render();
      this.renderStatusbar();
      // Only into an empty window: opening another folder keeps what's open.
      const session = !again && this.terminals.snapshot().terms.length === 0 && this.docs.snapshot().docs.length === 0
        ? this.savedSession() : null;
      // A terminal coming back in front: the main area stays as it was (covered) until it's there,
      // rather than show the welcome on the way.
      const activeTerm = session?.activeTerm ?? -1;
      if (session && activeTerm >= 0 && activeTerm < (session.terms ?? []).length) cover = freeze(this.body);
      // What a session brings back takes the welcome's place: it's shown only if nothing comes back
      // (see restoreSession), rather than for the moment it takes.
      const restoring = !!session && ((session.docs ?? []).length > 0 || (session.terms ?? []).length > 0);
      if (!again) {
        if (!restoring) this.showWelcome();
        this.sidebar.focus();
      }
      this.editors.load().catch((e) => this.toast(String(e.message ?? e)));
      this.log('workspaceOpened', { repos: this.repos.length });
      await this.loadAgents(opened.settings);
      if (session) await this.restoreSession(session, cover);
      else cover?.();
    } catch (e) {
      cover?.();
      const message = String((e as Error).message ?? e);
      if (again) {
        this.toast(message);
        return;
      }
      // Nothing to open yet (no folder given, none in the settings) is a first run, not an error.
      this.showOpenForm(base, base || this.opened || !message.startsWith('no base folder') ? message : undefined);
    }
  }

  /** The agents offered for new terminals: the settings' list, and which of them are installed. */
  private async loadAgents(settings: Settings): Promise<void> {
    const agents = await this.t.request<{ shell: string; agents: { name: string; command: string[]; path: string | null }[] }>('agents');
    await this.terminals.configure(settings, agents.shell, agents.agents);
  }

  /** The settings file changed (or can't be read). What can change at once does; a repository
   * setting opens the folder again; the rest applies to terminals opened from now on. */
  private onSettings(settings: Settings | undefined, error: string | undefined): void {
    this.settingsError = error ?? null;
    this.renderStatusbar();
    this.settingsView.refresh().catch(() => { /* shown again when its tab is */ });
    const opened = this.opened;
    // With no folder open, opening one reads the file.
    if (!settings || !opened) return;
    const before = opened.settings;
    const changed = (keys: (keyof Settings)[]) => keys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k]));
    if (changed(REPO_SETTINGS)) {
      this.open(opened.base, true);
      return;
    }
    opened.settings = settings;
    this.viewer.configure(settings);
    this.diff.configure(settings);
    this.terminals.applySettings(settings);
    if (changed(['agents'])) this.loadAgents(settings).catch((e) => this.toast(String(e.message ?? e)));
    if (changed(['editor'])) this.editors.load().catch((e) => this.toast(String(e.message ?? e)));
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
      // A commit (or an agent's edit) changes what the open file's markers compare against.
      const open = this.viewer.path;
      if (this.mode === 'file' && open && changed.some((root) => this.repoOf(open)?.root === root)) this.viewer.refreshMarkers();
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
    this.docs.open(this.diffSpec(item), pin);
  }

  private diffSpec(item: Item): DocSpec {
    const kind = item.target.kind;
    return {
      key: `diff:${item.key}`,
      kind: 'diff',
      title: basename(item.entry.path),
      detail: '',
      tooltip: `${this.name(item.repo)}/${item.entry.path}${kind === 'staged' ? ' (staged)' : kind === 'conflict' ? ' (conflict)' : ''}`,
      show: (saved, front) => this.showItem(item.key, saved, false, front),
      persist: { diff: item.key } satisfies Persist,
    };
  }

  /** Draws the diff for a sidebar key, as the file stands now: in place with `keepView` (the file
   * changed), else as a view of its own. */
  private showItem(key: string, saved?: unknown, keepView = false, front = true): void {
    const item = this.sidebar.resolve(key);
    if (!item) {
      this.sidebar.mark(null);
      const message = `${key.split('\x1f')[2] ?? 'This file'} has no more changes here.`;
      this.present('diff', async () => this.diff.clear(message), front);
      return;
    }
    this.sidebar.mark(key);
    const { prev, next } = this.sidebar.neighbours();
    const r = item.repo;
    const worktree = item.target.right?.rev === 'worktree' ? item.target.right.path : null;
    const show = () => this.diff.show(item.target, {
      repoName: this.name(r),
      file: worktree ? this.join(r.root, worktree) : undefined,
      revert: item.target.kind === 'conflict' ? undefined : () => this.revertItem(item),
      prev: prev ? () => this.sidebar.step(-1) : undefined,
      next: next ? () => this.sidebar.step(1) : undefined,
    }, keepView, saved);
    if (keepView) show().catch((e) => this.toast(String(e.message ?? e)));
    else this.present('diff', show, front);
  }

  /** Throws away the changes an item shows, as VS Code's "Discard Changes" does, once confirmed. */
  private async revertItem(item: Item): Promise<void> {
    const group = item.key.split('\x1f')[1];
    if (group !== 'changes' && group !== 'untracked' && group !== 'staged') return;
    const e = item.entry;
    const name = basename(e.path);
    const message = group === 'untracked'
      ? `${e.path} isn't tracked by Git, so reverting it deletes it. This can't be undone.`
      : group === 'changes'
        ? `The changes to ${e.path}${e.index ? ' that aren\'t staged' : ''} will be lost: it goes back to ${e.index ? 'its staged version' : 'the last commit'}. This can't be undone.`
        : e.index === 'added'
          ? `${e.path} is new, so reverting it unstages and deletes it. This can't be undone.`
          : `The staged changes to ${e.path}, and any made since, will be lost: it goes back to the last commit${e.origPath ? `, under its old name ${e.origPath}` : ''}. This can't be undone.`;
    if (!await confirmAction(group === 'untracked' ? `Delete ${name}?` : `Revert ${name}?`, message, group === 'untracked' ? 'Delete' : 'Revert')) return;
    await this.act(() => this.git.revert(item.repo.root, group, e.path, e.origPath));
  }

  /** The repo's branches in a menu; picking one switches to it (a remote one gets a local branch
   * tracking it). Git refuses if uncommitted changes would be overwritten, and the toast says so. */
  private async branchMenu(r: Repo, at: HTMLElement): Promise<void> {
    let b: { local: string[]; remote: string[] };
    try {
      b = await this.git.branches(r.root);
    } catch (e) {
      this.toast(String((e as Error).message ?? e));
      return;
    }
    const current = r.status?.branch ?? null;
    const go = async (branch: string, remote: boolean) => {
      if (branch === current) return;
      await this.act(() => this.git.switch(r.root, branch, remote));
      if (this.mode === 'history' && this.historyRepo?.root === r.root) this.history.refresh(r);
    };
    showMenu(at, [
      ...b.local.map((name) => ({ label: name, checked: name === current, run: () => go(name, false) })),
      ...(b.remote.length ? ['separator' as const, ...b.remote.map((name) => ({ label: name, title: `A new branch tracking ${name}`, run: () => go(name, true) }))] : []),
    ]);
  }

  private openCommitDiff(target: DiffTarget, repo: Repo): void {
    this.docs.open(this.commitSpec(target, repo));
  }

  private commitSpec(target: DiffTarget, repo: Repo): DocSpec {
    return {
      key: `commit:${repo.root}\x1f${target.hash}\x1f${target.path}`,
      kind: 'diff',
      title: basename(target.path),
      detail: '',
      tooltip: `${this.name(repo)}/${target.path} in commit ${target.hash?.slice(0, 7)}`,
      show: (saved, front) => this.present('diff',
        () => this.diff.show(target, { repoName: this.name(repo), back: () => this.showHistory(repo) }, false, saved), front),
      persist: { commit: { root: repo.root, target } } satisfies Persist,
    };
  }

  private showHistory(r: Repo): void {
    this.docs.open(this.historySpec(r));
  }

  private historySpec(r: Repo): DocSpec {
    return {
      key: `history:${r.root}`,
      kind: 'history',
      title: 'History',
      detail: this.name(r),
      tooltip: `The commits of ${this.name(r)}`,
      show: (_saved, front) => {
        this.historyRepo = r;
        this.present('history', () => this.history.show(r), front);
      },
      persist: { history: r.root } satisfies Persist,
    };
  }

  /** The settings screen, in a tab of its own. */
  showSettings(): void {
    this.docs.open(this.settingsSpec(), true);
  }

  private settingsSpec(): DocSpec {
    return {
      key: 'settings',
      kind: 'settings',
      title: 'Settings',
      detail: '',
      tooltip: 'Your settings, for every folder',
      show: (_saved, front) => this.present('settings', () => this.settingsView.show(), front),
      persist: { settings: true } satisfies Persist,
    };
  }

  /** Shows a view in the main area once it's ready, so none of its in-between states are seen: what
   * was on screen stays, as a still copy, while `load` puts the view together underneath (behind a
   * terminal that's in front, the view is put together out of sight). A load that takes long shows the
   * view as it is by then (its header, and an empty editor) rather than keep the old one up.
   * `front`: bring the documents in front of a terminal once it's ready. */
  private present(mode: App['mode'], load?: () => Promise<unknown>, front = true): void {
    const ticket = ++this.presenting;
    if (!this.cover && !this.review.hidden) this.cover = freeze(this.shownView() ?? this.review);
    this.setMode(mode);
    let shown = false;
    const show = () => {
      if (shown || ticket !== this.presenting) return;
      shown = true;
      if (front && !this.terminals.reviewActive) this.terminals.select(null);
      this.cover?.();
      this.cover = null;
    };
    const ready = load ? load().catch((e) => this.toast(String((e as Error).message ?? e))) : Promise.resolve();
    Promise.race([ready, delay(250)]).then(show);
  }

  private presenting = 0;
  /** Removes the still copy over the main area, while there is one. */
  private cover: (() => void) | null = null;

  private setMode(mode: App['mode']): void {
    if (this.mode === mode) return;
    this.mode = mode;
    const view = mode === 'diff' ? this.diff.el : mode === 'history' ? this.history.el : mode === 'file' ? this.viewer.el
      : mode === 'settings' ? this.settingsView.el : this.welcome();
    this.showView(view);
  }

  /** Brings `view` to the front of the main area. The panels stay in place once added, stacked, with
   * only the one in front visible (and the rest inert): taken out and put back, a Monaco editor would
   * lay itself out again, a frame late, and show its scrollbars. The welcome and the open-folder
   * form are made afresh each time, and go when something else comes to the front. */
  private showView(view: HTMLElement): void {
    if (view.parentElement !== this.review) this.review.append(view);
    for (const v of [...this.review.children] as HTMLElement[]) {
      const shown = v === view;
      if (!shown && v.classList.contains('transient')) {
        v.remove();
        continue;
      }
      v.classList.toggle('shown', shown);
      v.inert = !shown;
    }
  }

  /** The view in front of the main area. */
  private shownView(): HTMLElement | null {
    return this.review.querySelector(':scope > .shown');
  }

  /** Opens a file in the preview tab (or its own with `pin`), at `reveal` if given. */
  private openFile(path: string, reveal?: Reveal, pin = false): void {
    this.docs.open(this.fileSpec(path, reveal), pin);
  }

  private fileSpec(path: string, reveal?: Reveal): DocSpec {
    const rel = this.relative(path).replaceAll('\\', '/');
    return {
      key: `file:${path}`,
      kind: 'file',
      title: basename(path),
      detail: '',
      tooltip: rel,
      // A reveal applies when the file is opened, not when its tab is shown again.
      show: (saved, front) => this.present('file',
        () => this.viewer.show(path, false, saved === undefined ? reveal : undefined, saved ?? undefined), front),
      persist: { file: path } satisfies Persist,
    };
  }

  /** A tab from its note, if what it showed is still there (a diff needs its file still changed). */
  private specFor(p: Persist): DocSpec | null {
    const repo = (root: string) => this.repos.find((r) => r.root === root);
    if ('diff' in p) {
      const item = this.sidebar.resolve(p.diff);
      return item ? this.diffSpec(item) : null;
    }
    if ('file' in p) return this.fileSpec(p.file);
    if ('settings' in p) return this.settingsSpec();
    if ('history' in p) {
      const r = repo(p.history);
      return r ? this.historySpec(r) : null;
    }
    const r = repo(p.commit.root);
    return r ? this.commitSpec(p.commit.target, r) : null;
  }

  /** Resolved by the first full scan of the open workspace, when every repo's status is known. */
  private scanned: Promise<void> = Promise.resolve();
  private onScanned: (() => void) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoring = false;

  /** Saves the open tabs and terminals for this base folder, soon (changes come in bursts). */
  private saveSession(now = false): void {
    if (this.restoring || !this.opened) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const save = () => {
      const docs = this.docs.snapshot();
      const terms = this.terminals.snapshot();
      const session: Session = { docs: docs.docs as Session['docs'], active: docs.active, terms: terms.terms, activeTerm: terms.active };
      try { localStorage.setItem(SESSION + this.opened!.base, JSON.stringify(session)); } catch { /* storage unavailable */ }
    };
    if (now) save();
    else this.saveTimer = setTimeout(save, 400);
  }

  /** Reopens the tabs and terminals this base folder had last time: terminals start the same
   * program in the same folder, as a new session. */
  private savedSession(): Session | null {
    try { return JSON.parse(localStorage.getItem(SESSION + this.opened!.base) ?? 'null'); } catch { return null; }
  }

  /** `cover`: what already covers the main area, if anything; removed once the terminals are back. */
  private async restoreSession(session: Session, cover: (() => void) | null): Promise<void> {
    this.restoring = true;
    try {
      // Terminals start at once; tabs wait for the first scan, since a diff tab comes back only if
      // its file still has changes. A scan that takes long doesn't hold them back for ever. Each
      // terminal comes to the front while it starts (so it starts at the window's size): the main
      // area is covered meanwhile with what it showed, so they don't flash past.
      const activeTerm = session.activeTerm ?? -1;
      const terminalInFront = activeTerm >= 0 && activeTerm < (session.terms ?? []).length;
      const thaw = cover ?? freeze(this.body);
      const terms = this.terminals.restore(session.terms ?? [], activeTerm);
      Promise.race([terms, delay(1500)]).finally(thaw);
      // The main area is empty until the tabs are back; a scan that takes long shows the welcome
      // meanwhile, rather than nothing.
      let docsBack = false;
      const slow = setTimeout(() => { if (!docsBack && !terminalInFront) this.showWelcome(); }, 1000);
      await Promise.race([this.scanned, delay(10_000)]);
      docsBack = true;
      clearTimeout(slow);
      const docs = (session.docs ?? []).flatMap(({ persist, pinned }) => {
        const spec = this.specFor(persist);
        return spec ? [{ spec, pinned }] : [];
      });
      // Behind the terminal that was in front, if one was.
      if (docs.length) this.docs.restore(docs, Math.max(0, session.active), !terminalInFront);
      // Nothing to show where the documents go (no tab came back): the welcome, behind the terminal
      // in front if there is one.
      else this.showWelcome(!terminalInFront);
      await terms;
    } finally {
      this.restoring = false;
    }
    this.saveSession();
  }

  /** The repo a path is in: the one with the longest root that contains it. */
  private repoOf(path: string): Repo | undefined {
    let best: Repo | undefined;
    for (const r of this.repos) {
      const inside = path === r.root || path.startsWith(r.root + '/') || path.startsWith(r.root + '\\');
      if (inside && (!best || r.root.length > best.root.length)) best = r;
    }
    return best;
  }

  /** What opens the diff of a file with changes, null if it has none: its conflict, else its
   * changes not staged (or untracked), else its staged ones, as the Repositories view lists them. */
  private diffOf(path: string): (() => void) | null {
    const r = this.repoOf(path);
    if (!r?.status) return null;
    const rel = path.slice(r.root.length + 1).replaceAll('\\', '/');
    const e = r.status.entries.find((x) => x.path === rel);
    if (!e) return null;
    const group = e.conflict ? 'conflicts' : e.worktree ? 'changes' : e.untracked ? 'untracked' : 'staged';
    const key = `${r.root}\x1f${group}\x1f${rel}`;
    return () => {
      const item = this.sidebar.resolve(key);
      if (item) this.openItem(item);
    };
  }

  /** What the viewer's change markers compare a file against: the file at HEAD ('' if it's new
   * or untracked), or null when it has no uncommitted changes. */
  private async baseline(path: string): Promise<string | null> {
    const r = this.repoOf(path);
    if (!r?.status) return null;
    const rel = path.slice(r.root.length + 1).replaceAll('\\', '/');
    const e = r.status.entries.find((x) => x.path === rel);
    if (!e || e.conflict) return null;
    if (e.untracked || e.index === 'added') return '';
    const head = await this.git.file(r.root, 'HEAD', e.origPath ?? rel);
    return head && !head.binary ? head.text : null;
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

  /** Where a new terminal can run: the base folder first (chosen by default), then its repositories,
   * marked as under it so that one named like it can't be taken for it. */
  private folders(): Folder[] {
    const base = this.opened?.base;
    if (!base) return [];
    const baseName = basename(base);
    const repos = this.repos.filter((r) => r.root !== base).map((r) => ({ path: r.root, name: this.name(r), base: baseName }));
    return [{ path: base, name: baseName }, ...repos];
  }

  /** `front`: bring the documents in front of a terminal to show it. */
  private showWelcome(front = true): void {
    this.mode = 'diff'; // force setMode to redraw
    this.present('welcome', undefined, front);
  }

  private welcome(): HTMLElement {
    const n = this.repos.length;
    return h('div', { class: 'centered transient' }, h('div', { class: 'welcome' },
      h('h1', {}, this.opened ? basename(this.opened.base) : 'Gako'),
      this.opened ? h('p', { class: 'dim' }, `${n} repositor${n === 1 ? 'y' : 'ies'} in ${this.opened.base}`) : null,
      h('p', { class: 'dim' }, 'Select a file to see its diff; ↑ and ↓ move between files. A double click keeps a file open in its own tab.')));
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
    const scanning = this.scanInfo === 'Scanning…';
    fill(this.statusbar,
      this.opened ? h('span', { class: 'status-item' }, icon('folder'), h('span', { class: 'status-text' }, this.opened.base)) : null,
      this.scanInfo ? h('span', { class: `status-item dim ${scanning ? 'spinning' : ''}` }, icon(scanning ? 'busy' : 'repos'), h('span', { class: 'status-text' }, this.scanInfo)) : null,
      this.indexInfo ? h('span', { class: 'status-item dim' }, icon('symbols'), h('span', { class: 'status-text' }, this.indexInfo)) : null,
      h('span', { class: 'spacer' }),
      this.settingsError ? h('button', { class: 'status-button warning', 'data-tip': this.settingsError, onclick: () => this.showSettings() },
        icon('warning'), 'Settings file has an error') : null,
      h('button', { class: 'status-button', onclick: () => this.chooseFolder() }, icon('folder-open'), 'Open folder…'),
      h('button', { class: 'status-button icon-only', 'data-tip': `Settings (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'},)`, 'aria-label': 'Settings', onclick: () => this.showSettings() }, icon('settings')),
      this.showAbout ? h('button', { class: 'status-button icon-only', 'data-tip': 'About Gako', 'aria-label': 'About Gako', onclick: () => this.showAbout?.() }, icon('info')) : null,
    );
  }

  private toast(message: string): void {
    const el = h('div', { class: 'toast', onclick: () => el.remove() }, message);
    this.toasts.append(el);
    setTimeout(() => el.remove(), 8000);
  }

  private formReturn: { mode: App['mode']; view: Element | null } | null = null;

  /** "Open folder…": the shell's native folder picker, or the form where one isn't available. */
  private async chooseFolder(): Promise<void> {
    if (!this.pickFolder) {
      this.showOpenForm(this.opened?.base);
      return;
    }
    try {
      const path = await this.pickFolder(this.opened?.base);
      if (path) await this.open(path);
    } catch (e) {
      this.toast(String((e as Error).message ?? e));
    }
  }

  /** Where a folder is chosen: at the first run, when one can't be opened, and in place of a
   * native picker. With the shell's picker it offers "Open folder…", and typing a path as a fallback;
   * in a plain browser, only the path. With a folder open, Cancel (or Escape) puts back what was
   * showing. */
  private showOpenForm(value?: string, error?: string): void {
    if (!this.terminals.reviewActive) this.terminals.select(null);
    // What Cancel goes back to: what was showing before the form (a form shown again after a
    // failed open keeps the first one's).
    const current = this.shownView();
    if (!current?.querySelector(':scope > .open-form')) this.formReturn = { mode: this.mode, view: current };
    const before = this.formReturn ?? { mode: 'welcome' as const, view: null };
    this.mode = 'welcome';
    const picker = !!this.pickFolder;
    const input = h('input', { type: 'text', class: 'path', value: value ?? '', placeholder: '/path/to/your/base/folder', spellcheck: false });
    const submit = (e: Event) => {
      e.preventDefault();
      if (input.value.trim()) this.open(input.value.trim());
    };
    const cancel = () => {
      if (this.shownView() !== host) return;
      if (before.mode === 'welcome' || !before.view) this.showWelcome();
      else {
        this.mode = before.mode;
        this.showView(before.view as HTMLElement);
      }
    };
    const browse = async () => {
      const path = await this.pickFolder?.(input.value.trim() || this.opened?.base).catch(() => null);
      if (path) this.open(path);
    };
    // With a picker, the path field shows only when asked for (or when a typed path failed).
    const typed = h('div', { class: 'path-row', hidden: picker && !error },
      input, h('button', { type: 'submit', class: picker ? '' : 'primary' }, 'Open'));
    const first = !this.opened && !error;
    const form: HTMLFormElement = h('form', {
      class: 'welcome open-form', onsubmit: submit,
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape' && this.opened) cancel(); },
    },
    h('h1', {}, first ? 'Welcome to Gako' : 'Open a folder'),
    h('p', { class: 'dim' }, 'Choose the folder that holds your repositories: Gako finds every Git repository inside it.'),
    error ? h('p', { class: 'error-box' }, error.charAt(0).toUpperCase() + error.slice(1)) : null,
    picker ? h('div', { class: 'form-buttons' },
      h('button', { type: 'button', class: 'primary', onclick: browse }, icon('folder-open'), 'Open folder…'),
      this.opened ? h('button', { type: 'button', onclick: cancel }, 'Cancel') : null,
      typed.hidden ? h('button', { type: 'button', class: 'link', onclick: (e: MouseEvent) => {
        typed.hidden = false;
        (e.currentTarget as HTMLElement).remove();
        input.focus();
      } }, 'or type its path') : null) : null,
    typed,
    !picker && this.opened ? h('div', { class: 'form-buttons' }, h('button', { type: 'button', onclick: cancel }, 'Cancel')) : null);
    const host = h('div', { class: 'centered transient' }, form);
    this.showView(host);
    if (!typed.hidden) input.focus();
    else (form.querySelector('button.primary') as HTMLElement | null)?.focus();
  }
}

async function main(): Promise<void> {
  // macOS draws its own slim scrollbars; elsewhere the styles draw them (style.css).
  document.documentElement.classList.toggle('mac', navigator.platform.startsWith('Mac'));
  const b = boot();
  const t = await connect(b);
  const hello = await t.request<{ env: Record<string, string> }>('hello');
  const app = new App(t, hello.env, b.pickFolder, b.showAbout);
  b.onShowSettings?.(() => app.showSettings());
  let last: string | undefined;
  try { last = localStorage.getItem(LAST_BASE) ?? undefined; } catch { /* storage unavailable */ }
  // The folder given on the command line, then the last one opened, then the settings file's.
  await app.open(hello.env.GAKO_BASE || last);
}

main().catch((e) => {
  document.body.textContent = String(e?.stack ?? e);
});

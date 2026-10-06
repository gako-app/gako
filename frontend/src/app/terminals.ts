// The agent bar, on the right: one entry per terminal (an agent or a shell) with its state, and the
// terminal itself shown in the main area when its entry is picked.
//
// A terminal runs a program (the shell, or a configured agent such as `claude`) in the base folder
// or one of its repos. Hidden terminals release their WebGL context (TerminalTab does that). An
// exited one keeps its output until it's closed or restarted.
//
// States: working, waiting for you, quiet, exited or failed (a non-zero exit code). An agent that
// shows its state in the terminal title (Claude Code, Codex: see agentstate.ts) is read from it;
// for the others, working means output in the last two seconds. A terminal that finishes a stretch
// of work, or starts waiting for you, while you aren't looking at it is marked until you do: its
// name turns bold and a blue mark appears.

import { type Renderer, TerminalTab } from '../terminal';
import type { CoreEvent, Transport } from '../transport';
import { h } from './dom';
import type { Settings } from './model';
import { readTitle, titleHasState, titleTopic } from './agentstate';
import { iconButton } from './icons';

export interface Program {
  name: string;
  /** Missing for the default shell. */
  cmd?: string[];
}

export interface Folder {
  path: string;
  name: string;
}

type State = 'working' | 'waiting' | 'quiet' | 'exited' | 'failed';

interface Tab {
  term: TerminalTab;
  program: Program;
  folder: Folder;
  banner: HTMLElement;
  state: State;
  /** When the current stretch of output started. */
  busySince: number;
  /** Finished something while nobody was looking. */
  unseen: boolean;
  /** The program shows its state in the title, so output alone doesn't mean working. */
  titled: boolean;
  /** The title last drawn. */
  shownTitle: string;
  /** When the last notification taken into account arrived. */
  noticeAt: number;
}

/** Output within this long counts as working. */
const WORKING_MS = 2000;
/** A stretch of output lasting this long after the user's last keystroke counts as work worth
 * flagging when it ends; shorter ones are redraws, or the echo of what was typed. */
const BUSY_MIN_MS = 1500;
const COLLAPSED = 'gako.agentsCollapsed';

export class Terminals {
  readonly el = h('aside', { class: 'agents' });
  private list = h('div', { class: 'agent-list' });
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private addButton = iconButton('plus', 'Start an agent or a shell', (e) => this.menu(e.currentTarget as HTMLElement), { class: 'add' });
  private collapseButton = h('span', { class: 'collapse' });
  private menuEl: HTMLElement | null = null;
  private programs: Program[] = [{ name: 'Shell' }];
  private settings: Settings | null = null;
  collapsed = false;
  /** Told when the bar collapses or expands, so the layout can follow. */
  onCollapse: (() => void) | null = null;

  constructor(
    private t: Transport,
    private body: HTMLElement,
    private review: HTMLElement,
    private folders: () => Folder[],
    private log: (ev: string, data?: Record<string, unknown>) => void,
    private onError: (message: string) => void,
    /** A terminal came to the front (true) or the documents did (false). */
    private onFront: (terminal: boolean) => void,
  ) {
    this.el.append(
      h('header', { class: 'agents-header' }, h('span', { class: 'agents-title' }, 'Agents'), h('span', { class: 'spacer' }), this.addButton, this.collapseButton),
      this.list);
    try { this.collapsed = localStorage.getItem(COLLAPSED) === '1'; } catch { /* storage unavailable */ }
    this.setCollapsed(this.collapsed);
    t.onEvent((ev: CoreEvent) => {
      if (ev.t !== 'exit') return;
      const tab = this.tabs.find((x) => x.term.id === ev.term);
      if (!tab) return;
      tab.term.onExit(ev);
      this.showBanner(tab);
      this.tick();
    });
    // Working and quiet are about time, so states are checked on a clock as well.
    setInterval(() => this.tick(), 500);
    // Looking at the window again counts as seeing the terminal in front.
    window.addEventListener('focus', () => {
      if (this.active?.unseen) {
        this.active.unseen = false;
        this.render();
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (this.menuEl && !this.menuEl.contains(e.target as Node)) this.closeMenu();
    });
  }

  /** Called once the workspace is open: the settings, and which agents are installed. */
  async configure(settings: Settings, shell: string, agents: { name: string; command: string[]; path: string | null }[]): Promise<void> {
    this.settings = settings;
    const shellName = shell.split(/[\\/]/).pop() ?? 'Shell';
    this.programs = [{ name: `Shell (${shellName})` }, ...agents.filter((a) => a.path).map((a) => ({ name: a.name, cmd: a.command }))];
  }

  /** True when the documents are in front, not a terminal. */
  get reviewActive(): boolean {
    return this.active === null;
  }

  async open(program: Program, folder: Folder): Promise<void> {
    const s = this.settings;
    const term = new TerminalTab(this.t, this.log, this.body, {
      title: program.name,
      scrollback: s?.terminalScrollback ?? 1000,
      renderer: (s?.terminalRenderer === 'dom' ? 'dom' : 'webgl') as Renderer,
      fontSize: s?.terminalFontSize,
      fontFamily: s?.terminalFontFamily,
      maxCombining: s?.terminalMaxCombining ?? 4,
      cmd: program.cmd,
      cwd: folder.path,
    });
    const banner = h('div', { class: 'term-banner', hidden: true });
    term.el.append(banner);
    const tab: Tab = { term, program, folder, banner, state: 'quiet', busySince: 0, unseen: false, titled: false, shownTitle: '', noticeAt: 0 };
    this.tabs.push(tab);
    // Shown before it starts, so the program starts at the size of the window.
    this.select(tab);
    try {
      await term.start();
    } catch (e) {
      this.onError(`Couldn't start ${program.name}: ${(e as Error).message ?? e}`);
      this.close(tab, true);
      return;
    }
    this.log('termOpened', { program: program.name, folder: folder.path, pid: term.pid });
    this.render();
  }

  /** Shows a terminal in the main area, or, with null, gives the main area back to the documents. */
  select(tab: Tab | null): void {
    const was = this.active;
    this.active?.term.hide();
    this.active = tab;
    this.review.hidden = tab !== null;
    if (tab) tab.unseen = false;
    tab?.term.show();
    if ((was === null) !== (tab === null)) this.onFront(tab !== null);
    this.render();
  }

  private close(tab: Tab, force = false): void {
    if (!force && !tab.term.exit && !confirm(`${tab.program.name} is still running in ${tab.folder.name}. Close it?`)) return;
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.term.close();
    if (this.active === tab) this.select(this.tabs[i] ?? this.tabs[i - 1] ?? null);
    this.render();
  }

  private restart(tab: Tab): void {
    this.close(tab, true);
    this.open(tab.program, tab.folder);
  }

  private showBanner(tab: Tab): void {
    const code = tab.term.exit?.code;
    tab.banner.hidden = false;
    tab.banner.replaceChildren(
      h('span', {}, `${tab.program.name} exited${code === null || code === undefined ? '' : ` with code ${code}`}.`),
      h('button', { onclick: () => this.restart(tab) }, 'Restart'),
      h('button', { onclick: () => this.close(tab, true) }, 'Close'),
    );
  }

  private stateOf(tab: Tab, now: number): State {
    const exit = tab.term.exit;
    if (exit) return exit.code ? 'failed' : 'exited';
    const title = tab.term.title;
    if (titleHasState(title)) tab.titled = true;
    let state: State;
    if (tab.titled) {
      const t = readTitle(title);
      state = t === 'idle' ? 'quiet' : t;
    } else {
      state = now - tab.term.lastOutputAt < WORKING_MS ? 'working' : 'quiet';
    }
    // A notification since the user last typed (Claude Code's approval requests come this way, see
    // agents.rs in the core) means it's waiting for them, until they type.
    const notice = tab.term.notice;
    if (state === 'quiet' && notice && notice.at > tab.term.lastInputAt) return 'waiting';
    return state;
  }

  /** Whether the user is looking at this terminal right now. */
  private watching(tab: Tab): boolean {
    return tab === this.active && document.hasFocus() && !document.hidden;
  }

  /** Updates states, flagging work that ended unwatched; redraws only when something changed. */
  private tick(): void {
    const now = performance.now();
    let changed = false;
    for (const tab of this.tabs) {
      const state = this.stateOf(tab, now);
      // A notification is the program asking for the user, whatever its state.
      const notice = tab.term.notice;
      if (notice && notice.at > tab.noticeAt) {
        tab.noticeAt = notice.at;
        if (!this.watching(tab)) tab.unseen = true;
        changed = true;
      }
      if (tab.term.title !== tab.shownTitle) {
        tab.shownTitle = tab.term.title;
        changed = true;
      }
      if (state === tab.state) continue;
      if (state === 'working') tab.busySince = tab.term.lastOutputAt;
      const worked = tab.term.lastOutputAt - Math.max(tab.busySince, tab.term.lastInputAt);
      const finished = (tab.state === 'working' && state === 'quiet' && worked >= BUSY_MIN_MS) ||
        state === 'waiting' || state === 'exited' || state === 'failed';
      if (finished && !this.watching(tab)) tab.unseen = true;
      tab.state = state;
      changed = true;
    }
    if (changed) this.render();
  }

  private stateText(tab: Tab): string {
    const code = tab.term.exit?.code;
    // A notification sent since the user last typed says best what the agent wants.
    const notice = tab.term.notice;
    if (notice && notice.at > tab.term.lastInputAt && tab.state !== 'working' && !tab.term.exit) return notice.text;
    switch (tab.state) {
      case 'working': return 'working';
      case 'waiting': return 'waiting for you';
      case 'quiet': return tab.unseen ? 'finished' : 'quiet';
      case 'exited': return 'exited';
      case 'failed': return `failed${code === null || code === undefined ? '' : ` (${code})`}`;
    }
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    try { localStorage.setItem(COLLAPSED, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
    this.el.classList.toggle('collapsed', collapsed);
    this.collapseButton.replaceChildren(collapsed
      ? iconButton('agents-show', 'Show the agent bar', () => this.setCollapsed(false), { class: 'bar-toggle' })
      : iconButton('agents-hide', 'Hide the agent bar', () => this.setCollapsed(true), { class: 'bar-toggle' }));
    this.onCollapse?.();
    this.render();
  }

  private render(): void {
    if (!this.tabs.length) {
      this.list.replaceChildren(this.collapsed ? '' : h('div', { class: 'agents-empty dim' },
        'No agents running. ', h('button', { class: 'link', onclick: (e: Event) => this.menu(e.currentTarget as HTMLElement) }, 'Start one…')));
      return;
    }
    this.list.replaceChildren(...this.tabs.map((tab) => h('div', {
      class: `agent ${tab === this.active ? 'active' : ''} ${tab.unseen ? 'unseen' : ''}`,
      'data-tip': `${tab.program.name} in ${tab.folder.path}: ${this.stateText(tab)}${tab.term.title ? `\n${tab.term.title}` : ''}`,
      onclick: () => this.select(tab),
    },
    h('span', { class: `dot ${tab.state}` }),
    this.collapsed
      ? h('span', { class: 'agent-initials' }, initials(tab.program.name))
      : h('span', { class: 'agent-text' },
        h('span', { class: 'agent-name' }, tab.program.name),
        h('span', { class: 'agent-detail' }, `${titleTopic(tab.term.title) || tab.folder.name} · ${this.stateText(tab)}`)),
    tab.unseen ? h('span', { class: 'unseen-mark' }) : null,
    this.collapsed ? null : h('span', { class: 'close', 'data-tip': 'Close', onclick: (e: Event) => { e.stopPropagation(); this.close(tab); } }, '×'))));
  }

  private menu(anchor: HTMLElement): void {
    if (this.menuEl) {
      this.closeMenu();
      return;
    }
    const folders = this.folders();
    let folder = folders[0];
    const folderList = h('div', { class: 'menu-list' });
    const drawFolders = () => folderList.replaceChildren(...folders.map((f) =>
      h('button', { class: `menu-item ${f === folder ? 'selected' : ''}`, title: f.path, onclick: () => { folder = f; drawFolders(); } }, f.name)));
    drawFolders();
    this.menuEl = h('div', { class: 'menu' },
      h('div', { class: 'menu-title' }, 'Run'),
      h('div', { class: 'menu-list' }, this.programs.map((p) => h('button', {
        class: 'menu-item', onclick: () => { this.closeMenu(); this.open(p, folder); },
      }, p.name))),
      h('div', { class: 'menu-title' }, 'In'),
      folderList);
    document.body.append(this.menuEl);
    // Opens leftwards from the bar's button, kept on screen.
    const r = anchor.getBoundingClientRect();
    const w = this.menuEl.getBoundingClientRect().width;
    this.menuEl.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    this.menuEl.style.top = `${r.bottom + 4}px`;
  }

  private closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }
}

/** "Claude Code" → "CC", "OpenCode" → "OC", "Codex" → "Co", "Shell (zsh)" → "Sh". */
function initials(name: string): string {
  const words = name.replace(/\(.*\)/g, '').trim().split(/\s+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : name.slice(0, 2);
}

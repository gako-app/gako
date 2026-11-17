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

// The agent bar, on the right: one entry per terminal (an agent or a shell) with its state, and the
// terminal itself shown when its entry is picked: in the main area, in place of the documents
// (single pane), or in a pane of its own beside them (dual pane, see panes.ts). In the dual layout
// the pane keeps showing the terminal last picked, and the pane last clicked or typed in decides
// what ⌘W and Ctrl+Tab act on. Entries can be dragged into a new order (reorder.ts), and a middle
// click closes one as its × does. Entries in the same list can be grouped from their context menu
// (groups.ts): a group is dragged as one, its entries within it, and it folds and is renamed from
// its header.
//
// An agent that Gako knows how to resume (see agents.rs in the core) starts on a session with an ID
// Gako picks, or tells Gako the one it picked (Codex); one that switches session inside the
// terminal (Claude Code's /resume) says so too, and is followed. Once the user has typed in it,
// reopening its terminal (a session restored, or Restart) resumes that session; one that fails at
// once, untouched, couldn't, and is started again on a new session.
//
// A terminal runs a program (the shell, or a configured agent such as `claude`) in the base folder,
// one of its repos, or a folder picked with "Other folder…" in the + menu (the last few picked are
// offered again). Terminals running outside the workspace (the base folder and its repos; picked
// so, or left from a base folder opened before) are listed apart, under "Other folders", each
// naming its folder. Which list an entry is in follows from its folder and the workspace open, so
// opening the earlier base folder again brings them back up. Hidden terminals release their WebGL context (TerminalTab does that). An
// exited one keeps its output until it's closed or restarted.
//
// States: working, waiting for you, quiet, exited or failed (a non-zero exit code). An agent that
// shows its state in the terminal title (Claude Code, Codex: see agentstate.ts) is read from it;
// for the others, working means output in the last two seconds. A terminal that finishes a stretch
// of work, or starts waiting for you, while you aren't looking at it is marked until you do: its
// name turns bold and a blue mark appears.

import { type Renderer, TerminalTab } from '../terminal';
import type { CoreEvent, Transport } from '../transport';
import { basename, fill, h, within } from './dom';
import type { Settings } from './model';
import { readTitle, titleHasState, titleTopic } from './agentstate';
import { chevron, icon, iconButton } from './icons';
import { Reorder } from './reorder';
import { dissolveSmall, groupName, join, leave, moveUnit, unitsOf } from './groups';
import { type MenuHeading, type MenuItem, showMenu } from './menu';

export interface Program {
  name: string;
  /** Missing for the default shell. */
  cmd?: string[];
  /** How its sessions are started and resumed; missing for a program Gako doesn't resume. */
  sessions?: Sessions;
}

/** As the core's `agents` request gives them (agents.rs): `{id}` in the arguments stands for the
 * session's ID. */
export interface Sessions {
  /** Starts the program on a session with the ID Gako picks; null: the program picks it. */
  session: string[] | null;
  /** Resumes it; null: `session` does. */
  resume: string[] | null;
  /** The program says which session it's on, and the terminal follows it: Codex, which picks its
   * own ID, and Claude Code, which can switch session (/resume, /clear). */
  follows: boolean;
}

/** An agent's session, and whether there's anything in it to resume: the user typed in its
 * terminal. */
export interface SessionRef {
  id: string;
  used: boolean;
}

export interface Folder {
  path: string;
  name: string;
  /** For a repository under the base folder, the base folder's name: the + menu shows the
   * repository indented beneath it, and everywhere else it's named in full ("projectX/A"). */
  base?: string;
  /** Picked with "Other folder…" (or from the ones picked before): its terminals are reopened
   * whatever base folder is open, not with one base folder's session. */
  custom?: boolean;
}

/** A folder's name in full: "projectX/A" for a repository under the base folder "projectX". */
function folderName(f: Folder): string {
  return f.base ? `${f.base}/${f.name}` : f.name;
}

/** A terminal's program, folder and agent session, as sessions keep them. */
export interface Saved {
  program: Program;
  folder: Folder;
  session?: SessionRef;
  /** The group it's in: `id` tells which of the terminals saved together share one. */
  group?: { id: number; name: string; folded?: boolean };
}

/** Terminals grouped in the bar: their members are next to each other in it (see groups.ts). */
interface Group {
  id: number;
  name: string;
  folded: boolean;
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
  /** The agent's session, if it's one Gako resumes and its ID is known. */
  session: SessionRef | null;
  /** Started by resuming its session, and when the program started. */
  resumed: boolean;
  startedAt: number;
  group: Group | null;
  /** The base folder it was started under, if it was: terminals left from the same one can be
   * grouped under "Other folders", as they come back up together. */
  home: string | null;
}

/** Output within this long counts as working. */
const WORKING_MS = 2000;
/** A stretch of output lasting this long after the user's last keystroke counts as work worth
 * flagging when it ends; shorter ones are redraws, or the echo of what was typed. */
const BUSY_MIN_MS = 1500;
/** An agent that fails this soon after it started resuming its session, untouched, couldn't
 * resume it. */
const RESUME_FAILED_MS = 10_000;
/** How long a click on a group's header waits for a second one (a rename) before folding it. */
const FOLD_WAIT_MS = 250;
const COLLAPSED = 'gako.agentsCollapsed';
const OTHERS_FOLDED = 'gako.otherFoldersFolded';
/** The folders last picked with "Other folder…", newest first. */
const RECENT = 'gako.recentFolders';
const RECENT_MAX = 5;

export class Terminals {
  readonly el = h('aside', { class: 'agents' });
  private list = h('div', { class: 'agent-list' });
  /** The terminals in the base folder, and those elsewhere (under "Other folders"); each is
   * reordered within itself. */
  private mainGroup = h('div', { class: 'agent-group' });
  private otherGroup = h('div', { class: 'agent-group' });
  private reorder = new Reorder(this.mainGroup, 'y', () => this.render());
  private otherReorder = new Reorder(this.otherGroup, 'y', () => this.render());
  private othersFolded = false;
  /** Each group's list of members, by group and list (a group is in one list, unless the base
   * folder changed under it), kept across redraws so a drag within it survives them. */
  private groupBodies = new Map<string, { el: HTMLElement; reorder: Reorder }>();
  private groupIds = 0;
  /** The group whose name is being edited: the bar isn't redrawn meanwhile. */
  private renaming: Group | null = null;
  /** A click on a group's header, waiting to see if it's a double click (see headerClick()). */
  private foldTimer: ReturnType<typeof setTimeout> | null = null;
  private recent: string[] = [];
  /** In the bar's order, which isn't the order of the lists shown: see ordered(). */
  private tabs: Tab[] = [];
  /** The terminal shown: in front of the documents (single pane; null while they're in front), or
   * in the terminal pane (dual pane). */
  private active: Tab | null = null;
  /** Single pane: the terminal last in front, shown in the pane when switching to dual. */
  private last: Tab | null = null;
  private dual = false;
  /** Dual pane: whether the terminal pane, not the documents, has the keyboard. */
  private termFocused = false;
  /** The terminal pane (dual pane only): a header naming what's shown, and the terminal. */
  readonly pane = h('section', { class: 'term-pane', hidden: true });
  private paneHeader = h('header', { class: 'term-pane-header' });
  private paneBody = h('div', { class: 'term-pane-body' });
  private paneEmpty = h('div', { class: 'term-pane-empty dim' }, 'Pick an agent in the agent bar, or start one with +.');
  /** Where terminals are drawn: the documents' area, or the terminal pane. */
  private host: HTMLElement;
  private addButton = iconButton('plus', 'Start an agent or a shell', (e) => this.menu(e.currentTarget as HTMLElement), { class: 'add' });
  private collapseButton = h('span', { class: 'collapse' });
  private menuEl: HTMLElement | null = null;
  private programs: Program[] = [{ name: 'Shell' }];
  private settings: Settings | null = null;
  collapsed = false;
  /** Told when the bar collapses or expands, so the layout can follow. */
  onCollapse: (() => void) | null = null;
  /** Told when terminals open, close or come to the front, so the session can be saved. */
  onChange: (() => void) | null = null;

  constructor(
    private t: Transport,
    private body: HTMLElement,
    private review: HTMLElement,
    private folders: () => Folder[],
    private log: (ev: string, data?: Record<string, unknown>) => void,
    private onError: (message: string) => void,
    /** A terminal came to the front (true) or the documents did (false). */
    private onFront: (terminal: boolean) => void,
    /** The shell's native folder picker, for "Other folder…" (none in a plain browser). */
    private pickFolder?: (defaultPath?: string) => Promise<string | null>,
  ) {
    this.host = body;
    this.paneBody.append(this.paneEmpty);
    this.pane.append(this.paneHeader, this.paneBody);
    // Clicking or typing in the pane gives it the keyboard's shortcuts.
    this.pane.addEventListener('focusin', () => this.paneFocus(true));
    this.pane.addEventListener('mousedown', () => this.paneFocus(true));
    this.el.append(
      h('header', { class: 'agents-header' }, h('span', { class: 'agents-title' }, 'Agents'), h('span', { class: 'spacer' }), this.addButton, this.collapseButton),
      this.list);
    try {
      this.collapsed = localStorage.getItem(COLLAPSED) === '1';
      this.othersFolded = localStorage.getItem(OTHERS_FOLDED) === '1';
      const recent = JSON.parse(localStorage.getItem(RECENT) ?? '[]');
      if (Array.isArray(recent)) this.recent = recent.filter((p) => typeof p === 'string').slice(0, RECENT_MAX);
    } catch { /* storage unavailable */ }
    this.setCollapsed(this.collapsed);
    t.onEvent((ev: CoreEvent) => {
      if (ev.t !== 'exit') return;
      const tab = this.tabs.find((x) => x.term.id === ev.term);
      if (!tab) return;
      tab.term.onExit(ev);
      if (this.resumeFailed(tab)) return;
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

  /** A lost connection is back: every terminal still running takes up where it left off. */
  async reattach(): Promise<void> {
    await Promise.all(this.tabs.map(async (tab) => {
      try {
        await tab.term.reattach();
        if (tab.term.exit) this.showBanner(tab);
      } catch (e) {
        this.onError(`Couldn't reconnect ${tab.program.name}: ${(e as Error).message ?? e}`);
      }
    }));
    this.tick();
  }

  /** Called once the workspace is open: the settings, and which agents are installed. */
  async configure(settings: Settings, shell: string, agents: { name: string; command: string[]; path: string | null; sessions: Sessions | null }[]): Promise<void> {
    this.applySettings(settings);
    const shellName = shell.split(/[\\/]/).pop() ?? 'Shell';
    this.programs = [{ name: `Shell (${shellName})` }, ...agents.filter((a) => a.path).map((a): Program => ({
      name: a.name, cmd: a.command, ...(a.sessions ? { sessions: a.sessions } : {}),
    }))];
  }

  /** New settings: open terminals take the font and copy on select now; scrollback, the renderer and the combining
   * limit apply to terminals opened from now on. */
  applySettings(settings: Settings): void {
    this.settings = settings;
    for (const tab of this.tabs) {
      tab.term.setFont(settings.terminalFontFamily, settings.terminalFontSize, settings.terminalFontLigatures);
      tab.term.copyOnSelect = settings.terminalCopyOnSelect;
    }
  }

  /** The base folder's terminals open (exited ones aren't kept), in the bar's order, and which one
   * is in front (-1: none). Those in other folders aren't the base folder's to reopen: see others(). */
  snapshot(): { terms: Saved[]; active: number } {
    const open = this.ordered().filter((t) => !t.term.exit && !t.folder.custom && this.inBase(t));
    return { terms: open.map((t) => this.saved(t)), active: this.active ? open.indexOf(this.active) : -1 };
  }

  /** The terminals open in folders picked with "Other folder…", reopened whatever base folder is. */
  others(): Saved[] {
    return this.ordered().filter((t) => !t.term.exit && t.folder.custom).map((t) => this.saved(t));
  }

  private saved(t: Tab): Saved {
    return {
      program: t.program, folder: t.folder, ...(t.session ? { session: t.session } : {}),
      ...(t.group ? { group: { id: t.group.id, name: t.group.name, folded: t.group.folded } } : {}),
    };
  }

  /** Starts the same programs again in the same folders, resuming agents' sessions; then shows the
   * one that was in front, or gives the main area back to the documents. -1 for `active` keeps
   * what was shown before. */
  async restore(terms: Saved[], active: number): Promise<void> {
    const was = this.active;
    const restored: (Tab | undefined)[] = [];
    const groups = new Map<number, Group>();
    const folds = new Map<Group, boolean>();
    for (const { program, folder, session, group } of terms) {
      let g: Group | null = null;
      if (group && typeof group.id === 'number' && typeof group.name === 'string') {
        g = groups.get(group.id) ?? { id: ++this.groupIds, name: group.name, folded: false };
        groups.set(group.id, g);
        folds.set(g, !!group.folded);
      }
      await this.open(this.current(program), folder, undefined, session ?? null, g);
      restored.push(this.tabs.at(-1));
    }
    // Folded only now: each terminal is shown as it starts, which would unfold its group.
    for (const [g, folded] of folds) g.folded = folded;
    // A group whose other members couldn't start, or had exited, is no more.
    dissolveSmall(this.tabs);
    this.select(active < 0 && was && this.tabs.includes(was) ? was : restored[active] ?? null);
  }

  /** Another base folder was opened, or its repositories changed: terminals outside it move under
   * "Other folders", and those back in it move up. */
  workspaceChanged(): void {
    this.render();
  }

  /** In the base folder or one of its repositories (which `extraFolders` can put elsewhere). With
   * no folder open yet, every terminal counts as in it. */
  private inBase(tab: Tab): boolean {
    const roots = this.folders().map((f) => f.path);
    return !roots.length || roots.some((root) => within(tab.folder.path, root));
  }

  /** The terminals in the order shown: the base folder's, then the others. */
  private ordered(): Tab[] {
    return [...this.tabs.filter((t) => this.inBase(t)), ...this.tabs.filter((t) => !this.inBase(t))];
  }


  /** The programs still running, as "Claude Code in projectX/gako", for the shell's question on quitting. */
  running(): string[] {
    return this.tabs.filter((t) => !t.term.exit).map((t) => `${t.program.name} in ${folderName(t.folder)}`);
  }

  /** True when the documents have the keyboard: in front (single pane), or the pane last used
   * (dual pane). */
  get reviewActive(): boolean {
    return this.dual ? !this.termFocused : this.active === null;
  }

  /** Dual pane: the terminal pane (true) or the documents (false) were clicked or typed in. */
  paneFocus(terminal: boolean): void {
    if (!this.dual || this.termFocused === terminal) return;
    this.termFocused = terminal && this.active !== null;
    this.render();
  }

  /** Switches between the single layout (terminals in front of the documents) and the dual one
   * (terminals in their own pane). The terminal that has the keyboard keeps it. */
  setDual(dual: boolean): void {
    if (dual === this.dual) return;
    const shown = this.active ?? this.last ?? this.tabs[0] ?? null;
    const terminalInFront = this.dual ? this.termFocused : this.active !== null;
    this.active?.term.hide();
    this.dual = dual;
    this.host = dual ? this.paneBody : this.body;
    for (const t of this.tabs) this.host.append(t.term.el);
    this.pane.hidden = !dual;
    if (dual) {
      this.review.hidden = false;
      this.active = shown;
      this.termFocused = terminalInFront && shown !== null;
      shown?.term.show(this.termFocused);
      this.onFront(false);
    } else {
      this.termFocused = false;
      this.active = terminalInFront ? shown : null;
      this.last = shown;
      this.review.hidden = this.active !== null;
      this.active?.term.show();
      this.onFront(this.active !== null);
    }
    this.render();
    this.onChange?.();
  }

  /** The program as the settings have it now, if they still do: how it resumes may have changed. */
  private current(program: Program): Program {
    return this.programs.find((p) => p.name === program.name && JSON.stringify(p.cmd) === JSON.stringify(program.cmd)) ?? program;
  }

  /** The arguments that start `program` on its session: resuming `session` if there's something in
   * it, otherwise on a new one. */
  private sessionArgs(program: Program, session: SessionRef | null): { args: string[]; session: SessionRef | null; resumed: boolean } {
    const known = program.sessions;
    if (!program.cmd || !known || this.settings?.agentResume === false) return { args: [], session: null, resumed: false };
    const fill = (args: string[], id: string) => args.map((a) => a.replaceAll('{id}', id));
    const resume = known.resume ?? known.session;
    if (session?.used && resume) return { args: fill(resume, session.id), session: { id: session.id, used: true }, resumed: true };
    // A program that picks its own ID says which once it has one.
    if (!known.session) return { args: [], session: null, resumed: false };
    const id = crypto.randomUUID();
    return { args: fill(known.session, id), session: { id, used: false }, resumed: false };
  }

  /** Starts `program` in `folder`, in a new entry at the end of the bar or at `at` (in `group`), on
   * `session` if it's an agent's to resume. */
  async open(program: Program, folder: Folder, at = this.tabs.length, session: SessionRef | null = null, group: Group | null = null): Promise<void> {
    const s = this.settings;
    const start = this.sessionArgs(program, session);
    const term = new TerminalTab(this.t, this.log, this.host, {
      title: program.name,
      scrollback: s?.terminalScrollback ?? 10_000,
      renderer: (s?.terminalRenderer === 'dom' ? 'dom' : 'webgl') as Renderer,
      fontSize: s?.terminalFontSize,
      fontFamily: s?.terminalFontFamily,
      fontLigatures: s?.terminalFontLigatures ?? false,
      maxCombining: s?.terminalMaxCombining ?? 4,
      copyOnSelect: s?.terminalCopyOnSelect ?? false,
      cmd: program.cmd && [...program.cmd, ...start.args],
      cwd: folder.path,
    });
    const banner = h('div', { class: 'term-banner', hidden: true });
    term.el.append(banner);
    const tab: Tab = {
      term, program, folder, banner, state: 'quiet', busySince: 0, unseen: false, titled: false, shownTitle: '', noticeAt: 0,
      session: start.session, resumed: start.resumed, startedAt: performance.now(), group, home: null,
    };
    const roots = this.folders();
    if (roots.length && this.inBase(tab)) tab.home = roots[0].path;
    this.tabs.splice(at, 0, tab);
    // Shown before it starts, so the program starts at the size of the window.
    this.select(tab);
    try {
      await term.start();
      tab.startedAt = performance.now();
    } catch (e) {
      this.onError(`Couldn't start ${program.name}: ${(e as Error).message ?? e}`);
      this.close(tab, true);
      return;
    }
    this.log('termOpened', { program: program.name, folder: folder.path, pid: term.pid });
    if (folder.custom) this.remember(folder.path);
    this.render();
    this.onChange?.();
  }

  /** Closes the terminal in front (⌘W), asking first if its program is still running. */
  closeActive(): void {
    if (this.active) this.close(this.active);
  }

  /** Shows the next (1) or previous (-1) terminal, wrapping round (Ctrl+Tab). */
  cycle(delta: number): void {
    const tabs = this.ordered();
    if (!tabs.length) return;
    const i = this.active ? tabs.indexOf(this.active) : -1;
    this.select(tabs[(i + delta + tabs.length) % tabs.length]);
  }

  /** Shows a terminal and gives it the keyboard; null gives the keyboard back to the documents
   * (bringing them to the front, in the single layout). */
  select(tab: Tab | null): void {
    const was = this.active;
    if (this.dual) {
      // The pane keeps its terminal while the documents have the keyboard.
      if (tab === null) {
        this.paneFocus(false);
        return;
      }
      if (was !== tab) was?.term.hide();
      this.unfold(tab);
      this.active = tab;
      this.termFocused = true;
      tab.unseen = false;
      tab.term.show();
      this.render();
      this.onChange?.();
      return;
    }
    if (was && !tab) this.last = was;
    this.unfold(tab);
    this.active?.term.hide();
    this.active = tab;
    this.review.hidden = tab !== null;
    if (tab) tab.unseen = false;
    tab?.term.show();
    if ((was === null) !== (tab === null)) this.onFront(tab !== null);
    this.render();
    this.onChange?.();
  }

  /** A terminal picked (Ctrl+Tab, say) in a folded group unfolds it. */
  private unfold(tab: Tab | null): void {
    if (tab?.group?.folded) tab.group.folded = false;
  }

  /** `replaced`: it's started again in its place (restarted), so its group stays even if it was
   * left with one member meanwhile. */
  private close(tab: Tab, force = false, replaced = false): void {
    if (!force && !tab.term.exit && !confirm(`${tab.program.name} is still running in ${folderName(tab.folder)}. Close it?`)) return;
    // The neighbour shown next is the one below it in the bar, or above.
    const shown = this.ordered();
    const i = shown.indexOf(tab);
    const next = shown[i + 1] ?? shown[i - 1] ?? null;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    if (!replaced) dissolveSmall(this.tabs);
    tab.term.close();
    if (this.last === tab) this.last = null;
    if (this.active === tab && this.dual) {
      // The pane shows the neighbour, or nothing; the keyboard stays where it was.
      this.active = next;
      if (next) next.term.show(this.termFocused);
      else this.termFocused = false;
    } else if (this.active === tab) this.select(next);
    this.render();
    this.onChange?.();
  }

  /** Starts an exited program again in its place in the bar, resuming its session. */
  private restart(tab: Tab): void {
    const at = this.tabs.indexOf(tab);
    this.close(tab, true, true);
    this.open(this.current(tab.program), tab.folder, at, tab.session, tab.group);
  }

  /** An agent that failed at once after resuming its session, before anyone typed in it, couldn't
   * resume it (there was nothing in it, or it's gone): it's started again on a new session, in its
   * place, keeping in front what was. */
  private resumeFailed(tab: Tab): boolean {
    if (!tab.resumed || !tab.term.exit?.code || tab.term.lastInputAt > 0 || performance.now() - tab.startedAt > RESUME_FAILED_MS) return false;
    const at = this.tabs.indexOf(tab);
    const was = this.active === tab ? null : this.active;
    const shown = this.active === tab;
    this.close(tab, true, true);
    this.onError(`${tab.program.name} couldn't resume its conversation in ${folderName(tab.folder)}, so it started a new one.`);
    this.open(this.current(tab.program), tab.folder, at, null, tab.group).then(() => {
      if (!shown) this.select(was);
    });
    return true;
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
      // There's something to resume once the user has typed; an agent that says which session
      // it's on (after its first turn, or whenever it switches) is followed there.
      const learned = tab.term.sessionId;
      if (learned && tab.program.sessions?.follows && tab.session?.id !== learned) {
        tab.session = { id: learned, used: true };
        this.onChange?.();
      }
      if (tab.session && !tab.session.used && tab.term.lastInputAt > 0) {
        tab.session.used = true;
        this.onChange?.();
      }
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

  /** The text selected in the terminal holding `el`; '' if none. */
  selectionAt(el: Element): string {
    return this.tabs.find((t) => t.term.el.contains(el))?.term.term.getSelection() ?? '';
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

  /** Dual pane: the pane's header names the terminal shown (and marks the pane that has the
   * keyboard); with none shown, the pane says how to show one. */
  private renderPane(): void {
    if (!this.dual) return;
    const tab = this.active;
    this.pane.classList.toggle('focused', this.termFocused);
    fill(this.paneHeader, tab
      ? [h('span', { class: `dot ${tab.state}` }), h('span', { class: 'term-pane-name' }, tab.program.name),
        h('span', { class: 'dim' }, `${titleTopic(tab.term.title) || folderName(tab.folder)} · ${this.stateText(tab)}`)]
      : h('span', { class: 'dim' }, 'No agent shown'));
    this.paneEmpty.hidden = tab !== null;
  }

  private render(): void {
    this.renderPane();
    if (!this.tabs.length) {
      // A stack, centred, that reads the same however narrow the bar is.
      this.list.replaceChildren(this.collapsed ? '' : h('div', { class: 'agents-empty' },
        icon('agent'),
        h('div', { class: 'agents-empty-title' }, 'No agents running'),
        h('div', { class: 'agents-empty-text' }, 'Start a coding agent or a shell in one of your repositories.'),
        h('button', { onclick: (e: Event) => this.menu(e.currentTarget as HTMLElement) }, icon('plus'), 'Start an agent')));
      return;
    }
    // Drawn again once the name is in, or a drag over.
    if (this.renaming) return;
    const reorders = [this.reorder, this.otherReorder, ...[...this.groupBodies.values()].map((b) => b.reorder)];
    if (!reorders.every((r) => r.canDraw())) return;
    const main = this.tabs.filter((t) => this.inBase(t));
    const others = this.tabs.filter((t) => !this.inBase(t));
    const used = new Set<string>();
    this.mainGroup.replaceChildren(...this.units(main, true, used));
    this.otherGroup.replaceChildren(...this.units(others, false, used));
    for (const key of this.groupBodies.keys()) if (!used.has(key)) this.groupBodies.delete(key);
    this.list.replaceChildren(this.mainGroup, others.length ? h('div', { class: `agent-others ${this.othersFolded ? 'folded' : ''}` },
      h('button', { class: 'group-toggle', onclick: () => this.foldOthers(!this.othersFolded) },
        chevron(!this.othersFolded), 'Other folders', h('span', { class: 'count' }, String(others.length))),
      this.otherGroup) : '');
  }

  private foldOthers(folded: boolean): void {
    this.othersFolded = folded;
    try { localStorage.setItem(OTHERS_FOLDED, folded ? '1' : '0'); } catch { /* storage unavailable */ }
    this.render();
  }

  /** One list's entries (`inBase`: the base folder's), each lone one or group dragged within it as
   * a unit; `used` collects the groups' keys drawn. */
  private units(list: Tab[], inBase: boolean, used: Set<string>): HTMLElement[] {
    const reorder = inBase ? this.reorder : this.otherReorder;
    const units = unitsOf<Group, Tab>(list);
    return units.map((unit) => {
      const el = unit[0].group ? this.groupBlock(unit[0].group, unit, inBase, used) : this.entry(unit[0], inBase);
      reorder.attach(el, (to) => this.moved(units, unit, to), el.querySelector<HTMLElement>(':scope > .agent-grp-header') ?? el);
      return el;
    });
  }

  /** A group: its header (dragged to move it, clicked to fold it, double-clicked to rename it), then its
   * members, dragged within it. With the bar collapsed, only a frame around the members. */
  private groupBlock(group: Group, members: Tab[], inBase: boolean, used: Set<string>): HTMLElement {
    const key = `${group.id}:${inBase}`;
    used.add(key);
    let body = this.groupBodies.get(key);
    if (!body) {
      const el = h('div', { class: 'agent-grp-body' });
      body = { el, reorder: new Reorder(el, 'y', () => this.render()) };
      this.groupBodies.set(key, body);
    }
    const singles = members.map((t) => [t]);
    const { reorder } = body;
    body.el.replaceChildren(...members.map((tab, i) => {
      const el = this.entry(tab, inBase);
      reorder.attach(el, (to) => this.moved(singles, singles[i], to));
      return el;
    }));
    const folded = group.folded && !this.collapsed;
    const unseen = members.some((t) => t.unseen);
    const header = h('div', {
      class: `agent-grp-header ${folded && members.includes(this.active!) ? 'active' : ''} ${folded && unseen ? 'unseen' : ''}`,
      'data-tip': `${group.name}: ${members.length} terminals. Click to fold, double-click to rename.`,
      onclick: (e: MouseEvent) => this.headerClick(e, group),
      oncontextmenu: (e: MouseEvent) => this.groupMenu(e, group),
    },
    h('button', { class: 'agent-grp-fold', onclick: (e: Event) => { e.stopPropagation(); this.fold(group, !group.folded); } }, chevron(!group.folded)),
    h('span', { class: 'agent-grp-name' }, group.name),
    // Folded, it still shows how its terminals are doing.
    folded ? h('span', { class: 'agent-grp-dots' }, ...members.map((t) => h('span', { class: `dot ${t.state}` }))) : null,
    h('span', { class: 'count' }, String(members.length)),
    folded && unseen ? h('span', { class: 'unseen-mark' }) : null);
    return h('div', { class: `agent-grp ${folded ? 'folded' : ''}`, 'data-group': String(group.id) }, header, body.el);
  }

  /** Moves `unit` to `to` among `units` (it was dragged there). */
  private moved(units: Tab[][], unit: Tab[], to: number): void {
    if (!unit.every((t) => this.tabs.includes(t))) return;
    moveUnit(this.tabs, units, unit, to);
    this.render();
    this.onChange?.();
  }

  /** A click on a group's header folds or unfolds it; a double click renames it instead. The fold
   * waits a moment for a second click. The header is drawn again after a fold, so it's the click's
   * count that tells a double click, not a dblclick event (which needs the same element twice). */
  private headerClick(e: MouseEvent, group: Group): void {
    if (this.renaming) return;
    if (e.detail >= 2) {
      if (this.foldTimer !== null) {
        clearTimeout(this.foldTimer);
        this.foldTimer = null;
      } else if (e.detail === 2) {
        // The second click came after the wait: the first one's fold is undone.
        this.fold(group, !group.folded);
      }
      if (e.detail === 2) this.rename(group);
      return;
    }
    if (this.foldTimer !== null) clearTimeout(this.foldTimer);
    this.foldTimer = setTimeout(() => {
      this.foldTimer = null;
      this.fold(group, !group.folded);
    }, FOLD_WAIT_MS);
  }

  private fold(group: Group, folded: boolean): void {
    group.folded = folded;
    this.render();
    this.onChange?.();
  }

  /** Whether `a` and `b` can be in a group: in the same list, and, under "Other folders", coming
   * back up together (from the same base folder, or in the same folder). */
  private canGroup(a: Tab, b: Tab): boolean {
    const inBase = this.inBase(a);
    if (inBase !== this.inBase(b)) return false;
    return inBase || a.folder.path === b.folder.path || (a.home !== null && a.home === b.home);
  }

  /** Groups were changed: one left with a single member is no more. */
  private regrouped(): void {
    dissolveSmall(this.tabs);
    this.render();
    this.onChange?.();
  }

  private entryMenu(e: MouseEvent, tab: Tab): void {
    e.preventDefault();
    const shown = this.ordered();
    const groups = [...new Set(shown.map((t) => t.group))]
      .filter((g): g is Group => !!g && g !== tab.group && this.canGroup(tab, shown.find((t) => t.group === g)!));
    const loners = tab.group ? [] : shown.filter((t) => t !== tab && !t.group && this.canGroup(tab, t));
    const toGroup = (g: Group): MenuItem => ({ label: g.name, run: () => {
      join(this.tabs, tab, g);
      this.regrouped();
    } });
    const items: (MenuItem | MenuHeading | 'separator')[] = [];
    // Entries that would read the same (two shells in one folder) are told apart by their place in
    // the bar.
    const label = (t: Tab) => `${t.program.name} · ${titleTopic(t.term.title) || folderName(t.folder)}`;
    const labels = loners.map(label);
    if (groups.length || loners.length) {
      items.push({ heading: tab.group ? 'Move to' : 'Group with' }, ...groups.map(toGroup), ...loners.map((t, i): MenuItem => ({
        label: labels.indexOf(labels[i]) !== labels.lastIndexOf(labels[i]) ? `${labels[i]} (${shown.indexOf(t) + 1})` : labels[i],
        title: `${t.program.name} in ${t.folder.path}`,
        run: () => {
          const g: Group = { id: ++this.groupIds, name: this.newGroupName(), folded: false };
          tab.group = g;
          join(this.tabs, t, g);
          this.regrouped();
        },
      })), 'separator');
    }
    if (tab.group) items.push({ label: 'Remove from group', run: () => { leave(this.tabs, tab); this.regrouped(); } }, 'separator');
    items.push({ label: 'Close', run: () => this.close(tab) });
    showMenu({ x: e.clientX, y: e.clientY }, items);
  }

  private groupMenu(e: MouseEvent, group: Group): void {
    e.preventDefault();
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'Rename', run: () => this.rename(group) },
      { label: 'Ungroup', run: () => {
        for (const t of this.tabs) if (t.group === group) t.group = null;
        this.regrouped();
      } },
      'separator',
      { label: 'Close all', run: () => this.closeGroup(group) },
    ]);
  }

  private newGroupName(): string {
    return groupName(this.tabs.flatMap((t) => (t.group ? [t.group.name] : [])));
  }

  /** Closes a group's terminals, asking first if any is still running. */
  private closeGroup(group: Group): void {
    const members = this.tabs.filter((t) => t.group === group);
    const running = members.filter((t) => !t.term.exit).length;
    if (running && !confirm(`${running === 1 ? 'A terminal' : `${running} terminals`} in ${group.name} ${running === 1 ? 'is' : 'are'} still running. Close ${members.length === 1 ? 'it' : 'them all'}?`)) return;
    for (const t of members) this.close(t, true);
  }

  /** Edits a group's name in its header: Enter or clicking away keeps it, Escape leaves it as it
   * was. */
  private rename(group: Group): void {
    if (this.renaming) return;
    this.render();
    const name = this.list.querySelector<HTMLElement>(`.agent-grp[data-group="${group.id}"] .agent-grp-name`);
    if (!name) return;
    this.renaming = group;
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (keep && value) group.name = value;
      this.renaming = null;
      this.render();
      if (keep && value) this.onChange?.();
    };
    const input = h('input', {
      class: 'agent-grp-input', value: group.name, spellcheck: 'false',
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      },
      onblur: () => finish(true),
      // Pressing in the field mustn't start a drag of the group.
      onpointerdown: (e: Event) => e.stopPropagation(),
    }) as HTMLInputElement;
    name.replaceWith(input);
    input.focus();
    input.select();
  }

  /** `inBase`: the entry is under the base folder; one elsewhere names its folder beside the program. */
  private entry(tab: Tab, inBase: boolean): HTMLElement {
    const topic = titleTopic(tab.term.title);
    const el = h('div', {
      class: `agent ${tab === this.active ? 'active' : ''} ${tab.unseen ? 'unseen' : ''}`,
      'data-tip': `${tab.program.name} in ${tab.folder.path}: ${this.stateText(tab)}${tab.term.title ? `\n${tab.term.title}` : ''}`,
      onclick: () => this.select(tab),
      onauxclick: (e: MouseEvent) => { if (e.button === 1) this.close(tab); },
      oncontextmenu: (e: MouseEvent) => this.entryMenu(e, tab),
    },
    h('span', { class: `dot ${tab.state}` }),
    this.collapsed
      ? h('span', { class: 'agent-initials' }, initials(tab.program.name))
      : h('span', { class: 'agent-text' },
        inBase
          ? h('span', { class: 'agent-name' }, tab.program.name)
          : h('span', { class: 'agent-name' }, tab.program.name, h('span', { class: 'agent-folder' }, icon('folder'), folderName(tab.folder))),
        h('span', { class: 'agent-detail' }, inBase
          ? `${topic || folderName(tab.folder)} · ${this.stateText(tab)}`
          : topic ? `${topic} · ${this.stateText(tab)}` : this.stateText(tab))),
    tab.unseen ? h('span', { class: 'unseen-mark' }) : null,
    !this.collapsed && tab.term.exit ? iconButton('restart', `Restart ${tab.program.name}`, () => this.restart(tab), { class: 'restart' }) : null,
    this.collapsed ? null : h('span', { class: 'close', 'data-tip': 'Close', onclick: (e: Event) => { e.stopPropagation(); this.close(tab); } }, icon('close')));
    return el;
  }

  /** Puts a picked folder first among the recent ones. */
  private remember(path: string): void {
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT, JSON.stringify(this.recent)); } catch { /* storage unavailable */ }
  }

  private forget(path: string): void {
    this.recent = this.recent.filter((p) => p !== path);
    try { localStorage.setItem(RECENT, JSON.stringify(this.recent)); } catch { /* storage unavailable */ }
  }

  private menu(anchor: HTMLElement): void {
    if (this.menuEl) {
      this.closeMenu();
      return;
    }
    const folders = this.folders();
    const custom = (path: string): Folder => ({ path, name: basename(path), custom: true });
    let folder: Folder | undefined = folders[0] ?? (this.recent.length ? custom(this.recent[0]) : undefined);
    const folderList = h('div', { class: 'menu-list' });
    const item = (f: Folder, ...content: (Node | string | null)[]) =>
      h('button', { class: `menu-item ${f.custom ? 'recent' : ''} ${f.path === folder?.path && !!f.custom === !!folder?.custom ? 'selected' : ''}`, title: f.path, onclick: () => { folder = f; drawFolders(); } }, ...content);
    const drawFolders = () => folderList.replaceChildren(
      ...folders.map((f) => item(f, f.base ? icon('nested') : null, f.name)),
      // The folders picked before, under a label of their own (a line would read as a new section),
      // then the picker.
      this.recent.length ? h('div', { class: 'menu-subtitle' }, 'Recent') : '',
      ...this.recent.map((path) => item(custom(path), icon('folder'), h('span', { class: 'menu-name' }, basename(path)),
        h('span', { class: 'menu-remove', 'data-tip': 'Remove from this list', onclick: (e: Event) => {
          e.stopPropagation();
          this.forget(path);
          if (folder?.custom && folder.path === path) folder = folders[0] ?? (this.recent.length ? custom(this.recent[0]) : undefined);
          drawFolders();
        } }, icon('close')))),
      this.pickFolder ? h('button', { class: 'menu-item', onclick: async () => {
        const path = await this.pickFolder?.(folder?.path).catch(() => null);
        if (!path) return;
        this.remember(path);
        folder = custom(path);
        drawFolders();
      } }, 'Other folder…') : '');
    drawFolders();
    this.menuEl = h('div', { class: 'menu' },
      h('div', { class: 'menu-title' }, 'Run'),
      h('div', { class: 'menu-list' }, this.programs.map((p) => h('button', {
        class: 'menu-item', onclick: () => { if (!folder) return; this.closeMenu(); this.open(p, folder); },
      }, p.name))),
      h('div', { class: 'menu-separator' }),
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

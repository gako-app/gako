// Terminal tabs: one per agent or shell, next to the Review tab, and the status strip.
//
// A tab runs a program (the shell, or a configured agent such as `claude`) in the base folder or one
// of its repos. Hidden tabs release their WebGL context (TerminalTab does that). An exited tab keeps
// its output until it's closed or restarted.

import { type Renderer, TerminalTab } from '../terminal';
import type { CoreEvent, Transport } from '../transport';
import { h } from './dom';
import type { Settings } from './model';

export interface Program {
  name: string;
  /** Missing for the default shell. */
  cmd?: string[];
}

export interface Folder {
  path: string;
  name: string;
}

interface Tab {
  term: TerminalTab;
  program: Program;
  folder: Folder;
  button: HTMLButtonElement;
  banner: HTMLElement;
}

/** Output within this long counts as working. */
const WORKING_MS = 2000;

export class Terminals {
  readonly bar = h('nav', { class: 'main-tabs' });
  readonly strip = h('span', { class: 'strip' });
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private reviewButton = h('button', { class: 'tab active', onclick: () => this.select(null) }, 'Review');
  private addButton = h('button', { class: 'tab add', title: 'New terminal', onclick: (e: Event) => this.menu(e.currentTarget as HTMLElement) }, '+');
  private menuEl: HTMLElement | null = null;
  private programs: Program[] = [{ name: 'Shell' }];
  private settings: Settings | null = null;

  constructor(
    private t: Transport,
    private body: HTMLElement,
    private review: HTMLElement,
    private folders: () => Folder[],
    private log: (ev: string, data?: Record<string, unknown>) => void,
    private onError: (message: string) => void,
  ) {
    this.bar.append(this.reviewButton, this.addButton);
    t.onEvent((ev: CoreEvent) => {
      if (ev.t !== 'exit') return;
      const tab = this.tabs.find((x) => x.term.id === ev.term);
      if (!tab) return;
      tab.term.onExit(ev);
      this.showBanner(tab);
      this.render();
    });
    // Working and quiet are about time, so the strip is redrawn on a clock as well.
    setInterval(() => this.renderStrip(), 1000);
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
      maxCombining: s?.terminalMaxCombining ?? 8,
      cmd: program.cmd,
      cwd: folder.path,
    });
    const banner = h('div', { class: 'term-banner', hidden: true });
    term.el.append(banner);
    const tab: Tab = { term, program, folder, banner, button: h('button', { class: 'tab' }) };
    tab.button.addEventListener('click', () => this.select(tab));
    this.tabs.push(tab);
    this.bar.insertBefore(tab.button, this.addButton);
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

  select(tab: Tab | null): void {
    this.active?.term.hide();
    this.active = tab;
    this.review.hidden = tab !== null;
    tab?.term.show();
    this.render();
  }

  private close(tab: Tab, force = false): void {
    if (!force && !tab.term.exit && !confirm(`${tab.program.name} is still running in ${tab.folder.name}. Close it?`)) return;
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.button.remove();
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

  private state(tab: Tab): 'working' | 'quiet' | 'exited' | 'failed' {
    const exit = tab.term.exit;
    if (exit) return exit.code ? 'failed' : 'exited';
    return performance.now() - tab.term.lastOutputAt < WORKING_MS ? 'working' : 'quiet';
  }

  private label(tab: Tab): string {
    return `${tab.program.name} · ${tab.folder.name}`;
  }

  private render(): void {
    this.reviewButton.classList.toggle('active', this.active === null);
    for (const tab of this.tabs) {
      tab.button.classList.toggle('active', tab === this.active);
      tab.button.replaceChildren(
        h('span', { class: `dot ${this.state(tab)}` }),
        h('span', {}, this.label(tab)),
        h('span', { class: 'close', title: 'Close', onclick: (e: Event) => { e.stopPropagation(); this.close(tab); } }, '×'),
      );
    }
    this.renderStrip();
  }

  private renderStrip(): void {
    this.strip.replaceChildren(...this.tabs.map((tab) => {
      const state = this.state(tab);
      const code = tab.term.exit?.code;
      return h('button', {
        class: `chip ${state}`, onclick: () => this.select(tab),
        title: `${this.label(tab)}: ${state}${state === 'failed' || state === 'exited' ? ` (code ${code ?? '?'})` : ''}`,
      }, h('span', { class: `dot ${state}` }), tab.program.name);
    }));
    for (const tab of this.tabs) tab.button.querySelector('.dot')?.setAttribute('class', `dot ${this.state(tab)}`);
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
    const r = anchor.getBoundingClientRect();
    this.menuEl.style.left = `${Math.max(8, r.left)}px`;
    this.menuEl.style.top = `${r.bottom + 4}px`;
    document.body.append(this.menuEl);
  }

  private closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }
}

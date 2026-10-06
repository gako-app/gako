// The phase 0 harness UI: a tab bar over a diff view, a file view and terminal tabs.

import type { Metrics } from '../metrics';
import { TerminalTab, type Renderer, type TermOptions } from '../terminal';
import type { Transport } from '../transport';
import { DiffView, FileView } from './views';

export interface Hello {
  root: string;
  binDir: string;
  platform: string;
  arch: string;
  pid: number;
  version: string;
  flow: { high: number; low: number; chunk: number };
  env: Record<string, string>;
}

export interface Config {
  hello: Hello;
  shell: string;
  scenario: string;
  runId: string;
  fixtures: string;
  outDir: string;
  tuiLoad: string;
  cols: number;
  rows: number;
  scrollback: number;
  renderer: Renderer;
  maxCombining: number;
  env: Record<string, string>;
}

export function join(platform: string, ...parts: string[]): string {
  const sep = platform === 'windows' ? '\\' : '/';
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
}

export function config(hello: Hello, shell: string): Config {
  const env = hello.env;
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  const j = (...p: string[]) => join(hello.platform, ...p);
  const runId = env.GAKO_RUN_ID ?? 'manual';
  const exe = hello.platform === 'windows' ? '.exe' : '';
  return {
    hello,
    shell,
    scenario: env.GAKO_SCENARIO ?? 'manual',
    runId,
    fixtures: env.GAKO_FIXTURES ?? j(hello.root, 'bench', 'out', 'fixtures'),
    outDir: env.GAKO_OUT_DIR ?? j(hello.root, 'bench', 'out', 'runs', runId),
    tuiLoad: env.GAKO_TUI_LOAD ?? j(hello.binDir, `tui-load${exe}`),
    cols: num('GAKO_COLS', 200),
    rows: num('GAKO_ROWS', 50),
    scrollback: num('GAKO_SCROLLBACK', 1000),
    renderer: env.GAKO_RENDERER === 'dom' ? 'dom' : 'webgl',
    // The app's default (settings.terminalMaxCombining); GAKO_MAX_COMBINING=0 measures without it.
    maxCombining: num('GAKO_MAX_COMBINING', 8),
    env,
  };
}

interface Tab {
  name: string;
  button: HTMLButtonElement;
  show(): void;
  hide(): void;
  terminal?: TerminalTab;
}

export class App {
  readonly diff: DiffView;
  readonly file: FileView;
  readonly terminals = new Map<number, TerminalTab>();
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private bar = document.getElementById('tabs')!;
  private views = document.getElementById('views')!;
  private extra = document.createElement('span');

  constructor(
    readonly t: Transport,
    readonly metrics: Metrics,
    readonly cfg: Config,
  ) {
    this.diff = new DiffView(this.views);
    this.file = new FileView(this.views);
    this.extra.className = 'extra';
    this.bar.appendChild(this.extra);
    this.addTab('Diff', this.diff.el);
    this.addTab('File', this.file.el);
    t.onEvent((ev) => {
      if (ev.t === 'exit') this.terminals.get(ev.term)?.onExit(ev);
    });
  }

  fixture(...parts: string[]): string {
    return join(this.cfg.hello.platform, this.cfg.fixtures, ...parts);
  }

  out(name: string): string {
    return join(this.cfg.hello.platform, this.cfg.outDir, name);
  }

  /** A button in the tab bar's right-hand area, for manual runs. */
  action(label: string, fn: () => void): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    this.extra.appendChild(b);
  }

  private addTab(name: string, el: HTMLElement, terminal?: TerminalTab): Tab {
    const button = document.createElement('button');
    button.textContent = name;
    const tab: Tab = {
      name,
      button,
      terminal,
      show: terminal ? () => terminal.show() : () => (el.style.display = ''),
      hide: terminal ? () => terminal.hide() : () => (el.style.display = 'none'),
    };
    button.onclick = () => this.selectTab(tab);
    this.bar.insertBefore(button, this.extra);
    this.tabs.push(tab);
    return tab;
  }

  select(target: string | TerminalTab): void {
    const tab = this.tabs.find((t) => (typeof target === 'string' ? t.name === target : t.terminal === target));
    if (tab) this.selectTab(tab);
  }

  private selectTab(tab: Tab): void {
    if (tab === this.active) return;
    this.active?.hide();
    this.active?.button.classList.remove('active');
    this.active = tab;
    tab.button.classList.add('active');
    tab.show();
  }

  async openTerminal(title: string, opts: Partial<TermOptions> = {}): Promise<TerminalTab> {
    const term = new TerminalTab(this.t, (ev, data) => this.metrics.log(ev, data), this.views, {
      title,
      cols: this.cfg.cols,
      rows: this.cfg.rows,
      scrollback: this.cfg.scrollback,
      renderer: this.cfg.renderer,
      maxCombining: this.cfg.maxCombining,
      cwd: this.fixture('workspace', 'platform'),
      ...opts,
    });
    await term.start();
    this.terminals.set(term.id, term);
    this.addTab(title, term.el, term);
    return term;
  }

  closeTerminal(term: TerminalTab): void {
    const i = this.tabs.findIndex((t) => t.terminal === term);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    tab.button.remove();
    if (this.active === tab) this.active = null;
    this.terminals.delete(term.id);
    term.close();
  }
}

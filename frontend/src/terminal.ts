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

// One terminal tab: xterm.js on top of a PTY in gako-core.
//
// - Backpressure: bytes are acknowledged to the core once xterm.js's write callback fires.
// - WebGL: the renderer's context is released while the tab is hidden and recreated when shown,
//   so hidden tabs don't count against the browser's limit on live WebGL contexts.
// - Ligatures, when on, come from the ligatures addon, which reads the font's file through the
//   browser's local font access; it has to load after open() and before the WebGL renderer.
// - Every received byte goes into a running hash, compared with the core's at exit.
// - Runs of combining marks are capped before xterm.js stores them (see combining.ts).

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import { FNV_OFFSET, fnv1a } from './check';
import { CombiningCap } from './combining';
import { Notifications } from './app/agentstate';
import type { CoreEvent, TermStats, Transport } from './transport';

export type Renderer = 'webgl' | 'dom';
export type Log = (ev: string, data?: Record<string, unknown>) => void;

export interface TermOptions {
  title: string;
  /** A fixed size (for measurements); without one the terminal fits its container. */
  cols?: number;
  rows?: number;
  scrollback: number;
  renderer: Renderer;
  fontSize?: number;
  fontFamily?: string;
  /** Draw the font's ligatures. */
  fontLigatures?: boolean;
  /** Combining marks kept per character; 0 keeps them all. */
  maxCombining?: number;
  cmd?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

type Exit = Extract<CoreEvent, { t: 'exit' }>;

interface PendingEcho {
  ch: string;
  x0: number;
  t0: number;
  matched: boolean;
  resolve: (ms: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const encoder = new TextEncoder();

/** What xterm.js sends on its own rather than from the keyboard: focus reports, mouse reports, and
 * replies to the program's queries (device attributes, cursor position, OSC colours). */
const TERMINAL_REPORT = /^\x1b(\[[IO]|\[\?[\d;]*c|\[>[\d;]*c|\[\d+;\d+R|\[<[\d;]+[Mm]|\[M|\]|P)/;

export class TerminalTab {
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  id = 0;
  pid: number | null = null;
  visible = false;
  received = 0;
  hash = FNV_OFFSET;
  lastOutputAt = 0;
  /** When the user last typed or pasted into it. */
  lastInputAt = 0;
  /** The title the program set (OSC 0 or 2), which some agents use to show their state. */
  title = '';
  /** The last desktop notification the program sent (OSC 9, 99 or 777), and when. */
  notice: { text: string; at: number } | null = null;
  private notifications = new Notifications();
  exit: Exit | null = null;
  contextLosses = 0;
  private webgl: WebglAddon | null = null;
  private ligatures: LigaturesAddon | null = null;
  private wantLigatures: boolean;
  private fit: FitAddon | null = null;
  private opened = false;
  private exitWaiters: ((e: Exit) => void)[] = [];
  private echo: PendingEcho | null = null;
  private cap: CombiningCap | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private t: Transport,
    private log: Log,
    parent: HTMLElement,
    readonly opts: TermOptions,
  ) {
    this.wantLigatures = !!opts.fontLigatures;
    this.el = document.createElement('div');
    this.el.className = 'view terminal';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
    this.term = new Terminal({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      scrollback: opts.scrollback,
      allowProposedApi: true,
      fontFamily: opts.fontFamily ?? 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: opts.fontSize ?? 12,
      theme: { background: '#1e1e1e', foreground: '#cccccc' },
    });
    this.term.onTitleChange((title) => { this.title = title; });
    for (const code of [9, 99, 777]) {
      this.term.parser.registerOscHandler(code, (data) => {
        const action = this.notifications.handle(code, data);
        if (action && 'reply' in action) this.t.sendBytes(this.id, encoder.encode(action.reply));
        else if (action) this.notice = { text: action.notice, at: performance.now() };
        return true;
      });
    }
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    // Links open in the browser (the shell routes window.open outside the app).
    this.term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')));
    this.cap = opts.maxCombining ? new CombiningCap(opts.maxCombining) : null;
    if (opts.cols === undefined) {
      this.fit = new FitAddon();
      this.term.loadAddon(this.fit);
      this.resizeObserver = new ResizeObserver(() => this.refit());
      this.resizeObserver.observe(this.el);
    }
  }

  /** Starts the program. With a fitted terminal, show it first so it starts at the right size. */
  async start(): Promise<void> {
    const { cmd, cwd, env } = this.opts;
    const { cols, rows } = this.term;
    const r = await this.t.request<{ term: number; pid: number | null }>('termOpen', { cols, rows, cmd, cwd, env });
    this.id = r.term;
    this.pid = r.pid;
    this.t.onBytes(this.id, (data) => this.output(data));
    this.term.onData((d) => {
      if (!TERMINAL_REPORT.test(d)) this.lastInputAt = performance.now();
      this.t.sendBytes(this.id, encoder.encode(d));
    });
    this.term.onBinary((d) => this.t.sendBytes(this.id, Uint8Array.from(d, (c) => c.charCodeAt(0))));
  }

  private output(data: Uint8Array): void {
    this.received += data.length;
    this.hash = fnv1a(this.hash, data);
    this.lastOutputAt = performance.now();
    const text = this.cap ? this.cap.apply(data) : data;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // Marks held back at the end of a chunk are written once no more output follows.
    if (this.cap?.holding) this.flushTimer = setTimeout(() => this.term.write(this.cap!.flush()), 30);
    this.term.write(text, () => {
      this.t.send({ t: 'ack', term: this.id, n: data.length });
      if (this.echo) this.checkEcho();
    });
  }

  onExit(ev: Exit): void {
    this.exit = ev;
    for (const w of this.exitWaiters.splice(0)) w(ev);
  }

  /** Fits the terminal to its container and tells the PTY, if the size changed. */
  private refit(): void {
    if (!this.fit || !this.visible || !this.opened) return;
    const before = `${this.term.cols}x${this.term.rows}`;
    try {
      this.fit.fit();
    } catch {
      return; // not laid out yet
    }
    if (this.id && `${this.term.cols}x${this.term.rows}` !== before) {
      this.t.send({ t: 'resize', term: this.id, cols: this.term.cols, rows: this.term.rows });
    }
  }

  waitExit(): Promise<Exit> {
    return this.exit ? Promise.resolve(this.exit) : new Promise((r) => this.exitWaiters.push(r));
  }

  /** Resolves once no output has arrived for `quietMs`. */
  async waitQuiet(quietMs: number, timeoutMs = 600_000): Promise<void> {
    const start = performance.now();
    while (performance.now() - Math.max(this.lastOutputAt, start) < quietMs) {
      if (performance.now() - start > timeoutMs) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Shows the terminal, and gives it the keyboard unless `focus` is false. */
  show(focus = true): void {
    this.el.style.display = '';
    this.visible = true;
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
      if (this.wantLigatures) this.term.loadAddon(this.ligatures = new LigaturesAddon());
    }
    if (this.opts.renderer === 'webgl' && !this.webgl) this.attachWebgl();
    this.refit();
    this.term.refresh(0, this.term.rows - 1);
    if (focus) this.term.focus();
  }

  /** Changes the font while the terminal runs (the settings changed). */
  setFont(fontFamily: string, fontSize: number, ligatures: boolean): void {
    if (this.term.options.fontFamily !== fontFamily) this.term.options.fontFamily = fontFamily;
    if (this.term.options.fontSize !== fontSize) this.term.options.fontSize = fontSize;
    if (ligatures !== this.wantLigatures) {
      this.wantLigatures = ligatures;
      if (this.opened) {
        if (ligatures) this.term.loadAddon(this.ligatures = new LigaturesAddon());
        else {
          this.ligatures?.dispose();
          this.ligatures = null;
        }
        // WebGL's glyphs were drawn with the font's features as they were: start it again.
        if (this.webgl) {
          this.webgl.dispose();
          this.webgl = null;
          this.attachWebgl();
        }
      }
    }
    this.refit();
  }

  hide(): void {
    this.webgl?.dispose();
    this.webgl = null;
    this.el.style.display = 'none';
    this.visible = false;
  }

  private attachWebgl(): void {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        this.contextLosses++;
        this.log('webglContextLoss', { term: this.id });
        addon.dispose();
        if (this.webgl === addon) this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch (e) {
      this.log('webglUnavailable', { term: this.id, error: String(e) });
    }
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
    this.t.send({ t: 'resize', term: this.id, cols, rows });
  }

  type(text: string): void {
    this.t.sendBytes(this.id, encoder.encode(text));
  }

  stats(): Promise<TermStats> {
    return this.t.request<TermStats>('termStats', { term: this.id });
  }

  /** Transport check: did the frontend receive exactly the bytes the core read from the PTY? */
  transportCheck(core: TermStats): Record<string, unknown> {
    return {
      ok: core.bytes === this.received && core.hash === this.hash,
      coreBytes: core.bytes,
      receivedBytes: this.received,
      coreHash: core.hash,
      receivedHash: this.hash,
      pauses: core.pauses,
      maxUnacked: core.maxUnacked,
    };
  }

  /**
   * Keystroke to echo: from the key going in to xterm.js rendering the echoed character (to it
   * being parsed, when the tab is hidden and nothing renders). Input goes through xterm.js's own
   * input path, as a key press would. The echo is recognized by the cursor moving one cell right
   * with the character left of it. A backspace afterwards keeps the input line short.
   */
  measureEcho(ch = 'x', timeoutMs = 2000): Promise<number | null> {
    if (this.echo) return Promise.resolve(null);
    const buf = this.term.buffer.active;
    return new Promise((resolve) => {
      const done = (v: number | null) => {
        clearTimeout(this.echo?.timer);
        this.echo = null;
        resolve(v);
        this.term.input('\x7f', true);
      };
      this.echo = { ch, x0: buf.cursorX, t0: performance.now(), matched: false, resolve: done, timer: setTimeout(() => done(null), timeoutMs) };
      this.term.input(ch, true);
    });
  }

  private checkEcho(): void {
    const e = this.echo!;
    if (e.matched) return;
    const buf = this.term.buffer.active;
    const cell = buf.getLine(buf.baseY + buf.cursorY)?.getCell(buf.cursorX - 1);
    if (buf.cursorX !== e.x0 + 1 || cell?.getChars() !== e.ch) return;
    e.matched = true;
    if (!this.visible) {
      e.resolve(performance.now() - e.t0);
      return;
    }
    const d = this.term.onRender(() => {
      d.dispose();
      e.resolve(performance.now() - e.t0);
    });
  }

  close(): void {
    this.resizeObserver?.disconnect();
    if (this.id) this.t.send({ t: 'close', term: this.id });
    this.webgl?.dispose();
    this.term.dispose();
    this.el.remove();
  }
}

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

// Scripted runs for the terminal and viewer suite (docs/performance.md). bench/measure starts the app with GAKO_SCENARIO set,
// reads the records these write to the log, and samples memory from outside.

import type { App } from './app';
import { checkSeqLines, checkTail, logicalLines, screenTail } from '../check';
import { capCombining } from '../combining';
import { frames, ms, sleep, summarize } from '../metrics';
import type { TerminalTab } from '../terminal';

interface LogDump { path: string; bytes: number; kind: 'log'; lastSeq: number; trailer: string }
interface TextDump { path: string; bytes: number; kind: 'long' | 'emoji'; tail: string; trailer: string }
type Dump = LogDump | TextDump;

interface Manifest {
  version: number;
  diff: { old: string; new: string };
  large: { path: string };
  normal: LogDump;
  long: TextDump;
  emoji: TextDump;
  load: LogDump;
}

interface TuiReport { lastSeq: number; cols: number; rows: number; panel: string[]; frames: number; bytes: number }
interface DumpReport { bytes: number; elapsedMs: number; startEpochMs: number; endEpochMs: number }

const PANEL_ROWS = 8;

async function manifest(app: App): Promise<Manifest> {
  const r = await app.t.request<{ text: string }>('readFile', { path: app.fixture('manifest.json') });
  return JSON.parse(r.text);
}

async function readJson<T>(app: App, path: string): Promise<T | null> {
  try {
    return JSON.parse((await app.t.request<{ text: string }>('readFile', { path })).text) as T;
  } catch {
    return null;
  }
}

async function waitForJson<T>(app: App, path: string, timeoutMs = 3_600_000): Promise<T | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const v = await readJson<T>(app, path);
    if (v) return v;
    await sleep(250);
  }
  return null;
}

const fixturePath = (app: App, rel: string) => app.fixture(...rel.split('/'));

function env(app: App, key: string, d: number): number {
  return app.cfg.env[key] ? Number(app.cfg.env[key]) : d;
}

function quote(arg: string): string {
  return `"${arg}"`;
}

/** A command line to type into the default shell. PowerShell runs a quoted path only after `&`. */
function commandLine(app: App, args: string[]): string {
  const line = args.map(quote).join(' ');
  return app.cfg.hello.platform === 'windows' ? `& ${line}` : line;
}

// --- shared steps -------------------------------------------------------------------------------

export async function openDiff(app: App, m: Manifest): Promise<number> {
  const took = await app.diff.open(app.t, fixturePath(app, m.diff.old), fixturePath(app, m.diff.new));
  return took;
}

async function shellReady(term: TerminalTab): Promise<void> {
  while (term.received === 0) await sleep(50);
  await term.waitQuiet(1000, 15_000);
}

async function echoSeries(app: App, term: TerminalTab, n: number, gapMs: number, label: string) {
  const values: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < n; i++) {
    const v = await term.measureEcho();
    if (v === null) timeouts++;
    else values.push(v);
    await sleep(gapMs);
  }
  const s = summarize(values);
  app.metrics.log('echo', { label, visible: term.visible, timeouts, ...s, values });
  app.metrics.show(`echo ${label}`, `median ${ms(s.median)} p95 ${ms(s.p95)} (${timeouts} timeouts)`);
  return s;
}

function tuiArgs(app: App, i: number, seconds: number): string[] {
  return [app.cfg.tuiLoad, 'run', '--seconds', String(seconds), '--seed', String(i), '--report', app.out(`tui-${i}.json`)];
}

async function checkTui(app: App, term: TerminalTab, i: number) {
  const exit = await term.waitExit();
  const report = await readJson<TuiReport>(app, app.out(`tui-${i}.json`));
  const transport = term.transportCheck(exit.stats);
  if (!report) {
    app.metrics.log('integrity', { what: `tui-${i}`, ok: false, error: 'no report', transport });
    return false;
  }
  const lines = checkSeqLines(logicalLines(term.term), 8, report.lastSeq);
  const panel = screenTail(term.term, PANEL_ROWS);
  const panelOk = panel.every((row, k) => row === report.panel[k]);
  const ok = lines.ok && panelOk && transport.ok === true;
  app.metrics.log('integrity', {
    what: `tui-${i}`, ok, lines, panelOk, panel: panelOk ? undefined : { got: panel, want: report.panel }, transport,
    frames: report.frames, size: `${report.cols}x${report.rows}`,
  });
  return ok;
}

function checkDumpBuffer(app: App, term: TerminalTab, dump: Dump) {
  const lines = logicalLines(term.term);
  // The terminal caps runs of combining marks, so the expected text is capped the same way.
  return dump.kind === 'log'
    ? checkSeqLines(lines, 9, dump.lastSeq, dump.trailer)
    : checkTail(lines, capCombining(dump.tail, app.cfg.maxCombining), dump.trailer);
}

// --- scenarios ----------------------------------------------------------------------------------

/** Cold start: usable once a terminal tab shows its shell's first output. */
async function coldstart(app: App): Promise<void> {
  const shell = await app.openTerminal('Shell');
  app.select(shell);
  while (shell.received === 0) await sleep(5);
  await frames(1);
  app.metrics.log('usable', { sinceNavMs: performance.now() });
}

/** Memory, idle: the sample workspace's 5,000-line diff showing, plus one idle terminal tab. */
async function idle(app: App): Promise<void> {
  const m = await manifest(app);
  await app.openTerminal('Shell');
  app.select('Diff');
  const took = await openDiff(app, m);
  app.metrics.log('diffOpen', { ms: took, cold: true, changes: app.diff.changes() });
  app.metrics.log('scenarioReady');
}

/** Diff open and scroll, file open and scroll, keystroke to echo. */
async function ui(app: App): Promise<void> {
  const m = await manifest(app);
  const shell = await app.openTerminal('Shell');
  app.select('Diff');
  for (let i = 0; i < 6; i++) {
    const took = await openDiff(app, m);
    app.metrics.log('diffOpen', { ms: took, cold: i === 0, run: i, changes: app.diff.changes() });
    app.metrics.show(i === 0 ? 'diff open (cold)' : 'diff open (warm)', ms(took));
    await sleep(300);
  }
  for (let i = 0; i < 2; i++) {
    const r = await app.diff.scroll(5000, 4000);
    app.metrics.log('diffScroll', { run: i, ...r });
    app.metrics.show('diff scroll', `${r.fps.toFixed(0)} fps, ${r.stalls} stalls`);
  }
  app.select('File');
  for (let i = 0; i < 4; i++) {
    const took = await app.file.open(app.t, fixturePath(app, m.large.path));
    app.metrics.log('fileOpen', { ms: took, cold: i === 0, run: i });
    app.metrics.show('5 MB file open', ms(took));
    await sleep(300);
  }
  for (let i = 0; i < 2; i++) {
    const r = await app.file.scroll(5000, 4000);
    app.metrics.log('fileScroll', { run: i, ...r });
    app.metrics.show('file scroll', `${r.fps.toFixed(0)} fps, ${r.stalls} stalls`);
  }
  app.select(shell);
  await shellReady(shell);
  await echoSeries(app, shell, 50, 100, 'idle shell');
  const tui = await app.openTerminal('tui-load', { cmd: tuiArgs(app, 0, 30) });
  app.select(tui);
  await sleep(1000);
  await echoSeries(app, tui, 50, 100, 'one tui-load');
  app.metrics.log('scenarioDone');
}

/**
 * Four agent TUIs, plus a 50 MB log dumped into a fifth tab. Measures the dump time, checks
 * nothing was lost or garbled, and measures echo in a TUI tab while the others run.
 */
async function load(app: App): Promise<void> {
  const m = await manifest(app);
  const seconds = env(app, 'GAKO_LOAD_SECONDS', 300);
  const dumpAt = env(app, 'GAKO_LOAD_DUMP_AT', 20);
  const tuis: TerminalTab[] = [];
  for (let i = 1; i <= 4; i++) tuis.push(await app.openTerminal(`Agent ${i}`, { cmd: tuiArgs(app, i, seconds) }));
  app.select(tuis[0]);
  app.metrics.log('loadStarted', { seconds, dumpAt });
  await sleep(dumpAt * 1000);

  const report = app.out('dump-load.json');
  const dumpTab = await app.openTerminal('Dump', {
    cmd: [app.cfg.tuiLoad, 'dump', fixturePath(app, m.load.path), '--report', report],
  });
  app.select(dumpTab);
  const t0 = performance.now();
  app.metrics.log('dumpStart', { kind: 'load', bytes: m.load.bytes });
  // Meanwhile, input in a hidden agent tab must still get through.
  const hidden: number[] = [];
  let dumping = true;
  const hiddenEcho = (async () => {
    while (dumping) {
      const v = await tuis[1].measureEcho();
      if (v !== null) hidden.push(v);
      await sleep(500);
    }
  })();
  const exit = await dumpTab.waitExit();
  const wallMs = performance.now() - t0;
  dumping = false;
  await hiddenEcho;
  const r = await readJson<DumpReport>(app, report);
  const buffer = checkDumpBuffer(app, dumpTab, m.load);
  const transport = dumpTab.transportCheck(exit.stats);
  app.metrics.log('dumpDone', { kind: 'load', elapsedMs: r?.elapsedMs, wallMs, buffer, transport });
  app.metrics.log('integrity', { what: 'dump-load', ok: buffer.ok && transport.ok === true, buffer, transport });
  app.metrics.log('echo', { label: 'hidden agent tab during dump', visible: false, ...summarize(hidden), values: hidden });
  app.metrics.show('50 MB dump', `${ms(r?.elapsedMs ?? NaN)}, ${buffer.ok && transport.ok ? 'intact' : 'NOT INTACT'}`);

  app.select(tuis[0]);
  await sleep(1000);
  await echoSeries(app, tuis[0], 40, 500, 'agent tab under load');
  app.metrics.log('loadSteady');

  let ok = true;
  for (let i = 0; i < 4; i++) ok = (await checkTui(app, tuis[i], i + 1)) && ok;
  app.metrics.show('agent TUIs', ok ? 'intact' : 'NOT INTACT');
  app.metrics.log('scenarioDone');
}

/** Hides and shows terminal tabs repeatedly while four TUIs run. */
async function cycle(app: App): Promise<void> {
  const seconds = env(app, 'GAKO_CYCLE_SECONDS', 240);
  const every = env(app, 'GAKO_CYCLE_MS', 1000);
  const tuis: TerminalTab[] = [];
  for (let i = 1; i <= 4; i++) tuis.push(await app.openTerminal(`Agent ${i}`, { cmd: tuiArgs(app, i, seconds + 10) }));
  app.metrics.log('cycleStarted', { seconds, everyMs: every });
  document.addEventListener('visibilitychange', () => app.metrics.log('visibility', { state: document.visibilityState }));
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < seconds * 1000) {
    app.select(tuis[n % 4]);
    n++;
    if (n % 20 === 0) {
      app.metrics.log('cycles', { n, contextLosses: tuis.reduce((a, t) => a + t.contextLosses, 0) });
      app.metrics.show('cycles', String(n));
    }
    await sleep(every);
  }
  app.metrics.log('cycleDone', { n, contextLosses: tuis.reduce((a, t) => a + t.contextLosses, 0) });
  let ok = true;
  for (let i = 0; i < 4; i++) {
    app.select(tuis[i]);
    ok = (await checkTui(app, tuis[i], i + 1)) && ok;
  }
  app.metrics.show('agent TUIs', ok ? 'intact' : 'NOT INTACT');
  app.metrics.log('scenarioDone');
}

/**
 * Three 250 MB dumps into the same shell tab: line-oriented, very long lines, combining + emoji.
 * One command runs them in sequence with pauses, the same command the VS Code baseline runs.
 */
async function dump(app: App): Promise<void> {
  const m = await manifest(app);
  const pause = env(app, 'GAKO_DUMP_PAUSE', 30);
  const kinds = (app.cfg.env.GAKO_DUMPS ?? 'normal,long,emoji').split(',') as ('normal' | 'long' | 'emoji')[];
  const shell = await app.openTerminal('Shell');
  app.select(shell);
  await shellReady(shell);
  const files = kinds.map((k) => fixturePath(app, m[k].path));
  app.metrics.log('dumpsStarted', { kinds, pause });
  const args = ['dump', ...files, '--delay', String(pause), '--pause', String(pause), '--report-dir', app.cfg.outDir];
  shell.type(`${commandLine(app, [app.cfg.tuiLoad, ...args])}\r`);
  for (const kind of kinds) {
    const d = m[kind];
    const r = await waitForJson<DumpReport>(app, app.out(`dump-${kind}.json`));
    await shell.waitQuiet(1000);
    const buffer = checkDumpBuffer(app, shell, d);
    const transport = shell.transportCheck(await shell.stats());
    app.metrics.log('dumpDone', { kind, ...r, buffer, transport });
    app.metrics.log('integrity', { what: `dump-${kind}`, ok: buffer.ok && transport.ok === true, buffer, transport });
    app.metrics.show(`dump ${kind}`, `${ms(r?.elapsedMs ?? NaN)}, ${buffer.ok && transport.ok ? 'intact' : 'NOT INTACT'}`);
  }
  await sleep(pause * 1000);
  app.metrics.log('scenarioDone');
}

/** Resize, close a tab, then wait to be quit: child processes must all exit. */
async function lifecycle(app: App): Promise<void> {
  const tabs: TerminalTab[] = [];
  for (let i = 1; i <= 3; i++) {
    const t = await app.openTerminal(`Shell ${i}`);
    tabs.push(t);
    app.select(t);
    await shellReady(t);
    // A TUI running as a child of the shell, so there are grandchildren to clean up too.
    t.type(`${commandLine(app, [app.cfg.tuiLoad, 'run'])}\r`);
  }
  await sleep(2000);
  app.metrics.log('lifecycleSpawned', { pids: tabs.map((t) => t.pid) });
  for (const [cols, rows] of [[120, 40], [220, 60], [80, 24], [app.cfg.cols, app.cfg.rows]]) {
    for (const t of tabs) t.resize(cols, rows);
    await sleep(700);
  }
  app.metrics.log('resized');
  const closed = tabs[1];
  app.metrics.log('tabClosing', { term: closed.id, pid: closed.pid });
  app.closeTerminal(closed);
  await sleep(2000);
  app.metrics.log('readyToQuit', { pids: tabs.map((t) => t.pid) });
}

export const scenarios: Record<string, (app: App) => Promise<void>> = { coldstart, idle, ui, load, cycle, dump, lifecycle };

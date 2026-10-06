// Checks the integrity checkers against xterm.js's real buffer (headless), so a "NOT INTACT" in a
// measurement run means the terminal pipeline, not the checker.
//
//   node --test test/          (needs the fixtures and a release build of tui-load)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import xtermHeadless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';

import { checkSeqLines, checkTail, logicalLines, screenTail } from '../src/check.ts';

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;
const root = new URL('../../', import.meta.url).pathname;
const fixtures = join(root, 'bench/out/fixtures');
const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'));

function terminal(convertEol: boolean) {
  const term = new Terminal({ cols: 200, rows: 50, scrollback: 1000, allowProposedApi: true, convertEol });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  return term;
}

function write(term: InstanceType<typeof Terminal>, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** The last `bytes` of a file, starting after a newline, as a PTY would deliver them. */
function tail(path: string, bytes: number): Uint8Array {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  return start === 0 ? buf : buf.subarray(buf.indexOf(10) + 1);
}

test('tui-load output passes the line and panel checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gako-check-'));
  const raw = join(dir, 'tui.raw');
  const report = join(dir, 'tui.json');
  execFileSync('python3', [join(root, 'frontend/test/capture-tui.py'), raw, report, join(root, 'core/target/release/tui-load')]);
  const r = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(`${r.cols}x${r.rows}`, '200x50');
  const term = terminal(false);
  await write(term, readFileSync(raw));
  const lines = checkSeqLines(logicalLines(term), 8, r.lastSeq);
  assert.ok(lines.ok, JSON.stringify(lines));
  assert.deepEqual(screenTail(term, 8), r.panel);

  // Lost chunks must be caught. (Damage inside a panel redraw that a later frame repaints can't
  // show in the buffer; the transport hash covers that.)
  const bytes = readFileSync(raw);
  const pieces = [];
  for (let at = 0; at < bytes.length; at += 20_000) pieces.push(bytes.subarray(at, at + 19_900));
  const damaged = Buffer.concat(pieces);
  const term2 = terminal(false);
  await write(term2, damaged);
  const lines2 = checkSeqLines(logicalLines(term2), 8, r.lastSeq);
  const panelOk = screenTail(term2, 8).every((row, k) => row === r.panel[k]);
  assert.ok(!lines2.ok || !panelOk, 'damage went unnoticed');
});

test('log dump passes, and a dropped chunk fails', async () => {
  const d = manifest.load;
  const data = tail(join(fixtures, d.path), 4 * 1024 * 1024);
  const term = terminal(true);
  await write(term, data);
  const ok = checkSeqLines(logicalLines(term), 9, d.lastSeq, d.trailer);
  assert.ok(ok.ok, JSON.stringify(ok));

  const cut = data.length - 50_000;
  const damaged = Buffer.concat([data.subarray(0, cut), data.subarray(cut + 777)]);
  const term2 = terminal(true);
  await write(term2, damaged);
  assert.equal(checkSeqLines(logicalLines(term2), 9, d.lastSeq, d.trailer).ok, false);
});

for (const kind of ['long', 'emoji'] as const) {
  test(`${kind} dump tail check`, async () => {
    const d = manifest[kind];
    const data = tail(join(fixtures, d.path), 12 * 1024 * 1024);
    const term = terminal(true);
    await write(term, data);
    const r = checkTail(logicalLines(term), d.tail, d.trailer);
    assert.ok(r.ok, JSON.stringify(r));
  });
}

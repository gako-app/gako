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

// Phases 3–5 timings against gako-core alone, on a copy of a generated layout:
//
//   node bench/measure/core.mjs [work|stress]
//
// Prints JSON: folder listing, search (first result and total), go to file, symbol index build
// time and size, definition and symbol lookups, and the core's memory with everything loaded.

import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const layout = process.argv[2] ?? 'stress';
const exe = process.platform === 'win32' ? '.exe' : '';
const work = mkdtempSync(join(tmpdir(), `gako-core-bench-`));
const base = join(work, 'base');
cpSync(join(root, 'bench', 'out', 'fixtures', 'layouts', layout), base, { recursive: true });
const realBase = execFileSync(process.platform === 'win32' ? 'cmd' : 'pwd', process.platform === 'win32' ? ['/c', 'cd'] : ['-P'], { cwd: base }).toString().trim();

const core = spawn(join(root, 'core', 'target', 'release', `gako-core${exe}`), [], {
  env: { ...process.env, GAKO_TOKEN: 'bench', GAKO_ROOT: root },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const { port, pid } = JSON.parse(await new Promise((r) => core.stdout.once('data', (d) => r(d.toString()))));
const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=bench`);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'res') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.e ? p.rej(new Error(m.e)) : p.res(m.r);
  } else for (const l of listeners) l(m, performance.now());
};
const req = (m, p) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ t: 'req', id, m, p })); });
const until = (pred) => new Promise((res) => { const l = (m, t) => { if (pred(m)) { listeners.delete(l); res([m, t]); } }; listeners.add(l); });
const time = async (fn) => { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r]; };
const median = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
const out = { layout };

const t0 = performance.now();
const scanned = until((m) => m.t === 'scanDone');
const indexed = until((m) => m.t === 'indexReady');
await req('workspaceOpen', { base: realBase });
out.scanMs = (await scanned)[1] - t0;
const [ready] = await indexed;
out.index = { buildMs: ready.ms, files: ready.files, symbols: ready.symbols };

// Folder listing: the base folder and the folder of 3,000 untracked files.
const big = execFileSync('find', [realBase, '-type', 'd', '-name', 'cache']).toString().split('\n')[0];
out.listBaseMs = (await time(() => req('filesList', { path: realBase })))[0];
out.listBigMs = (await time(() => req('filesList', { path: big })))[0];

// Search: first result and total, three queries, all repos.
out.search = [];
for (const pattern of ['computeLedger', 'timeout: 1', 'no such text anywhere']) {
  let first = null;
  const t = performance.now();
  const l = (m, at) => { if (m.t === 'searchResults' && first === null) first = at - t; };
  listeners.add(l);
  const stats = await req('search', { search: 1, query: { pattern }, scope: { kind: 'all' } });
  listeners.delete(l);
  out.search.push({ pattern, firstResultMs: first, totalMs: performance.now() - t, matches: stats.matches, files: stats.files, searched: stats.searched });
}

// Go to file, as typed letter by letter.
const typed = [];
for (const q of ['l', 'le', 'led', 'ledg', 'ledge', 'ledger']) typed.push((await time(() => req('findFiles', { query: q })))[0]);
out.findFilesMs = { median: median(typed), max: Math.max(...typed) };

// Symbol lookups.
const defs = [];
for (const name of ['computeLedger', 'LedgerStore0', 'findAccount', 'nothing_like_this']) defs.push((await time(() => req('symbolDefinitions', { name })))[0]);
out.definitionMs = { median: median(defs), max: Math.max(...defs) };
const syms = [];
for (const q of ['led', 'ledgerst', 'cmpld']) syms.push((await time(() => req('symbolSearch', { query: q })))[0]);
out.symbolSearchMs = { median: median(syms), max: Math.max(...syms) };

// The index follows edits: a new function appears after its file is saved.
const target = execFileSync('find', [realBase, '-name', '*.ts', '-path', '*src*']).toString().split('\n')[0];
appendFileSync(target, '\nexport function addedDuringTheBench() {}\n');
const tEdit = performance.now();
let found = false;
while (!found && performance.now() - tEdit < 5000) {
  found = (await req('symbolDefinitions', { name: 'addedDuringTheBench' })).symbols.length > 0;
  if (!found) await new Promise((r) => setTimeout(r, 50));
}
out.indexUpdateMs = found ? performance.now() - tEdit : null;

// The core's memory with the workspace open, the index built and a search done.
if (process.platform === 'darwin') {
  const fp = execFileSync('footprint', ['-p', String(pid), '-f', 'bytes', '--noCategories']).toString();
  out.coreFootprintMB = Number(/phys_footprint: (\d+)/.exec(fp)?.[1] ?? 0) / 2 ** 20;
} else if (process.platform === 'linux') {
  out.coreRssMB = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;
}

core.stdin.end();
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v), 2));
process.exit(0);

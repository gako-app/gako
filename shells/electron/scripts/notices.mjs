// Writes THIRD-PARTY-NOTICES.txt at the repository root: every third-party package the packaged app
// contains, with its version, licence and licence text. Run by `npm run package`, or alone:
//
//   npm run notices -w shells/electron
//
// What's covered: the npm packages bundled into the frontend (the frontend's dependencies and
// theirs), and the Rust crates the core is built from (cargo metadata, normal dependencies, all
// platforms). Electron and Chromium ship their own LICENSE and LICENSES.chromium.html, which
// packaging copies into the app's resources next to this file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LICENCE_FILE = /^(licen[cs]e|copying|unlicense|notice)([-._].*)?$/i;

/** The licence texts a package ships, by file name. */
function texts(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => LICENCE_FILE.test(n)).sort(); } catch { /* none */ }
  return names
    .filter((n) => fs.statSync(path.join(dir, n)).isFile())
    .map((n) => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8').trim() }));
}

/** The npm packages bundled into the frontend: its dependencies, and theirs, recursively. */
function npmPackages() {
  const found = new Map();
  const visit = (name, from) => {
    // Node's resolution: the nearest node_modules up from the dependent package.
    let dir = from;
    let pkgDir = null;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) { pkgDir = candidate; break; }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (!pkgDir || found.has(pkgDir)) return;
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const licence = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(' OR ');
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    found.set(pkgDir, { name: pkg.name, version: pkg.version, licence: licence || 'unknown', url: pkg.homepage ?? repo ?? '', texts: texts(pkgDir) });
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, pkgDir);
  };
  const frontend = path.join(root, 'frontend');
  const deps = JSON.parse(fs.readFileSync(path.join(frontend, 'package.json'), 'utf8')).dependencies ?? {};
  for (const dep of Object.keys(deps)) visit(dep, frontend);
  return [...found.values()];
}

/** The crates the core is built from: gako-core's normal dependencies, transitively. */
function crates() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', path.join(root, 'core', 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const start = meta.packages.find((p) => p.name === 'gako-core');
  const seen = new Set();
  const walk = (id) => {
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue; // build and dev dependencies aren't shipped
      if (seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      walk(dep.pkg);
    }
  };
  walk(start.id);
  return [...seen].map((id) => byId.get(id)).map((p) => ({
    name: p.name, version: p.version, licence: p.license ?? (p.license_file ? `see ${p.license_file}` : 'unknown'),
    url: p.repository ?? p.homepage ?? '', texts: texts(path.dirname(p.manifest_path)),
  }));
}

/** Licence texts already written, so a text many packages share (Apache 2.0's) appears once. */
const written = new Map();

function section(title, packages) {
  const out = [`${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`];
  for (const p of packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    const id = `${p.name} ${p.version}`;
    out.push(`\n${'-'.repeat(78)}\n${id}\nLicence: ${p.licence}${p.url ? `\nSource: ${p.url}` : ''}\n`);
    if (!p.texts.length) out.push('(The package ships no licence file; its licence is the one named above.)\n');
    for (const t of p.texts) {
      const first = written.get(t.text);
      if (first) out.push(`\n--- ${t.name}: the same text as ${first}'s, above ---\n`);
      else {
        written.set(t.text, id);
        out.push(`\n--- ${t.name} ---\n${t.text}\n`);
      }
    }
  }
  return out.join('');
}

const npm = npmPackages();
const rust = crates();
const header = `Third-party software in Gako

Gako includes the software below. Each item names its licence and, where the package provides it,
the licence's full text with its copyright notice.

Electron and Chromium, which run Gako's window, come with their own notices: LICENSE and
LICENSES.chromium.html, in the same folder as this file in the packaged app.

${npm.length} npm packages (in the window's code) and ${rust.length} Rust crates (in gako-core).
`;
fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), `${header}\n${section('npm packages', npm)}\n${section('Rust crates', rust)}`);
console.log(`THIRD-PARTY-NOTICES.txt: ${npm.length} npm packages, ${rust.length} crates`);
const missing = [...npm, ...rust].filter((p) => !p.texts.length).map((p) => `${p.name} ${p.version} (${p.licence})`);
if (missing.length) console.log(`no licence file shipped by: ${missing.join(', ')}`);

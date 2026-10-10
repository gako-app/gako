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

// Builds the macOS disk image, dist/Gako-<version>-<arch>.dmg, from the Gako.app that `npm run
// package` left in dist/: a window with Gako's icon, a link to Applications and a background
// saying to drag one onto the other (scripts/dmg-settings.py).
//
// The image is made by dmgbuild, which writes the window's layout itself rather than asking Finder
// to, so it works on a machine with nobody logged in, such as CI. It's installed, with the pinned
// hashes in scripts/dmg-requirements.txt, into shells/electron/.venv; all it needs from the system
// is python3.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const shell = path.join(scripts, '..');
const root = path.join(shell, '..', '..');

if (process.platform !== 'darwin') {
  console.error('the disk image is built on macOS only');
  process.exit(1);
}
const app = path.join(root, 'dist', `Gako-darwin-${process.arch}`, 'Gako.app');
if (!fs.existsSync(app)) {
  console.error(`Gako.app isn't packaged (${app}); run \`npm run package\` from the repository root`);
  process.exit(1);
}

const venv = path.join(shell, '.venv');
const python = path.join(venv, 'bin', 'python');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
if (!fs.existsSync(python)) run('python3', ['-m', 'venv', venv]);
run(python, [
  '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check',
  '--require-hashes', '--only-binary', ':all:', '-r', path.join(scripts, 'dmg-requirements.txt'),
]);

const { version } = require('../package.json');
const out = path.join(root, 'dist', `Gako-${version}-${process.arch}.dmg`);
run(python, [
  '-m', 'dmgbuild', '-s', path.join(scripts, 'dmg-settings.py'),
  '-D', `app=${app}`, '-D', `build=${path.join(shell, 'build')}`,
  'Gako', out,
]);
console.log(`disk image: ${out}`);

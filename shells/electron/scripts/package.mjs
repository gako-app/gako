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

// Packages Gako for this platform: Gako.app on macOS, Gako.exe and its folder on Windows, a gako
// folder on Linux, in dist/ at the repository root. Build the frontend and the core first, as the
// root `npm run package` does.
//
// The app is the Electron shell (main.cjs, preload.cjs) with the core binary and the built frontend
// added to its resources, where main.cjs looks for them once packaged.

import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const shell = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(shell, '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const core = path.join(root, 'core', 'target', 'release', `gako-core${exe}`);
const frontend = path.join(root, 'frontend', 'dist');
const notices = path.join(root, 'THIRD-PARTY-NOTICES.txt');
const licence = path.join(root, 'LICENSE');

for (const [what, p] of [['the core', core], ['the frontend', path.join(frontend, 'index.html')], ['the notices', notices], ['the licence', licence]]) {
  if (!fs.existsSync(p)) {
    console.error(`${what} isn't built (${p}); run \`npm run package\` from the repository root`);
    process.exit(1);
  }
}

const [out] = await packager({
  dir: shell,
  name: 'Gako',
  executableName: process.platform === 'linux' ? 'gako' : 'Gako',
  appBundleId: 'app.gako.desktop',
  appCategoryType: 'public.app-category.developer-tools',
  darwinDarkModeSupport: true,
  icon: path.join(shell, 'build', { darwin: 'icon.icns', win32: 'icon.ico' }[process.platform] ?? 'icon.png'),
  electronVersion: require('electron/package.json').version,
  out: path.join(root, 'dist'),
  overwrite: true,
  asar: true,
  prune: false,
  // The shell is two files; its dependencies are build tools.
  ignore: [/^\/build($|\/)/, /^\/scripts($|\/)/, /^\/node_modules($|\/)/],
  // Resources/gako-core, Resources/dist, and Gako's third-party notices.
  extraResource: [core, frontend, notices],
});

const resources = process.platform === 'darwin' ? path.join(out, 'Gako.app', 'Contents', 'Resources') : path.join(out, 'resources');

// Electron's own licence files come with the Electron the packager downloaded, beside the app. On
// Windows and Linux that's inside the app's folder; on macOS it's outside Gako.app, so they move
// into its resources, to be carried wherever the app is copied.
if (process.platform === 'darwin') {
  for (const f of ['LICENSE', 'LICENSES.chromium.html']) {
    const from = path.join(out, f);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(resources, f));
    else console.warn(`warning: Electron's ${f} wasn't in the package; the app goes without it`);
  }
}
// Gako's own licence goes in as GAKO-LICENSE.txt, clear of Electron's LICENSE on macOS.
fs.copyFileSync(licence, path.join(resources, 'GAKO-LICENSE.txt'));
console.log(`packaged: ${out}`);

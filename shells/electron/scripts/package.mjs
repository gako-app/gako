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
const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');

for (const [what, p] of [['the core', core], ['the frontend', path.join(frontend, 'index.html')], ['the notices', notices]]) {
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
  // Resources/gako-core, Resources/dist, and the licence notices: Gako's third-party notices and
  // Electron's own two files (which would otherwise sit beside the app, not in it).
  extraResource: [core, frontend, notices, path.join(electronDist, 'LICENSE'), path.join(electronDist, 'LICENSES.chromium.html')],
});
console.log(`packaged: ${out}`);

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

// Bare Electron shell: one window, gako-core as a child process, no app logic.
//
// Starts gako-core with a random token, reads the port from its first stdout line, and hands
// both to the frontend through the preload script. gako-core watches its stdin: when this process
// exits, even by crashing, the pipe closes and the core exits too.
//
// Run from the repository (`npm run app`), it uses the built core and frontend there; packaged
// (`npm run package`, scripts/package.mjs), it finds them in the app's resources.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

function findRoot() {
  for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'docs', 'PLAN.md')) && fs.existsSync(path.join(dir, 'core'))) return dir;
  }
  throw new Error('cannot find the repository root');
}

const exe = process.platform === 'win32' ? '.exe' : '';
// The core's root: the repository, or for the packaged app the user's home folder (where terminals
// opened without a folder start).
const root = process.env.GAKO_ROOT || (app.isPackaged ? app.getPath('home') : findRoot());
const coreBin = process.env.GAKO_CORE_BIN ||
  (app.isPackaged ? path.join(process.resourcesPath, `gako-core${exe}`) : path.join(root, 'core', 'target', 'release', `gako-core${exe}`));
const dist = app.isPackaged ? path.join(process.resourcesPath, 'dist') : path.join(root, 'frontend', 'dist');

app.setName('Gako');
// Chromium's own files (local storage, caches) apart from the core's settings.json, which lives in
// the same Gako folder. On Windows they go to the local AppData, not the roaming one, which a
// corporate profile may put on a network drive (where Chromium's caches end up locked or slow).
const chromiumData = process.platform === 'win32' && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : app.getPath('appData');
app.setPath('userData', path.join(chromiumData, 'Gako', 'Electron'));

// Chromium can't start its helper processes (graphics, the page) when Windows won't run them in
// their sandbox: most often because Gako was started from a network drive or a redirected folder.
// Chromium then retries and quits with only a console message, or leaves a blank window; this says
// what happened and what to do. One failed graphics start can be recovered from, so it takes three.
let gpuLaunchFailures = 0;
function launchFailed(what) {
  console.error(`gako: ${what} failed to start`);
  if (what === 'the GPU process' && ++gpuLaunchFailures < 3) return;
  const here = path.dirname(process.execPath);
  dialog.showErrorBox('Gako can\'t start',
    `Chromium, which Gako is built on, couldn't start ${what}.\n\n` +
    (process.platform === 'win32'
      ? `This usually happens when Gako runs from a network drive or a redirected folder. Gako is in:\n${here}\n\n` +
        'Copy the Gako folder to a local disk, such as C:\\Tools\\Gako, and start it from there.'
      : `Gako is in:\n${here}`));
  app.exit(1);
}
app.on('child-process-gone', (_e, d) => {
  if (d.reason === 'launch-failed') launchFailed(d.type === 'GPU' ? 'the GPU process' : `a helper process (${d.type})`);
  else if (d.reason !== 'clean-exit' && d.reason !== 'killed') console.error(`gako: ${d.type} process gone (${d.reason}, exit code ${d.exitCode})`);
});
app.on('render-process-gone', (_e, _wc, d) => {
  if (d.reason === 'launch-failed') launchFailed('the process that draws the window');
  else if (d.reason !== 'clean-exit' && d.reason !== 'killed') console.error(`gako: the window's process is gone (${d.reason}, exit code ${d.exitCode})`);
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// A folder on the command line (`electron . /path/to/base`, or `Gako /path/to/base` once packaged)
// becomes the workspace to open.
function baseFromArgs() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  return args.find((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isDirectory());
}

function startCore() {
  const token = crypto.randomBytes(32).toString('hex');
  const base = baseFromArgs();
  const core = spawn(coreBin, [], {
    env: {
      ...process.env,
      GAKO_TOKEN: token,
      GAKO_SHELL_KIND: 'electron',
      GAKO_ROOT: root,
      ...(base ? { GAKO_BASE: path.resolve(base) } : {}),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  core.on('exit', (code) => {
    if (!quitting) {
      console.error(`gako-core exited unexpectedly (${code})`);
      app.exit(1);
    }
  });
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: core.stdout });
    lines.once('line', (line) => {
      const ready = JSON.parse(line);
      resolve({ core, boot: { url: `ws://127.0.0.1:${ready.port}`, token, shell: 'electron' } });
    });
    core.once('error', reject);
  });
}

let quitting = false;
let core = null;

/** THIRD-PARTY-NOTICES.txt: in the app's resources, or at the repository root. */
const noticesFile = () => path.join(app.isPackaged ? process.resourcesPath : root, 'THIRD-PARTY-NOTICES.txt');
// Packaging renames it: on macOS, Electron's own LICENSE sits in the same folder.
const licenceFile = () => (app.isPackaged ? path.join(process.resourcesPath, 'GAKO-LICENSE.txt') : path.join(root, 'LICENSE'));

// The window comes back where it was left: its size and position (if they still fit a display) and
// whether it was maximised or full screen. The first time, it opens centred at up to 1600 × 1000.
// The bench always gets the same fixed size, so its measurements stay comparable.
const windowFile = () => path.join(app.getPath('userData'), 'window.json');

function savedWindow() {
  if (process.env.GAKO_BENCH) return null;
  try {
    const s = JSON.parse(fs.readFileSync(windowFile(), 'utf8'));
    const fits = screen.getAllDisplays().some(({ workArea: a }) =>
      s.x < a.x + a.width - 100 && s.x + s.width > a.x + 100 && s.y >= a.y - 10 && s.y < a.y + a.height - 100);
    return fits && s.width >= 400 && s.height >= 300 ? s : null;
  } catch {
    return null;
  }
}

function firstWindow() {
  if (process.env.GAKO_BENCH) return { width: 1600, height: 1000 };
  const a = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1600, Math.round(a.width * 0.85));
  const height = Math.min(1000, Math.round(a.height * 0.85));
  return { width, height, x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2) };
}

function rememberWindow(win) {
  if (process.env.GAKO_BENCH) return;
  const save = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    try {
      fs.writeFileSync(windowFile(), JSON.stringify({ ...b, maximized: win.isMaximized(), fullScreen: win.isFullScreen() }));
    } catch { /* not worth failing for */ }
  };
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, later);
  win.on('close', save);
}

/** The menu bar on macOS: Gako's own, without Electron's items. Windows and Linux get none (their
 * copy and paste shortcuts work without one). ⌘W isn't taken, so it reaches the page. */
function setMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Gako', submenu: [
      { role: 'about' },
      { label: 'Licence…', click: () => shell.openPath(licenceFile()) },
      { label: 'Third-Party Notices…', click: () => shell.openPath(noticesFile()) },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }, { type: 'separator' }]),
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]));
}

app.whenReady().then(async () => {
  setMenu();
  app.setAboutPanelOptions({
    applicationName: 'Gako',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 João Sena Ribeiro',
    credits: 'Free software under the GNU Affero General Public License, version 3 or later, with no warranty: Gako menu › Licence. Third-party software: Gako menu › Third-Party Notices',
  });
  // Packaged, the Dock icon comes from the app bundle; run from the repository, it's set here.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png'));

  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const started = await startCore();
  core = started.core;
  ipcMain.on('gako:boot', (e) => {
    e.returnValue = started.boot;
  });
  // The native folder picker, for "Open folder…": the path chosen, or null if cancelled.
  ipcMain.handle('gako:pickFolder', async (e, defaultPath) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Open a folder',
      buttonLabel: 'Open',
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });

  const saved = savedWindow();
  const win = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : firstWindow()),
    minWidth: 800,
    minHeight: 500,
    title: 'Gako',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (saved?.maximized) win.maximize();
  if (saved?.fullScreen) win.setFullScreen(true);
  rememberWindow(win);
  // Links (from terminal output) open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // bench/ measures what's drawn: a window left behind other apps counts as hidden on macOS and
  // stops drawing, so under the bench it comes to the front.
  if (process.env.GAKO_BENCH) win.once('ready-to-show', () => { app.focus({ steal: true }); win.moveTop(); });
  // bench/ sets GAKO_SCENARIO to drive the phase 0 measurement harness instead of the app.
  win.loadURL(process.env.GAKO_SCENARIO ? 'app://gako/bench.html' : 'app://gako/index.html');

  // Closing the window (or quitting) stops every agent running in it: ask first. The frontend says
  // which are running; the bench never asks.
  let confirmed = !!process.env.GAKO_BENCH;
  win.on('close', (e) => {
    if (confirmed) return;
    e.preventDefault();
    win.webContents.executeJavaScript('window.gakoRunning ? window.gakoRunning() : []')
      .catch(() => [])
      .then((running) => {
        if (running.length) {
          const n = running.length;
          const answer = dialog.showMessageBoxSync(win, {
            type: 'warning',
            message: `${n === 1 ? 'An agent is' : `${n} agents are`} still running`,
            detail: `${running.join(', ')}. Quitting Gako stops ${n === 1 ? 'it' : 'them'}.`,
            buttons: ['Quit', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
          });
          if (answer !== 0) {
            quitRequested = false;
            return;
          }
        }
        confirmed = true;
        if (quitRequested) app.quit();
        else win.close();
      });
  });
});

// ⌘Q closes the window first, so it asks the same question; a quit cancelled there is forgotten.
let quitRequested = false;
app.on('before-quit', () => { quitRequested = true; });

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  quitting = true;
  if (core && core.exitCode === null) {
    // Closing stdin is the normal stop signal; the kill is a fallback.
    core.stdin.end();
    setTimeout(() => core.exitCode === null && core.kill(), 2000).unref();
  }
});

// Bare Electron shell: one window, gako-core as a child process, no app logic.
//
// Starts gako-core with a random token, reads the port from its first stdout line, and hands
// both to the frontend through the preload script. gako-core watches its stdin: when this process
// exits, even by crashing, the pipe closes and the core exits too.
//
// Run from the repository (`npm run app`), it uses the built core and frontend there; packaged
// (`npm run package`, scripts/package.mjs), it finds them in the app's resources.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
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
// the same Gako folder.
app.setPath('userData', path.join(app.getPath('appData'), 'Gako', 'Electron'));

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

/** The menu bar on macOS: Gako's own, without Electron's items. Windows and Linux get none (their
 * copy and paste shortcuts work without one). ⌘W isn't taken, so it reaches the page. */
function setMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Gako', submenu: [
      { role: 'about' }, { type: 'separator' },
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
  app.setAboutPanelOptions({ applicationName: 'Gako', applicationVersion: app.getVersion(), copyright: 'Lucide icons: ISC licence' });
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

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Gako',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
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

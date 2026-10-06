// Bare Electron shell: one window, gako-core as a child process, no app logic.
//
// Starts gako-core with a random token, reads the port from its first stdout line, and hands
// both to the frontend through the preload script. gako-core watches its stdin: when this process
// exits, even by crashing, the pipe closes and the core exits too.

const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
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

const root = process.env.GAKO_ROOT || findRoot();
const exe = process.platform === 'win32' ? '.exe' : '';
const coreBin = process.env.GAKO_CORE_BIN || path.join(root, 'core', 'target', 'release', `gako-core${exe}`);
const dist = path.join(root, 'frontend', 'dist');

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

app.whenReady().then(async () => {
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
  // bench/ sets GAKO_SCENARIO to drive the phase 0 measurement harness instead of the app.
  win.loadURL(process.env.GAKO_SCENARIO ? 'app://gako/bench.html' : 'app://gako/index.html');
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  quitting = true;
  if (core && core.exitCode === null) {
    // Closing stdin is the normal stop signal; the kill is a fallback.
    core.stdin.end();
    setTimeout(() => core.exitCode === null && core.kill(), 2000).unref();
  }
});

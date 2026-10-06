// Renders build/icon.svg into the icon files the packaged app needs: icon.png (1024 px, and Linux's),
// icon.ico (Windows) and, on macOS, icon.icns. Run it with Electron, which draws the SVG:
//
//   npm run icons -w shells/electron
//
// The generated files are committed, so packaging doesn't depend on this script.

const { app, BrowserWindow, nativeImage } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const build = path.join(__dirname, '..', 'build');
const SIZE = 1024;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.dock?.hide();

/** An .ico holding PNG images (Windows Vista and later read these). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(build, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, transparent: true, frame: false,
    backgroundColor: '#00000000', webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const full = image.getSize().width === SIZE ? image : image.resize({ width: SIZE, height: SIZE, quality: 'best' });
  const png = (size) => (size === SIZE ? full : full.resize({ width: size, height: size, quality: 'best' })).toPNG();

  fs.writeFileSync(path.join(build, 'icon.png'), png(SIZE));
  fs.writeFileSync(path.join(build, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) }))));

  if (process.platform === 'darwin') {
    const set = fs.mkdtempSync(path.join(os.tmpdir(), 'gako-')) + '/icon.iconset';
    fs.mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${size}x${size}.png`), png(size));
      fs.writeFileSync(path.join(set, `icon_${size}x${size}@2x.png`), png(size * 2));
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')]);
    fs.rmSync(path.dirname(set), { recursive: true, force: true });
  }
  console.log('icons written to', build);
  app.quit();
});

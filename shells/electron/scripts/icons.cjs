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

// Renders build/icon.svg into the icon files the packaged app needs: icon.png (1024 px, and Linux's),
// icon.ico (Windows) and, on macOS, icon.icns; and build/dmg-background.svg into the macOS disk
// image's background, dmg-background.png and its Retina twin dmg-background@2x.png. Run it with
// Electron, which draws the SVGs:
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
// Each drawing closes its window; the app quits when all are done, not when the first one closes.
app.on('window-all-closed', () => {});

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

/** Draws an SVG file at `width` × `height` pixels, scaling it to fit. */
async function render(file, width, height) {
  const svg = fs.readFileSync(path.join(build, file), 'utf8')
    .replace(/(<svg\b[^>]*?)\swidth="\d+"\s+height="\d+"/, `$1 width="${width}" height="${height}"`);
  const win = new BrowserWindow({
    width, height, show: false, transparent: true, frame: false,
    backgroundColor: '#00000000', webPreferences: { offscreen: true },
  });
  const html = `<html><meta charset="utf-8"><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  win.destroy();
  return image.getSize().width === width ? image : image.resize({ width, height, quality: 'best' });
}

app.whenReady().then(async () => {
  const full = await render('icon.svg', SIZE, SIZE);
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
  fs.writeFileSync(path.join(build, 'dmg-background.png'), (await render('dmg-background.svg', 640, 360)).toPNG());
  fs.writeFileSync(path.join(build, 'dmg-background@2x.png'), (await render('dmg-background.svg', 1280, 720)).toPNG());
  console.log('icons and the disk image background written to', build);
  app.quit();
});

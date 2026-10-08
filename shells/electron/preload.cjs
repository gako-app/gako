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

// Hands the core's address and token to the frontend's boot module, the native folder picker, a
// way to open the About window, and the menu's call to show the settings. Nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__GAKO_BOOT__', ipcRenderer.sendSync('gako:boot'));
contextBridge.exposeInMainWorld('__GAKO_SHELL__', {
  pickFolder: (defaultPath) => ipcRenderer.invoke('gako:pickFolder', defaultPath ?? null),
  showAbout: (tab) => ipcRenderer.send('gako:showAbout', tab ?? 'about'),
  onShowSettings: (fn) => { ipcRenderer.on('gako:showSettings', () => fn()); },
});

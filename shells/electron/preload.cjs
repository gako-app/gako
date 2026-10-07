// Hands the core's address and token to the frontend's boot module, and the native folder picker.
// Nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__GAKO_BOOT__', ipcRenderer.sendSync('gako:boot'));
contextBridge.exposeInMainWorld('__GAKO_SHELL__', {
  pickFolder: (defaultPath) => ipcRenderer.invoke('gako:pickFolder', defaultPath ?? null),
});

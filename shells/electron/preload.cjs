// Hands the core's address and token to the frontend's boot module. Nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__GAKO_BOOT__', ipcRenderer.sendSync('gako:boot'));

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelApi', {
  onUpdate:    (cb) => ipcRenderer.on('panel-update',    (_, d) => cb(d)),
  openConsole: (tab) => ipcRenderer.send('panel-open-console', tab || 'approvals'),
  dismiss:     () => ipcRenderer.send('palette-dismiss'),
  searchUsers: (q)  => ipcRenderer.invoke('search-users', q),
  runAction:   (d)  => ipcRenderer.send('panel-run-action', d),
});

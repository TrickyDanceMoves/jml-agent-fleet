'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelApi', {
  onUpdate:    (cb) => {
    ipcRenderer.removeAllListeners('panel-update');
    ipcRenderer.on('panel-update', (_, d) => cb(d));
  },
  openConsole: (tab) => ipcRenderer.send('panel-open-console', tab || 'approvals'),
  close:       () => ipcRenderer.send('panel-close'),
  searchUsers: (q)  => ipcRenderer.invoke('search-users', q),
  runAction:   (d)  => ipcRenderer.send('panel-run-action', d),
  setPref:     (p)  => ipcRenderer.send('panel-pref', p),
  setMode:     (whatif) => ipcRenderer.send('panel-set-mode', { whatif }),
  resize:         (w)      => ipcRenderer.invoke('panel-resize', { width: w }),
  resizeTo:       (bounds) => ipcRenderer.invoke('panel-resize-to', bounds),
  slimResizeTo:   (bounds) => ipcRenderer.invoke('panel-slim-resize', bounds),
  saveBounds:      (b)           => ipcRenderer.send('panel-save-bounds', b),
  requestRefresh:  ()            => ipcRenderer.send('panel-request-refresh'),
  approvePending:    (id, token)   => ipcRenderer.invoke('panel-approve-pending', { id, writeToken: token }),
  rejectPending:     (id)          => ipcRenderer.invoke('panel-reject-pending', { id }),
  verifyPin:         (user, pin)   => ipcRenderer.invoke('verify-operator-pin', { user, pin }),
  getCurrentOperator: ()           => ipcRenderer.invoke('get-current-operator'),
  runQuickLeaver:    (payload)     => ipcRenderer.send('run-quick-leaver', payload),
  runQuickMover:     (payload)     => ipcRenderer.send('run-quick-mover', payload),
  onQuickOpResult:   (cb)          => ipcRenderer.on('quick-op-result', (_, d) => cb(d)),
  sendAgentMessage:  (agent, text) => ipcRenderer.send('send-message', { agent, text }),
  onAgentChunk:      (cb)          => ipcRenderer.on('msg-chunk',    (_, d) => cb(d)),
  onAgentComplete:   (cb)          => ipcRenderer.on('msg-complete', (_, d) => cb(d)),
  onAgentError:      (cb)          => ipcRenderer.on('msg-error',    (_, d) => cb(d)),
  clearAgentHistory: (agent)       => ipcRenderer.send('clear-history', { agent }),
  onSlimEdge:        (cb)          => ipcRenderer.on('slim-edge-changed', (_, e) => cb(e)),
});

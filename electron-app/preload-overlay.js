'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onInit:             (cb) => ipcRenderer.once('overlay-init', (_, d) => cb(d)),
  onUpdate:           (cb) => { ipcRenderer.removeAllListeners('overlay-update'); ipcRenderer.on('overlay-update', (_, d) => cb(d)); },
  close:              () => ipcRenderer.send('overlay-close'),
  resizeTo:           (b) => ipcRenderer.invoke('overlay-resize-to', b),
  searchUsers:        (q) => ipcRenderer.invoke('search-users', q),
  sendAgentMessage:   (agent, text) => ipcRenderer.send('send-message', { agent, text }),
  onAgentChunk:       (cb) => ipcRenderer.on('msg-chunk',    (_, d) => cb(d)),
  onAgentComplete:    (cb) => ipcRenderer.on('msg-complete', (_, d) => cb(d)),
  onAgentError:       (cb) => ipcRenderer.on('msg-error',    (_, d) => cb(d)),
  clearHistory:       (agent) => ipcRenderer.send('clear-history', { agent }),
  approvePending:     (id, token) => ipcRenderer.invoke('panel-approve-pending', { id, writeToken: token }),
  rejectPending:      (id) => ipcRenderer.invoke('panel-reject-pending', { id }),
  verifyPin:          (user, pin) => ipcRenderer.invoke('verify-operator-pin', { user, pin }),
  getCurrentOperator: () => ipcRenderer.invoke('get-current-operator'),
  setMode:            (whatif)   => ipcRenderer.send('panel-set-mode', { whatif }),
  getConversationHistory: (agent) => ipcRenderer.invoke('get-conversation-display', { agent }),
  onMsgMirror: (cb) => ipcRenderer.on('msg-mirror', (_, d) => cb(d)),
  onConversationReset: (cb) => ipcRenderer.on('conversation-reset', () => cb()),
  appQuit: () => ipcRenderer.send('app-quit'),
});

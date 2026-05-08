'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

contextBridge.exposeInMainWorld('api', {
  currentUser: os.userInfo().username,
  sendMessage:      (agent, text)    => ipcRenderer.send('send-message', { agent, text }),
  setMode:          (whatif)         => ipcRenderer.send('set-mode', { whatif }),
  clearHistory:     (agent)          => ipcRenderer.send('clear-history', { agent }),
  getAuditLog:       ()               => ipcRenderer.send('get-audit-log'),
  getDashboardStats: ()               => ipcRenderer.send('get-dashboard-stats'),
  getSecurityReports:()               => ipcRenderer.send('get-security-reports'),
  windowMinimize:   ()               => ipcRenderer.send('window-minimize'),
  windowMaximize:   ()               => ipcRenderer.send('window-maximize'),
  windowClose:      ()               => ipcRenderer.send('window-close'),

  onChunk:          (cb) => ipcRenderer.on('msg-chunk',       (_, d) => cb(d)),
  onComplete:       (cb) => ipcRenderer.on('msg-complete',    (_, d) => cb(d)),
  onError:          (cb) => ipcRenderer.on('msg-error',       (_, d) => cb(d)),
  onHistoryCleared: (cb) => ipcRenderer.on('history-cleared', (_, d) => cb(d)),
  onAuditLogData:    (cb) => ipcRenderer.on('audit-log-data',     (_, d) => cb(d)),
  onDashboardStats:  (cb) => ipcRenderer.on('dashboard-stats',    (_, d) => cb(d)),
  onSecurityReports: (cb) => ipcRenderer.on('security-reports',   (_, d) => cb(d)),

  getExportsStatus:   ()   => ipcRenderer.send('get-exports-status'),
  runBlobExport:      ()   => ipcRenderer.send('run-blob-export'),
  runSentinelIngest:  ()   => ipcRenderer.send('run-sentinel-ingest'),
  onExportsStatus:    (cb) => ipcRenderer.on('exports-status',      (_, d) => cb(d)),
  onExportRunResult:  (cb) => ipcRenderer.on('export-run-result',   (_, d) => cb(d))
});

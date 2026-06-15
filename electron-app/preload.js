'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

contextBridge.exposeInMainWorld('api', {
  currentUser: os.userInfo().username,
  demoClipSave:     (name, buf)      => ipcRenderer.invoke('demo-clip-save', { name, buf }),
  sendMessage:      (agent, text)    => ipcRenderer.send('send-message', { agent, text }),
  abortAgent:       (agent)          => ipcRenderer.send('abort-agent', { agent }),
  setMode:          (whatif)         => ipcRenderer.send('set-mode', { whatif }),
  clearHistory:     (agent)          => ipcRenderer.send('clear-history', { agent }),
  getAuditLog:       ()               => ipcRenderer.send('get-audit-log'),
  getOperationStatuses: ()            => ipcRenderer.send('get-operation-statuses'),
  exportEvidencePacket: (payload)     => ipcRenderer.invoke('export-evidence-packet', payload),
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
  onOperationStatus: (cb) => ipcRenderer.on('operation-status',   (_, d) => cb(d)),
  onOperationStatuses:(cb) => ipcRenderer.on('operation-statuses', (_, d) => cb(d)),
  onDashboardStats:  (cb) => ipcRenderer.on('dashboard-stats',    (_, d) => cb(d)),
  onSecurityReports: (cb) => ipcRenderer.on('security-reports',   (_, d) => cb(d)),

  getExportsStatus:   ()   => ipcRenderer.send('get-exports-status'),
  runBlobExport:      ()   => ipcRenderer.send('run-blob-export'),
  runSentinelIngest:  ()   => ipcRenderer.send('run-sentinel-ingest'),
  onExportsStatus:    (cb) => ipcRenderer.on('exports-status',      (_, d) => cb(d)),
  onExportRunResult:  (cb) => ipcRenderer.on('export-run-result',   (_, d) => cb(d)),

  getPendingApprovals: ()                  => ipcRenderer.send('get-pending-approvals'),
  approvePending:      (id, writeToken)    => ipcRenderer.send('approve-pending', { id, writeToken }),
  rejectPending:       (id)                => ipcRenderer.send('reject-pending',  { id }),
  onPendingApprovals:  (cb)     => ipcRenderer.on('pending-approvals', (_, d) => cb(d)),
  onApproveResult:     (cb)     => ipcRenderer.on('approve-result',    (_, d) => cb(d)),
  onRejectResult:      (cb)     => ipcRenderer.on('reject-result',     (_, d) => cb(d)),

  runBulkImport:       (rows, whatif) => ipcRenderer.send('run-bulk-import', { rows, whatif }),
  getScheduledOps:     ()             => ipcRenderer.send('get-scheduled-ops'),
  saveScheduledOp:     (op)           => ipcRenderer.send('save-scheduled-op', { op }),
  deleteScheduledOp:   (id)           => ipcRenderer.send('delete-scheduled-op', { id }),
  onBulkImportProgress:(cb)           => ipcRenderer.on('bulk-import-progress', (_, d) => cb(d)),
  onBulkImportComplete:(cb)           => ipcRenderer.on('bulk-import-complete',  (_, d) => cb(d)),
  onScheduledOps:      (cb)           => ipcRenderer.on('scheduled-ops',         (_, d) => cb(d)),
  onScheduledOpFired:  (cb)           => ipcRenderer.on('scheduled-op-fired',    (_, d) => cb(d)),

  runCertification:    (campaignType, whatif) => ipcRenderer.send('run-certification', { campaignType, whatif }),
  getCertHistory:      ()                     => ipcRenderer.send('get-cert-history'),
  onCertificationResult:(cb)                  => ipcRenderer.on('certification-result', (_, d) => cb(d)),
  onCertHistory:        (cb)                  => ipcRenderer.on('cert-history',          (_, d) => cb(d)),

  getPolicy:       ()               => ipcRenderer.send('get-policy'),
  savePolicy:      (policies, sod)  => ipcRenderer.send('save-policy', { policies, sod }),
  getOperators:    ()               => ipcRenderer.send('get-operators'),
  saveOperators:   (operators, roles) => ipcRenderer.send('save-operators', { operators, roles }),
  onPolicyData:    (cb)             => ipcRenderer.on('policy-data',       (_, d) => cb(d)),
  onPolicySaved:   (cb)             => ipcRenderer.on('policy-saved',      (_, d) => cb(d)),
  onOperatorsData: (cb)             => ipcRenderer.on('operators-data',    (_, d) => cb(d)),
  onOperatorsSaved:(cb)             => ipcRenderer.on('operators-saved',   (_, d) => cb(d)),

  getAgentHealth:  ()   => ipcRenderer.send('get-agent-health'),
  onAgentHealth:   (cb) => ipcRenderer.on('agent-health', (_, d) => cb(d)),

  // Agent quarantine (kill switch) — invoke, returns { ok, ... }
  quarantineAgent: (payload) => ipcRenderer.invoke('quarantine-agent', payload),

  // Policy simulation — read-only decision preview
  simulatePolicy: (payload) => ipcRenderer.invoke('simulate-policy', payload),

  // Access snapshot — read-only current state for before/after diff
  getAccessSnapshot: (upn) => ipcRenderer.invoke('get-access-snapshot', { upn }),

  getHrQueue:      ()   => ipcRenderer.send('get-hr-queue'),
  onHrQueue:       (cb) => ipcRenderer.on('hr-queue', (_, d) => cb(d)),

  // Feature: User Lookup
  searchUsers:          (query)  => ipcRenderer.send('search-users', { query }),
  getUserDetail:        (userId) => ipcRenderer.send('get-user-detail', { userId }),
  onUserSearchResults:  (cb)     => ipcRenderer.on('user-search-results', (_, d) => cb(d)),
  onUserDetail:         (cb)     => ipcRenderer.on('user-detail',         (_, d) => cb(d)),

  // Feature: Quick Mover / Leaver
  runQuickMover:  (payload) => ipcRenderer.send('run-quick-mover',  payload),
  runQuickLeaver: (payload) => ipcRenderer.send('run-quick-leaver', payload),
  onQuickOpResult:(cb)      => ipcRenderer.on('quick-op-result',    (_, d) => cb(d)),

  // Feature: Stale Accounts
  getStaleAccounts:     (days)    => ipcRenderer.send('get-stale-accounts',     { days }),
  disableStaleAccounts: (userIds) => ipcRenderer.send('disable-stale-accounts', { userIds }),
  onStaleAccounts:      (cb)      => ipcRenderer.on('stale-accounts',           (_, d) => cb(d)),
  onStaleDisableResult: (cb)      => ipcRenderer.on('stale-disable-result',     (_, d) => cb(d)),

  // Feature: License Utilization
  getLicenseUtilization: ()   => ipcRenderer.send('get-license-utilization'),
  onLicenseUtilization:  (cb) => ipcRenderer.on('license-utilization', (_, d) => cb(d)),

  // Feature: Certificate Expiry
  getCertExpiry:  ()   => ipcRenderer.send('get-cert-expiry'),
  onCertExpiry:   (cb) => ipcRenderer.on('cert-expiry', (_, d) => cb(d)),

  // Feature: SoD Tester
  testSodConflict: (payload) => ipcRenderer.send('test-sod-conflict', payload),
  onSodResult:     (cb)      => ipcRenderer.on('sod-result', (_, d) => cb(d)),

  // Feature: Graph Query Runner
  runGraphQuery:        (payload)     => ipcRenderer.send('run-graph-query', payload),
  onGraphQueryResult:   (cb)          => ipcRenderer.on('graph-query-result',    (_, d) => cb(d)),
  suggestGraphQuery:    (description) => ipcRenderer.send('suggest-graph-query', { description }),
  onGraphQuerySuggestion:(cb)         => ipcRenderer.on('graph-query-suggestion',(_, d) => cb(d)),
  digestGraphResult:    (payload)     => ipcRenderer.send('digest-graph-result', payload),
  onGraphDigest:        (cb)          => ipcRenderer.on('graph-digest',          (_, d) => cb(d)),

  // Feature: PIM Roles
  getPimRoles:         ()        => ipcRenderer.send('get-pim-roles'),
  activatePimRole:     (payload) => ipcRenderer.send('activate-pim-role', payload),
  onPimRoles:          (cb)      => ipcRenderer.on('pim-roles',           (_, d) => cb(d)),
  onPimActivateResult: (cb)      => ipcRenderer.on('pim-activate-result', (_, d) => cb(d)),

  // Entra operator sign-in (device code) — real directory identity instead of
  // trusting the local Windows username
  startEntraOperatorSignin: ()   => ipcRenderer.send('entra-signin-start'),
  onEntraDeviceCode:        (cb) => ipcRenderer.on('entra-device-code',   (_, d) => cb(d)),
  onEntraSigninResult:      (cb) => ipcRenderer.on('entra-signin-result', (_, d) => cb(d)),

  // Operator identity
  getOperatorsForLogin: ()             => ipcRenderer.invoke('get-operators-for-login'),
  getCurrentOperator:   ()             => ipcRenderer.invoke('get-current-operator'),
  selectOperator:       (name, role)   => ipcRenderer.send('select-operator', { name, role }),
  switchOperator:       (name, role)   => ipcRenderer.send('switch-operator',  { name, role }),
  onOperatorSwitched:   (cb)           => ipcRenderer.on('operator-switched',  (_, d) => cb(d)),

  // Operator authentication (PIN / Windows) — for write-access gating
  getOperatorAuth:        ()                  => ipcRenderer.invoke('get-operator-auth'),
  setOperatorAuthPin:     (user, pin)         => ipcRenderer.invoke('set-operator-auth-pin', { user, pin }),
  setOperatorAuthWindows: (user)              => ipcRenderer.invoke('set-operator-auth-windows', { user }),
  verifyOperatorPin:      (user, pin)         => ipcRenderer.invoke('verify-operator-pin', { user, pin }),

  // Tenant onboarding (read/write agent config.json TenantId across the fleet)
  getTenantConfig:        ()                  => ipcRenderer.invoke('get-tenant-config'),
  previewTenantConfig:    (payload)           => ipcRenderer.invoke('preview-tenant-config', payload),
  saveTenantConfig:       (payload)           => ipcRenderer.invoke('save-tenant-config', payload),

  // Operator activity log
  getOperatorActivity:    (limit)             => ipcRenderer.invoke('get-operator-activity', { limit }),

  // Notification routing rules
  getNotificationRules:   ()                  => ipcRenderer.invoke('get-notification-rules'),
  saveNotificationRules:  (rules)             => ipcRenderer.invoke('save-notification-rules', { rules }),

  // Tenant onboarding wizard
  startDeviceCodeSignin:        ()              => ipcRenderer.invoke('start-device-code-signin'),
  checkDeviceCodeStatus:        ()              => ipcRenderer.invoke('check-device-code-status'),
  createAgentAppRegistrations:  (names)         => ipcRenderer.invoke('create-agent-app-registrations', { agentNames: names }),

  // First-run setup
  completeFirstRun: (data)  => ipcRenderer.invoke('complete-first-run', data),
  skipFirstRun:     ()      => ipcRenderer.invoke('skip-first-run'),

  // Integrations config
  getIntegrationsConfig:  ()       => ipcRenderer.invoke('get-integrations-config'),
  saveIntegrationsConfig: (config) => ipcRenderer.invoke('save-integrations-config', { config }),

  // AI Provider configuration
  getAiProviderConfig:  ()       => ipcRenderer.invoke('get-ai-provider-config'),
  saveAiProviderConfig: (config) => ipcRenderer.invoke('save-ai-provider-config', { config }),
  testAiProvider:       ()       => ipcRenderer.invoke('test-ai-provider'),
  getAiTraces:          (limit)  => ipcRenderer.invoke('get-ai-traces', { limit }),

  // Open external URL in default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Sign out — closes main window, returns to operator select
  signOut: () => ipcRenderer.send('sign-out'),

  // Hard quit — terminates the entire application process
  appQuit: () => ipcRenderer.send('app-quit'),

  // Avatar file picker — uses Electron native dialog (reliable vs hidden input)
  pickImageFile: () => ipcRenderer.invoke('pick-image-file'),

  // Docked panel toggle
  toggleDockedPanel: () => ipcRenderer.invoke('toggle-docked-panel'),
  // Agent overlay toggle
  toggleOverlay: () => ipcRenderer.send('toggle-overlay'),
  onDockedPanelState: (cb) => {
    ipcRenderer.removeAllListeners('docked-panel-state');
    ipcRenderer.on('docked-panel-state', (_, v) => cb(v));
  },
  // Mode sync from docked panel
  onModeChanged: (cb) => ipcRenderer.on('mode-changed', (_, d) => cb(d)),

  // Window state
  onMaximized:    (cb) => ipcRenderer.on('window-maximized', (_, v) => cb(v)),
  onOverlayState: (cb) => ipcRenderer.on('overlay-state',    (_, v) => cb(v)),

  // Cross-window conversation sync
  getConversationHistory: (agent) => ipcRenderer.invoke('get-conversation-display', { agent }),
  onMsgMirror: (cb) => ipcRenderer.on('msg-mirror', (_, d) => cb(d)),
});

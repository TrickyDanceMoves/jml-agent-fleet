'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu, Notification, globalShortcut, screen, shell } = require('electron');
const { execFileSync, execFile, spawnSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

const AGENTS_DIR    = app.isPackaged
  ? path.join(process.resourcesPath, 'agents')
  : path.join(__dirname, '..');
const APP_ICON      = nativeImage.createFromPath(path.join(__dirname, 'Assets', 'icon-rounded.png'));
const TRAY_ICON     = nativeImage.createFromPath(path.join(__dirname, 'Assets', 'tray-icon.png'));
const REPORTS_DIR   = path.join(__dirname, '..', 'auditor', 'reports');
const TENANT_DOMAIN   = 'contoso.onmicrosoft.com';
const SETUP_FILE      = path.join(AGENTS_DIR, 'approver', 'setup.json');
const INT_CONFIG_FILE = path.join(AGENTS_DIR, 'approver', 'integrations.config.json');

// Stamp every child process with the console operator identity so Write-AuditEntry picks it up
process.env.JML_CONSOLE_OPERATOR = os.userInfo().username;

// BOM-safe JSON file reader — config files saved by PS/VS Code may have UTF-8 BOM
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').split(String.fromCharCode(0xFEFF)).join(''));
}

const PENDING_DIR    = path.join(AGENTS_DIR, 'approver', 'pending');
const SCHEDULED_FILE = path.join(AGENTS_DIR, 'approver', 'scheduled.json');
const POLICIES_FILE  = path.join(AGENTS_DIR, 'approver', 'policies.json');
const SOD_FILE       = path.join(AGENTS_DIR, 'shared', 'sod-policy.json');
const OPERATORS_FILE = path.join(AGENTS_DIR, 'approver', 'operators.json');
const OPERATOR_AUTH_FILE = path.join(AGENTS_DIR, 'approver', 'operator-auth.json');
const OPERATOR_ACTIVITY_FILE = path.join(AGENTS_DIR, 'approver', 'operator-activity.jsonl');
const PANEL_BOUNDS_FILE      = path.join(__dirname, 'panel-bounds.json');
const AI_PROVIDER_CONFIG_FILE = path.join(AGENTS_DIR, 'approver', 'ai-provider.json');

function loadPanelBounds() { try { return JSON.parse(fs.readFileSync(PANEL_BOUNDS_FILE, 'utf8')); } catch { return null; } }
function savePanelBounds(b) { try { fs.writeFileSync(PANEL_BOUNDS_FILE, JSON.stringify(b)); } catch {} }
const CERT_SCRIPT    = path.join(AGENTS_DIR, 'certifier', 'Invoke-CertificationCampaign.ps1');
const AGENT_DIRS     = ['joiner','mover','leaver','enroller','approver','provisioner','auditor'];

// ── AI provider abstraction ───────────────────────────────────────────────────
const { loadConfig: _loadProviderConfig, saveConfig: _saveProviderConfig, buildProvider } = require('./providers');
let _aiProviderConfig = null;
let _cachedProvider   = null; // invalidated whenever config is saved

function _ensureProviderConfig() {
  if (!_aiProviderConfig) _aiProviderConfig = _loadProviderConfig(AI_PROVIDER_CONFIG_FILE);
}

function getAIProvider() {
  _ensureProviderConfig();
  if (!_cachedProvider) _cachedProvider = buildProvider(_aiProviderConfig);
  return _cachedProvider;
}

// AI observability — append a trace line per model turn (provider, model, latency,
// tokens). Gives Foundry-style run telemetry regardless of which provider is active.
const AI_TRACES_FILE = path.join(AGENTS_DIR, 'approver', 'ai-traces.jsonl');
function recordAITrace(agent, trace) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), agent, ...trace });
    fs.appendFileSync(AI_TRACES_FILE, line + '\n', 'utf8');
  } catch {}
}

// ── Agent state ───────────────────────────────────────────────────────────────
const state = {
  approver: { messages: [], whatif: true, lastRisk: null, abortController: null },
  auditor:  { messages: [], abortController: null }
};

// ── System prompts ────────────────────────────────────────────────────────────
// Reads PrimaryDomain from the first available agent config; falls back to TENANT_DOMAIN.
function getActiveTenantDomain() {
  for (const agent of AGENT_DIRS) {
    try {
      const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = readJson(cfgPath);
        if (cfg.PrimaryDomain) return cfg.PrimaryDomain;
      }
    } catch {}
  }
  return TENANT_DOMAIN;
}

function buildApproverSystem(domain) { return `
You are the Approver Agent for a JML identity lifecycle management system.
You are the intelligent gatekeeper for identity change requests in Microsoft Entra ID.

Tenant: ${domain}
UPN format: firstname.lastname@${domain}

Request types:
JOINER: givenName, surname, userPrincipalName (auto-generate from name), department, jobTitle, usageLocation (2-letter ISO), manager?, licenses?, groups?
ENROLLER: userPrincipalName, licenses?, groups?
MOVER: userPrincipalName + at least one of: newDepartment, newJobTitle, newManager, licensesToAdd, licensesToRemove, groupsToAdd, groupsToRemove
LEAVER: userPrincipalName (two-stage: Soft then Hard)

Rules:
- Never invent or guess values
- Always confirm full details before calling a tool
- For leavers, explain the two-stage process and confirm each stage
- Auto-generate UPNs as firstname.lastname@${domain}
- Use lookup_user to verify a user exists (or disambiguate a partial name) before operating on them
- Use list_available_licenses / list_groups to confirm exact SKU and group names before assigning them

AI-ASSISTED PROVISIONING:

For JOINER and MOVER requests — only call suggest_provisioning if the operator explicitly
asks for suggestions (e.g. "what should I assign?", "any recommendations?") or appears
unsure about which licenses or groups to use. Do not call it automatically. If they
already know what they want, proceed directly without suggesting.

For ALL operations in LIVE mode — before calling any submit_* tool, call score_risk with
the full operation details. Then:
- riskLevel 'low' or 'medium': show the assessment briefly, then proceed.
- riskLevel 'high': show the risk reasons and ask the operator to explicitly confirm
  before continuing.
- riskLevel 'critical' or blocked=true: do NOT proceed. Explain the block clearly.
- dualApproval=true: inform the operator that a second approval token is required.

In WHATIF mode score_risk is informational — show it but don't gate on it.

OPERATOR ROLE CONTEXT:
Current operator role: ${currentRole || 'unknown'}

Role-based action boundaries:
- admin: full authority — can submit all operation types including Hard leavers in Live mode.
- helpdesk: can submit Joiners, Enrollers, Movers, and Soft leavers in Live mode.
  Hard leavers are always escalated to the admin approval queue — inform the operator
  that after submitting, an admin must approve from the Approvals tab before execution.
  If a Soft leaver is blocked (user holds privileged roles), it is also escalated.
- viewer: read-only — all submit tools are blocked. Remind the operator to switch to
  an admin or helpdesk account.

When the current operator is helpdesk and they request a Hard leaver:
1. Acknowledge that it will be submitted for admin approval.
2. Proceed with submit_leaver_hard — the system will automatically route it.
3. Show the approval token and tell them to notify an admin.

FORMATTING RULES (always follow):
- Always write UPNs in full (e.g. sarah.chen@${domain}). Never abbreviate to "..." or truncate the domain.
- Do not use # or ## markdown headings in responses. Use **bold** labels or plain prose instead.
- Keep responses concise. Lead with the result, add context below.
`.trim(); }

function buildAuditorSystem(domain) { return `
You are the JML Audit Agent -- a read-only intelligence layer over Microsoft Entra ID.
Tenant: ${domain}

You NEVER suggest or make changes to the directory. Strictly observational.

You have two roles:

1. TENANT INTELLIGENCE: Answer questions about the live tenant state using your query tools.
   Available: user counts, license utilization, recent joins/leavers, admin roles, group summary, JML activity, stale accounts, guest users, single-user deep dive (query_user_detail).
   Present numbers prominently. Offer follow-up queries when results are interesting.

2. OPERATIONAL GUIDE: Answer "how do I" questions about the JML system itself -- without calling any tools.
   You know the following about this system:

   WORKFLOW: New hire → Joiner (creates account) → Enroller (licenses + devices) → Mover (if role changes) → Leaver (offboarding)

   JOINER requires: First name, last name, department, job title, usage location (2-letter country code, e.g. US).
   UPN is auto-generated as firstname.lastname@${domain}. Optional: manager UPN, license SKUs, group names.

   ENROLLER: Run after Joiner completes. Needs only the UPN. Assigns enrollment licenses, adds to onboarding groups, inventories registered devices.

   MOVER requires: UPN + at least one change (new department, job title, manager, licenses to add/remove, groups to add/remove).

   LEAVER is two stages:
   - Soft (Stage 1): disables account, revokes all sign-in sessions. Reversible.
   - Hard (Stage 2): removes all licenses and group memberships. Not automatically reversible.
   Always requires a ticket reference (e.g. INC-1234) for audit compliance.

   WHATIF MODE: Runs the full logic but makes no changes to the directory. Use to preview any operation.

   RISK LEVELS: WhatIf (safe preview) → Joiner/Enroller (low risk, creates/adds) → Mover (medium, modifies) → Leaver Soft (high, disables) → Leaver Hard (critical, removes access)

   TICKET REFERENCE: Required for Leavers. Recommended for Movers. Optional for Joiners/Enrollers.

   LICENSE SKUs in this tenant: Microsoft_Entra_Suite, INTUNE_D

   DUAL APPROVAL: Leaver Soft requires a second operator to approve via --approve=<TOKEN> before execution.

   FREEZE WINDOWS: Identity changes are blocked on weekends (Saturday and Sunday, all day).

FORMATTING RULES (always follow):
- Always write UPNs in full (e.g. sarah.chen@${domain}). Never abbreviate to "..." or truncate the domain.
- Do not use # or ## markdown headings. Use **bold** labels or plain prose to organize information.
- Tables are fine. Bullets are fine. Headings are not needed for data responses.
- Keep responses concise and direct. Lead with the answer, details below.
`.trim(); }

// ── Tool definitions ──────────────────────────────────────────────────────────
const APPROVER_TOOLS = [
  {
    name: 'submit_joiner',
    description: 'Create a new Entra ID user account.',
    input_schema: {
      type: 'object',
      properties: {
        givenName:          { type: 'string' },
        surname:            { type: 'string' },
        userPrincipalName:  { type: 'string' },
        department:         { type: 'string' },
        jobTitle:           { type: 'string' },
        usageLocation:      { type: 'string' },
        manager:            { type: 'string' },
        licenses:           { type: 'array',  items: { type: 'string' } },
        groups:             { type: 'array',  items: { type: 'string' } },
        mobilePhone:        { type: 'string' },
        officeLocation:     { type: 'string' }
      },
      required: ['givenName', 'surname', 'userPrincipalName', 'department', 'jobTitle', 'usageLocation']
    }
  },
  {
    name: 'submit_enroller',
    description: 'Enroll a user: assign licenses, add to groups, inventory devices.',
    input_schema: {
      type: 'object',
      properties: {
        userPrincipalName: { type: 'string' },
        licenses:          { type: 'array', items: { type: 'string' } },
        groups:            { type: 'array', items: { type: 'string' } }
      },
      required: ['userPrincipalName']
    }
  },
  {
    name: 'submit_mover',
    description: 'Update an existing user account for a role or department change.',
    input_schema: {
      type: 'object',
      properties: {
        userPrincipalName: { type: 'string' },
        newDepartment:     { type: 'string' },
        newJobTitle:       { type: 'string' },
        newManager:        { type: 'string' },
        licensesToAdd:     { type: 'array', items: { type: 'string' } },
        licensesToRemove:  { type: 'array', items: { type: 'string' } },
        groupsToAdd:       { type: 'array', items: { type: 'string' } },
        groupsToRemove:    { type: 'array', items: { type: 'string' } }
      },
      required: ['userPrincipalName']
    }
  },
  {
    name: 'suggest_provisioning',
    description: 'Get peer-based license and group recommendations for a new hire or mover. Call this after learning their department and job title.',
    input_schema: {
      type: 'object',
      properties: {
        department: { type: 'string', description: 'The user\'s department' },
        jobTitle:   { type: 'string', description: 'The user\'s job title' }
      },
      required: ['department', 'jobTitle']
    }
  },
  {
    name: 'score_risk',
    description: 'Score a provisioning operation for risk before executing it in Live mode. Returns riskLevel, score, reasons, and whether the operation is blocked.',
    input_schema: {
      type: 'object',
      properties: {
        operation:         { type: 'string', enum: ['joiner','enroller','mover','leaver_soft','leaver_hard'] },
        userPrincipalName: { type: 'string', description: 'Target UPN. Use NEW_USER for joiners who don\'t exist yet.' },
        licenses:          { type: 'array', items: { type: 'string' }, description: 'License SKU names being assigned' },
        groups:            { type: 'array', items: { type: 'string' }, description: 'Group display names being assigned' },
        newDepartment:     { type: 'string', description: 'For movers: the destination department' }
      },
      required: ['operation', 'userPrincipalName']
    }
  },
  {
    name: 'submit_leaver_soft',
    description: 'Stage 1 leaver: disable account and revoke all sign-in sessions.',
    input_schema: {
      type: 'object',
      properties: { userPrincipalName: { type: 'string' } },
      required: ['userPrincipalName']
    }
  },
  {
    name: 'submit_leaver_hard',
    description: 'Stage 2 leaver: remove all licenses and group memberships.',
    input_schema: {
      type: 'object',
      properties: { userPrincipalName: { type: 'string' } },
      required: ['userPrincipalName']
    }
  },
  {
    name: 'lookup_user',
    description: 'Look up a user by UPN or display name. Returns profile, account status, manager, licenses, and group memberships. Call this to verify a user exists or to disambiguate a partial name before operating on them.',
    input_schema: {
      type: 'object',
      properties: { upnOrName: { type: 'string', description: 'Full UPN, or display-name prefix to search' } },
      required: ['upnOrName']
    }
  },
  {
    name: 'list_available_licenses',
    description: 'List license SKUs in the tenant with assigned / total / available counts. Call before assigning licenses to confirm availability and exact SKU names.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'list_groups',
    description: 'List groups in the tenant, optionally filtered by display-name prefix. Call to confirm exact group names before assigning.',
    input_schema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Display-name prefix filter' } },
      required: []
    }
  }
];

const AUDITOR_TOOLS = [
  { name: 'query_user_summary',   description: 'Count breakdown: total, enabled, disabled, members, guests.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_license_report', description: 'License SKU utilization: assigned / total / available.',        input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_recent_joins',   description: 'Accounts created in last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, topN: { type: 'integer' } }, required: [] } },
  { name: 'query_recent_leavers', description: 'Accounts disabled in last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, topN: { type: 'integer' } }, required: [] } },
  { name: 'query_admin_roles',    description: 'All populated directory roles and members.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_group_summary',  description: 'Group breakdown: unified / dynamic / security.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_jml_activity',   description: 'Recent JML agent operations from local audit log.',
    input_schema: { type: 'object', properties: { topN: { type: 'integer' } }, required: [] } },
  { name: 'query_stale_accounts', description: 'Enabled accounts with no sign-in in last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, topN: { type: 'integer' } }, required: [] } },
  { name: 'query_guest_users',    description: 'External/guest accounts.',
    input_schema: { type: 'object', properties: { topN: { type: 'integer' } }, required: [] } },
  { name: 'query_user_detail',    description: 'Deep-dive a single user by UPN or display name: profile, status, manager, licenses, groups, last sign-in.',
    input_schema: { type: 'object', properties: { upnOrName: { type: 'string' } }, required: ['upnOrName'] } }
];

// ── PS1 dispatch ──────────────────────────────────────────────────────────────
function writePayloadFile(payload) {
  const p = path.join(os.tmpdir(), 'jml-payload-' + Date.now() + '.json');
  fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  return p;
}

function runPs(scriptPath, params = {}) {
  if (!fs.existsSync(scriptPath)) throw new Error('Script not found: ' + scriptPath);
  const args = ['-NonInteractive', '-File', scriptPath];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'boolean') { if (v) args.push('-' + k); }
    else if (Array.isArray(v))  { args.push('-' + k, v.join(',')); }
    else                        { args.push('-' + k, String(v)); }
  }
  return execFileSync('powershell', args, { encoding: 'utf8', timeout: 120000 });
}

function runPsAsync(scriptPath, params = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(scriptPath)) { reject(new Error('Script not found: ' + scriptPath)); return; }
    const args = ['-NonInteractive', '-File', scriptPath];
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean') { if (v) args.push('-' + k); }
      else if (Array.isArray(v))  { args.push('-' + k, v.join(',')); }
      else                        { args.push('-' + k, String(v)); }
    }
    execFile('powershell', args, { encoding: 'utf8', timeout: 120000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// ── System tray + toast notifications ────────────────────────────────────────
let tray              = null;
let dockedWin         = null;
let overlayWin        = null;
let overlayAnchorY    = null;
let paletteWin        = null;
let quitting          = false;
let dockedKeepConsole = false;

// ── Panel/palette preload path ────────────────────────────────────────────────
const PANEL_PRELOAD   = path.join(__dirname, 'preload-panel.js');
const OVERLAY_PRELOAD = path.join(__dirname, 'preload-overlay.js');

// ── Conversation display history (persisted in memory for cross-window sync) ──
// Stores the rendered turn history per agent so overlay/docked can replay them.
const _convHistory = { approver: [], auditor: [] };
const CONV_HISTORY_MAX = 80; // max turns kept per agent

function _pushConvTurn(agent, role, text) {
  if (!_convHistory[agent]) return;
  _convHistory[agent].push({ role, text, ts: Date.now() });
  if (_convHistory[agent].length > CONV_HISTORY_MAX) _convHistory[agent].shift();
}

/** Broadcast a mirrored turn to all windows EXCEPT the originating sender */
function _broadcastMirror(senderContents, agent, role, text) {
  const targets = [win, overlayWin, dockedWin].filter(
    w => w && !w.isDestroyed() && w.webContents !== senderContents
  );
  targets.forEach(w => w.webContents.send('msg-mirror', { agent, role, text }));
}

// ── Push live data to docked panel / overlay ─────────────────────────────────
function pushPanelUpdate(partial) {
  if (dockedWin && !dockedWin.isDestroyed()) {
    dockedWin.webContents.send('panel-update', partial);
  }
  // Mirror approval/mode data to overlay
  if (overlayWin && !overlayWin.isDestroyed()) {
    const mirror = {};
    if (partial.pendingList !== undefined) mirror.pendingList = partial.pendingList;
    if (partial.approvals   !== undefined) mirror.approvals   = partial.approvals;
    if (partial.mode        !== undefined) mirror.mode        = partial.mode;
    if (Object.keys(mirror).length) overlayWin.webContents.send('overlay-update', mirror);
  }
}

function pushOverlayUpdate(partial) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay-update', partial);
  }
}

// ── Cert expiry polling ───────────────────────────────────────────────────────
const _certAlerted = new Set();
function pollCertExpiry() {
  try {
    const agents = ['joiner','mover','leaver','enroller','approver','auditor'];
    const certs  = agents.map(ag => {
      try {
        const cfg = readJson(path.join(AGENTS_DIR, ag, 'config.json'));
        const exp = cfg.CertExpiry || cfg.certExpiry;
        const days = exp ? Math.ceil((new Date(exp) - Date.now()) / 86400000) : null;
        return { agent: ag, daysLeft: days };
      } catch { return { agent: ag, daysLeft: null }; }
    });
    // Send to docked panel
    pushPanelUpdate({ certs });
    // Toast when a cert is within 30 days and we haven't alerted yet
    certs.forEach(c => {
      if (c.daysLeft != null && c.daysLeft <= 30 && !_certAlerted.has(c.agent)) {
        _certAlerted.add(c.agent);
        sendToast(
          'Cert Expiring — ' + c.agent,
          `The ${c.agent} agent certificate expires in ${c.daysLeft} day${c.daysLeft !== 1 ? 's' : ''}. Renew via Agent Certs.`
        );
      }
    });
  } catch {}
}

// ── Last-event polling ────────────────────────────────────────────────────────
let _lastEventTs = null;
function pollLastEvent() {
  try {
    const logDirs = ['joiner','mover','leaver','enroller','approver','auditor'].map(ag =>
      path.join(AGENTS_DIR, ag, 'logs')
    );
    const allEvents = [];
    for (const dir of logDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 2);
      for (const f of files) {
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && allEvents.length < 20; i--) {
          try { allEvents.push(JSON.parse(lines[i])); } catch {}
        }
      }
    }
    const recent = allEvents
      .filter(e => e && e.timestamp)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 3);
    if (recent.length && recent[0].timestamp !== _lastEventTs) {
      _lastEventTs = recent[0].timestamp;
      pushPanelUpdate({ recentEvents: recent });
    }
  } catch {}
}

async function pollHrQueue() {
  try {
    const { QueueServiceClient } = require('@azure/storage-queue');
    const qClient = QueueServiceClient.fromConnectionString('UseDevelopmentStorage=true');
    const queue   = qClient.getQueueClient('jml-hr-events');
    const props   = await queue.getProperties();
    const count   = props.approximateMessageCount || 0;
    let oldestMin = null;
    if (count > 0) {
      try {
        const peek = await queue.peekMessages({ numberOfMessages: 1 });
        const msg  = peek.peekedMessageItems && peek.peekedMessageItems[0];
        if (msg && msg.insertedOn) {
          oldestMin = Math.round((Date.now() - new Date(msg.insertedOn)) / 60000);
        }
      } catch {}
    }
    pushPanelUpdate({ hrQueue: { count, oldestMin } });
  } catch { /* Azurite not running — leave last known panel state intact */ }
}

function showMainWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

function buildTrayMenu() {
  const pendingCount = fs.existsSync(PENDING_DIR)
    ? fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).length : 0;
  return Menu.buildFromTemplate([
    { label: 'Show Console',  click: showMainWindow },
    { label: pendingCount > 0 ? `Approvals — ${pendingCount} pending` : 'Approvals', click: () => { showMainWindow(); } },
    { type: 'separator' },
    { label: dockedWin && !dockedWin.isDestroyed() ? 'Hide Docked Panel' : 'Show Docked Panel',
      click: () => {
        if (dockedWin && !dockedWin.isDestroyed()) {
          dockedWin.isVisible() ? dockedWin.hide() : dockedWin.show();
        } else { createDockedPanel(); }
      }
    },
    { label: 'Agent Overlay (Ctrl+Shift+Space)', click: toggleOverlayWindow },
    { type: 'separator' },
    { label: 'Quit JML Console', click: () => {
      const choice = dialog.showMessageBoxSync({
        type: 'question', buttons: ['Quit', 'Cancel'],
        defaultId: 1, cancelId: 1,
        title: 'Quit JML Console',
        message: 'Are you sure you want to quit?',
        detail: 'The app will stop running and tray notifications will be disabled.'
      });
      if (choice === 0) { quitting = true; app.quit(); }
    }}
  ]);
}

function createTray() {
  tray = new Tray(TRAY_ICON);
  tray.setToolTip('JML Fleet Console');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => { tray.setContextMenu(buildTrayMenu()); });
  tray.on('double-click', showMainWindow);
}

function pushFreshPanelData() {
  try {
    const files = fs.existsSync(PENDING_DIR)
      ? fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')) : [];
    const count = files.length;
    let oldestApproval = null;
    files.forEach(f => {
      try {
        const d = readJson(path.join(PENDING_DIR, f));
        const ts = d.requestedAt || d.timestamp || d.submittedAt;
        if (ts && (!oldestApproval || new Date(ts) < new Date(oldestApproval))) oldestApproval = ts;
      } catch {}
    });
    pushPanelUpdate({
      approvals: count, oldestApproval,
      mode: state.approver.whatif ? 'safe' : 'live',
      keepConsole: dockedKeepConsole
    });
  } catch {}
  pollCertExpiry();
  pollLastEvent();
  pollHrQueue();
}

function createDockedPanel() {
  if (dockedWin && !dockedWin.isDestroyed()) { dockedWin.show(); dockedWin.focus(); return; }
  const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = screen.getPrimaryDisplay().workArea;
  const saved = loadPanelBounds();
  const W = saved ? Math.max(220, Math.min(640, saved.width))               : 280;
  const H = saved ? Math.max(220, Math.min(wa_h - 20, saved.height))        : Math.min(600, wa_h - 40);
  const X = saved ? Math.max(wa_x, Math.min(wa_x + wa_w - W, saved.x))     : wa_x + wa_w - W - 8;
  const Y = saved ? Math.max(wa_y, Math.min(wa_y + wa_h - H, saved.y))     : wa_y + Math.round((wa_h - H) / 2);
  dockedWin = new BrowserWindow({
    width: W, height: H, x: X, y: Y,
    frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    transparent: true,
    icon: APP_ICON,
    backgroundColor: '#00000000',
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  dockedWin.setContentProtection(true);
  dockedWin.loadFile(path.join(__dirname, 'renderer', 'docked.html'));
  dockedWin.on('closed', () => { dockedWin = null; });
  dockedWin.on('moved', () => {
    if (!dockedWin || dockedWin.isDestroyed()) return;
    const [wx, wy] = dockedWin.getPosition();
    const [ww, wh] = dockedWin.getSize();
    const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = screen.getPrimaryDisplay().workArea;

    // ── Slim mode: detect nearest edge and snap + reorient ──
    if (ww <= 220 || wh <= 160) {
      const cx = wx + ww / 2;
      const cy = wy + wh / 2;
      const dRight  = Math.abs(cx - (wa_x + wa_w));
      const dLeft   = Math.abs(cx - wa_x);
      const dTop    = Math.abs(cy - wa_y);
      const dBottom = Math.abs(cy - (wa_y + wa_h));
      const minD = Math.min(dRight, dLeft, dTop, dBottom);

      let edge, nx, ny, nw, nh;
      const clampX = (w) => Math.max(wa_x, Math.min(wa_x + wa_w - w, Math.round(cx - w / 2)));
      const clampY = (h) => Math.max(wa_y, Math.min(wa_y + wa_h - h, Math.round(cy - h / 2)));

      if (minD === dRight)  { edge = 'right';  nw = 200; nh = 220; nx = wa_x + wa_w - nw; ny = clampY(nh); }
      else if (minD === dLeft)   { edge = 'left';   nw = 200; nh = 220; nx = wa_x;              ny = clampY(nh); }
      else if (minD === dTop)    { edge = 'top';    nw = 300; nh = 160; nx = clampX(nw);         ny = wa_y;       }
      else                       { edge = 'bottom'; nw = 300; nh = 160; nx = clampX(nw);         ny = wa_y + wa_h - nh; }

      // Overlay collision avoidance: offset slim pill if overlay is parked at the same edge
      if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
        const [ov_x, ov_y] = overlayWin.getPosition();
        const [ov_w, ov_h] = overlayWin.getSize();
        const ov_r = ov_x + ov_w, ov_b = ov_y + ov_h;
        const OV_GAP = 8;
        if ((edge === 'right' && ov_r >= wa_x + wa_w - 20) ||
            (edge === 'left'  && ov_x <= wa_x + 20)) {
          if (ny < ov_b + OV_GAP && ny + nh > ov_y - OV_GAP) {
            const spaceAbove = ov_y - OV_GAP - wa_y;
            const spaceBelow = (wa_y + wa_h) - (ov_b + OV_GAP);
            if (spaceAbove >= nh)        ny = ov_y - OV_GAP - nh;
            else if (spaceBelow >= nh)   ny = ov_b + OV_GAP;
            ny = Math.max(wa_y, Math.min(wa_y + wa_h - nh, ny));
          }
        } else if ((edge === 'top'    && ov_y <= wa_y + 20) ||
                   (edge === 'bottom' && ov_b >= wa_y + wa_h - 20)) {
          if (nx < ov_r + OV_GAP && nx + nw > ov_x - OV_GAP) {
            const spaceLeft  = ov_x - OV_GAP - wa_x;
            const spaceRight = (wa_x + wa_w) - (ov_r + OV_GAP);
            if (spaceLeft >= nw)         nx = ov_x - OV_GAP - nw;
            else if (spaceRight >= nw)   nx = ov_r + OV_GAP;
            nx = Math.max(wa_x, Math.min(wa_x + wa_w - nw, nx));
          }
        }
      }
      dockedWin.setBounds({ x: nx, y: ny, width: nw, height: nh }, false);
      dockedWin.webContents.send('slim-edge-changed', edge);
      return;
    }

    // ── Normal mode: snap to nearby edges ──
    const SNAP = 18;
    let nx = wx, ny = wy;
    if (Math.abs(wx - wa_x) <= SNAP)                   nx = wa_x;
    if (Math.abs(wx + ww - (wa_x + wa_w)) <= SNAP)     nx = wa_x + wa_w - ww;
    if (Math.abs(wy - wa_y) <= SNAP)                   ny = wa_y;
    if (Math.abs(wy + wh - (wa_y + wa_h)) <= SNAP)     ny = wa_y + wa_h - wh;
    if (nx !== wx || ny !== wy) {
      dockedWin.setPosition(nx, ny);
      savePanelBounds({ x: nx, y: ny, width: ww, height: wh });
    }
  });
  dockedWin.webContents.once('did-finish-load', () => {
    pushFreshPanelData();
    // Overlay rich sample data so the panel shows meaningful content in dev
    setTimeout(() => pushPanelUpdate(buildMockPanelData()), 300);
  });
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.show(); overlayWin.focus(); return; }
  const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = screen.getPrimaryDisplay().workArea;
  const W = 460;
  const H = 88;
  overlayAnchorY = wa_y + Math.round(wa_h * 0.72);
  const X = wa_x + Math.round((wa_w - W) / 2);
  const Y = overlayAnchorY - H;
  overlayWin = new BrowserWindow({
    width: W, height: H, x: X, y: Y,
    frame: false, resizable: true,
    alwaysOnTop: true, skipTaskbar: true,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: OVERLAY_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  overlayWin.setContentProtection(true);
  overlayWin.setMinimumSize(300, 88);
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; overlayAnchorY = null; });
  overlayWin.on('moved', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const [wx, wy] = overlayWin.getPosition();
    const [ww, wh] = overlayWin.getSize();
    const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = screen.getPrimaryDisplay().workArea;
    const SNAP = 24;
    let nx = wx, ny = wy;
    if (Math.abs(wx - wa_x) <= SNAP)               nx = wa_x;
    if (Math.abs(wx + ww - (wa_x + wa_w)) <= SNAP) nx = wa_x + wa_w - ww;
    if (Math.abs(wy - wa_y) <= SNAP)               ny = wa_y;
    if (Math.abs(wy + wh - (wa_y + wa_h)) <= SNAP) ny = wa_y + wa_h - wh;
    if (nx !== wx || ny !== wy) overlayWin.setPosition(nx, ny);
  });
  overlayWin.webContents.once('did-finish-load', () => {
    overlayWin.webContents.send('overlay-init', { anchorY: overlayAnchorY, winX: X, winW: W });
    // Push current approval state
    try {
      const files = fs.existsSync(PENDING_DIR) ? fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')) : [];
      const pendingList = files.map(f => {
        try {
          const d = readJson(path.join(PENDING_DIR, f));
          return { id: d.id || f.replace('.json',''), tool: d.tool, severity: d.severity,
            requestedBy: d.requestedBy, requestedByRole: d.requestedByRole,
            requestedAt: d.requestedAt, input: d.input };
        } catch { return null; }
      }).filter(Boolean);
      pushOverlayUpdate({ approvals: files.length, pendingList, mode: state.approver.whatif ? 'safe' : 'live' });
    } catch {}
  });
}

function toggleOverlayWindow() {
  const sendOverlayState = (v) => { if (win && !win.isDestroyed()) win.webContents.send('overlay-state', v); };
  if (!overlayWin || overlayWin.isDestroyed()) { createOverlayWindow(); sendOverlayState(true); return; }
  if (overlayWin.isVisible()) { overlayWin.hide(); sendOverlayState(false); } else { overlayWin.show(); overlayWin.focus(); sendOverlayState(true); }
}

function createPaletteWindow() {
  if (paletteWin && !paletteWin.isDestroyed()) {
    paletteWin.show(); paletteWin.focus(); return;
  }
  const { x: pw_x, y: pw_y, width: pw_w, height: pw_h } = screen.getPrimaryDisplay().workArea;
  const W = 600, H = 460;
  paletteWin = new BrowserWindow({
    width: W, height: H,
    x: pw_x + Math.round((pw_w - W) / 2), y: pw_y + Math.round(pw_h * 0.18),
    frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    transparent: true,
    icon: APP_ICON,
    backgroundColor: '#00000000',
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  paletteWin.loadFile(path.join(__dirname, 'renderer', 'palette.html'));
  paletteWin.on('blur', () => { if (paletteWin && !paletteWin.isDestroyed()) paletteWin.close(); });
  paletteWin.on('closed', () => { paletteWin = null; });
}

function sendToast(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: APP_ICON, silent: false });
  n.on('click', showMainWindow);
  n.show();
}

let _lastApprovalCount = -1;
function pollTrayApprovals() {
  try {
    const count = fs.existsSync(PENDING_DIR)
      ? fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).length
      : 0;
    if (_lastApprovalCount >= 0 && count > _lastApprovalCount) {
      const diff = count - _lastApprovalCount;
      sendToast(
        'Pending Approval' + (diff > 1 ? 's' : ''),
        diff + ' new approval request' + (diff > 1 ? 's' : '') + ' awaiting admin sign-off.'
      );
    }
    _lastApprovalCount = count;
    tray && tray.setToolTip('JML Fleet Console' + (count ? ' · ' + count + ' pending' : ''));
    let oldestApproval = null;
    if (count > 0) {
      const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
      files.forEach(f => {
        try {
          const d = readJson(path.join(PENDING_DIR, f));
          const ts = d.requestedAt || d.timestamp || d.submittedAt;
          if (ts && (!oldestApproval || new Date(ts) < new Date(oldestApproval))) oldestApproval = ts;
        } catch {}
      });
    }
    // Build trimmed list for panel cards
    let pendingList = [];
    if (count > 0) {
      const files2 = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
      pendingList = files2.map(f => {
        try {
          const d = readJson(path.join(PENDING_DIR, f));
          return { id: d.id || f.replace('.json',''), tool: d.tool, severity: d.severity,
                   requestedBy: d.requestedBy, requestedByRole: d.requestedByRole,
                   requestedAt: d.requestedAt || d.timestamp,
                   input: { userPrincipalName: d.input?.userPrincipalName } };
        } catch { return null; }
      }).filter(Boolean).sort((a,b) => new Date(a.requestedAt) - new Date(b.requestedAt));
    }
    pushPanelUpdate({ approvals: count, oldestApproval, pendingList });
  } catch {}
}

function routeBlockedLeaverToApproval(input, stage, reason, requiredApproverRole) {
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const reqRole = requiredApproverRole || 'admin';
  const record = {
    id: token, token,
    tool: 'submit_leaver_' + stage.toLowerCase(),
    severity: 'crit',
    requestedBy: currentOperator || 'helpdesk',
    requestedByRole: currentRole,
    requiredApproverRole: reqRole,
    requestedAt: new Date().toISOString(),
    input: { userPrincipalName: input.userPrincipalName, stage, ticketRef: input.ticketRef || '' },
    note: reason || 'Hard-stage leaver submitted by helpdesk — admin approval required to execute.',
    status: 'pending'
  };
  fs.writeFileSync(path.join(PENDING_DIR, token + '.json'), JSON.stringify(record, null, 2), 'utf8');
  sendToast('Admin Approval Required', (input.userPrincipalName || 'User') + ' queued for admin sign-off.');
  return token;
}

// Extract and parse JSON from PowerShell stdout that may contain non-JSON
// header lines or pretty-printed (multi-line) ConvertTo-Json output.
function _parseMultilineJson(raw, emptyMsg) {
  const trimmed = raw.trim();
  if (!trimmed) return { error: emptyMsg || 'No output from script' };
  // Fast path: entire output is valid JSON
  try { return JSON.parse(trimmed); } catch {}
  // Slow path: find a { ... } or [ ... ] block spanning multiple lines.
  // Avoid log lines like "[Certifier]" by only accepting "[" or "[{"/"[]".
  const ls = trimmed.split('\n');
  const isStart = (line) => {
    const t = line.trim();
    return t.startsWith('{') || t === '[' || t.startsWith('[{') || t.startsWith('[]');
  };
  for (let start = 0; start < ls.length; start++) {
    if (!isStart(ls[start])) continue;
    const t = ls[start].trim();
    const close = t.startsWith('{') ? '}' : ']';
    for (let end = ls.length - 1; end >= start; end--) {
      if (!ls[end].trim().endsWith(close)) continue;
      const block = ls.slice(start, end + 1).join('\n');
      try { return JSON.parse(block); } catch {}
    }
  }
  return { error: 'JSON parse error: no parseable object or array found', raw: trimmed.slice(0, 400) };
}

function parsePs1Output(raw) {
  const lines = raw.trim().split('\n');
  const visible = lines.filter(l => /\[(ACTION|ERROR|WARN|SKIP|WHATIF)\]/.test(l))
                       .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\] /, '').trim());
  // Use _parseMultilineJson to handle both inline and pretty-printed ConvertTo-Json output
  const parsed = _parseMultilineJson(raw);
  const data = parsed && !parsed.error ? parsed : null;
  return { lines: visible, data };
}

const AUDITOR_QUERY_MAP = {
  query_user_summary:   'UserSummary',
  query_license_report: 'LicenseReport',
  query_recent_joins:   'RecentJoins',
  query_recent_leavers: 'RecentLeavers',
  query_admin_roles:    'AdminRoles',
  query_group_summary:  'GroupSummary',
  query_jml_activity:   'JMLActivity',
  query_stale_accounts: 'StaleAccounts',
  query_guest_users:    'GuestUsers'
};

function executeTool(agent, toolName, input, whatif) {
  if (agent === 'auditor') {
    if (toolName === 'query_user_detail') {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-LookupUser.ps1'), { UpnOrName: input.upnOrName });
      return _parseMultilineJson(raw, 'No output from user lookup script');
    }
    const queryType = AUDITOR_QUERY_MAP[toolName];
    const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1');
    const params = { QueryType: queryType };
    if (input.days) params.Days = input.days;
    if (input.topN) params.TopN = input.topN;
    const raw = runPs(script, params);
    return _parseMultilineJson(raw, 'No output from auditor query script');
  }

  const w = whatif ? true : false;

  // LIVE-mode risk gate: every submit_* in Live mode requires a fresh score_risk
  // result. The gate is enforced here — not just in the system prompt — so a
  // prompt-injected or confused model cannot skip the risk assessment.
  if (toolName.startsWith('submit_') && !w) {
    const risk = state.approver.lastRisk;
    if (!risk) {
      return { error: 'RISK_GATE: Call score_risk before any Live submit operation.' };
    }
    if (risk.blocked) {
      return { error: 'RISK_GATE: Operation is blocked. Reasons: ' + (risk.reasons || []).join('; ') };
    }
    if (risk.riskLevel === 'critical') {
      return { error: 'RISK_GATE: Risk level is critical — operation refused. Reasons: ' + (risk.reasons || []).join('; ') };
    }
    state.approver.lastRisk = null; // consumed — next submit needs a fresh score
  }

  switch (toolName) {
    case 'lookup_user': {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-LookupUser.ps1'), { UpnOrName: input.upnOrName });
      return _parseMultilineJson(raw, 'No output from user lookup script');
    }
    case 'list_available_licenses': {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1'), { QueryType: 'LicenseReport' });
      return _parseMultilineJson(raw, 'No output from license report');
    }
    case 'list_groups': {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-ListGroups.ps1'), input.filter ? { Filter: input.filter } : {});
      return _parseMultilineJson(raw, 'No output from group list script');
    }
    case 'suggest_provisioning': {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-ProvisioningRecommendation.ps1'), {
        Department: input.department,
        JobTitle:   input.jobTitle
      });
      return _parseMultilineJson(raw, 'No output from recommendation script');
    }
    case 'score_risk': {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-RiskScore.ps1'), {
        Operation:         input.operation,
        UserPrincipalName: input.userPrincipalName,
        Licenses:          input.licenses,
        Groups:            input.groups,
        NewDepartment:     input.newDepartment
      });
      const res = _parseMultilineJson(raw, 'No output from risk score script');
      if (res && !res.error) state.approver.lastRisk = { ...res, ts: Date.now() };
      return res;
    }
    case 'submit_joiner': {
      const _pf = writePayloadFile({
        givenName: input.givenName, surname: input.surname,
        userPrincipalName: input.userPrincipalName, department: input.department,
        jobTitle: input.jobTitle, usageLocation: input.usageLocation,
        manager: input.manager, licenses: input.licenses, groups: input.groups,
        mobilePhone: input.mobilePhone, officeLocation: input.officeLocation,
        ticketRef: input.ticketRef
      });
      try { return parsePs1Output(runPs(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: _pf, WhatIf: w })); }
      finally { try { fs.unlinkSync(_pf); } catch {} }
    }
    case 'submit_enroller': {
      // Invoke-EnrollerProcess.ps1 takes -PayloadPath (JSON), NOT -UserPrincipalName.
      // It reads payload.userPrincipalName / payload.licenses / payload.groups.
      const _pfEnr = writePayloadFile({
        userPrincipalName: input.userPrincipalName,
        licenses: input.licenses,
        groups: input.groups,
        ticketRef: input.ticketRef
      });
      try { return parsePs1Output(runPs(path.join(AGENTS_DIR, 'enroller', 'Invoke-EnrollerProcess.ps1'), { PayloadPath: _pfEnr, WhatIf: w })); }
      finally { try { fs.unlinkSync(_pfEnr); } catch {} }
    }
    case 'submit_mover':
      {
        const _pf = writePayloadFile({
          userPrincipalName: input.userPrincipalName,
          department: input.newDepartment,
          jobTitle: input.newJobTitle,
          manager: input.newManager,
          licensesToAdd: input.licensesToAdd,
          licensesToRemove: input.licensesToRemove,
          groupsToAdd: input.groupsToAdd,
          groupsToRemove: input.groupsToRemove,
          ticketRef: input.ticketRef
        });
        try { return parsePs1Output(runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: _pf, WhatIf: w })); }
        finally { try { fs.unlinkSync(_pf); } catch {} }
      }
    case 'submit_leaver_soft':
    case 'submit_leaver_hard': {
      const _stage = toolName === 'submit_leaver_hard' ? 'Hard' : 'Soft';
      // Helpdesk operators cannot execute Hard leavers directly — always route to admin approval.
      // Soft leavers pass through with OperatorRole check; the PS1 blocks further if user
      // holds privileged roles and returns the BLOCKED sentinel.
      if (currentRole === 'helpdesk' && _stage === 'Hard' && !w) {
        const _tok = routeBlockedLeaverToApproval(input, _stage,
          'Hard-stage leaver (license + group removal) submitted by helpdesk — admin sign-off required before execution.',
          'admin');
        return { approvalQueued: true, token: _tok, message: 'Hard-stage leavers require admin approval. Request queued — an admin operator must approve from the Approvals tab.' };
      }
      if (currentRole === 'helpdesk' && _stage === 'Hard' && w) {
        return { approvalRequired: true, message: 'Hard-stage leavers require admin approval in Live mode. This request would be queued for admin sign-off.' };
      }
      try {
        return parsePs1Output(runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
          UserPrincipalName: input.userPrincipalName, Stage: _stage, WhatIf: w, OperatorRole: currentRole
        }));
      } catch (_lErr) {
        const _stdout = _lErr.stdout || _lErr.message || '';
        // Soft leaver blocked by PS1 because user holds privileged roles → escalate
        if (currentRole === 'helpdesk' && !w && _stdout.includes('BLOCKED: Operator role')) {
          const _tok = routeBlockedLeaverToApproval(input, _stage,
            'User holds privileged Entra directory roles — admin approval required to proceed.',
            'admin');
          return { approvalQueued: true, token: _tok, message: 'User holds privileged roles. Approval request submitted — an admin operator must approve from the Approvals tab.' };
        }
        if (currentRole === 'helpdesk' && w && _stdout.includes('BLOCKED: Operator role')) {
          return { approvalRequired: true, message: 'This user holds privileged roles. In Live mode, this leaver would be routed to the Approvals tab for admin sign-off.' };
        }
        throw _lErr;
      }
    }
    default:
      return { error: 'Unknown tool: ' + toolName };
  }
}

// ── AI agent loop (provider-agnostic streaming) ───────────────────────────────
async function runAgentLoop(sender, agent, userText) {
  const provider = getAIProvider();
  if (!provider) {
    sender.send('msg-error', { agent, text: 'AI provider not configured. Open Settings → AI Provider to add an API key.' });
    return;
  }

  const agentState = state[agent];
  agentState.messages.push({ role: 'user', content: userText });

  const domain       = getActiveTenantDomain();
  const systemPrompt = agent === 'approver' ? buildApproverSystem(domain) : buildAuditorSystem(domain);
  const tools        = agent === 'approver' ? APPROVER_TOOLS  : AUDITOR_TOOLS;

  // Stop button support: abort() cancels the in-flight provider stream
  const ac = new AbortController();
  agentState.abortController = ac;

  let _fullText = '';

  try {
    while (true) {
      let response;
      try {
        response = await provider.streamTurn({
          system:      systemPrompt,
          tools,
          messages:    agentState.messages,
          signal:      ac.signal,
          onText:      (text) => { sender.send('msg-chunk', { agent, type: 'text', text }); _fullText += text; },
          onToolStart: (toolName) => { sender.send('msg-chunk', { agent, type: 'tool_start', toolName }); }
        });
      } catch (err) {
        if (ac.signal.aborted) break; // operator pressed Stop — end the turn quietly
        throw err;
      }

      agentState.messages.push({ role: 'assistant', content: response.content });
      if (response.trace) recordAITrace(agent, response.trace);

      if (response.stopReason === 'end_turn') break;

      const toolCalls  = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const tool of toolCalls) {
        sender.send('msg-chunk', { agent, type: 'tool_running', toolName: tool.name });
        let result;
        try {
          result = executeTool(agent, tool.name, tool.input, agentState.whatif);
          // Pass structured result for cards that render it (risk score, provisioning suggestions)
          const sendResult = (tool.name === 'score_risk' || tool.name === 'suggest_provisioning') ? result : undefined;
          sender.send('msg-chunk', { agent, type: 'tool_done', toolName: tool.name, success: true, result: sendResult });
        } catch (err) {
          result = { error: err.message };
          sender.send('msg-chunk', { agent, type: 'tool_done', toolName: tool.name, success: false });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
      }

      if (toolResults.length > 0) {
        agentState.messages.push({ role: 'user', content: toolResults });
      } else {
        break;
      }
    }
  } finally {
    agentState.abortController = null;
  }

  _pushConvTurn(agent, 'assistant', _fullText);
  _broadcastMirror(sender, agent, 'assistant', _fullText);
  sender.send('msg-complete', { agent });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.on('send-message', (event, { agent, text }) => {
  // Store and mirror the user turn before the agent responds
  _pushConvTurn(agent, 'user', text);
  _broadcastMirror(event.sender, agent, 'user', text);
  runAgentLoop(event.sender, agent, text).catch(err => {
    event.sender.send('msg-error', { agent, text: err.message });
  });
});

ipcMain.on('abort-agent', (_, { agent }) => {
  const ctrl = state[agent] && state[agent].abortController;
  if (ctrl) ctrl.abort();
});

// Return stored display history for a given agent (used on overlay/docked open)
ipcMain.handle('get-conversation-display', (_, { agent }) => {
  return _convHistory[agent] || [];
});

ipcMain.on('set-mode', (event, { whatif }) => {
  state.approver.whatif = whatif;
  pushPanelUpdate({ mode: whatif ? 'safe' : 'live' });
});

ipcMain.on('panel-pref', (_, prefs) => {
  if (typeof prefs.keepConsole === 'boolean') dockedKeepConsole = prefs.keepConsole;
});

ipcMain.on('panel-set-mode', (_, { whatif }) => {
  state.approver.whatif = whatif;
  pushPanelUpdate({ mode: whatif ? 'safe' : 'live' });
  if (win && !win.isDestroyed()) win.webContents.send('mode-changed', { whatif });
});

ipcMain.handle('panel-resize', (_, { width }) => {
  if (!dockedWin || dockedWin.isDestroyed()) return;
  const { x: wa_x, width: wa_w } = screen.getPrimaryDisplay().workArea;
  const W = Math.max(220, Math.min(640, Math.round(width)));
  const H = dockedWin.getSize()[1];
  const X = wa_x + wa_w - W - 8;
  const Y = dockedWin.getPosition()[1];
  dockedWin.setSize(W, H);
  dockedWin.setPosition(X, Y);
  savePanelBounds({ x: X, y: Y, width: W, height: H });
});

ipcMain.handle('panel-resize-to', (_, { x, y, width, height }) => {
  if (!dockedWin || dockedWin.isDestroyed()) return;
  const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = screen.getPrimaryDisplay().workArea;
  const W = Math.max(220, Math.min(640, Math.round(width)));
  const H = Math.max(220, Math.min(900, Math.round(height)));
  const X = Math.max(wa_x, Math.min(wa_x + wa_w - W, Math.round(x)));
  const Y = Math.max(wa_y, Math.min(wa_y + wa_h - H, Math.round(y)));
  dockedWin.setBounds({ x: X, y: Y, width: W, height: H }, false);
});

ipcMain.handle('panel-slim-resize', (_, { x, y, width, height, edge }) => {
  if (!dockedWin || dockedWin.isDestroyed()) return;
  const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = screen.getPrimaryDisplay().workArea;
  const W = Math.max(24, Math.min(640, Math.round(width)));
  const H = Math.max(24, Math.min(wa_h, Math.round(height)));
  // Snap flush to the specified edge, or right edge by default
  let X, Y;
  const clampX = Math.max(wa_x, Math.min(wa_x + wa_w - W, Math.round(x)));
  const clampY = Math.max(wa_y, Math.min(wa_y + wa_h - H, Math.round(y)));
  if (edge === 'left')        { X = wa_x;              Y = clampY; }
  else if (edge === 'top')    { X = clampX;             Y = wa_y;   }
  else if (edge === 'bottom') { X = clampX;             Y = wa_y + wa_h - H; }
  else                        { X = wa_x + wa_w - W;   Y = clampY; } // right (default)
  dockedWin.setBounds({ x: X, y: Y, width: W, height: H }, false);
});

ipcMain.handle('overlay-resize-to', (_, { x, y, width, height }) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = screen.getPrimaryDisplay().workArea;
  const W = Math.max(300, Math.min(800, Math.round(width)));
  const H = Math.max(88, Math.min(700, Math.round(height)));
  const X = Math.max(wa_x, Math.min(wa_x + wa_w - W, Math.round(x)));
  const Y = Math.max(wa_y, Math.min(wa_y + wa_h - H, Math.round(y)));
  overlayWin.setBounds({ x: X, y: Y, width: W, height: H }, false);
});

ipcMain.on('overlay-close', () => {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
});

ipcMain.on('toggle-overlay', toggleOverlayWindow);

ipcMain.on('clear-history', (event, { agent }) => {
  state[agent].messages = [];
  event.sender.send('history-cleared', { agent });
});

ipcMain.on('get-audit-log', (event) => {
  const auditPath = path.join(AGENTS_DIR, 'audit.jsonl');
  if (!fs.existsSync(auditPath)) { event.sender.send('audit-log-data', []); return; }
  const lines   = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  event.sender.send('audit-log-data', entries.reverse());
});

// ── Evidence packet export ──────────────────────────────────────────────────────
// Assembles a tamper-evident compliance evidence packet from selected audit entries.
// Integrity is proven by shelling out to the authoritative Verify-AuditLog.ps1 (the
// PowerShell verifier reproduces the exact hash format the writer used) rather than
// re-implementing the hash in JS, which would be fragile across PS/JSON formatting.
ipcMain.handle('export-evidence-packet', async (event, payload) => {
  const { hashes } = payload || {};
  try {
    const auditPath = path.join(AGENTS_DIR, 'audit.jsonl');
    if (!fs.existsSync(auditPath)) return { ok: false, error: 'No audit log found.' };

    const all = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Filter to requested entries (by hash); empty/absent → whole log
    const wanted = Array.isArray(hashes) && hashes.length
      ? all.filter(e => hashes.includes(e.hash))
      : all;
    if (!wanted.length) return { ok: false, error: 'No matching entries to export.' };

    // Authoritative chain integrity check via the PowerShell verifier
    let integrity = 'not run';
    try {
      const verifyScript = path.join(AGENTS_DIR, 'shared', 'Verify-AuditLog.ps1');
      const out = execFileSync('powershell',
        ['-NonInteractive', '-File', verifyScript, '-AuditLogPath', auditPath],
        { encoding: 'utf8', timeout: 60000 });
      const line = out.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
      integrity = line;
    } catch (e) {
      const out = (e.stdout || '').toString().trim().split('\n').map(l => l.trim()).filter(Boolean).pop();
      integrity = out || ('verification error: ' + e.message);
    }

    const packet = {
      packetType: 'JML Agent Fleet — Compliance Evidence Packet',
      generatedAt: new Date().toISOString(),
      generatedBy: process.env.JML_CONSOLE_OPERATOR || 'unknown',
      tenantDomain: getActiveTenantDomain(),
      entryCount: wanted.length,
      chainIntegrity: integrity,
      entries: wanted.map(e => ({
        timestamp: e.timestamp,
        agent:     e.agent,
        action:    e.action,
        subject:   e.subject,
        operator:  e.operator || null,
        mode:      e.whatif ? 'Safe (WhatIf)' : 'Live',
        outcome:   e.outcome,
        ticketRef: (e.details && e.details.ticketRef) || null,
        details:   e.details || {},
        prevHash:  e.prevHash,
        hash:      e.hash
      }))
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Evidence Packet',
      defaultPath: `jml-evidence-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    fs.writeFileSync(filePath, JSON.stringify(packet, null, 2), 'utf8');
    return { ok: true, path: filePath, count: wanted.length, integrity };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('get-dashboard-stats', async (event) => {
  try {
    const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1');
    if (!fs.existsSync(script)) { event.sender.send('dashboard-stats', { error: 'Auditor not configured' }); return; }
    const parseJ = raw => { const l = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop(); return l ? JSON.parse(l) : {}; };
    const [userRaw, licenseRaw, activityRaw] = await Promise.all([
      runPsAsync(script, { QueryType: 'UserSummary' }),
      runPsAsync(script, { QueryType: 'LicenseReport' }),
      runPsAsync(script, { QueryType: 'JMLActivity', TopN: '5' })
    ]);
    event.sender.send('dashboard-stats', {
      users:    parseJ(userRaw),
      licenses: parseJ(licenseRaw),
      activity: parseJ(activityRaw)
    });
  } catch (err) {
    event.sender.send('dashboard-stats', { error: err.message });
  }
});

ipcMain.on('get-security-reports', (event) => {
  function latestReport(prefix) {
    if (!fs.existsSync(REPORTS_DIR)) return null;
    const files = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort().reverse();
    if (!files.length) return null;
    try { return readJson(path.join(REPORTS_DIR, files[0])); }
    catch { return null; }
  }
  event.sender.send('security-reports', {
    ueba:       latestReport('ueba-'),
    drift:      latestReport('drift-'),
    riskyUsers: latestReport('risky-users-')
  });
});

// ── Exports tab ───────────────────────────────────────────────────────────────
ipcMain.on('get-exports-status', (event) => {
  function readStatus(file) {
    try { return readJson(file); } catch { return null; }
  }
  const base = path.join(REPORTS_DIR);
  event.sender.send('exports-status', {
    blob:     readStatus(path.join(base, 'blob-export-status.json')),
    sentinel: readStatus(path.join(base, 'sentinel-ingest-status.json')) || readStatus(path.join(base, 'sentinel-status.json'))
  });
});

ipcMain.on('run-blob-export', async (event) => {
  const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-BlobExport.ps1');
  try {
    await runPsAsync(script);
    const statusPath = path.join(REPORTS_DIR, 'blob-export-status.json');
    const status = fs.existsSync(statusPath) ? readJson(statusPath) : null;
    event.sender.send('export-run-result', { type: 'blob', ok: true, status });
  } catch (err) {
    event.sender.send('export-run-result', { type: 'blob', ok: false, error: err.message });
  }
});

ipcMain.on('run-sentinel-ingest', async (event) => {
  const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-SentinelIngest.ps1');
  try {
    await runPsAsync(script);
    const statusPath = path.join(REPORTS_DIR, 'sentinel-ingest-status.json');
    const status = fs.existsSync(statusPath) ? readJson(statusPath) : null;
    event.sender.send('export-run-result', { type: 'sentinel', ok: true, status });
  } catch (err) {
    event.sender.send('export-run-result', { type: 'sentinel', ok: false, error: err.message });
  }
});

// ── Scheduled ops helpers ─────────────────────────────────────────────────────
function loadScheduled() {
  if (!fs.existsSync(SCHEDULED_FILE)) return [];
  try { return readJson(SCHEDULED_FILE); } catch { return []; }
}

function saveScheduled(ops) {
  const dir = path.dirname(SCHEDULED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(ops, null, 2), 'utf8');
}

// ── Docked panel / palette IPC ────────────────────────────────────────────────
function toggleDockedPanel() {
  const sendState = (v) => { if (win && !win.isDestroyed()) win.webContents.send('docked-panel-state', v); };
  if (!dockedWin || dockedWin.isDestroyed()) {
    createDockedPanel();
    if (!dockedKeepConsole && win && !win.isDestroyed()) win.hide();
    sendState(true);
    return true;
  }
  if (dockedWin.isVisible()) {
    dockedWin.hide();
    sendState(false);
    showMainWindow();
    return false;
  } else {
    dockedWin.show(); dockedWin.focus();
    if (!dockedKeepConsole && win && !win.isDestroyed()) win.hide();
    sendState(true);
    return true;
  }
}
ipcMain.handle('toggle-docked-panel', toggleDockedPanel);

ipcMain.on('panel-open-console', (event, tab) => {
  if (dockedWin && !dockedWin.isDestroyed()) {
    dockedWin.hide();
    if (win && !win.isDestroyed()) win.webContents.send('docked-panel-state', false);
  }
  showMainWindow();
  if (win && !win.isDestroyed() && tab) {
    win.webContents.executeJavaScript(`
      if (typeof switchTab === 'function') switchTab(${JSON.stringify(tab)});
    `).catch(() => {});
  }
});

ipcMain.on('palette-dismiss', () => {
  if (paletteWin && !paletteWin.isDestroyed()) paletteWin.close();
  if (dockedWin  && !dockedWin.isDestroyed() && dockedWin.isVisible()) {
    dockedWin.hide();
    if (win && !win.isDestroyed()) win.webContents.send('docked-panel-state', false);
    showMainWindow();
  }
});

ipcMain.on('panel-run-action', (event, { type, upn }) => {
  showMainWindow();
  if (!win || win.isDestroyed()) return;
  let js;
  if (type === 'joiner') {
    js = `
      if (typeof switchTab === 'function') switchTab('approver');
      setTimeout(() => {
        const i = document.getElementById('input-approver');
        if (i) { i.value = 'Onboard a new hire: '; i.focus(); }
      }, 200);`;
  } else if (type === 'move') {
    js = `
      if (typeof switchTab === 'function') switchTab('operations');
      setTimeout(() => {
        const det = document.getElementById('ops-quick-mover');
        if (det) det.setAttribute('open','');
        const upnEl = document.getElementById('qm-upn');
        if (upnEl) upnEl.value = ${JSON.stringify(upn || '')};
        if (upnEl && upnEl.value) upnEl.focus();
      }, 200);`;
  } else {
    const stage = type === 'hard-leave' ? 'Hard' : 'Soft';
    js = `
      if (typeof switchTab === 'function') switchTab('operations');
      setTimeout(() => {
        const det = document.getElementById('ops-quick-leaver');
        if (det) det.setAttribute('open','');
        const upnEl = document.getElementById('ql-upn');
        if (upnEl) upnEl.value = ${JSON.stringify(upn || '')};
        const r = document.querySelector('input[name="ql-stage"][value="${stage}"]');
        if (r) r.checked = true;
      }, 200);`;
  }
  win.webContents.executeJavaScript(js).catch(() => {});
});

ipcMain.on('panel-close', () => {
  if (dockedWin && !dockedWin.isDestroyed()) {
    dockedWin.hide();
    if (win && !win.isDestroyed()) win.webContents.send('docked-panel-state', false);
  }
  if (!dockedKeepConsole) showMainWindow();
});

ipcMain.on('panel-save-bounds', (_, bounds) => { savePanelBounds(bounds); });

ipcMain.on('panel-request-refresh', () => { pushFreshPanelData(); });

ipcMain.handle('panel-approve-pending', (event, { id, writeToken }) => {
  const role = (currentRole || 'viewer').toLowerCase();
  if (role === 'viewer' || role === 'guest') return { ok: false, error: 'Read-only role — blocked' };
  if (!writeToken) return { ok: false, error: 'PIN verification required' };
  const check = consumeWriteToken(writeToken, currentOperator);
  if (!check.ok) return { ok: false, error: 'Invalid write token: ' + check.reason };
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    if (!fs.existsSync(file)) return { ok: false, error: 'Request not found' };
    const op   = readJson(file);
    const inp  = op.input || op;
    const tool = (op.tool || '').toLowerCase();
    let raw;
    if (tool === 'submit_joiner') {
      const pf = writePayloadFile({ givenName: inp.givenName, surname: inp.surname, userPrincipalName: inp.userPrincipalName, department: inp.department, jobTitle: inp.jobTitle, usageLocation: inp.usageLocation });
      try { raw = runPs(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: pf }); }
      finally { try { fs.unlinkSync(pf); } catch {} }
    } else {
      const stage = inp.stage || (tool.includes('hard') ? 'Hard' : 'Soft');
      const params = { UserPrincipalName: inp.userPrincipalName, Stage: stage, OperatorRole: 'admin' };
      if (inp.ticketRef) params.TicketRef = inp.ticketRef;
      raw = runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), params);
    }
    parsePs1Output(raw);
    fs.unlinkSync(file);
    sendToast('Approval Executed', (inp.userPrincipalName || id) + ' completed successfully.');
    setTimeout(pollTrayApprovals, 400);
    return { ok: true, upn: inp.userPrincipalName };
  } catch (err) {
    sendToast('Approval Failed', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('panel-reject-pending', (_, { id }) => {
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    let upn = '';
    try { upn = readJson(file).input?.userPrincipalName || ''; } catch {}
    if (fs.existsSync(file)) fs.unlinkSync(file);
    sendToast('Approval Rejected', (upn || id) + ' rejected and removed from the queue.');
    setTimeout(pollTrayApprovals, 400);
    return { ok: true, upn };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Shared user cache — populated by Graph searches from main window, queried by panel/overlay
let _sharedUserCache = [];

ipcMain.handle('search-users', async (event, query) => {
  const q = (query || '').toLowerCase().trim();
  if (!q || q.length < 2) return [];

  // 1. Check shared Graph cache first (fast, no PS overhead)
  const fromCache = _sharedUserCache.filter(u =>
    u.upn.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q)
  ).slice(0, 8);
  if (fromCache.length) return fromCache;

  // 2. Fallback: search recent audit log entries
  try {
    const entries = [];
    const logDirs = ['joiner','mover','leaver','enroller'].map(ag => path.join(AGENTS_DIR, ag, 'logs'));
    const seen = new Set();
    for (const dir of logDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 2);
      for (const f of files) {
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            const upn = e.subject || e.userPrincipalName || '';
            if (!upn || seen.has(upn)) continue;
            if (upn.toLowerCase().includes(q)) {
              seen.add(upn);
              entries.push({ upn, displayName: e.displayName || upn.split('@')[0] });
            }
          } catch {}
        }
      }
    }
    return entries.slice(0, 8);
  } catch { return []; }
});

// ── Approvals tab ─────────────────────────────────────────────────────────────
ipcMain.on('get-pending-approvals', (event) => {
  try {
    if (!fs.existsSync(PENDING_DIR)) { event.sender.send('pending-approvals', []); return; }
    const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
    const approvals = files.map(f => {
      try { return readJson(path.join(PENDING_DIR, f)); } catch { return null; }
    }).filter(Boolean);
    event.sender.send('pending-approvals', approvals);
  } catch (err) {
    event.sender.send('pending-approvals', { error: err.message });
  }
});

// Helper: enforce write-token presence for any IPC that mutates the directory.
// Viewer/guest operators are always blocked. Helpdesk/admin must supply a fresh
// token minted by verify-operator-pin. WhatIf operations don't need a token.
function requireWriteToken(event, payload, eventName) {
  const role = (currentRole || 'viewer').toLowerCase();
  if (role === 'viewer' || role === 'guest') {
    event.sender.send(eventName, { ok: false, error: 'Read-only role — write operations blocked' });
    return false;
  }
  // WhatIf flows are non-destructive — skip the token requirement
  if (payload && (payload.whatif === true || payload.preview === true)) return true;
  const token = payload && payload.writeToken;
  if (!token) {
    event.sender.send(eventName, { ok: false, error: 'PIN verification required before Live write' });
    return false;
  }
  const check = consumeWriteToken(token, currentOperator);
  if (!check.ok) {
    event.sender.send(eventName, { ok: false, error: 'Invalid write token: ' + check.reason });
    return false;
  }
  return true;
}

ipcMain.on('approve-pending', (event, payload) => {
  if (!requireWriteToken(event, payload, 'approve-result')) return;
  const { id } = payload || {};
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    if (!fs.existsSync(file)) { event.sender.send('approve-result', { ok: false, error: 'Not found' }); return; }
    const op   = readJson(file);

    // Role gate: if the pending record requires admin, only admin can approve
    const reqRole = op.requiredApproverRole || 'helpdesk';
    const actorRole = (currentRole || 'viewer').toLowerCase();
    if (reqRole === 'admin' && actorRole !== 'admin') {
      event.sender.send('approve-result', { ok: false, error: 'Insufficient role — this action requires an admin operator to approve.' });
      return;
    }

    const inp  = op.input || op;
    const tool = (op.tool || '').toLowerCase();
    let raw;
    if (tool === 'submit_joiner') {
      const pf = writePayloadFile({ givenName: inp.givenName, surname: inp.surname, userPrincipalName: inp.userPrincipalName, department: inp.department, jobTitle: inp.jobTitle, usageLocation: inp.usageLocation });
      try { raw = runPs(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: pf }); }
      finally { try { fs.unlinkSync(pf); } catch {} }
    } else {
      const stage = inp.stage || (tool.includes('hard') ? 'Hard' : 'Soft');
      const params = { UserPrincipalName: inp.userPrincipalName, Stage: stage, OperatorRole: 'admin' };
      if (inp.ticketRef) params.TicketRef = inp.ticketRef;
      raw = runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), params);
    }
    const result = parsePs1Output(raw);
    fs.unlinkSync(file);
    sendToast('Approval Executed', (inp.userPrincipalName || 'Operation') + ' leaver completed successfully.');
    event.sender.send('approve-result', { ok: true, result });
  } catch (err) {
    sendToast('Approval Failed', err.message);
    event.sender.send('approve-result', { ok: false, error: err.message });
  }
});

ipcMain.on('reject-pending', (event, { id }) => {
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    let upn = '';
    try { upn = readJson(file).input?.userPrincipalName || ''; } catch {}
    if (fs.existsSync(file)) fs.unlinkSync(file);
    sendToast('Approval Rejected', (upn || 'Request') + ' was rejected and removed from the queue.');
    event.sender.send('reject-result', { ok: true });
  } catch (err) {
    event.sender.send('reject-result', { ok: false, error: err.message });
  }
});

// ── Operations tab ────────────────────────────────────────────────────────────
ipcMain.on('run-bulk-import', async (event, { rows, whatif }) => {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    event.sender.send('bulk-import-progress', { index: i, status: 'running', upn: row.userPrincipalName });
    try {
      let raw;
      const op = (row.operation || '').toLowerCase();
      if (op === 'joiner') {
        const _pf2 = writePayloadFile({
          givenName: row.givenName, surname: row.surname,
          userPrincipalName: row.userPrincipalName, department: row.department,
          jobTitle: row.jobTitle, usageLocation: row.usageLocation
        });
        try { raw = runPs(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: _pf2, WhatIf: !!whatif }); }
        finally { try { fs.unlinkSync(_pf2); } catch {} }
      } else if (op === 'leaver') {
        raw = runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
          UserPrincipalName: row.userPrincipalName, Stage: row.stage || 'Soft',
          TicketRef: row.ticketRef, WhatIf: !!whatif
        });
      } else if (op === 'mover') {
        const _pfMover = writePayloadFile({
          userPrincipalName: row.userPrincipalName,
          department: row.department,
          jobTitle: row.jobTitle,
          manager: row.manager,
          licensesToAdd: row.licensesToAdd,
          licensesToRemove: row.licensesToRemove,
          groupsToAdd: row.groupsToAdd,
          groupsToRemove: row.groupsToRemove,
          ticketRef: row.ticketRef
        });
        try { raw = runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: _pfMover, WhatIf: !!whatif }); }
        finally { try { fs.unlinkSync(_pfMover); } catch {} }
      } else {
        throw new Error('Unknown operation: ' + row.operation);
      }
      const result = parsePs1Output(raw);
      event.sender.send('bulk-import-progress', { index: i, status: 'done', upn: row.userPrincipalName, result });
    } catch (err) {
      event.sender.send('bulk-import-progress', { index: i, status: 'error', upn: row.userPrincipalName, error: err.message });
    }
  }
  event.sender.send('bulk-import-complete', { total: rows.length });
});

ipcMain.on('get-scheduled-ops', (event) => {
  event.sender.send('scheduled-ops', loadScheduled());
});

ipcMain.on('save-scheduled-op', (event, { op }) => {
  const ops = loadScheduled();
  const newOp = Object.assign({}, op, {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: 'pending'
  });
  ops.push(newOp);
  saveScheduled(ops);
  event.sender.send('scheduled-ops', ops);
});

ipcMain.on('delete-scheduled-op', (event, { id }) => {
  const ops = loadScheduled().filter(o => o.id !== id);
  saveScheduled(ops);
  event.sender.send('scheduled-ops', ops);
});

// ── Certifications tab ────────────────────────────────────────────────────────
ipcMain.on('run-certification', (event, { campaignType, whatif }) => {
  try {
    const raw    = runPs(CERT_SCRIPT, { CampaignType: campaignType, WhatIf: !!whatif });
    const lines  = raw.trim().split('\n')
      .filter(l => /\[Certifier\]/.test(l))
      .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\] /, '').trim());
    const parsed = _parseMultilineJson(raw, 'No certification campaign output');
    const campaigns = Array.isArray(parsed) ? parsed : [];
    event.sender.send('certification-result', { ok: true, campaigns, lines });
  } catch (err) {
    event.sender.send('certification-result', { ok: false, error: err.message, campaigns: [], lines: [] });
  }
});

ipcMain.on('get-cert-history', (event) => {
  const auditPath = path.join(AGENTS_DIR, 'audit.jsonl');
  if (!fs.existsSync(auditPath)) { event.sender.send('cert-history', []); return; }
  const lines   = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.agent === 'certifier');
  event.sender.send('cert-history', entries.reverse());
});

// ── Settings tab ──────────────────────────────────────────────────────────────
ipcMain.on('get-policy', (event) => {
  try {
    const policies = fs.existsSync(POLICIES_FILE) ? readJson(POLICIES_FILE) : {};
    const sod      = fs.existsSync(SOD_FILE)       ? readJson(SOD_FILE) : {};
    event.sender.send('policy-data', { policies, sod });
  } catch (err) {
    event.sender.send('policy-data', { error: err.message });
  }
});

ipcMain.on('save-policy', (event, { policies, sod }) => {
  try {
    fs.writeFileSync(POLICIES_FILE, JSON.stringify(policies, null, 2), 'utf8');
    fs.writeFileSync(SOD_FILE,      JSON.stringify(sod,      null, 2), 'utf8');
    event.sender.send('policy-saved', { ok: true });
  } catch (err) {
    event.sender.send('policy-saved', { ok: false, error: err.message });
  }
});

ipcMain.on('get-operators', (event) => {
  try {
    const data = fs.existsSync(OPERATORS_FILE) ? readJson(OPERATORS_FILE) : { operators: {}, roles: {} };
    event.sender.send('operators-data', data);
  } catch (err) {
    event.sender.send('operators-data', { error: err.message });
  }
});

ipcMain.on('save-operators', (event, { operators, roles }) => {
  try {
    if (currentRole !== 'admin') {
      const existing = fs.existsSync(OPERATORS_FILE) ? readJson(OPERATORS_FILE) : {};
      const existingOps = existing.operators || {};
      for (const [user, role] of Object.entries(existingOps)) {
        if (role === 'admin' && (operators || {})[user] !== 'admin') {
          event.sender.send('operators-saved', { ok: false, error: 'Non-admin operators cannot remove or demote admin accounts.' });
          return;
        }
      }
      for (const [user, role] of Object.entries(operators || {})) {
        if (role === 'admin' && existingOps[user] !== 'admin') {
          event.sender.send('operators-saved', { ok: false, error: 'Non-admin operators cannot add admin accounts.' });
          return;
        }
      }
    }
    const existing = fs.existsSync(OPERATORS_FILE) ? readJson(OPERATORS_FILE) : {};
    const updated  = Object.assign({}, existing, { operators, roles });
    fs.writeFileSync(OPERATORS_FILE, JSON.stringify(updated, null, 2), 'utf8');
    event.sender.send('operators-saved', { ok: true });
  } catch (err) {
    event.sender.send('operators-saved', { ok: false, error: err.message });
  }
});

// ── AI Provider config ────────────────────────────────────────────────────────
ipcMain.handle('get-ai-provider-config', () => {
  _ensureProviderConfig();
  // Mask stored API keys — return length > 0 indicator instead of value
  const safe = JSON.parse(JSON.stringify(_aiProviderConfig));
  for (const key of ['claude', 'openai', 'azure-openai', 'azure-foundry']) {
    const node = safe[key];
    if (node && node.apiKey) node.apiKey = node.apiKey.length > 0 ? '••••' : '';
  }
  return safe;
});

ipcMain.handle('save-ai-provider-config', (_, { config }) => {
  try {
    _ensureProviderConfig();
    // Merge: preserve existing API keys when the UI sends back masked '••••' placeholders
    const merged = JSON.parse(JSON.stringify(_aiProviderConfig));
    merged.provider = config.provider;
    for (const key of ['claude', 'openai', 'azure-foundry', 'azure-openai', 'ollama']) {
      if (!config[key]) continue;
      if (!merged[key]) merged[key] = {};
      Object.assign(merged[key], config[key]);
      // Don't overwrite a real key with the masked placeholder
      if (config[key].apiKey === '••••') merged[key].apiKey = _aiProviderConfig[key]?.apiKey || '';
    }
    _aiProviderConfig = merged;
    _cachedProvider   = null; // force rebuild on next use
    _saveProviderConfig(AI_PROVIDER_CONFIG_FILE, merged);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-ai-traces', (_, payload) => {
  try {
    if (!fs.existsSync(AI_TRACES_FILE)) return { traces: [], summary: { count: 0 } };
    const limit = (payload && payload.limit) || 50;
    const lines = fs.readFileSync(AI_TRACES_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const recent = all.slice(-limit).reverse();
    const totIn  = all.reduce((s, t) => s + (t.inputTokens  || 0), 0);
    const totOut = all.reduce((s, t) => s + (t.outputTokens || 0), 0);
    const avgLat = all.length ? Math.round(all.reduce((s, t) => s + (t.latencyMs || 0), 0) / all.length) : 0;
    return { traces: recent, summary: { count: all.length, totalInputTokens: totIn, totalOutputTokens: totOut, avgLatencyMs: avgLat } };
  } catch (err) {
    return { traces: [], summary: { count: 0 }, error: err.message };
  }
});

ipcMain.handle('test-ai-provider', async () => {
  try {
    const provider = getAIProvider();
    if (!provider) return { ok: false, error: 'No provider configured' };
    const text = await provider.complete({
      maxTokens: 10,
      messages: [{ role: 'user', content: 'Reply with the single word: connected' }]
    });
    return { ok: true, provider: provider.name, text: text.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Access snapshot (read-only) for before/after diff ───────────────────────────
ipcMain.handle('get-access-snapshot', async (_, { upn }) => {
  if (!upn) return { ok: false, error: 'upn required' };
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
$uid = '${String(upn).replace(/'/g, "''")}'
$user = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$uid\`?\`$select=displayName,userPrincipalName,accountEnabled,department,jobTitle"
$lic  = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$uid/licenseDetails?\`$select=skuPartNumber"
$grp  = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$uid/memberOf/microsoft.graph.group?\`$select=displayName&\`$top=50"
@{
  displayName    = $user.displayName
  accountEnabled = $user.accountEnabled
  department     = $user.department
  jobTitle       = $user.jobTitle
  licenses       = @($lic.value | ForEach-Object { $_.skuPartNumber })
  groups         = @($grp.value | ForEach-Object { $_.displayName })
} | ConvertTo-Json -Depth 4 -Compress
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const snap = _parseMultilineJson(raw, 'No output from snapshot query');
    if (snap && snap.error) return { ok: false, error: snap.error };
    return { ok: true, snapshot: snap };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Policy simulation ──────────────────────────────────────────────────────────
// Read-only: runs the same risk/policy engine as score_risk without executing.
// Returns the decision (allow / warn / requires_approval / blocked), matched
// policies, risk level, and dual-approval requirement.
ipcMain.handle('simulate-policy', (_, payload) => {
  const { operation, userPrincipalName, licenses, groups, newDepartment } = payload || {};
  if (!operation || !userPrincipalName) {
    return { ok: false, error: 'operation and userPrincipalName are required' };
  }
  try {
    const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-RiskScore.ps1'), {
      Operation:         operation,
      UserPrincipalName: userPrincipalName,
      Licenses:          licenses || '',
      Groups:            groups || '',
      NewDepartment:     newDepartment || ''
    });
    const result = _parseMultilineJson(raw, 'No output from risk score script');
    if (result && !result.error) {
      // Derive a plain-English decision from the engine output
      const lvl = (result.riskLevel || result.level || '').toLowerCase();
      let decision = 'allow';
      if (result.blocked || lvl === 'critical') decision = 'blocked';
      else if (result.dualApproval || lvl === 'high') decision = 'requires_approval';
      else if (lvl === 'medium') decision = 'warn';
      result.decision = decision;
    }
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Agent quarantine (kill switch) ─────────────────────────────────────────────
ipcMain.handle('quarantine-agent', async (event, payload) => {
  const { agent, reason, whatif, revoke, writeToken } = payload || {};
  // Real (non-WhatIf) quarantine is a privileged mutation — require a write token
  // and admin role, same gate as other destructive operations.
  if (!whatif) {
    if ((currentRole || 'viewer').toLowerCase() !== 'admin') {
      return { ok: false, error: 'Quarantine requires an admin operator.' };
    }
    const check = consumeWriteToken(writeToken, currentOperator);
    if (!check.ok) return { ok: false, error: check.error || 'Write token required.' };
  }
  try {
    const args = {
      AgentName: agent,
      Reason: reason || 'Manual quarantine via JML Console',
    };
    if (whatif) args.WhatIf = true;
    if (revoke) args.Revoke = true;
    const raw = runPs(path.join(AGENTS_DIR, 'provisioner', 'Invoke-AgentQuarantine.ps1'), args);
    const result = _parseMultilineJson(raw, 'No output from quarantine script');
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Agent health ──────────────────────────────────────────────────────────────
ipcMain.on('get-agent-health', (event) => {
  try {
    const auditPath = path.join(AGENTS_DIR, 'audit.jsonl');
    const lastActivity = {};
    const lastOutcome  = {};
    if (fs.existsSync(auditPath)) {
      const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.agent) { lastActivity[e.agent] = e.timestamp; lastOutcome[e.agent] = e.outcome; }
        } catch {}
      }
    }

    const agents = AGENT_DIRS.map(name => {
      const dir        = path.join(AGENTS_DIR, name);
      const cfgPath    = path.join(dir, 'config.json');
      if (!fs.existsSync(cfgPath)) {
        return { name, dir, clientId: null, credentialType: 'unknown', expiry: null, daysUntilExpiry: null,
          lastActivity: lastActivity[name] || null, lastOutcome: lastOutcome[name] || null, status: 'unconfigured' };
      }
      let cfg = {};
      try { cfg = readJson(cfgPath); } catch {}
      const clientId      = cfg.ClientId || null;
      const credType      = cfg.CertThumbprint ? 'certificate' : cfg.SecretExpiry ? 'secret' : 'unknown';
      const expiryStr     = credType === 'certificate' ? (cfg.CertExpiry || null) : (cfg.SecretExpiry || null);
      let daysUntilExpiry = null;
      if (expiryStr) {
        const diff = new Date(expiryStr) - Date.now();
        daysUntilExpiry = Math.floor(diff / 86400000);
      }
      const outcome = lastOutcome[name] || null;
      let status;
      if (!clientId) {
        status = 'unconfigured';
      } else if (daysUntilExpiry !== null && daysUntilExpiry < 0) {
        status = 'critical';
      } else if (outcome === 'failed') {
        status = 'critical';
      } else if (daysUntilExpiry !== null && daysUntilExpiry < 30) {
        status = 'warning';
      } else {
        status = 'healthy';
      }
      return { name, dir, clientId, credentialType: credType, expiry: expiryStr,
        daysUntilExpiry, lastActivity: lastActivity[name] || null, lastOutcome: outcome, status };
    });
    event.sender.send('agent-health', { agents });
  } catch (err) {
    event.sender.send('agent-health', { agents: [], error: err.message });
  }
});

// ── HR Event Queue ────────────────────────────────────────────────────────────
ipcMain.on('get-hr-queue', async (event) => {
  try {
    const { QueueServiceClient }  = require('@azure/storage-queue');
    const { TableClient }         = require('@azure/data-tables');
    const connStr = 'UseDevelopmentStorage=true';

    const qClient   = QueueServiceClient.fromConnectionString(connStr);
    const queueName = 'hr-events';
    const queue     = qClient.getQueueClient(queueName);

    let queueDepth = 0;
    try {
      const props = await queue.getProperties();
      queueDepth = props.approximateMessagesCount || 0;
    } catch {}

    const tableClient = TableClient.fromConnectionString(connStr, 'HREvents');
    const events = [];
    try {
      const iter = tableClient.listEntities({ queryOptions: { top: 50 } });
      for await (const entity of iter) {
        events.push({
          partitionKey: entity.partitionKey,
          rowKey:       entity.rowKey,
          eventId:      entity.eventId   || entity.rowKey,
          status:       entity.status    || '',
          eventType:    entity.eventType || '',
          upn:          entity.upn       || entity.UserPrincipalName || '',
          timestamp:    entity.timestamp || entity.Timestamp || ''
        });
        if (events.length >= 50) break;
      }
    } catch {}

    event.sender.send('hr-queue', { queueDepth, events });
  } catch (err) {
    event.sender.send('hr-queue', { queueDepth: 0, events: [], error: err.message });
  }
});

ipcMain.on('window-minimize', () => { if (win) win.minimize(); });
ipcMain.on('window-maximize', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } });
ipcMain.on('window-close', () => {
  if (win && !win.isDestroyed()) win.hide();
  if (!dockedWin || dockedWin.isDestroyed()) { createDockedPanel(); }
  else if (!dockedWin.isVisible()) { dockedWin.show(); }
});
ipcMain.on('sign-out', () => {
  currentOperator = null;
  currentRole     = 'viewer';
  if (win && !win.isDestroyed()) { win.close(); win = null; }
  createOperatorWindow();
});

ipcMain.on('app-quit', () => {
  quitting = true;
  app.quit();
});

// ── Window ────────────────────────────────────────────────────────────────────
let win;
let operatorWin;
let setupWin;
let currentOperator = os.userInfo().username;
let currentRole     = 'admin';

function isFirstRun() {
  try {
    if (!fs.existsSync(SETUP_FILE)) return true;
    return !readJson(SETUP_FILE).firstRunComplete;
  } catch { return true; }
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 460, height: 640,
    resizable: false,
    frame: false,
    center: true,
    icon: APP_ICON,
    backgroundColor: '#11131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
}

function createMainWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780,
    minWidth: 900, minHeight: 600,
    frame: false,
    icon: APP_ICON,
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setIcon(APP_ICON);

  win.on('maximize',   () => { if (!win.isDestroyed()) win.webContents.send('window-maximized', true); });
  win.on('unmaximize', () => { if (!win.isDestroyed()) win.webContents.send('window-maximized', false); });
  win.on('restore',    () => { if (!win.isDestroyed()) win.webContents.send('window-maximized', false); });
}

function createOperatorWindow() {
  operatorWin = new BrowserWindow({
    width: 460, height: 680,
    resizable: false,
    frame: false,
    center: true,
    icon: APP_ICON,
    backgroundColor: '#11131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  operatorWin.loadFile(path.join(__dirname, 'renderer', 'operator-select.html'));
}

ipcMain.handle('get-operators-for-login', () => {
  try {
    if (!fs.existsSync(OPERATORS_FILE)) return { operators: {} };
    return { operators: readJson(OPERATORS_FILE).operators || {} };
  } catch { return { operators: {} }; }
});

ipcMain.handle('get-current-operator', () => {
  const ops = (() => { try { return readJson(OPERATORS_FILE).operators || {}; } catch { return {}; } })();
  const role = ops[currentOperator] || 'viewer';
  currentRole = role;
  return { name: currentOperator, role };
});

ipcMain.on('select-operator', (event, { name, role }) => {
  currentOperator = name;
  currentRole     = role || 'viewer';
  process.env.JML_CONSOLE_OPERATOR = name;
  if (operatorWin && !operatorWin.isDestroyed()) { operatorWin.close(); operatorWin = null; }
  if (!win) createMainWindow();
});

ipcMain.on('switch-operator', (event, { name, role }) => {
  currentOperator = name;
  currentRole     = role || 'viewer';
  process.env.JML_CONSOLE_OPERATOR = name;
  if (win && !win.isDestroyed()) win.webContents.send('operator-switched', { name, role });
});

// ── Operator authentication (PIN / Windows) — gates write-mode operations ────
const crypto = require('crypto');
function readOperatorAuth() {
  try { return readJson(OPERATOR_AUTH_FILE) || {}; } catch { return {}; }
}
function writeOperatorAuth(data) {
  fs.writeFileSync(OPERATOR_AUTH_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), 32).toString('base64');
}

ipcMain.handle('get-operator-auth', () => {
  const data = readOperatorAuth();
  // Strip hash/salt before returning to renderer
  const out = {};
  for (const [u, v] of Object.entries(data)) {
    out[u] = { mode: v.mode || 'none', set: !!(v.pinHash || v.mode === 'windows') };
  }
  return out;
});

ipcMain.handle('set-operator-auth-pin', (event, { user, pin }) => {
  if (!user || !pin || String(pin).length < 4) return { ok: false, error: 'PIN must be at least 4 characters' };
  const data = readOperatorAuth();
  const salt = crypto.randomBytes(16).toString('base64');
  const pinHash = hashPin(pin, salt);
  const wasSet = !!(data[user] && data[user].pinHash);
  data[user] = { mode: 'pin', salt, pinHash, updatedAt: new Date().toISOString() };
  writeOperatorAuth(data);
  logOperatorActivity(wasSet ? 'pin.changed' : 'pin.set', { target: user });
  return { ok: true };
});

ipcMain.handle('set-operator-auth-windows', (event, { user }) => {
  if (!user) return { ok: false, error: 'user required' };
  const data = readOperatorAuth();
  data[user] = { mode: 'windows', updatedAt: new Date().toISOString() };
  writeOperatorAuth(data);
  logOperatorActivity('auth.windows.set', { target: user });
  return { ok: true };
});

// ── Tenant onboarding: read/write each agent's config.json TenantId ──────────
ipcMain.handle('get-tenant-config', () => {
  // Read first available config.json to surface tenant settings
  const out = { tenantId: '', primaryDomain: '', region: '', clientIds: {}, agents: [] };
  for (const agent of AGENT_DIRS) {
    const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
    if (!fs.existsSync(cfgPath)) { out.agents.push({ agent, exists: false }); continue; }
    try {
      const cfg = readJson(cfgPath);
      if (!out.tenantId && cfg.TenantId) out.tenantId = cfg.TenantId;
      if (!out.primaryDomain && cfg.PrimaryDomain) out.primaryDomain = cfg.PrimaryDomain;
      if (!out.region && cfg.Region) out.region = cfg.Region;
      out.clientIds[agent] = cfg.ClientId || '';
      out.agents.push({ agent, exists: true, hasCert: !!cfg.CertThumbprint, hasSecret: !!cfg.EncryptedSecret });
    } catch (e) {
      out.agents.push({ agent, exists: true, error: e.message });
    }
  }
  return out;
});

// Compute a diff of what save-tenant-config would change, without writing.
ipcMain.handle('preview-tenant-config', (event, { tenantId, primaryDomain, region, clientIds }) => {
  const changes = [];
  for (const agent of AGENT_DIRS) {
    const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
    if (!fs.existsSync(cfgPath)) { changes.push({ agent, exists: false }); continue; }
    try {
      const cfg = readJson(cfgPath);
      const diff = {};
      if (tenantId && cfg.TenantId !== tenantId) diff.TenantId = { from: cfg.TenantId || '', to: tenantId };
      if (primaryDomain && cfg.PrimaryDomain !== primaryDomain) diff.PrimaryDomain = { from: cfg.PrimaryDomain || '', to: primaryDomain };
      if (region && cfg.Region !== region) diff.Region = { from: cfg.Region || '', to: region };
      if (clientIds && clientIds[agent] && cfg.ClientId !== clientIds[agent]) diff.ClientId = { from: cfg.ClientId || '', to: clientIds[agent] };
      changes.push({ agent, exists: true, diff });
    } catch (e) {
      changes.push({ agent, exists: true, error: e.message });
    }
  }
  return { changes };
});

ipcMain.handle('save-tenant-config', (event, { tenantId, primaryDomain, region, clientIds }) => {
  if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    return { ok: false, error: 'Tenant ID must be a GUID' };
  }
  const updated = []; const skipped = []; const errors = [];
  for (const agent of AGENT_DIRS) {
    const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
    if (!fs.existsSync(cfgPath)) { skipped.push(agent); continue; }
    try {
      const cfg = readJson(cfgPath);
      cfg.TenantId = tenantId;
      if (primaryDomain) cfg.PrimaryDomain = primaryDomain;
      if (region) cfg.Region = region;
      if (clientIds && clientIds[agent]) cfg.ClientId = clientIds[agent];
      // Strip BOM-safe write with UTF-8 (no BOM) — match what readJson handles
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      updated.push(agent);
    } catch (e) {
      errors.push({ agent, error: e.message });
    }
  }
  logOperatorActivity('tenant.config.saved', { tenantId, primaryDomain, region, updated, errors: errors.length });
  return { ok: true, updated, skipped, errors };
});

// Read recent operator activity (most recent first). Used by Settings → Operators audit view.
const ALLOWED_EXTERNAL_HOSTS = [
  'portal.azure.com', 'aad.portal.azure.com', 'entra.microsoft.com',
  'compliance.microsoft.com', 'learn.microsoft.com', 'admin.microsoft.com',
];
ipcMain.handle('open-external', (_, url) => {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return;
    if (!ALLOWED_EXTERNAL_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) return;
    return shell.openExternal(url);
  } catch { return; }
});

ipcMain.handle('pick-image-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
  });
  if (canceled || !filePaths.length) return null;
  try {
    const { nativeImage } = require('electron');
    const img     = nativeImage.createFromPath(filePaths[0]);
    if (img.isEmpty()) return null;
    const size    = img.getSize();
    const min     = Math.min(size.width, size.height);
    const cropped = img.crop({
      x: Math.floor((size.width  - min) / 2),
      y: Math.floor((size.height - min) / 2),
      width: min, height: min
    });
    return cropped.resize({ width: 96, height: 96 }).toDataURL();
  } catch { return null; }
});

ipcMain.handle('get-operator-activity', (event, { limit }) => {
  try {
    if (!fs.existsSync(OPERATOR_ACTIVITY_FILE)) return { entries: [] };
    const raw = fs.readFileSync(OPERATOR_ACTIVITY_FILE, 'utf8').replace(/^﻿/, '');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const max = Math.max(1, Math.min(500, limit || 50));
    const entries = lines.slice(-max).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    return { entries };
  } catch (e) { return { entries: [], error: e.message }; }
});

// ── Tenant onboarding wizard (device-code sign-in + app reg creation) ──────
// Track an in-flight Connect-MgGraph process. Sign-in is long-running so it
// runs in the background and the renderer polls for status.
let _signinProc = null;
let _signinState = { status: 'idle', deviceCode: '', verificationUrl: '', tenantId: '', account: '', error: '' };

function spawnSigninProcess() {
  const { spawn } = require('child_process');
  _signinState = { status: 'pending', deviceCode: '', verificationUrl: '', tenantId: '', account: '', error: '' };
  // 6>&1 redirects the Information stream (Write-Host / stream 6) to stdout so
  // the device-code message from Connect-MgGraph is captured by Node.js.
  const script = `
    $ErrorActionPreference = 'Stop'
    $InformationPreference = 'Continue'
    try {
      Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
      Connect-MgGraph -Scopes "Application.ReadWrite.All","User.Read.All","Directory.ReadWrite.All" -UseDeviceAuthentication -NoWelcome 6>&1
      $ctx = Get-MgContext
      @{ status='success'; tenantId=$ctx.TenantId; account=$ctx.Account } | ConvertTo-Json -Compress
    } catch {
      @{ status='error'; error=$_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  let buf = '';

  // Parse the running buffer for device-code info and/or final result.
  // Called on every chunk from both stdout and stderr.
  function parseBuf() {
    if (!_signinState.deviceCode) {
      // Support both common orderings of the device-code message:
      //   "…open the page https://…/devicelogin … code XXXXXXXX …"
      //   "…enter the code XXXXXXXX … https://…/devicelogin …"
      const m1 = buf.match(/https:\/\/microsoft\.com\/devicelogin[^]*?code\s+([A-Z0-9]{8,})/i);
      const m2 = buf.match(/code\s+([A-Z0-9]{8,})[^]*?(https:\/\/microsoft\.com\/devicelogin)/i);
      const code = (m1 && m1[1]) || (m2 && m2[1]);
      if (code) {
        _signinState.deviceCode = code;
        _signinState.verificationUrl = 'https://microsoft.com/devicelogin';
      }
    }
    // Final JSON line marks auth completion
    const finalLine = buf.split(/\r?\n/).reverse().find(l => l.trim().startsWith('{'));
    if (finalLine) {
      try {
        const j = JSON.parse(finalLine);
        if (j.status === 'success') {
          _signinState.status = 'success'; _signinState.tenantId = j.tenantId; _signinState.account = j.account;
        } else if (j.status === 'error') {
          _signinState.status = 'error'; _signinState.error = j.error;
        }
      } catch (_) { /* partial line – wait for more data */ }
    }
  }

  p.stdout.on('data', d => { buf += d.toString(); parseBuf(); });
  p.stderr.on('data', d => { buf += d.toString(); parseBuf(); });
  p.on('close', () => {
    if (_signinState.status === 'pending') _signinState.status = 'error', _signinState.error = 'signin terminated without result';
    _signinProc = null;
  });
  _signinProc = p;
}

ipcMain.handle('start-device-code-signin', () => {
  if ((currentRole || 'viewer') !== 'admin') return { ok: false, error: 'admin required' };
  if (_signinProc) { try { _signinProc.kill(); } catch (_) {} _signinProc = null; }
  spawnSigninProcess();
  logOperatorActivity('tenant.wizard.signin.start', {});
  return { ok: true };
});

ipcMain.handle('check-device-code-status', () => {
  return _signinState;
});

ipcMain.handle('create-agent-app-registrations', (event, { agentNames }) => {
  if ((currentRole || 'viewer') !== 'admin') return { ok: false, error: 'admin required' };
  if (_signinState.status !== 'success') return { ok: false, error: 'sign in to the target tenant first' };
  const names = Array.isArray(agentNames) && agentNames.length ? agentNames : AGENT_DIRS;
  const created = []; const errors = [];
  for (const agent of names) {
    try {
      const script = `
        $ErrorActionPreference = 'Stop'
        Import-Module Microsoft.Graph.Applications -ErrorAction Stop
        $app = New-MgApplication -DisplayName "jml-fleet-${agent}"
        $sp = New-MgServicePrincipal -AppId $app.AppId
        @{ agent='${agent}'; appId=$app.AppId; objectId=$app.Id; spId=$sp.Id } | ConvertTo-Json -Compress
      `;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });
      const out = (r.stdout || '').trim().split(/\r?\n/).reverse().find(l => l.trim().startsWith('{'));
      if (!out) throw new Error(r.stderr || 'no output from New-MgApplication');
      created.push(JSON.parse(out));
    } catch (e) {
      errors.push({ agent, error: e.message });
    }
  }
  logOperatorActivity('tenant.wizard.appregs.created', { created: created.length, errors: errors.length });
  return { ok: true, created, errors, tenantId: _signinState.tenantId };
});

// ── Notification routing rules ──────────────────────────────────────────────
const NOTIFICATION_RULES_FILE = path.join(AGENTS_DIR, 'approver', 'notification-rules.json');
ipcMain.handle('get-notification-rules', () => {
  try {
    if (!fs.existsSync(NOTIFICATION_RULES_FILE)) return { rules: [] };
    return readJson(NOTIFICATION_RULES_FILE) || { rules: [] };
  } catch (e) { return { rules: [], error: e.message }; }
});
ipcMain.handle('save-notification-rules', (event, { rules }) => {
  if (!Array.isArray(rules)) return { ok: false, error: 'rules must be an array' };
  // Basic validation
  for (const r of rules) {
    if (!r.event || !Array.isArray(r.channels) || !r.severity) {
      return { ok: false, error: 'each rule needs event, channels[], severity' };
    }
  }
  try {
    fs.writeFileSync(NOTIFICATION_RULES_FILE, JSON.stringify({ rules }, null, 2) + '\n', 'utf8');
    logOperatorActivity('notification.rules.saved', { count: rules.length });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Append a JSONL entry to operator-activity.jsonl. Best-effort, non-blocking.
function logOperatorActivity(event, details) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      operator: currentOperator || process.env.JML_CONSOLE_OPERATOR || 'unknown',
      role: currentRole || 'viewer',
      event,
      details: details || {}
    };
    fs.appendFileSync(OPERATOR_ACTIVITY_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) { /* non-fatal */ }
}

// In-memory write-token registry. Each successful PIN verification mints a
// short-TTL single-use token; write-IPC handlers require it. This closes the
// devtools-bypass gap — the renderer alone can't fake a verified state.
const writeTokens = new Map(); // token → { user, expires, used }
const WRITE_TOKEN_TTL_MS = 60 * 1000; // 60 seconds
function mintWriteToken(user) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + WRITE_TOKEN_TTL_MS;
  writeTokens.set(token, { user, expires, used: false });
  // Lazy cleanup: drop expired tokens whenever a new one is minted
  for (const [t, v] of writeTokens) if (v.expires < Date.now()) writeTokens.delete(t);
  return token;
}
function consumeWriteToken(token, expectedUser) {
  const entry = writeTokens.get(token);
  if (!entry) return { ok: false, reason: 'token-missing' };
  if (entry.used) return { ok: false, reason: 'token-already-used' };
  if (entry.expires < Date.now()) { writeTokens.delete(token); return { ok: false, reason: 'token-expired' }; }
  if (expectedUser && entry.user !== expectedUser) return { ok: false, reason: 'token-user-mismatch' };
  entry.used = true;
  writeTokens.delete(token); // single-use
  return { ok: true };
}

// Validate a Windows credential by invoking PowerShell's
// System.DirectoryServices.AccountManagement.PrincipalContext.ValidateCredentials.
// Credentials are passed via stdin as JSON — they never appear on the command line
// or in process listings. Returns boolean; any error / timeout → false.
function verifyWindowsCredential(username, password) {
  if (!username || !password) return false;
  const script = [
    "Add-Type -AssemblyName System.DirectoryServices.AccountManagement",
    "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')",
    "$ok = $ctx.ValidateCredentials($payload.username, $payload.password)",
    "@{ok=$ok} | ConvertTo-Json -Compress"
  ].join('; ');
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: JSON.stringify({ username, password }),
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true
      }
    );
    if (result.error || result.status !== 0) return false;
    const out = (result.stdout || '').trim();
    if (!out) return false;
    const parsed = JSON.parse(out);
    return parsed && parsed.ok === true;
  } catch (_e) {
    return false;
  }
}

ipcMain.handle('verify-operator-pin', (event, { user, pin }) => {
  const data = readOperatorAuth();
  const entry = data[user];
  if (!entry) return { ok: false, error: 'no PIN set for this operator' };
  let verified = false;
  if (entry.mode === 'windows') {
    // Windows-auth flow: validate the entered value against the current Windows
    // user's password via PrincipalContext.ValidateCredentials (machine context).
    // Uses the OS username — the operator name in operator-auth.json may differ.
    verified = verifyWindowsCredential(os.userInfo().username, pin);
  } else if (entry.mode === 'pin') {
    if (!entry.pinHash || !entry.salt) return { ok: false, error: 'corrupt PIN entry' };
    const candidate = hashPin(pin, entry.salt);
    verified = crypto.timingSafeEqual(Buffer.from(candidate, 'base64'), Buffer.from(entry.pinHash, 'base64'));
  } else {
    return { ok: false, error: 'unknown auth mode' };
  }
  if (!verified) {
    logOperatorActivity('pin.verify.fail', { target: user });
    return { ok: false };
  }
  logOperatorActivity('pin.verify.ok', { target: user, mode: entry.mode });
  // Mint a write token the renderer can attach to subsequent write IPC calls
  const token = mintWriteToken(user);
  return { ok: true, writeToken: token, ttlMs: WRITE_TOKEN_TTL_MS };
});

// ── Screenshot capture mode (npm start -- --capture) ─────────────────────────
const CAPTURE_MODE = process.argv.includes('--capture');
const CAPTURE_OUT  = path.join(__dirname, '..', 'docs', 'images');

// Mock data pushed directly to renderer for tabs that need Graph/PS connections
const MOCK_DASHBOARD = {
  users:    { total: 12, enabled: 10, disabled: 2, guests: 0 },
  licenses: { licenses: [
    { sku: 'Microsoft 365 E3',     total: 25, assigned: 10 },
    { sku: 'Power BI Pro',         total: 5,  assigned: 2  },
    { sku: 'Intune Device',        total: 10, assigned: 1  }
  ]},
  activity: { totalEntries: 28, recentEntries: [] }
};
const MOCK_AGENT_HEALTH = [
  { name:'joiner',      status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*2).toISOString(),  lastOutcome:'success' },
  { name:'mover',       status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*7).toISOString(),  lastOutcome:'success' },
  { name:'leaver',      status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*5).toISOString(),  lastOutcome:'success' },
  { name:'enroller',    status:'warning',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*6).toISOString(),  lastOutcome:'partial' },
  { name:'approver',    status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*1).toISOString(),  lastOutcome:'success' },
  { name:'provisioner', status:'unconfigured', credentialType:'certificate', daysUntilExpiry:null, lastActivity: null, lastOutcome: null },
  { name:'auditor',     status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*0.5).toISOString(), lastOutcome:'success' }
];
const MOCK_CERT_EXPIRY = [
  { agent:'joiner',      thumbprint:'A1B2C3D4E5F6',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'mover',       thumbprint:'B2C3D4E5F6A1',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'leaver',      thumbprint:'C3D4E5F6A1B2',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'enroller',    thumbprint:'D4E5F6A1B2C3',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'approver',    thumbprint:'E5F6A1B2C3D4',  expiry: new Date(Date.now()+86400000*47).toISOString(),  daysLeft:47  },
  { agent:'provisioner', thumbprint:null,             expiry: null, daysLeft: null },
  { agent:'auditor',     thumbprint:'F6A1B2C3D4E5',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 }
];
// ── Docked panel sample data (dev / demo) ─────────────────────────────────────
function buildMockPanelData() { return {
  approvals: 3,
  oldestApproval: new Date(Date.now() - 2 * 3600000).toISOString(),
  certs: [
    { agent: 'joiner',      daysLeft: 72  },
    { agent: 'mover',       daysLeft: 38  },
    { agent: 'leaver',      daysLeft: 11  },
    { agent: 'enroller',    daysLeft: 6   },
    { agent: 'approver',    daysLeft: null },
    { agent: 'provisioner', daysLeft: 94  },
    { agent: 'auditor',     daysLeft: 25  },
  ],
  recentEvents: [
    { agent: 'leaver',  subject: 'jane.doe@contoso.com',   outcome: 'success', timestamp: new Date(Date.now() -  5 * 60000).toISOString(), whatif: false },
    { agent: 'joiner',  subject: 'mark.weber@contoso.com', outcome: 'success', timestamp: new Date(Date.now() - 22 * 60000).toISOString(), whatif: true  },
    { agent: 'mover',   subject: 'alex.chen@contoso.com',  outcome: 'partial', timestamp: new Date(Date.now() - 58 * 60000).toISOString(), whatif: false },
  ],
  hrQueue: { count: 2, oldestMin: 45 },
  pendingList: [
    { id: 'INC-1020', tool: 'submit_leaver_hard', severity: 'crit', requestedBy: 'admin', requestedByRole: 'helpdesk', requestedAt: new Date(Date.now() - 2*3600000).toISOString(), input: { userPrincipalName: 'robert.martinez@contoso.com' } },
    { id: 'INC-1025', tool: 'submit_joiner',      severity: 'info', requestedBy: 'helpdesk1', requestedByRole: 'helpdesk', requestedAt: new Date(Date.now() - 45*60000).toISOString(), input: { userPrincipalName: 'alex.nguyen@contoso.com' } },
  ],
}; }
const MOCK_APPROVALS = [
  {
    id: 'INC-1020', token: 'INC-1020',
    tool: 'submit_leaver_hard', severity: 'crit',
    requestedBy: 'admin', requestedByRole: 'helpdesk',
    requestedAt: new Date(Date.now()-86400000*1).toISOString(),
    status: 'pending',
    input: {
      userPrincipalName: 'robert.martinez@contoso.onmicrosoft.com',
      stage: 'Hard', ticketRef: 'INC-1020',
      givenName: 'Robert', surname: 'Martinez',
    },
    note: 'User holds privileged Entra directory roles — admin approval required to proceed.'
  },
  {
    id: 'INC-1025', token: 'INC-1025',
    tool: 'submit_joiner', severity: 'info',
    requestedBy: 'helpdesk1', requestedByRole: 'helpdesk',
    requestedAt: new Date(Date.now()-3600000*2).toISOString(),
    status: 'pending',
    input: {
      userPrincipalName: 'alex.nguyen@contoso.onmicrosoft.com',
      stage: 'Provision', ticketRef: 'INC-1025',
      givenName: 'Alex', surname: 'Nguyen',
      department: 'Engineering', jobTitle: 'Software Engineer',
      licenses: ['Microsoft 365 E3'],
      groups: ['Engineering-All', 'Dev-Team'],
    },
    note: 'New hire provisioning — license assignment pending admin sign-off.'
  }
];

// JS injected into renderer for tabs that show empty state by default
const TAB_INJECT = {
  approver: `
    (function(){
      const c = document.getElementById('messages-approver');
      if (!c || c.querySelectorAll('.message').length > 1) return;
      c.innerHTML = \`
        <div class="message user"><div class="message-bubble">I need to offboard Robert Martinez — INC-1020. He was terminated yesterday.</div></div>
        <div class="message assistant"><div class="message-avatar avatar-approver"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg></div><div class="message-body"><div class="message-text">
          Before submitting in LIVE mode I'll run a risk score.<br><br>
          <strong>Risk Score: 68 / 100 — HIGH</strong><br>
          &bull; After-hours pattern flagged for this user by UEBA<br>
          &bull; Sensitive license: Microsoft 365 E3<br>
          &bull; No active freeze window<br><br>
          Proceeding with Soft stage (disable + session revoke). Confirm to continue?
        </div></div></div>
        <div class="message user"><div class="message-bubble">Confirmed. Go ahead.</div></div>
        <div class="message assistant"><div class="message-avatar avatar-approver"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg></div><div class="message-body"><div class="message-text">
          ✅ <strong>Soft leaver complete — INC-1020</strong><br>
          &bull; Account disabled<br>
          &bull; All active sessions revoked<br>
          &bull; Purview IRM termination record submitted<br>
          &bull; Audit entry written and hash-chained<br><br>
          Hard stage (license + group removal) requires dual approval. Token <strong>A3F9C1</strong> created — expires in 30 min.
        </div></div></div>
      \`;
      c.scrollTop = c.scrollHeight;
      if (typeof window.__jmlSetApproverDemoLifecycle === 'function') {
        window.__jmlSetApproverDemoLifecycle();
      }
    })();
  `,
  auditor: `
    (function(){
      const c = document.getElementById('messages-auditor');
      if (!c || c.querySelectorAll('.message').length > 1) return;
      c.innerHTML = \`
        <div class="message user"><div class="message-bubble">Show me all failed and partial operations in the last 7 days.</div></div>
        <div class="message assistant"><div class="message-avatar avatar-auditor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></div><div class="message-body"><div class="message-text">
          Found <strong>3 failed/partial entries</strong> in the last 7 days:<br><br>
          &bull; <code>enroller</code> &rarr; priya.patel@... &mdash; failed &times;2, partial &times;1 (INC-1011)<br>
          &nbsp;&nbsp;Error: Device not found in Intune on first two attempts. Third attempt partial — serial unconfirmed.<br><br>
          These triggered a <strong>UEBA warning</strong>: repeated-failures rule (3 events on same subject within 60 min).
        </div></div></div>
        <div class="message user"><div class="message-bubble">Any off-hours or suspicious access patterns?</div></div>
        <div class="message assistant"><div class="message-avatar avatar-auditor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></div><div class="message-body"><div class="message-text">
          ⚠️ <strong>2 critical UEBA findings:</strong><br><br>
          <strong>1. After-hours leaver</strong><br>
          robert.martinez offboarded at 02:14 UTC, 5 days ago (INC-1020). Normal ops window is 08:00–18:00 UTC.<br><br>
          <strong>2. Leaver-then-group-add</strong><br>
          james.wilson offboarded at 09:04, then added to Contractors-External at 11:30 — 2h 26m later. This may indicate re-engagement without a formal ticket.<br><br>
          Robert Martinez is also <strong>confirmedCompromised</strong> in Identity Protection. Sessions were auto-revoked.
        </div></div></div>
      \`;
      // Add action chips to the last assistant message (mirrors P4 in onComplete)
      const lastMsg = c.querySelector('.message.assistant:last-of-type .message-text');
      if (lastMsg && !lastMsg.querySelector('.auditor-finding-actions')) {
        const wrap = document.createElement('div');
        wrap.className = 'auditor-finding-actions';
        [['→ Security','security'],['→ Operations','operations'],['→ Audit Log','audit-log']].forEach(([label, tab]) => {
          const btn = document.createElement('button');
          btn.className = 'auditor-action-chip';
          btn.textContent = label;
          wrap.appendChild(btn);
        });
        lastMsg.appendChild(wrap);
      }
      c.scrollTop = c.scrollHeight;
      if (typeof window.__jmlSetAuditorDemoRail === 'function') {
        window.__jmlSetAuditorDemoRail(
          'Any off-hours or suspicious access patterns?',
          '2 critical UEBA findings. 3 failed/partial entries in the last 7 days. Robert Martinez is confirmedCompromised; sessions were auto-revoked.'
        );
      }
    })();
  `,
  users: `
    (function(){
      const inp = document.getElementById('user-search-input');
      if (inp) inp.value = 'sarah.chen';
      const panel = document.getElementById('user-detail-panel');
      if (panel) { panel.style.display='block'; panel.style.visibility='visible'; }
      const n = document.getElementById('udp-name');   if(n) n.textContent = 'Sarah Chen';
      const u = document.getElementById('udp-upn');    if(u) u.textContent = 'sarah.chen@contoso.onmicrosoft.com';
      const b = document.getElementById('udp-badge');  if(b){ b.textContent='Enabled'; b.className='status-chip chip-success'; }
      const d = document.getElementById('udp-details');
      if(d) d.innerHTML = '<table class="meta-table"><tr><td>Department</td><td>Engineering</td></tr><tr><td>Job Title</td><td>Engineering Manager</td></tr><tr><td>Office</td><td>Seattle, WA</td></tr><tr><td>Usage Location</td><td>US</td></tr><tr><td>Created</td><td>4/26/2026</td></tr></table>';
      const lic = document.getElementById('udp-licenses');
      if(lic) lic.innerHTML = '<span class="tag">Microsoft 365 E3</span><span class="tag">Power BI Standard</span>';
      const grp = document.getElementById('udp-groups');
      if(grp) grp.innerHTML = '<span class="tag">Engineering-All</span><span class="tag">M365-E3-Users</span><span class="tag">Dev-Team</span>';
      const rl = document.getElementById('user-results-list');
      if(rl) rl.innerHTML = \`
        <div class="ac-item selected"><span class="ac-name">Sarah Chen</span><span class="ac-upn">sarah.chen@contoso.onmicrosoft.com</span></div>
        <div class="ac-item"><span class="ac-name">Marcus Johnson</span><span class="ac-upn">marcus.johnson@contoso.onmicrosoft.com</span></div>
        <div class="ac-item"><span class="ac-name">Sales Lead</span><span class="ac-upn">jennifer.lee@contoso.onmicrosoft.com</span></div>
      \`;
      const cnt = document.getElementById('user-search-count');
      if (cnt) cnt.textContent = '3';
    })();
  `,
  graph: `
    (function(){
      const url = document.getElementById('graph-url');
      if(url) url.value = 'https://graph.microsoft.com/v1.0/users?$select=displayName,userPrincipalName,accountEnabled,assignedLicenses&$top=5&$count=true';
      const method = document.getElementById('graph-method');
      if(method) method.value = 'GET';
      const panel = document.getElementById('graph-response-panel');
      if(panel){ panel.style.display='block'; panel.style.visibility='visible'; }
      const colorBtn = document.getElementById('btn-color-json');
      if(colorBtn){ colorBtn.style.display='inline-flex'; colorBtn.classList.add('active'); colorBtn.textContent='Plain'; }
      const pre = document.getElementById('graph-response-pre');
      if(pre) pre.innerHTML = window.highlightJson ? window.highlightJson(JSON.stringify({
        "@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users",
        "@odata.count":10,
        "value":[
          {"displayName":"Sarah Chen","userPrincipalName":"sarah.chen@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"}]},
          {"displayName":"Marcus Johnson","userPrincipalName":"marcus.johnson@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"}]},
          {"displayName":"Emma Rodriguez","userPrincipalName":"emma.rodriguez@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"},{"skuId":"70d33638-9c74-4d01-bfd3-562de28bd4ba"}]},
          {"displayName":"David Kim","userPrincipalName":"david.kim@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"}]},
          {"displayName":"Robert Martinez","userPrincipalName":"robert.martinez@contoso.onmicrosoft.com","accountEnabled":false,"assignedLicenses":[]}
        ]
      }, null, 2)) : pre.textContent;
      const dc = document.getElementById('graph-digest-card');
      if(dc){ dc.style.display='block'; dc.style.visibility='visible'; }
      const dt = document.getElementById('graph-digest-text');
      if(dt) dt.textContent = '10 users in tenant. 9 accounts enabled, 1 disabled (robert.martinez — offboarded via leaver agent, INC-1020). Active users all hold M365 E3 (ENTERPRISEPACK). Emma Rodriguez additionally has Power BI Standard. No guest accounts in this result set.';
    })();
  `
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCapture() {
  // Use the configured admin operator so demo captures show the intended
  // approval path instead of falling back to viewer permissions.
  currentOperator = 'Nick';
  process.env.JML_CONSOLE_OPERATOR = 'Nick';

  // ── Operator selector ──────────────────────────────────────────────────────
  createOperatorWindow();
  await new Promise(r => operatorWin.webContents.once('did-finish-load', r));
  await sleep(1000);
  let selImg; for (let a=0;a<3;a++){try{selImg=await operatorWin.webContents.capturePage();break;}catch(e){await sleep(600);}}
  if (selImg) fs.writeFileSync(path.join(CAPTURE_OUT, 'operator-select.png'), selImg.toPNG());
  console.log('Captured: operator-select');
  operatorWin.close(); operatorWin = null;

  // ── Main window (tall for full-page shots) ────────────────────────────────
  win = new BrowserWindow({
    width: 1440, height: 1800,
    frame: false,
    icon: APP_ICON,
    backgroundColor: '#11131a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('jml-sidebar-collapsed', '0');
      document.querySelector('.layout')?.classList.remove('sidebar-collapsed');
    } catch (_) {}
  `);
  await sleep(1200);

  // Pre-send mock data so dashboard/certs show content without Graph connection
  win.webContents.send('dashboard-stats',  MOCK_DASHBOARD);
  win.webContents.send('agent-health',     MOCK_AGENT_HEALTH);
  win.webContents.send('cert-expiry', { certs: MOCK_CERT_EXPIRY.map(c => ({ ...c, daysRemaining: c.daysLeft })) });
  win.webContents.send('pending-approvals', MOCK_APPROVALS);
  await sleep(400);

  // Remove overflow constraints so all content is visible in tall screenshots.
  // IMPORTANT: do NOT set height:auto on .content or .layout — those are flex/grid
  // shell containers and height:auto causes .view.active{flex:1} to collapse to 0.
  // Instead: (1) remove overflow clipping on shells, (2) expand the active view and
  // any tab-specific scroller directly.
  const REMOVE_OVERFLOW = `
    (function(){
      // Shell containers — remove clipping only, preserve flex/grid height
      ['.content', '.layout'].forEach(s => {
        document.querySelectorAll(s).forEach(el => {
          el.style.overflow  = 'visible';
          el.style.maxHeight = 'none';
        });
      });
      // Keep inactive views truly hidden. Previous capture passes add inline
      // layout styles to the active view; when that view later becomes inactive
      // those inline styles must not leak into the next screenshot.
      document.querySelectorAll('.view:not(.active)').forEach(el => {
        el.style.display   = 'none';
        el.style.overflow  = '';
        el.style.maxHeight = '';
        el.style.height    = '';
        el.style.opacity   = '';
      });
      // Active view — expand to full content height so all content renders.
      // Also kill the viewfade animation (opacity starts at 0 with fill-mode:both)
      // which can freeze at opacity=0 in software-render / --disable-gpu mode.
      document.querySelectorAll('.view.active').forEach(el => {
        el.style.display   = 'block';
        el.style.animation = 'none';
        el.style.opacity   = '1';
        el.style.overflow  = 'visible';
        el.style.maxHeight = 'none';
        el.style.height    = 'auto';
      });
      // Also kill animations on ALL views to prevent residual opacity:0 state
      document.querySelectorAll('.view').forEach(el => {
        el.style.animation = 'none';
      });
      // Tab-specific inner scrollers
      ['.security-content', '.approvals-content', '.ops-content',
       '.certifications-content', '.exports-content', '.settings-content',
       '.audit-log-content'].forEach(s => {
        document.querySelectorAll(s).forEach(el => {
          el.style.overflow  = 'visible';
          el.style.maxHeight = 'none';
          el.style.height    = 'auto';
        });
      });
    })();
  `;

  const TABS = [
    // [tabId, ipcTriggerJs, extraWaitMs]
    // NOTE: dashboard/agent-health are NOT triggered via window.api — those real IPC
    // handlers can't connect to Entra in capture mode and would overwrite mock data
    // with error responses.  Mock data is re-sent inside the loop instead (see below).
    ['dashboard',      null, 2000],
    ['approver',       null, 600],
    ['auditor',        null, 600],
    ['security',       `window.api.getSecurityReports(); window.api.getAgentHealth();`, 2500],
    ['exports',        `window.api.getExportsStatus();`, 2000],
    ['approvals',      null, 2000],
    ['operations',     `window.api.getScheduledOps();`, 2000],
    // certifications: getCertHistory calls PS1 which may be slow; use longer wait
    ['certifications', null, 2200],
    ['settings',       `window.api.getPolicy();`, 1800],
    // audit-log: skip the IPC trigger in capture mode (PS1 needs real audit.jsonl);
    // the view renders its static structure without data
    ['audit-log',      null, 1200],
    ['users',          null, 1000],
    ['certs',          `window.api.getCertExpiry();`, 1500],
    ['graph',          null, 1000],
  ];

  // Capture approver in default (input) state first
  await win.webContents.executeJavaScript(`document.querySelector('[data-tab="approver"]')?.click()`);
  await sleep(800);
  {
    win.webContents.invalidate();
    await sleep(600);
    let img; for (let a=0;a<3;a++){try{img=await win.webContents.capturePage();break;}catch(e){await sleep(600);}}
    if (img) { fs.writeFileSync(path.join(CAPTURE_OUT, 'jml-fleet-input.png'), img.toPNG()); console.log('Captured: jml-fleet-input'); }
  }

  let lastFrameHash = null;
  let lastFrameTab  = null;

  async function forceCapturePaint() {
    const [w, h] = win.getSize();
    // Software-render capture can return the previous compositor frame unless
    // Chromium has a real resize/paint boundary between tab switches.
    win.setSize(w + 1, h, false);
    await sleep(80);
    win.setSize(w, h, false);
    win.webContents.invalidate();
    await win.webContents.executeJavaScript(`
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    `);
    await sleep(250);
  }

  for (const [tab, ipcJs, wait] of TABS) {
    // Navigate — reset capture inline styles first, then force a single active
    // view after switchTab so stale frames cannot remain visible.
    const activeViewId = await win.webContents.executeJavaScript(`
      (function(){
        const tab = ${JSON.stringify(tab)};
        document.querySelectorAll('.view').forEach(el => {
          el.style.display = '';
          el.style.overflow = '';
          el.style.maxHeight = '';
          el.style.height = '';
          el.style.opacity = '';
        });
        try {
          if (typeof switchTab === 'function') switchTab(tab);
          else document.querySelector('[data-tab="' + tab + '"]')?.click();
        } catch(e) {}
        document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
        document.querySelectorAll('.view').forEach(el => {
          const active = el.id === 'view-' + tab;
          el.classList.toggle('active', active);
          el.style.display = active ? 'block' : 'none';
        });
        const crumb = document.getElementById('crumb-cur');
        if (crumb && typeof TAB_TITLES !== 'undefined') crumb.textContent = TAB_TITLES[tab] || tab;
        return document.querySelector('.view.active')?.id || '';
      })()
    `);
    if (activeViewId !== 'view-' + tab) {
      console.warn(`Capture navigation warning: requested ${tab}, active ${activeViewId || '(none)'}`);
    }
    await sleep(500);
    if (ipcJs) {
      try { await win.webContents.executeJavaScript(ipcJs); } catch(e) { /* IPC trigger failed — skip */ }
    }
    // Re-send mock data that real IPC handlers would wipe in capture mode
    if (tab === 'approvals') win.webContents.send('pending-approvals', MOCK_APPROVALS);
    if (tab === 'dashboard') {
      win.webContents.send('dashboard-stats', MOCK_DASHBOARD);
      win.webContents.send('agent-health',    MOCK_AGENT_HEALTH);
      win.webContents.send('pending-approvals', MOCK_APPROVALS);
    }
    await sleep(wait);
    if (TAB_INJECT[tab]) await win.webContents.executeJavaScript(TAB_INJECT[tab]);
    await win.webContents.executeJavaScript(REMOVE_OVERFLOW);
    // Force a fresh paint before capture (especially needed in --disable-gpu / software render mode)
    await forceCapturePaint();
    let img;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { img = await win.webContents.capturePage(); break; }
      catch (e) { console.warn(`capturePage attempt ${attempt + 1} failed: ${e.message}`); await sleep(600); }
    }
    if (!img) { console.error('capturePage failed for', tab, '- skipping'); continue; }
    const png = img.toPNG();
    const frameHash = crypto.createHash('sha256').update(png).digest('hex');
    if (lastFrameHash === frameHash) {
      console.warn(`Capture warning: ${tab}.png is identical to ${lastFrameTab}.png`);
    }
    lastFrameHash = frameHash;
    lastFrameTab = tab;
    fs.writeFileSync(path.join(CAPTURE_OUT, tab + '.png'), png);
    console.log('Captured:', tab);
  }
  app.quit();
}

// ── First-run setup ───────────────────────────────────────────────────────────
ipcMain.handle('complete-first-run', (event, { winAuth, tenantId, primaryDomain } = {}) => {
  try {
    fs.writeFileSync(SETUP_FILE, JSON.stringify({
      firstRunComplete: true, completedAt: new Date().toISOString(), skipped: false
    }, null, 2), 'utf8');

    if (winAuth) {
      const username = os.userInfo().username;
      let opsData = {};
      try { opsData = readJson(OPERATORS_FILE); } catch {}
      if (!opsData.operators) opsData.operators = {};
      if (!opsData.operators[username]) opsData.operators[username] = 'admin';
      fs.writeFileSync(OPERATORS_FILE, JSON.stringify(opsData, null, 2), 'utf8');
      const authData = readOperatorAuth();
      if (!authData[username]) authData[username] = { mode: 'windows', updatedAt: new Date().toISOString() };
      writeOperatorAuth(authData);
    }

    if (tenantId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      for (const agent of AGENT_DIRS) {
        const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
        if (!fs.existsSync(cfgPath)) continue;
        try {
          const cfg = readJson(cfgPath);
          cfg.TenantId = tenantId;
          if (primaryDomain) cfg.PrimaryDomain = String(primaryDomain).slice(0, 200);
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        } catch {}
      }
    }

    if (setupWin && !setupWin.isDestroyed()) { setupWin.close(); setupWin = null; }
    createOperatorWindow();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('skip-first-run', () => {
  try {
    fs.writeFileSync(SETUP_FILE, JSON.stringify({
      firstRunComplete: true, completedAt: new Date().toISOString(), skipped: true
    }, null, 2), 'utf8');
    if (setupWin && !setupWin.isDestroyed()) { setupWin.close(); setupWin = null; }
    createOperatorWindow();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Integrations config ───────────────────────────────────────────────────────
const INT_CONFIG_DEFAULTS = {
  bamboohr: { enabled: false, label: '' },
  teams:    { enabled: false, channel: '', oncallHandle: '' },
  sentinel: { enabled: false, workspaceName: '', tableName: '' }
};

ipcMain.handle('get-integrations-config', () => {
  try {
    if (!fs.existsSync(INT_CONFIG_FILE)) return { ok: true, config: INT_CONFIG_DEFAULTS };
    return { ok: true, config: readJson(INT_CONFIG_FILE) };
  } catch { return { ok: true, config: INT_CONFIG_DEFAULTS }; }
});

ipcMain.handle('save-integrations-config', (event, { config } = {}) => {
  if (currentRole !== 'admin') return { ok: false, error: 'admin role required' };
  const str = (v, max = 200) => typeof v === 'string' ? v.slice(0, max) : '';
  const c = config || {};
  const sanitized = {
    bamboohr: { enabled: !!(c.bamboohr && c.bamboohr.enabled), label: str(c.bamboohr && c.bamboohr.label) },
    teams:    { enabled: !!(c.teams && c.teams.enabled), channel: str(c.teams && c.teams.channel), oncallHandle: str(c.teams && c.teams.oncallHandle) },
    sentinel: { enabled: !!(c.sentinel && c.sentinel.enabled), workspaceName: str(c.sentinel && c.sentinel.workspaceName), tableName: str(c.sentinel && c.sentinel.tableName) }
  };
  try {
    fs.writeFileSync(INT_CONFIG_FILE, JSON.stringify(sanitized, null, 2), 'utf8');
    logOperatorActivity('integrations.config.saved', {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

function ensureDataDirs() {
  const dirs = [
    path.join(AGENTS_DIR, 'approver', 'pending'),
    path.join(AGENTS_DIR, 'approver', 'logs'),
    path.join(AGENTS_DIR, 'auditor', 'reports'),
    path.join(AGENTS_DIR, 'auditor', 'logs'),
    path.join(AGENTS_DIR, 'joiner', 'logs'),
    path.join(AGENTS_DIR, 'mover', 'logs'),
    path.join(AGENTS_DIR, 'leaver', 'logs'),
    path.join(AGENTS_DIR, 'enroller', 'logs'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.jml.console');
  if (CAPTURE_MODE) { runCapture().catch(e => { console.error('Capture error:', e); app.quit(); process.exitCode = 1; }); return; }
  createTray();
  ensureDataDirs();
  if (isFirstRun()) { createSetupWindow(); } else { createOperatorWindow(); }

  // Global hotkey — Ctrl+Shift+J summons palette
  globalShortcut.register('CommandOrControl+Shift+J', () => {
    if (paletteWin && !paletteWin.isDestroyed()) {
      paletteWin.close();
    } else {
      createPaletteWindow();
    }
  });

  // Global hotkey — Ctrl+Shift+D toggles docked panel
  globalShortcut.register('CommandOrControl+Shift+D', () => { toggleDockedPanel(); });

  // Global hotkey — Ctrl+Shift+Space toggles agent overlay
  globalShortcut.register('CommandOrControl+Shift+Space', toggleOverlayWindow);

  setInterval(pollTrayApprovals, 30000);
  setInterval(pollCertExpiry,    60000 * 5);
  setInterval(pollLastEvent,     30000);
  setInterval(() => pollHrQueue(), 60000);
  pollTrayApprovals();
  pollCertExpiry();
  pollLastEvent();
  pollHrQueue();

  setInterval(() => {
    const ops  = loadScheduled();
    const now  = new Date();
    let changed = false;
    for (const op of ops) {
      if (op.status !== 'pending') continue;
      if (new Date(op.scheduledFor) > now) continue;
      try {
        const payload = op.payload || {};
        const w       = !!op.whatif;
        let raw;
        const opName  = (op.operation || '').toLowerCase();
        if (opName === 'joiner') {
          const _pf3 = writePayloadFile({
            givenName: payload.givenName, surname: payload.surname,
            userPrincipalName: payload.userPrincipalName, department: payload.department,
            jobTitle: payload.jobTitle, usageLocation: payload.usageLocation
          });
          try { raw = runPs(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: _pf3, WhatIf: w }); }
          finally { try { fs.unlinkSync(_pf3); } catch {} }
        } else if (opName === 'leaver') {
          raw = runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
            UserPrincipalName: payload.userPrincipalName, Stage: payload.stage || 'Soft',
            TicketRef: payload.ticketRef, WhatIf: w
          });
        } else if (opName === 'mover') {
          const _pfMover = writePayloadFile({
            userPrincipalName: payload.userPrincipalName,
            department: payload.department,
            jobTitle: payload.jobTitle,
            manager: payload.manager,
            licensesToAdd: payload.licensesToAdd,
            licensesToRemove: payload.licensesToRemove,
            groupsToAdd: payload.groupsToAdd,
            groupsToRemove: payload.groupsToRemove,
            ticketRef: payload.ticketRef
          });
          try { raw = runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: _pfMover, WhatIf: w }); }
          finally { try { fs.unlinkSync(_pfMover); } catch {} }
        }
        op.status = 'executed';
      } catch {
        op.status = 'failed';
      }
      changed = true;
      if (win) win.webContents.send('scheduled-op-fired', op);
    }
    if (changed) saveScheduled(ops);
  }, 60000);
});

app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// ── Feature: User Lookup ──────────────────────────────────────────────────────
ipcMain.on('search-users', (event, { query }) => {
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const cfg = readJson(cfgPath);
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
$q = '${query.replace(/'/g, "''")}'
$uri = "https://graph.microsoft.com/v1.0/users?\`$search=\`"displayName:$q\`" OR \`"userPrincipalName:$q\`"&\`$select=id,displayName,userPrincipalName,accountEnabled&\`$top=25&\`$count=true"
$resp = Invoke-MgGraphRequest -Method GET -Uri $uri -Headers @{'ConsistencyLevel'='eventual'} -ErrorAction Stop
if ($resp.value -and @($resp.value).Count -gt 0) { @($resp.value) | ConvertTo-Json -Depth 2 -Compress } else { '[]' }
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.split(String.fromCharCode(0xFEFF)).join('')).filter(l => l.trim().startsWith('[') || l.trim().startsWith('{')).slice(-1)[0] || '[]';
    let users = [];
    try {
      const parsed = JSON.parse(jsonLine);
      users = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
    // Populate shared cache so panel/overlay autocomplete benefits from Graph results
    users.forEach(u => {
      const upn = u.userPrincipalName || '';
      if (upn && !_sharedUserCache.find(c => c.upn === upn)) {
        _sharedUserCache.push({ upn, displayName: u.displayName || upn.split('@')[0] });
      }
    });
    if (_sharedUserCache.length > 500) _sharedUserCache = _sharedUserCache.slice(-500);
    event.sender.send('user-search-results', { users });
  } catch (err) {
    event.sender.send('user-search-results', { users: [], error: err.message });
  }
});

ipcMain.on('get-user-detail', (event, { userId }) => {
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
$uid = '${userId.replace(/'/g, "''")}'
$user = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$uid\`?\`$select=id,displayName,userPrincipalName,accountEnabled,department,jobTitle,officeLocation,usageLocation,createdDateTime"
$licensesRaw = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$uid/licenseDetails?\`$select=skuPartNumber"
$groupsRaw   = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$uid/memberOf/microsoft.graph.group?\`$select=displayName&\`$top=20"
$managerRaw  = $null
try { $managerRaw = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$uid/manager?\`$select=displayName,userPrincipalName" } catch {}
$out = @{
  user     = $user
  licenses = @($licensesRaw.value | ForEach-Object { $_.skuPartNumber })
  groups   = @($groupsRaw.value   | ForEach-Object { $_.displayName })
  manager  = if ($managerRaw) { @{ displayName=$managerRaw.displayName; userPrincipalName=$managerRaw.userPrincipalName } } else { $null }
}
$out | ConvertTo-Json -Depth 4 -Compress
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{') || l.startsWith('[')).slice(-1)[0] || '';
    let detail = {};
    try { if (jsonLine) detail = JSON.parse(jsonLine); } catch {}
    event.sender.send('user-detail', detail);
  } catch (err) {
    event.sender.send('user-detail', { error: err.message });
  }
});

// ── Feature: Quick Mover ──────────────────────────────────────────────────────
ipcMain.on('run-quick-mover', (event, payload) => {
  if (!requireWriteToken(event, payload, 'quick-op-result')) return;
  const { upn, newDepartment, newJobTitle, newManager, whatif } = payload || {};
  const pf = writePayloadFile({
    userPrincipalName: upn,
    department: newDepartment || null,
    jobTitle:   newJobTitle   || null,
    manager:    newManager    || null
  });
  try {
    const raw    = runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: pf, WhatIf: !!whatif });
    const result = parsePs1Output(raw);
    event.sender.send('quick-op-result', { type: 'mover', lines: result.lines, data: result.data });
  } catch (err) {
    event.sender.send('quick-op-result', { type: 'mover', lines: [err.message], data: null, error: true });
  } finally {
    try { fs.unlinkSync(pf); } catch {}
  }
});

// ── Feature: Quick Leaver ─────────────────────────────────────────────────────
ipcMain.on('run-quick-leaver', (event, payload) => {
  if (!requireWriteToken(event, payload, 'quick-op-result')) return;
  const { upn, stage, reason, whatif } = payload || {};
  try {
    const raw    = runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
      UserPrincipalName: upn, Stage: stage || 'Soft',
      TicketRef: reason || '', WhatIf: !!whatif, OperatorRole: currentRole
    });
    const result = parsePs1Output(raw);
    event.sender.send('quick-op-result', { type: 'leaver', lines: result.lines, data: result.data });
  } catch (err) {
    const stdout = err.stdout || err.message || '';
    if (currentRole === 'helpdesk' && !whatif && stdout.includes('BLOCKED: Operator role')) {
      const tok = routeBlockedLeaverToApproval({ userPrincipalName: upn, ticketRef: reason }, stage || 'Soft');
      event.sender.send('quick-op-result', { type: 'leaver', approvalQueued: true, token: tok,
        lines: ['[APPROVAL] User holds privileged Entra directory roles — approval request submitted for admin review.'] });
      return;
    }
    event.sender.send('quick-op-result', { type: 'leaver', lines: [err.message], data: null, error: true });
  }
});

// ── Feature: Stale Accounts ───────────────────────────────────────────────────
ipcMain.on('get-stale-accounts', (event, { days }) => {
  try {
    const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1');
    if (!fs.existsSync(script)) { event.sender.send('stale-accounts', { accounts: [], error: 'Auditor not configured' }); return; }
    const raw      = runPs(script, { QueryType: 'StaleAccounts', Days: days || 90, TopN: 100 });
    const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    let data = {};
    try { if (jsonLine) data = JSON.parse(jsonLine); } catch {}
    const accounts = (data.accounts || data.staleAccounts || []).map(a => ({
      id:          a.id          || a.Id          || '',
      displayName: a.displayName || a.DisplayName || '',
      upn:         a.userPrincipalName || a.UPN   || '',
      lastSignIn:  a.signInActivity ? (a.signInActivity.lastSignInDateTime || null) : (a.LastSignIn || null)
    }));
    event.sender.send('stale-accounts', { accounts });
  } catch (err) {
    event.sender.send('stale-accounts', { accounts: [], error: err.message });
  }
});

ipcMain.on('disable-stale-accounts', (event, { userIds }) => {
  try {
    const cfgPath = path.join(AGENTS_DIR, 'joiner', 'config.json');
    if (!fs.existsSync(cfgPath)) { event.sender.send('stale-disable-result', { ok: false, error: 'Joiner config not found' }); return; }
    const cfg = readJson(cfgPath);
    const idsJson = JSON.stringify(userIds);
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
$ids = '${idsJson.replace(/'/g, "''")}' | ConvertFrom-Json
$disabled = 0
foreach ($id in $ids) {
  try {
    Invoke-GraphWithRetry -Method PATCH -Uri "https://graph.microsoft.com/v1.0/users/$id" -Body @{ accountEnabled = $false } | Out-Null
    $disabled++
  } catch {}
}
@{ disabled = $disabled } | ConvertTo-Json
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 120000 });
    const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    let result = { disabled: 0 };
    try { if (jsonLine) result = JSON.parse(jsonLine); } catch {}
    event.sender.send('stale-disable-result', { ok: true, disabled: result.disabled });
  } catch (err) {
    event.sender.send('stale-disable-result', { ok: false, error: err.message });
  }
});

// ── Feature: License Utilization ──────────────────────────────────────────────
ipcMain.on('get-license-utilization', (event) => {
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
$resp = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/subscribedSkus?\`$select=skuPartNumber,prepaidUnits,consumedUnits"
$skus = $resp.value | ForEach-Object {
  @{
    sku      = $_.skuPartNumber
    total    = $_.prepaidUnits.enabled
    assigned = $_.consumedUnits
    available= $_.prepaidUnits.enabled - $_.consumedUnits
  }
}
@{ skus = @($skus) } | ConvertTo-Json -Depth 3 -Compress
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).slice(-1)[0];
    let data = { skus: [] };
    try { if (jsonLine) data = JSON.parse(jsonLine); } catch {}
    event.sender.send('license-utilization', { skus: data.skus || [] });
  } catch (err) {
    event.sender.send('license-utilization', { skus: [], error: err.message });
  }
});

// ── Feature: Certificate Expiry ───────────────────────────────────────────────
ipcMain.on('get-cert-expiry', (event) => {
  try {
    const results = [];
    for (const agentName of AGENT_DIRS) {
      const cfgPath = path.join(AGENTS_DIR, agentName, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      let cfg = {};
      try { cfg = readJson(cfgPath); } catch { continue; }
      if (!cfg.CertThumbprint && !cfg.CertExpiry) continue;
      const expiry = cfg.CertExpiry || null;
      let daysRemaining = null;
      if (expiry) {
        const diff = new Date(expiry) - Date.now();
        daysRemaining = Math.floor(diff / 86400000);
      }
      results.push({
        agent:         agentName,
        thumbprint:    cfg.CertThumbprint || '',
        expiry:        expiry,
        daysRemaining: daysRemaining
      });
    }
    event.sender.send('cert-expiry', { certs: results });
  } catch (err) {
    event.sender.send('cert-expiry', { certs: [], error: err.message });
  }
});

// ── Feature: SoD Conflict Tester ─────────────────────────────────────────────
ipcMain.on('test-sod-conflict', (event, { groupA, groupB, upn }) => {
  try {
    const script = path.join(AGENTS_DIR, 'shared', 'Invoke-SoDCheck.ps1');
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
$result = & '${script.replace(/\\/g, '\\\\')}' -UserPrincipalName '${(upn || 'test@test.com').replace(/'/g, "''")}' -IncomingGroups @('${groupA.replace(/'/g, "''")}','${groupB.replace(/'/g, "''")}')
$result | ConvertTo-Json -Depth 3 -Compress
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).slice(-1)[0];
    let result = {};
    try { if (jsonLine) result = JSON.parse(jsonLine); } catch {}
    event.sender.send('sod-result', result);
  } catch (err) {
    event.sender.send('sod-result', { error: err.message });
  }
});

// ── Feature: Graph Query Runner ───────────────────────────────────────────────
ipcMain.on('run-graph-query', (event, payload) => {
  try {
    const { method, url, body } = payload || {};
    const verb = String(method || 'GET').toUpperCase();
    if (!url) { event.sender.send('graph-query-result', { ok: false, error: 'Graph URL is required' }); return; }
    if (/^(POST|PATCH|DELETE)$/.test(verb) && !requireWriteToken(event, payload, 'graph-query-result')) return;
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const safeUrl  = url.replace(/'/g, "''");
    const safeBody = body ? JSON.stringify(body) : '';
    const bodyBlock = (verb === 'POST' || verb === 'PATCH') && safeBody
      ? `-Body ('${safeBody.replace(/'/g, "''")}' | ConvertFrom-Json)`
      : '';
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
$resp = Invoke-GraphWithRetry -Method ${verb} -Uri '${safeUrl}' ${bodyBlock}
$resp | ConvertTo-Json -Depth 6 -Compress
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{') || l.startsWith('[')).slice(-1)[0] || '';
    let result = null;
    try { result = jsonLine ? JSON.parse(jsonLine) : raw.trim(); } catch { result = raw.trim(); }
    event.sender.send('graph-query-result', { ok: true, result });
  } catch (err) {
    event.sender.send('graph-query-result', { ok: false, error: err.message });
  }
});

// ── Feature: Graph Query Digest ───────────────────────────────────────────────
ipcMain.on('digest-graph-result', async (event, { method, url, responseText }) => {
  const provider = getAIProvider();
  if (!provider) { event.sender.send('graph-digest', { ok: false }); return; }
  try {
    const truncated = responseText.length > 2500 ? responseText.slice(0, 2500) + '…' : responseText;
    const text = await provider.complete({
      maxTokens: 120,
      messages: [{ role: 'user', content: `In 1-2 plain English sentences, describe what this Microsoft Graph API call does and what the response contains. No markdown.\nMethod: ${method}\nURL: ${url}\nResponse: ${truncated}` }]
    });
    event.sender.send('graph-digest', { ok: true, text: text.trim() });
  } catch { event.sender.send('graph-digest', { ok: false }); }
});

// ── Feature: Graph Query Suggest ──────────────────────────────────────────────
ipcMain.on('suggest-graph-query', async (event, { description }) => {
  const provider = getAIProvider();
  if (!provider) { event.sender.send('graph-query-suggestion', { ok: false, error: 'AI provider not configured' }); return; }
  try {
    const text = await provider.complete({
      maxTokens: 300,
      messages: [{ role: 'user', content: `You are a Microsoft Graph API expert. Convert this request into a Graph API call.\nRespond with ONLY a raw JSON object (no markdown, no explanation):\n{"method":"GET","url":"https://graph.microsoft.com/v1.0/...","body":null}\n\nRequest: ${description}` }]
    });
    const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const suggestion = JSON.parse(cleaned);
    event.sender.send('graph-query-suggestion', { ok: true, ...suggestion });
  } catch (err) {
    event.sender.send('graph-query-suggestion', { ok: false, error: err.message });
  }
});

// ── Feature: PIM Roles ────────────────────────────────────────────────────────
ipcMain.on('get-pim-roles', (event) => {
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
try {
  $elig = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleEligibilitySchedules?\`$expand=roleDefinition"
  $active = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentSchedules?\`$expand=roleDefinition"
  $roles = @()
  foreach ($r in $elig.value) {
    $roles += @{ roleDefinitionId=$r.roleDefinitionId; roleName=if($r.roleDefinition){$r.roleDefinition.displayName}else{$r.roleDefinitionId}; status="Eligible"; expiry=$null }
  }
  foreach ($r in $active.value) {
    $exp = if($r.scheduleInfo -and $r.scheduleInfo.expiration){$r.scheduleInfo.expiration.endDateTime}else{$null}
    $roles += @{ roleDefinitionId=$r.roleDefinitionId; roleName=if($r.roleDefinition){$r.roleDefinition.displayName}else{$r.roleDefinitionId}; status="Active"; expiry=$exp }
  }
  @{ ok=$true; roles=@($roles) } | ConvertTo-Json -Depth 4 -Compress
} catch {
  @{ ok=$false; error=$_.Exception.Message; roles=@() } | ConvertTo-Json -Depth 2 -Compress
}
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).slice(-1)[0];
    let data = { ok: false, roles: [] };
    try { if (jsonLine) data = JSON.parse(jsonLine); } catch {}
    event.sender.send('pim-roles', data);
  } catch (err) {
    event.sender.send('pim-roles', { ok: false, roles: [], error: err.message });
  }
});

ipcMain.on('activate-pim-role', (event, { roleDefinitionId, justification, durationHours }) => {
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const cfg = readJson(cfgPath);
    const ps = `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
try {
  $me = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/me?\`$select=id"
  $body = @{
    action            = "selfActivate"
    principalId       = $me.id
    roleDefinitionId  = '${roleDefinitionId.replace(/'/g, "''")}'
    directoryScopeId  = "/"
    justification     = '${(justification || '').replace(/'/g, "''")}'
    scheduleInfo      = @{
      startDateTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
      expiration    = @{ type = "AfterDuration"; duration = "PT${Math.max(1, Math.min(8, parseInt(durationHours) || 1))}H" }
    }
  }
  $resp = Invoke-GraphWithRetry -Method POST -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentScheduleRequests" -Body $body
  @{ ok=$true; id=$resp.id } | ConvertTo-Json -Compress
} catch {
  @{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress
}
`;
    const raw = execFileSync('powershell', ['-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).slice(-1)[0];
    let result = { ok: false };
    try { if (jsonLine) result = JSON.parse(jsonLine); } catch {}
    event.sender.send('pim-activate-result', result);
  } catch (err) {
    event.sender.send('pim-activate-result', { ok: false, error: err.message });
  }
});

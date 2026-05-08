'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync }                 = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

const AGENTS_DIR    = path.join(os.homedir(), '.claude', 'agents');
const REPORTS_DIR   = path.join(__dirname, '..', 'auditor', 'reports');
const TENANT_DOMAIN = 'contoso.onmicrosoft.com';

// ── Agent state ───────────────────────────────────────────────────────────────
const state = {
  approver: { messages: [], whatif: true },
  auditor:  { messages: [] }
};

// ── System prompts ────────────────────────────────────────────────────────────
const APPROVER_SYSTEM = `
You are the Approver Agent for a JML identity lifecycle management system.
You are the intelligent gatekeeper for identity change requests in Microsoft Entra ID.

Tenant: ${TENANT_DOMAIN}
UPN format: firstname.lastname@${TENANT_DOMAIN}

Request types:
JOINER: givenName, surname, userPrincipalName (auto-generate from name), department, jobTitle, usageLocation (2-letter ISO), manager?, licenses?, groups?
ENROLLER: userPrincipalName, licenses?, groups?
MOVER: userPrincipalName + at least one of: newDepartment, newJobTitle, newManager, licensesToAdd, licensesToRemove, groupsToAdd, groupsToRemove
LEAVER: userPrincipalName (two-stage: Soft then Hard)

Rules:
- Never invent or guess values
- Always confirm full details before calling a tool
- For leavers, explain the two-stage process and confirm each stage
- Auto-generate UPNs as firstname.lastname@${TENANT_DOMAIN}
`.trim();

const AUDITOR_SYSTEM = `
You are the JML Audit Agent -- a read-only intelligence layer over Microsoft Entra ID.
Tenant: ${TENANT_DOMAIN}

You NEVER suggest or make changes to the directory. Strictly observational.

You have two roles:

1. TENANT INTELLIGENCE: Answer questions about the live tenant state using your query tools.
   Available: user counts, license utilization, recent joins/leavers, admin roles, group summary, JML activity, stale accounts, guest users.
   Present numbers prominently. Offer follow-up queries when results are interesting.

2. OPERATIONAL GUIDE: Answer "how do I" questions about the JML system itself -- without calling any tools.
   You know the following about this system:

   WORKFLOW: New hire → Joiner (creates account) → Enroller (licenses + devices) → Mover (if role changes) → Leaver (offboarding)

   JOINER requires: First name, last name, department, job title, usage location (2-letter country code, e.g. US).
   UPN is auto-generated as firstname.lastname@${TENANT_DOMAIN}. Optional: manager UPN, license SKUs, group names.

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
`.trim();

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
    input_schema: { type: 'object', properties: { topN: { type: 'integer' } }, required: [] } }
];

// ── PS1 dispatch ──────────────────────────────────────────────────────────────
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

function parsePs1Output(raw) {
  const lines = raw.trim().split('\n');
  const visible = lines.filter(l => /\[(ACTION|ERROR|WARN|SKIP|WHATIF)\]/.test(l))
                       .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\] /, '').trim());
  const jsonLine = lines.filter(l => l.trim().startsWith('{')).pop();
  let data = null;
  try { if (jsonLine) data = JSON.parse(jsonLine); } catch {}
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
    const queryType = AUDITOR_QUERY_MAP[toolName];
    const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1');
    const params = { QueryType: queryType };
    if (input.days) params.Days = input.days;
    if (input.topN) params.TopN = input.topN;
    const raw = runPs(script, params);
    const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    return jsonLine ? JSON.parse(jsonLine) : { error: 'No output' };
  }

  const w = whatif ? true : false;
  switch (toolName) {
    case 'submit_joiner':
      return parsePs1Output(runPs(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), {
        GivenName: input.givenName, Surname: input.surname,
        UserPrincipalName: input.userPrincipalName, Department: input.department,
        JobTitle: input.jobTitle, UsageLocation: input.usageLocation,
        Manager: input.manager, Licenses: input.licenses, Groups: input.groups,
        MobilePhone: input.mobilePhone, OfficeLocation: input.officeLocation,
        WhatIf: w
      }));
    case 'submit_enroller':
      return parsePs1Output(runPs(path.join(AGENTS_DIR, 'enroller', 'Invoke-EnrollerProcess.ps1'), {
        UserPrincipalName: input.userPrincipalName,
        Licenses: input.licenses, Groups: input.groups, WhatIf: w
      }));
    case 'submit_mover':
      return parsePs1Output(runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), {
        UserPrincipalName: input.userPrincipalName,
        Department: input.newDepartment, JobTitle: input.newJobTitle,
        Manager: input.newManager,
        LicensesToAdd: input.licensesToAdd, LicensesToRemove: input.licensesToRemove,
        GroupsToAdd: input.groupsToAdd, GroupsToRemove: input.groupsToRemove, WhatIf: w
      }));
    case 'submit_leaver_soft':
      return parsePs1Output(runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
        UserPrincipalName: input.userPrincipalName, Stage: 'Soft', WhatIf: w
      }));
    case 'submit_leaver_hard':
      return parsePs1Output(runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
        UserPrincipalName: input.userPrincipalName, Stage: 'Hard', WhatIf: w
      }));
    default:
      return { error: 'Unknown tool: ' + toolName };
  }
}

// ── Claude agent loop (with streaming) ───────────────────────────────────────
async function runAgentLoop(sender, agent, userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { sender.send('msg-error', { text: 'ANTHROPIC_API_KEY not set.' }); return; }

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic.default({ apiKey });

  const agentState = state[agent];
  agentState.messages.push({ role: 'user', content: userText });

  const systemPrompt = agent === 'approver' ? APPROVER_SYSTEM : AUDITOR_SYSTEM;
  const tools        = agent === 'approver' ? APPROVER_TOOLS  : AUDITOR_TOOLS;

  while (true) {
    const stream = client.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages: agentState.messages
    });

    let currentText = '';
    const toolInputs = {};

    stream.on('text', (text) => {
      sender.send('msg-chunk', { type: 'text', text });
      currentText += text;
    });

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolInputs[event.index] = { id: event.content_block.id, name: event.content_block.name, inputStr: '' };
        sender.send('msg-chunk', { type: 'tool_start', toolName: event.content_block.name });
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        if (toolInputs[event.index]) toolInputs[event.index].inputStr += event.delta.partial_json;
      }
    });

    const finalMsg = await stream.finalMessage();
    agentState.messages.push({ role: 'assistant', content: finalMsg.content });

    if (finalMsg.stop_reason === 'end_turn') break;

    const toolResults = [];
    for (const tool of Object.values(toolInputs)) {
      let input = {};
      try { input = JSON.parse(tool.inputStr || '{}'); } catch {}

      sender.send('msg-chunk', { type: 'tool_running', toolName: tool.name });
      let result;
      try {
        result = executeTool(agent, tool.name, input, agentState.whatif);
        sender.send('msg-chunk', { type: 'tool_done', toolName: tool.name, success: true });
      } catch (err) {
        result = { error: err.message };
        sender.send('msg-chunk', { type: 'tool_done', toolName: tool.name, success: false });
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
    }

    if (toolResults.length > 0) {
      agentState.messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  sender.send('msg-complete', { agent });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.on('send-message', (event, { agent, text }) => {
  runAgentLoop(event.sender, agent, text).catch(err => {
    event.sender.send('msg-error', { text: err.message });
  });
});

ipcMain.on('set-mode', (event, { whatif }) => {
  state.approver.whatif = whatif;
});

ipcMain.on('clear-history', (event, { agent }) => {
  state[agent].messages = [];
  event.sender.send('history-cleared', { agent });
});

ipcMain.on('get-audit-log', (event) => {
  const auditPath = path.join(AGENTS_DIR, 'shared', 'audit.jsonl');
  if (!fs.existsSync(auditPath)) { event.sender.send('audit-log-data', []); return; }
  const lines   = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  event.sender.send('audit-log-data', entries.reverse());
});

ipcMain.on('get-dashboard-stats', (event) => {
  try {
    const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1');
    if (!fs.existsSync(script)) { event.sender.send('dashboard-stats', { error: 'Auditor not configured' }); return; }
    const userRaw     = runPs(script, { QueryType: 'UserSummary' });
    const licenseRaw  = runPs(script, { QueryType: 'LicenseReport' });
    const activityRaw = runPs(script, { QueryType: 'JMLActivity', TopN: '5' });
    const parseJ = raw => { const l = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop(); return l ? JSON.parse(l) : {}; };
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
    try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, files[0]), 'utf8')); }
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
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  const base = path.join(REPORTS_DIR);
  event.sender.send('exports-status', {
    blob:     readStatus(path.join(base, 'blob-export-status.json')),
    sentinel: readStatus(path.join(base, 'sentinel-status.json'))
  });
});

ipcMain.on('run-blob-export', (event) => {
  const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-BlobExport.ps1');
  try {
    runPs(script);
    const status = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, 'blob-export-status.json'), 'utf8'));
    event.sender.send('export-run-result', { type: 'blob', ok: true, status });
  } catch (err) {
    event.sender.send('export-run-result', { type: 'blob', ok: false, error: err.message });
  }
});

ipcMain.on('run-sentinel-ingest', (event) => {
  const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-SentinelIngest.ps1');
  try {
    runPs(script);
    const status = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, 'sentinel-status.json'), 'utf8'));
    event.sender.send('export-run-result', { type: 'sentinel', ok: true, status });
  } catch (err) {
    event.sender.send('export-run-result', { type: 'sentinel', ok: false, error: err.message });
  }
});

ipcMain.on('window-minimize', () => { if (win) win.minimize(); });
ipcMain.on('window-maximize', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } });
ipcMain.on('window-close',    () => { app.quit(); });

// ── Window ────────────────────────────────────────────────────────────────────
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780,
    minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

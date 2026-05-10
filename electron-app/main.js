'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync }                 = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

const AGENTS_DIR    = path.join(__dirname, '..');
const REPORTS_DIR   = path.join(__dirname, '..', 'auditor', 'reports');
const TENANT_DOMAIN = 'contoso.onmicrosoft.com';

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
const CERT_SCRIPT    = path.join(AGENTS_DIR, 'certifier', 'Invoke-CertificationCampaign.ps1');
const AGENT_DIRS     = ['joiner','mover','leaver','enroller','approver','provisioner','auditor'];

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
    case 'suggest_provisioning': {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-ProvisioningRecommendation.ps1'), {
        Department: input.department,
        JobTitle:   input.jobTitle
      });
      const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
      return jsonLine ? JSON.parse(jsonLine) : { error: 'No output from recommendation script' };
    }
    case 'score_risk': {
      const raw = runPs(path.join(AGENTS_DIR, 'auditor', 'Invoke-RiskScore.ps1'), {
        Operation:         input.operation,
        UserPrincipalName: input.userPrincipalName,
        Licenses:          input.licenses,
        Groups:            input.groups,
        NewDepartment:     input.newDepartment
      });
      const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
      return jsonLine ? JSON.parse(jsonLine) : { error: 'No output from risk score script' };
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
  const auditPath = path.join(AGENTS_DIR, 'audit.jsonl');
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

ipcMain.on('run-blob-export', (event) => {
  const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-BlobExport.ps1');
  try {
    runPs(script);
    const status = readJson(path.join(REPORTS_DIR, 'blob-export-status.json'));
    event.sender.send('export-run-result', { type: 'blob', ok: true, status });
  } catch (err) {
    event.sender.send('export-run-result', { type: 'blob', ok: false, error: err.message });
  }
});

ipcMain.on('run-sentinel-ingest', (event) => {
  const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-SentinelIngest.ps1');
  try {
    runPs(script);
    const status = readJson(path.join(REPORTS_DIR, 'sentinel-status.json'));
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

ipcMain.on('approve-pending', (event, { id }) => {
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    if (!fs.existsSync(file)) { event.sender.send('approve-result', { ok: false, error: 'Not found' }); return; }
    const op = readJson(file);
    const params = { UserPrincipalName: op.userPrincipalName, Stage: op.stage || 'Soft' };
    if (op.ticketRef) params.TicketRef = op.ticketRef;
    const script = path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1');
    const raw    = runPs(script, params);
    const result = parsePs1Output(raw);
    fs.unlinkSync(file);
    event.sender.send('approve-result', { ok: true, result });
  } catch (err) {
    event.sender.send('approve-result', { ok: false, error: err.message });
  }
});

ipcMain.on('reject-pending', (event, { id }) => {
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
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
        raw = runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), {
          UserPrincipalName: row.userPrincipalName, Department: row.department,
          JobTitle: row.jobTitle, WhatIf: !!whatif
        });
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
    const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('[')).pop();
    let campaigns = [];
    try { if (jsonLine) campaigns = JSON.parse(jsonLine); } catch {}
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
    const existing = fs.existsSync(OPERATORS_FILE) ? readJson(OPERATORS_FILE) : {};
    const updated  = Object.assign({}, existing, { operators, roles });
    fs.writeFileSync(OPERATORS_FILE, JSON.stringify(updated, null, 2), 'utf8');
    event.sender.send('operators-saved', { ok: true });
  } catch (err) {
    event.sender.send('operators-saved', { ok: false, error: err.message });
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
ipcMain.on('window-close',    () => { app.quit(); });

// ── Window ────────────────────────────────────────────────────────────────────
let win;
let operatorWin;
let currentOperator = os.userInfo().username;

function createMainWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780,
    minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function createOperatorWindow() {
  operatorWin = new BrowserWindow({
    width: 420, height: 440,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#0d0f14',
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

ipcMain.handle('get-current-operator', () => ({ name: currentOperator }));

ipcMain.on('select-operator', (event, { name, role }) => {
  currentOperator = name;
  process.env.JML_CONSOLE_OPERATOR = name;
  if (operatorWin && !operatorWin.isDestroyed()) { operatorWin.close(); operatorWin = null; }
  if (!win) createMainWindow();
});

ipcMain.on('switch-operator', (event, { name, role }) => {
  currentOperator = name;
  process.env.JML_CONSOLE_OPERATOR = name;
  if (win && !win.isDestroyed()) win.webContents.send('operator-switched', { name, role });
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

// JS injected into renderer for tabs that show empty state by default
const TAB_INJECT = {
  approver: `
    (function(){
      const c = document.getElementById('messages-approver');
      if (!c || c.querySelectorAll('.message').length > 1) return;
      c.innerHTML = \`
        <div class="message user"><div class="message-bubble">I need to offboard Robert Martinez — INC-1020. He was terminated yesterday.</div></div>
        <div class="message assistant"><div class="message-avatar">AI</div><div class="message-body"><div class="message-text">
          Before submitting in LIVE mode I'll run a risk score.<br><br>
          <strong>Risk Score: 68 / 100 — HIGH</strong><br>
          &bull; After-hours pattern flagged for this user by UEBA<br>
          &bull; Sensitive license: Microsoft 365 E3<br>
          &bull; No active freeze window<br><br>
          Proceeding with Soft stage (disable + session revoke). Confirm to continue?
        </div></div></div>
        <div class="message user"><div class="message-bubble">Confirmed. Go ahead.</div></div>
        <div class="message assistant"><div class="message-avatar">AI</div><div class="message-body"><div class="message-text">
          ✅ <strong>Soft leaver complete — INC-1020</strong><br>
          &bull; Account disabled<br>
          &bull; All active sessions revoked<br>
          &bull; Purview IRM termination record submitted<br>
          &bull; Audit entry written and hash-chained<br><br>
          Hard stage (license + group removal) requires dual approval. Token <strong>A3F9C1</strong> created — expires in 30 min.
        </div></div></div>
      \`;
      c.scrollTop = c.scrollHeight;
    })();
  `,
  auditor: `
    (function(){
      const c = document.getElementById('messages-auditor');
      if (!c || c.querySelectorAll('.message').length > 1) return;
      c.innerHTML = \`
        <div class="message user"><div class="message-bubble">Show me all failed and partial operations in the last 7 days.</div></div>
        <div class="message assistant"><div class="message-avatar">AI</div><div class="message-body"><div class="message-text">
          Found <strong>3 failed/partial entries</strong> in the last 7 days:<br><br>
          &bull; <code>enroller</code> &rarr; priya.patel@... &mdash; failed &times;2, partial &times;1 (INC-1011)<br>
          &nbsp;&nbsp;Error: Device not found in Intune on first two attempts. Third attempt partial — serial unconfirmed.<br><br>
          These triggered a <strong>UEBA warning</strong>: repeated-failures rule (3 events on same subject within 60 min).
        </div></div></div>
        <div class="message user"><div class="message-bubble">Any off-hours or suspicious access patterns?</div></div>
        <div class="message assistant"><div class="message-avatar">AI</div><div class="message-body"><div class="message-text">
          ⚠️ <strong>2 critical UEBA findings:</strong><br><br>
          <strong>1. After-hours leaver</strong><br>
          robert.martinez offboarded at 02:14 UTC, 5 days ago (INC-1020). Normal ops window is 08:00–18:00 UTC.<br><br>
          <strong>2. Leaver-then-group-add</strong><br>
          james.wilson offboarded at 09:04, then added to Contractors-External at 11:30 — 2h 26m later. This may indicate re-engagement without a formal ticket.<br><br>
          Robert Martinez is also <strong>confirmedCompromised</strong> in Identity Protection. Sessions were auto-revoked.
        </div></div></div>
      \`;
      c.scrollTop = c.scrollHeight;
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
      const pre = document.getElementById('graph-response-pre');
      if(pre) pre.textContent = JSON.stringify({
        "@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users",
        "@odata.count":10,
        "value":[
          {"displayName":"Sarah Chen","userPrincipalName":"sarah.chen@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"}]},
          {"displayName":"Marcus Johnson","userPrincipalName":"marcus.johnson@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"}]},
          {"displayName":"Emma Rodriguez","userPrincipalName":"emma.rodriguez@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"},{"skuId":"70d33638-9c74-4d01-bfd3-562de28bd4ba"}]},
          {"displayName":"David Kim","userPrincipalName":"david.kim@contoso.onmicrosoft.com","accountEnabled":true,"assignedLicenses":[{"skuId":"06ebc4ee-1bb5-47dd-8120-11324bc54e06"}]},
          {"displayName":"Robert Martinez","userPrincipalName":"robert.martinez@contoso.onmicrosoft.com","accountEnabled":false,"assignedLicenses":[]}
        ]
      }, null, 2);
      const dc = document.getElementById('graph-digest-card');
      if(dc){ dc.style.display='block'; dc.style.visibility='visible'; }
      const dt = document.getElementById('graph-digest-text');
      if(dt) dt.textContent = '10 users in tenant. 9 accounts enabled, 1 disabled (robert.martinez — offboarded via leaver agent, INC-1020). Active users all hold M365 E3 (ENTERPRISEPACK). Emma Rodriguez additionally has Power BI Standard. No guest accounts in this result set.';
    })();
  `
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCapture() {
  currentOperator = 'admin';
  process.env.JML_CONSOLE_OPERATOR = 'admin';

  // ── Operator selector ──────────────────────────────────────────────────────
  createOperatorWindow();
  await new Promise(r => operatorWin.webContents.once('did-finish-load', r));
  await sleep(1000);
  const selImg = await operatorWin.webContents.capturePage();
  fs.writeFileSync(path.join(CAPTURE_OUT, 'operator-select.png'), selImg.toPNG());
  console.log('Captured: operator-select');
  operatorWin.close(); operatorWin = null;

  // ── Main window (larger for full-page shots) ───────────────────────────────
  win = new BrowserWindow({
    width: 1440, height: 900,
    frame: false,
    backgroundColor: '#0d0f14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await sleep(1200);

  // Pre-send mock data so dashboard/certs show content without Graph connection
  win.webContents.send('dashboard-stats',  MOCK_DASHBOARD);
  win.webContents.send('agent-health',     MOCK_AGENT_HEALTH);
  win.webContents.send('cert-expiry-data', MOCK_CERT_EXPIRY);
  await sleep(400);

  const TABS = [
    // [tabId, ipcTriggerJs, extraWaitMs]
    ['dashboard',      `window.api.getDashboardStats(); window.api.getAgentHealth();`, 2000],
    ['approver',       null, 600],
    ['auditor',        null, 600],
    ['security',       `window.api.getSecurityReports(); window.api.getAgentHealth();`, 2500],
    ['exports',        `window.api.getExportsStatus();`, 2000],
    ['approvals',      `window.api.getPendingApprovals();`, 1800],
    ['operations',     `window.api.getScheduledOps();`, 1800],
    ['certifications', `window.api.getCertHistory();`, 1800],
    ['settings',       `window.api.getPolicy();`, 1800],
    ['audit-log',      `window.api.getAuditLog();`, 2200],
    ['users',          null, 600],
    ['graph',          null, 600],
  ];

  for (const [tab, ipcJs, wait] of TABS) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="${tab}"]')?.click()`);
    await sleep(300);
    if (ipcJs) await win.webContents.executeJavaScript(ipcJs);
    await sleep(wait);
    if (TAB_INJECT[tab]) await win.webContents.executeJavaScript(TAB_INJECT[tab]);
    await sleep(300);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(CAPTURE_OUT, tab + '.png'), img.toPNG());
    console.log('Captured:', tab);
  }
  app.quit();
}

app.whenReady().then(() => {
  if (CAPTURE_MODE) { runCapture(); return; }
  createOperatorWindow();

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
          raw = runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), {
            UserPrincipalName: payload.userPrincipalName, Department: payload.department,
            JobTitle: payload.jobTitle, WhatIf: w
          });
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

app.on('window-all-closed', () => app.quit());

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
ipcMain.on('run-quick-mover', (event, { upn, newDepartment, newJobTitle, newManager, whatif }) => {
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
ipcMain.on('run-quick-leaver', (event, { upn, stage, reason, whatif }) => {
  try {
    const raw    = runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
      UserPrincipalName: upn, Stage: stage || 'Soft',
      TicketRef: reason || '', WhatIf: !!whatif
    });
    const result = parsePs1Output(raw);
    event.sender.send('quick-op-result', { type: 'leaver', lines: result.lines, data: result.data });
  } catch (err) {
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
ipcMain.on('run-graph-query', (event, { method, url, body }) => {
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const safeUrl  = url.replace(/'/g, "''");
    const safeBody = body ? JSON.stringify(body) : '';
    const bodyBlock = (method === 'POST' || method === 'PATCH') && safeBody
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
$resp = Invoke-GraphWithRetry -Method ${method} -Uri '${safeUrl}' ${bodyBlock}
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { event.sender.send('graph-digest', { ok: false }); return; }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });
    const truncated = responseText.length > 2500 ? responseText.slice(0, 2500) + '…' : responseText;
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: `In 1-2 plain English sentences, describe what this Microsoft Graph API call does and what the response contains. No markdown.\nMethod: ${method}\nURL: ${url}\nResponse: ${truncated}` }]
    });
    event.sender.send('graph-digest', { ok: true, text: msg.content[0].text.trim() });
  } catch { event.sender.send('graph-digest', { ok: false }); }
});

// ── Feature: Graph Query Suggest ──────────────────────────────────────────────
ipcMain.on('suggest-graph-query', async (event, { description }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { event.sender.send('graph-query-suggestion', { ok: false, error: 'ANTHROPIC_API_KEY not set' }); return; }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: `You are a Microsoft Graph API expert. Convert this request into a Graph API call.\nRespond with ONLY a raw JSON object (no markdown, no explanation):\n{"method":"GET","url":"https://graph.microsoft.com/v1.0/...","body":null}\n\nRequest: ${description}` }]
    });
    const text = msg.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const suggestion = JSON.parse(text);
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

'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu, Notification, globalShortcut, screen, shell } = require('electron');
const { execFileSync, execFile, spawnSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');
const {
  classifyToolResult,
  isLifecycleSubmitTool,
  lifecycleStageForTool,
} = require('./lib/operation-status');
const {
  assertExternalExecutionAllowed,
  demoReceipt,
  isDemoMode,
} = require('./lib/demo-safety');
const {
  collectGroundingFacts,
  groundedFallback,
  validateGroundedAssistantText,
} = require('./lib/agent-grounding');
const { stripQueryEcho } = require('./lib/response-sanitizer');

const PRESENTATION_MODE = isDemoMode(process.argv);

const AGENTS_DIR    = app.isPackaged
  ? path.join(process.resourcesPath, 'agents')
  : path.join(__dirname, '..');
const APP_ICON      = nativeImage.createFromPath(path.join(__dirname, 'Assets', 'icon-rounded.png'));
const TRAY_ICON     = nativeImage.createFromPath(path.join(__dirname, 'Assets', 'tray-icon.png'));
const REPORTS_DIR   = path.join(__dirname, '..', 'auditor', 'reports');
const TENANT_DOMAIN   = 'contoso.onmicrosoft.com';
const SETUP_FILE      = path.join(AGENTS_DIR, 'approver', 'setup.json');
const INT_CONFIG_FILE = path.join(AGENTS_DIR, 'approver', 'integrations.config.json');
// Durable tenant config — the source of truth for which tenant the console is
// wired to. Written by the first-run wizard and Settings → Tenant regardless of
// whether per-agent config.json credential files exist yet (they don't on a
// fresh install). Until this is written, the console stays unconfigured/stateless
// rather than displaying a placeholder tenant.
const TENANT_CONFIG_FILE = path.join(AGENTS_DIR, 'approver', 'tenant.json');

// Stamp every child process with the console operator identity so Write-AuditEntry picks it up
process.env.JML_CONSOLE_OPERATOR = os.userInfo().username;

// BOM-safe JSON file reader — config files saved by PS/VS Code may have UTF-8 BOM
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').split(String.fromCharCode(0xFEFF)).join(''));
}

// Durable tenant config helpers. tenant.json is the console-level source of truth
// so the tenant survives even when no agent credential files exist yet.
function readTenantConfig() {
  try { if (fs.existsSync(TENANT_CONFIG_FILE)) return readJson(TENANT_CONFIG_FILE) || {}; } catch {}
  return {};
}
function writeTenantConfig(patch) {
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'tenant configuration write');
  const next = { ...readTenantConfig(), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(TENANT_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(TENANT_CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

const PENDING_DIR    = path.join(AGENTS_DIR, 'approver', 'pending');
// Approval tokens carry a 30-min TTL, then linger as "EXPIRED" for a short grace
// so an operator can see they lapsed — after that they're pruned from the queue.
const APPROVAL_TTL_MS        = 30 * 60 * 1000;
const APPROVAL_EXPIRY_GRACE_MS = 10 * 60 * 1000;
// Start the TTL clock on pending approvals only once an admin operator is logged
// in to act on them (sets expiresAt on tokens that don't have one yet). This is
// why a request created overnight doesn't expire before an admin arrives.
function maybeStartApprovalTimers() {
  if (String(currentRole || '').toLowerCase() !== 'admin') return;
  if (!fs.existsSync(PENDING_DIR)) return;
  const exp = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  for (const f of fs.readdirSync(PENDING_DIR).filter(n => n.endsWith('.json'))) {
    try {
      const p = path.join(PENDING_DIR, f);
      const d = readJson(p);
      if (d && !d.expiresAt) { d.expiresAt = exp; fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8'); }
    } catch { /* skip */ }
  }
}

// Delete pending approval files whose expiry is older than the grace window so
// expired tokens disappear from the Approvals tab (and tray count). Returns the
// number pruned.
function pruneExpiredApprovals() {
  if (!fs.existsSync(PENDING_DIR)) return 0;
  const cutoff = Date.now() - APPROVAL_EXPIRY_GRACE_MS;
  let pruned = 0;
  for (const f of fs.readdirSync(PENDING_DIR).filter(n => n.endsWith('.json'))) {
    try {
      const d = readJson(path.join(PENDING_DIR, f));
      const exp = d && d.expiresAt ? Date.parse(d.expiresAt) : NaN;
      if (Number.isFinite(exp) && exp < cutoff) { fs.unlinkSync(path.join(PENDING_DIR, f)); pruned++; }
    } catch { /* skip unreadable file */ }
  }
  return pruned;
}
const SCHEDULED_FILE = path.join(AGENTS_DIR, 'approver', 'scheduled.json');
const POLICIES_FILE  = path.join(AGENTS_DIR, 'approver', 'policies.json');
const SOD_FILE       = path.join(AGENTS_DIR, 'shared', 'sod-policy.json');
const OPERATORS_FILE = path.join(AGENTS_DIR, 'approver', 'operators.json');
const OPERATOR_AUTH_FILE = path.join(AGENTS_DIR, 'approver', 'operator-auth.json');
const OPERATOR_ACTIVITY_FILE = path.join(AGENTS_DIR, 'approver', 'operator-activity.jsonl');
const PANEL_BOUNDS_FILE      = path.join(__dirname, 'panel-bounds.json');
const AI_PROVIDER_CONFIG_FILE = path.join(AGENTS_DIR, 'approver', 'ai-provider.json');
const OPERATIONS_FILE = path.join(AGENTS_DIR, 'approver', 'operations.jsonl');
const activeOperations = new Map();

function operationSubject(input = {}) {
  return input.userPrincipalName || input.upn || input.displayName
    || [input.givenName, input.surname].filter(Boolean).join(' ') || 'Unknown subject';
}

function persistOperation(operation) {
  if (PRESENTATION_MODE) return;
  try {
    fs.mkdirSync(path.dirname(OPERATIONS_FILE), { recursive: true });
    fs.appendFileSync(OPERATIONS_FILE, JSON.stringify(operation) + '\n', 'utf8');
  } catch {}
}

function emitOperation(sender, operation, persist = false) {
  if (persist) persistOperation(operation);
  sender.send('operation-status', operation);
  if (win && !win.isDestroyed() && win.webContents !== sender) {
    win.webContents.send('operation-status', operation);
  }
}

function readOperations() {
  let persisted = [];
  try {
    persisted = fs.readFileSync(OPERATIONS_FILE, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch {}
  return [...activeOperations.values(), ...persisted.reverse()].slice(0, 250);
}

function loadPanelBounds() { try { return JSON.parse(fs.readFileSync(PANEL_BOUNDS_FILE, 'utf8')); } catch { return null; } }
function savePanelBounds(b) {
  if (PRESENTATION_MODE) return;
  try { fs.writeFileSync(PANEL_BOUNDS_FILE, JSON.stringify(b)); } catch {}
}
const CERT_SCRIPT    = path.join(AGENTS_DIR, 'certifier', 'Invoke-CertificationCampaign.ps1');
const AGENT_DIRS     = ['joiner','mover','leaver','enroller','approver','provisioner','auditor','certifier'];

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

// ── Foundry IQ knowledge grounding ────────────────────────────────────────────
// Microsoft IQ layer (Enterprise Agents track): grounds risk/approval decisions
// in the JML policy corpus via Azure AI Foundry knowledge retrieval. Fail-closed
// when configured-but-unavailable so the control plane never acts on ungrounded
// policy. Config at approver/foundry-iq.json (gitignored — holds the key).
const { FoundryIQ, GroundingUnavailableError } = require('./lib/foundry-iq');
const FOUNDRY_IQ_CONFIG_FILE = path.join(AGENTS_DIR, 'approver', 'foundry-iq.json');
let _foundryIq = null;
function getFoundryIQ() {
  if (!_foundryIq) {
    let cfg = {};
    try { cfg = readJson(FOUNDRY_IQ_CONFIG_FILE); } catch {}
    _foundryIq = new FoundryIQ(cfg);
  }
  return _foundryIq;
}
function buildPolicyQuery(input = {}) {
  const parts = [
    input.operation && `Operation: ${input.operation}`,
    input.userPrincipalName && `User: ${input.userPrincipalName}`,
    input.newDepartment && `Target department: ${input.newDepartment}`,
    input.groups && `Groups: ${Array.isArray(input.groups) ? input.groups.join(', ') : input.groups}`,
    input.licenses && `Licenses: ${Array.isArray(input.licenses) ? input.licenses.join(', ') : input.licenses}`,
  ].filter(Boolean);
  return `Identity governance policy check. ${parts.join('. ')}. ` +
    `Cite separation-of-duties rules, approved access patterns, freeze windows, ` +
    `and offboarding requirements relevant to this operation.`;
}

// AI observability — append a trace line per model turn (provider, model, latency,
// tokens). Gives Foundry-style run telemetry regardless of which provider is active.
const AI_TRACES_FILE = path.join(AGENTS_DIR, 'approver', 'ai-traces.jsonl');
function recordAITrace(agent, trace) {
  if (PRESENTATION_MODE) return;
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
// Resolves the active tenant domain: durable tenant.json first, then any agent
// config that carries a PrimaryDomain, then the neutral example domain. The
// example is only ever used in prompt/export text, never presented as a
// configured value in the UI (the UI reads get-tenant-config, which returns
// empty until a tenant is actually saved).
function getActiveTenantDomain() {
  const t = readTenantConfig();
  if (t.primaryDomain) return t.primaryDomain;
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

// Human-readable "today" for agent prompts. Without a date anchor an LLM
// defaults to its training-era year and misreports recent activity (e.g. it
// claims the last mover runs were in 2023). Computed per request so it never
// goes stale.
function currentDateLine() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function buildApproverSystem(domain) { return `
You are the Approver Agent for a JML identity lifecycle management system.
You are the intelligent gatekeeper for identity change requests in Microsoft Entra ID.

Tenant: ${domain}
Current date: ${currentDateLine()} — treat this as today for freeze-window and relative-date reasoning.
UPN format: firstname.lastname@${domain}

Request types:
JOINER: givenName, surname, userPrincipalName (auto-generate from name), department, jobTitle, usageLocation (2-letter ISO), manager?, licenses?, groups?
ENROLLER: userPrincipalName, licenses?, groups?
MOVER: userPrincipalName + at least one of: newDepartment, newJobTitle, newManager, licensesToAdd, licensesToRemove, groupsToAdd, groupsToRemove
LEAVER: userPrincipalName (two-stage: Soft then Hard)

Rules:
- Never invent or guess values
- Always confirm full details before calling a tool
- For leavers, confirm each stage before executing it (no need to explain the
  two-stage model unless asked — a one-line "Soft stage next: disables sign-in" is enough)
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
- admin: full authority — can submit all operation types including Hard leavers and
  permanent user deletes (submit_leaver_delete) in Live mode.
- helpdesk: can submit Joiners, Enrollers, Movers, and Soft leavers in Live mode.
  Hard leavers and permanent deletes are always escalated to the admin approval queue —
  inform the operator that after submitting, an admin must approve from the Approvals tab
  before execution. If a Soft leaver is blocked (user holds privileged roles), it is escalated too.
- viewer: read-only — all submit tools are blocked. Remind the operator to switch to
  an admin or helpdesk account.

DELETE vs HARD LEAVE: submit_leaver_delete PERMANENTLY removes the user object (recoverable
from the Entra recycle bin for 30 days) and is separate from a Hard leave (which only strips
licenses/groups and leaves a disabled account). Only delete when the operator explicitly asks
to delete/remove the account entirely — never as part of a routine offboarding.

When the current operator is helpdesk and they request a Hard leaver:
1. Acknowledge that it will be submitted for admin approval.
2. Proceed with submit_leaver_hard — the system will automatically route it.
3. Show the approval token and tell them to notify an admin.

READ-ONLY TENANT QUERIES:
You also have the auditor's query_* tools (user counts, licenses, recent joins,
soft vs hard leavers, admin roles, groups, JML activity, stale accounts, guests). Use them freely to answer
questions or verify state — they are read-only and safe in any mode. Use lookup_user
for a single-user deep dive.

RESPONSE STYLE (always follow):
- Be brief. Routine confirmations and acknowledgements: 1-3 short sentences.
- Lead with the outcome. One line of what happened, then only essential details.
- Do not restate, paraphrase, or echo the operator's request back — just respond.
- Never explain the JML process, leaver stages, agent roles, or permission scopes
  (User.RW, Group.RW, etc.) unless the operator explicitly asks how something works.
- Never enumerate your tools or describe what you are about to do — just do it.
- Always write UPNs in full (e.g. sarah.chen@${domain}). Never truncate.
- No # or ## headings. Use **bold** labels sparingly for key values: names, UPNs,
  risk levels, tokens, outcomes.
- Use a table only for 4+ attributes of one entity; a short list for 3+ items;
  plain prose otherwise.
`.trim(); }

function buildAuditorSystem(domain) { return `
You are the JML Audit Agent -- a read-only intelligence layer over Microsoft Entra ID.
Tenant: ${domain}
Current date: ${currentDateLine()} — treat this as today. Every timestamp your tools return is accurate; report dates exactly as given and never assume an earlier year or "correct" them.

You NEVER suggest or make changes to the directory. Strictly observational.

You have two roles:

1. TENANT INTELLIGENCE: Answer questions about the live tenant state using your query tools.
   Available: user counts, license utilization, member/regular user lists, recent joins, soft leavers (accounts disabled) vs hard leavers (license + group removal), admin roles, group summary, JML activity, stale accounts, guest users, single-user deep dive (query_user_detail).
   Present numbers prominently. Offer follow-up queries when results are interesting.
   Never provide tenant counts, UPNs, names, or lists unless they appear in the latest tool result. For standard/regular users, call query_member_users. To answer how many or which users have NO license, call query_unlicensed_users -- it returns the exact count and full UPN list; never estimate the unlicensed total by subtracting license aggregates. Do not combine overlapping categories as if they add up to a total.

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

RESPONSE STYLE (always follow):
- Be brief. Lead with the answer — the number or finding first, context after.
- Do not restate, paraphrase, or echo the operator's question back — answer it directly.
- Never recite system internals (agent roles, permission scopes, stage definitions)
  unless the operator explicitly asks how something works.
- Always write UPNs in full (e.g. sarah.chen@${domain}). Never truncate.
- No # or ## headings. **Bold** the key values: counts, names, dates, risk indicators.
- Use a table only for 4+ attributes of one entity; a short list for 3+ items;
  plain prose otherwise. Keep paragraphs to 2-3 sentences.
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
    name: 'submit_leaver_delete',
    description: 'Permanently DELETE the user object from Entra ID — a separate, irreversible action distinct from a hard leave (which only strips licenses/groups and leaves a disabled account). The deleted user is recoverable from the Entra recycle bin for 30 days. Requires admin approval.',
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
  },
  {
    name: 'schedule_operation',
    description: 'Schedule a JML operation to run automatically at a FUTURE time instead of executing it now. Use this when the operator asks to schedule/defer/queue an onboarding, move, or offboarding for later (e.g. "onboard Sarah next Monday 9am", "offboard them at end of day Friday"). For an immediate action use the submit_* tools instead. A scheduled Hard/Delete leaver created by a non-admin is still gated on admin approval when it fires.',
    input_schema: {
      type: 'object',
      properties: {
        operation:    { type: 'string', enum: ['joiner', 'mover', 'leaver'], description: 'Which JML operation to schedule.' },
        scheduledFor: { type: 'string', description: 'ISO 8601 datetime (with timezone) when the operation should run. Resolve relative phrasing like "next Monday 9am" to an absolute datetime using the current date.' },
        whatif:       { type: 'boolean', description: 'Safe mode — simulate, no tenant change. Defaults to the current session mode.' },
        payload: {
          type: 'object',
          description: 'Operation fields. joiner: givenName, surname, department, jobTitle, usageLocation, manager, licenses[], groups[] (UPN auto-generated). mover: userPrincipalName, department, jobTitle, manager, licensesToAdd[], licensesToRemove[], groupsToAdd[], groupsToRemove[]. leaver: userPrincipalName, stage (Soft|Hard|Delete), ticketRef.'
        }
      },
      required: ['operation', 'scheduledFor', 'payload']
    }
  }
];

const AUDITOR_TOOLS = [
  { name: 'query_user_summary',   description: 'Count breakdown: total, enabled, disabled, members, guests.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_license_report', description: 'License SKU utilization: assigned / total / available.',        input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_recent_joins',   description: 'Accounts created in last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, topN: { type: 'integer' } }, required: [] } },
  { name: 'query_recent_leavers', description: 'Accounts disabled (soft-stage leaver) in last N days, from the Entra audit log.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, topN: { type: 'integer' } }, required: [] } },
  { name: 'query_hard_leavers',   description: 'Hard-stage leavers (license + group removal) processed by the JML system in last N days, from the JML audit chain. Use this for "hard leaver" questions; use query_recent_leavers for disabled/soft.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, topN: { type: 'integer' } }, required: [] } },
  { name: 'query_admin_roles',    description: 'All populated directory roles and members.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_group_summary',  description: 'Group breakdown: unified / dynamic / security.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_jml_activity',   description: 'Recent JML agent operations from local audit log.',
    input_schema: { type: 'object', properties: { topN: { type: 'integer' } }, required: [] } },
  { name: 'query_stale_accounts', description: 'Enabled accounts with no sign-in in last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, topN: { type: 'integer' } }, required: [] } },
  { name: 'query_guest_users',    description: 'External/guest accounts.',
    input_schema: { type: 'object', properties: { topN: { type: 'integer' } }, required: [] } },
  { name: 'query_member_users',   description: 'Member/regular user accounts, optionally only enabled accounts. Use this to list standard user UPNs.',
    input_schema: { type: 'object', properties: { topN: { type: 'integer' }, enabledOnly: { type: 'boolean' } }, required: [] } },
  { name: 'query_unlicensed_users', description: 'Definitive per-user list of member users with NO license assigned (assignedLicenses empty). Use this to answer "how many / which users have no license" — returns the exact count and full UPN list, not an aggregate estimate.',
    input_schema: { type: 'object', properties: { enabledOnly: { type: 'boolean' } }, required: [] } },
  { name: 'query_user_detail',    description: 'Deep-dive a single user by UPN or display name: profile, status, manager, licenses, groups, last sign-in.',
    input_schema: { type: 'object', properties: { upnOrName: { type: 'string' } }, required: ['upnOrName'] } }
];

// The Approver also gets every read-only tenant query (RBAC-safe for all roles:
// reads never mutate state). query_user_detail is excluded — the Approver's
// lookup_user covers the same need.
APPROVER_TOOLS.push(...AUDITOR_TOOLS.filter(t => t.name !== 'query_user_detail'));

// ── PS1 dispatch ──────────────────────────────────────────────────────────────
function writePayloadFile(payload) {
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'agent payload file write');
  const p = path.join(os.tmpdir(), 'jml-payload-' + Date.now() + '.json');
  fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  return p;
}

// NOTE: there is intentionally no synchronous runPs — execFileSync in the
// main process blocks the event loop and freezes every window. Use
// runPsAsync (script files) or runPsCommand (inline commands).
function runPsAsync(scriptPath, params = {}) {
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'PowerShell agent execution');
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(scriptPath)) { reject(new Error('Script not found: ' + scriptPath)); return; }
    const args = ['-NonInteractive', '-File', scriptPath];
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean') { if (v) args.push('-' + k); }
      else if (Array.isArray(v))  { args.push('-' + k, v.join(',')); }
      else                        { args.push('-' + k, String(v)); }
    }
    execFile('powershell', args, { encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        // Exit code 2 is the agent scripts' "completed with non-fatal errors"
        // (partial) convention — they print the full results JSON before exiting
        // 2. Resolve it so the caller classifies it as partial, not a hard
        // failure. Genuine failures exit 1 (or are killed/spawn errors).
        if (err.code === 2 && !err.killed) { resolve(stdout); return; }
        err.stdout = stdout;
        err.stderr = stderr;
        // Surface the script's real failure reason ("User not found: …") instead
        // of the generic "Command failed: powershell -NonInteractive -File …".
        const reason = extractPsError(stdout, stderr);
        if (reason) err.message = reason;
        reject(err);
      } else resolve(stdout);
    });
  });
}

// Strip ANSI/VT escape sequences (PowerShell Write-Host colours) so script
// output shown in the UI is clean text, not raw escape codes.
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

// Pull a human-readable failure reason out of an agent script's output so the
// UI can show "User not found: …" instead of the raw command line. The JML
// agent scripts log "[HH:MM:SS] [ERROR] <message>"; prefer the last such line,
// then fall back to a PowerShell exception line.
function extractPsError(stdout, stderr) {
  const clean = s => stripAnsi(String(s || '')).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = clean(stdout);
  // Prefer the last "[HH:MM:SS] [ERROR] <message>" line the agent scripts emit.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i].match(/\[ERROR\]\s*(.+)$/i);
    if (m) return m[1].trim().slice(0, 240);
  }
  // PowerShell exceptions / native errors land on stderr — surface the first
  // substantive line, dropping positional noise and the "Cmdlet : " prefix.
  const errLines = clean(stderr).filter(l =>
    !/^At line:|^\+|^\s*~+\s*$|CategoryInfo|FullyQualifiedErrorId/i.test(l));
  if (errLines.length) {
    return errLines[0].replace(/^[A-Za-z0-9_.-]+ : /, '').trim().slice(0, 240);
  }
  return '';
}

// Async inline-PowerShell runner. Query/search IPC handlers must use this
// instead of execFileSync — a sync child process blocks the entire main
// process event loop, freezing every window until Graph responds.
function runPsCommand(ps, { timeout = 60000 } = {}) {
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'PowerShell command execution');
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => err ? reject(err) : resolve(String(stdout ?? '')));
  });
}

// ── Warm Graph session ────────────────────────────────────────────────────────
// Cold Graph queries pay powershell.exe startup + module import + cert auth
// (3-8s) on every call. A persistent worker (lib/graph-worker.ps1) holds one
// authenticated auditor connection so repeat queries only pay the Graph round
// trip. Infrastructure failures fall back to a cold spawn; script errors are
// surfaced to the caller untouched.
const { GraphPsSession } = require('./lib/graph-ps-session');
let _graphSession = null;
function getGraphSession() {
  if (!_graphSession) {
    _graphSession = new GraphPsSession({
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'lib', 'graph-worker.ps1'),
        '-ConfigPath', path.join(AGENTS_DIR, 'auditor', 'config.json'),
        '-AgentsRoot', AGENTS_DIR],
    });
  }
  return _graphSession;
}

function auditorGraphPreamble() {
  const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
  return `
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText('${cfgPath.replace(/'/g, "''")}') | ConvertFrom-Json
$agentsRoot = '${AGENTS_DIR}'
. (Join-Path $agentsRoot 'shared\\Helpers.ps1')
Connect-AgentGraph -Config $cfg
`;
}

async function runAuditorGraph(body, { timeout = 60000 } = {}) {
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'Microsoft Graph query');
  try {
    return await getGraphSession().run(body, { timeout });
  } catch (e) {
    if (!e.sessionError) throw e; // real query error — do not retry cold
    return runPsCommand(auditorGraphPreamble() + body, { timeout });
  }
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
    const agents = ['joiner','mover','leaver','enroller','approver','provisioner','auditor','certifier'];
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
  if (PRESENTATION_MODE) {
    pushPanelUpdate(buildMockPanelData());
    return;
  }
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
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true }
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
    // Sample-data overlay is capture/QC only — production panels must show
    // real (possibly empty) state, never fake approvals or events.
    if (CAPTURE_MODE) setTimeout(() => pushPanelUpdate(buildMockPanelData()), 300);
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
    webPreferences: { preload: OVERLAY_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true }
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
    if (PRESENTATION_MODE) {
      pushOverlayUpdate({
        approvals: MOCK_APPROVALS.length,
        pendingList: MOCK_APPROVALS,
        mode: state.approver.whatif ? 'safe' : 'live',
      });
      return;
    }
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
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true }
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
    maybeStartApprovalTimers();
    pruneExpiredApprovals();
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

function routeBlockedLeaverToApproval(input, stage, reason, requiredApproverRole, requestedBy, requestedByRole) {
  // requestedBy/requestedByRole let a deferred caller (e.g. a scheduled run)
  // attribute the request to whoever created it, not whoever is logged in now.
  const reqBy   = requestedBy   || currentOperator;
  const reqRole2 = requestedByRole || currentRole;
  if (PRESENTATION_MODE) {
    const token = `demo-${Date.now().toString(36)}`;
    MOCK_APPROVALS.unshift({
      id: token,
      token,
      tool: `submit_leaver_${stage.toLowerCase()}`,
      severity: 'crit',
      requestedBy: reqBy || DEMO_ADMIN,
      requestedByRole: reqRole2,
      requiredApproverRole: requiredApproverRole || 'admin',
      requestedAt: new Date().toISOString(),
      input: {
        userPrincipalName: input.userPrincipalName,
        stage,
        ticketRef: input.ticketRef || '',
      },
      note: reason || 'Synthetic demo approval request.',
      status: 'pending',
      demo: true,
    });
    return token;
  }
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const reqRole = requiredApproverRole || 'admin';
  const record = {
    id: token, token,
    tool: 'submit_leaver_' + stage.toLowerCase(),
    severity: 'crit',
    requestedBy: reqBy || 'helpdesk',
    requestedByRole: reqRole2,
    requiredApproverRole: reqRole,
    requestedAt: new Date().toISOString(),
    // No expiry yet — the TTL clock only starts once an admin operator is logged
    // in to act on it (set by maybeStartApprovalTimers), so a request submitted
    // overnight can't lapse before any admin has a chance to see it.
    expiresAt: null,
    input: { userPrincipalName: input.userPrincipalName, stage, ticketRef: input.ticketRef || '' },
    note: reason || 'Hard-stage leaver submitted by helpdesk — admin approval required to execute.',
    status: 'pending'
  };
  fs.writeFileSync(path.join(PENDING_DIR, token + '.json'), JSON.stringify(record, null, 2), 'utf8');
  sendToast('Admin Approval Required', (input.userPrincipalName || 'User') + ' queued for admin sign-off.');
  emitApprovalQueued(input, stage, token, reqBy, reqRole2);
  return token;
}

// Surface a queued approval on the Glass Screen as an awaiting-approval run.
function emitApprovalQueued(input, stage, token, requestedBy, requestedByRole) {
  const op = {
    id: token, agent: 'leaver', toolName: 'submit_leaver_' + String(stage).toLowerCase(),
    stage, subject: input.userPrincipalName, operator: requestedBy || currentOperator, whatif: false,
    status: 'awaiting-approval', requestedByRole: requestedByRole || currentRole,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  activeOperations.set(token, op);
  if (win && !win.isDestroyed()) win.webContents.send('operation-status', op);
}

// Once an admin approves, the queued run continues like a normal execution —
// flip it to 'running' so the Glass Screen pipeline advances to Execute.
function markApprovalRunning(token) {
  const base = activeOperations.get(token);
  if (!base) return;
  const op = { ...base, status: 'running', updatedAt: new Date().toISOString() };
  activeOperations.set(token, op);
  if (win && !win.isDestroyed()) win.webContents.send('operation-status', op);
}

// Resolve a queued approval's Glass Screen run once an admin approves/rejects.
function resolveApprovalOperation(token, outcome, error) {
  const base = activeOperations.get(token) || { id: token, agent: 'leaver' };
  activeOperations.delete(token);
  const op = {
    ...base,
    status: outcome === 'success' ? 'succeeded' : 'failed',
    outcome, error: error || null,
    updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  };
  persistOperation(op);
  if (win && !win.isDestroyed()) win.webContents.send('operation-status', op);
}

// Separation-of-duties gate for approving a queued request. The approver must
// hold the required role (admin for destructive leavers) AND must not be the
// operator who requested it. Enforced on EVERY approval surface (console,
// docked panel, overlay). Returns { ok } or { ok:false, error }.
function approvalGate(op) {
  const reqRole   = String(op.requiredApproverRole || 'admin').toLowerCase();
  const actorRole = (currentRole || 'viewer').toLowerCase();
  if (reqRole === 'admin' && actorRole !== 'admin') {
    return { ok: false, error: 'Admin approval required — a helpdesk operator cannot give final sign-off on this offboarding.' };
  }
  if (op.requestedBy && currentOperator && String(op.requestedBy) === String(currentOperator)) {
    return { ok: false, error: 'Separation of duties — you submitted this request, so a different admin must approve it.' };
  }
  return { ok: true };
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

// Map an agent script's results JSON (PascalCase) into the camelCase detail
// shape the Glass Screen reads, so the Execute stage can list the exact
// licenses/groups changed and the account state for a specific run.
function operationDetailsFromResult(result, input) {
  const d = (result && result.data && typeof result.data === 'object') ? result.data : {};
  const arr = (k) => Array.isArray(d[k]) ? d[k].filter(Boolean) : [];
  const out = {
    ticketRef: (input && input.ticketRef) || d.ticketRef || '',
    accountCreated:  !!d.AccountCreated,
    accountDisabled: !!d.AccountDisabled,
    accountDeleted:  !!d.AccountDeleted,
    sessionsRevoked: !!d.SessionsRevoked,
    managerSet:      !!d.ManagerSet,
    licensesAdded:   arr('LicensesAdded'),
    licensesRemoved: arr('LicensesRemoved'),
    groupsAdded:     arr('GroupsAdded'),
    groupsRemoved:   arr('GroupsRemoved'),
    errors:          arr('Errors'),
  };
  if (d.AttributesUpdated && typeof d.AttributesUpdated === 'object') out.attributesUpdated = d.AttributesUpdated;
  return out;
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
  query_hard_leavers:   'RecentHardLeavers',
  query_admin_roles:    'AdminRoles',
  query_group_summary:  'GroupSummary',
  query_jml_activity:   'JMLActivity',
  query_stale_accounts: 'StaleAccounts',
  query_guest_users:    'GuestUsers',
  query_member_users:   'MemberUsers',
  query_unlicensed_users: 'UnlicensedUsers'
};

function collectConversationToolContents(messages) {
  const contents = [];
  for (const msg of messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && block.type === 'tool_result') contents.push(block.content);
    }
  }
  return contents;
}

// Directory queries (auditor + approver share them) run as the Auditor app, which
// needs its own config.json + credential. Entra *operator* sign-in does not supply
// that. Return a clear, actionable error instead of letting the PS script fail with
// an opaque Connect-MgGraph message that the agent then relays as "integration problem".
function auditorQueryUnavailable() {
  const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
  let cfg = null;
  try { if (fs.existsSync(cfgPath)) cfg = readJson(cfgPath); } catch {}
  if (!cfg || !cfg.TenantId || !cfg.ClientId || !(cfg.CertThumbprint || cfg.EncryptedSecret)) {
    return { error: 'Directory queries are unavailable: the Auditor agent has no app credential configured yet. Connect a tenant and set up the Auditor app registration (Settings → Tenant) with a certificate or secret, then retry.' };
  }
  return null;
}

async function executeTool(agent, toolName, input, whatif) {
  if (PRESENTATION_MODE) {
    return executeDemoTool(agent, toolName, input || {}, !!whatif);
  }

  if (agent === 'auditor') {
    if (toolName === 'query_user_detail') {
      const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-LookupUser.ps1'), { UpnOrName: input.upnOrName });
      return _parseMultilineJson(raw, 'No output from user lookup script');
    }
    const unavailable = auditorQueryUnavailable();
    if (unavailable) return unavailable;
    const queryType = AUDITOR_QUERY_MAP[toolName];
    const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1');
    const params = { QueryType: queryType };
    if (input.days) params.Days = input.days;
    if (input.topN) params.TopN = input.topN;
    if (input.enabledOnly !== undefined) params.EnabledOnly = !!input.enabledOnly;
    const raw = await runPsAsync(script, params);
    return _parseMultilineJson(raw, 'No output from auditor query script');
  }

  // Approver read-only tenant queries — same dispatch as the auditor branch.
  if (AUDITOR_QUERY_MAP[toolName]) {
    const unavailable = auditorQueryUnavailable();
    if (unavailable) return unavailable;
    const params = { QueryType: AUDITOR_QUERY_MAP[toolName] };
    if (input.days) params.Days = input.days;
    if (input.topN) params.TopN = input.topN;
    if (input.enabledOnly !== undefined) params.EnabledOnly = !!input.enabledOnly;
    const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1'), params);
    return _parseMultilineJson(raw, 'No output from auditor query script');
  }

  const w = whatif ? true : false;

  // RBAC: read-only operator roles can never reach a submit tool, regardless of
  // what the model decides. Enforced in code, not just the system prompt.
  if (toolName.startsWith('submit_')) {
    const role = (currentRole || 'viewer').toLowerCase();
    if (role === 'viewer' || role === 'guest') {
      return { error: 'RBAC: the current operator role is read-only. Submit operations require a helpdesk or admin account.' };
    }
  }

  // Schedule a JML operation for later (approver agent). Writes to the same
  // scheduled.json the Operations scheduler uses; the fire loop runs it at time
  // and still gates non-admin Hard/Delete leavers on approval.
  if (toolName === 'schedule_operation') {
    const role = (currentRole || 'viewer').toLowerCase();
    if (role === 'viewer' || role === 'guest') {
      return { error: 'RBAC: scheduling JML operations requires a helpdesk or admin account.' };
    }
    const op = String(input.operation || '').toLowerCase();
    if (!['joiner', 'mover', 'leaver'].includes(op)) {
      return { error: "schedule_operation: 'operation' must be joiner, mover, or leaver." };
    }
    const when = Date.parse(input.scheduledFor);
    if (!Number.isFinite(when)) {
      return { error: 'schedule_operation: scheduledFor must be a valid ISO 8601 datetime (with timezone).' };
    }
    if (when <= Date.now()) {
      return { error: 'schedule_operation: scheduledFor must be in the future. For an immediate action, use the submit_* tools.' };
    }
    const payload = (input.payload && typeof input.payload === 'object') ? { ...input.payload } : {};
    if ((op === 'mover' || op === 'leaver') && !payload.userPrincipalName) {
      return { error: `schedule_operation: ${op} requires payload.userPrincipalName.` };
    }
    if (op === 'joiner' && (!payload.givenName || !payload.surname)) {
      return { error: 'schedule_operation: joiner requires payload.givenName and payload.surname.' };
    }
    if (op === 'leaver' && payload.stage) {
      const norm = String(payload.stage).charAt(0).toUpperCase() + String(payload.stage).slice(1).toLowerCase();
      if (!['Soft', 'Hard', 'Delete'].includes(norm)) {
        return { error: 'schedule_operation: leaver stage must be Soft, Hard, or Delete.' };
      }
      payload.stage = norm;
    }
    const scheduled = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      operation: op,
      payload,
      scheduledFor: new Date(when).toISOString(),
      whatif: input.whatif !== undefined ? !!input.whatif : !!whatif,
      status: 'pending',
      requestedBy: currentOperator,
      requestedByRole: currentRole,
      label: payload.userPrincipalName || [payload.givenName, payload.surname].filter(Boolean).join(' ') || op,
      source: 'approver',
    };
    try {
      const ops = loadScheduled();
      ops.push(scheduled);
      saveScheduled(ops);
      if (win && !win.isDestroyed()) win.webContents.send('scheduled-ops', ops);
    } catch (e) {
      return { error: 'schedule_operation: could not save the schedule: ' + e.message };
    }
    return {
      scheduled: true,
      operation: op,
      scheduledFor: scheduled.scheduledFor,
      mode: scheduled.whatif ? 'Safe' : 'Live',
      message: `Scheduled ${op} for ${new Date(when).toLocaleString()} (${scheduled.whatif ? 'Safe' : 'Live'} mode). It will run automatically — view or cancel it under Operations → Scheduled.`,
    };
  }

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
      const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-LookupUser.ps1'), { UpnOrName: input.upnOrName });
      return _parseMultilineJson(raw, 'No output from user lookup script');
    }
    case 'list_available_licenses': {
      const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1'), { QueryType: 'LicenseReport' });
      return _parseMultilineJson(raw, 'No output from license report');
    }
    case 'list_groups': {
      const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-ListGroups.ps1'), input.filter ? { Filter: input.filter } : {});
      return _parseMultilineJson(raw, 'No output from group list script');
    }
    case 'suggest_provisioning': {
      const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-ProvisioningRecommendation.ps1'), {
        Department: input.department,
        JobTitle:   input.jobTitle
      });
      return _parseMultilineJson(raw, 'No output from recommendation script');
    }
    case 'score_risk': {
      const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-RiskScore.ps1'), {
        Operation:         input.operation,
        UserPrincipalName: input.userPrincipalName,
        Licenses:          input.licenses,
        Groups:            input.groups,
        NewDepartment:     input.newDepartment
      });
      const res = _parseMultilineJson(raw, 'No output from risk score script');
      if (res && res.error) return res;

      // Foundry IQ grounding: cite the org's own policy corpus for this decision.
      // Fail-closed — if grounding is configured but unavailable, the risk result
      // is marked blocked so the Live gate refuses to proceed on ungrounded policy.
      const iq = getFoundryIQ();
      if (iq.isConfigured()) {
        try {
          const g = await iq.retrieve(buildPolicyQuery(input));
          res.grounding = {
            source: 'Foundry IQ',
            summary: g.answer || null,
            citations: g.citations || [],
          };
          // A grounded SoD/freeze hit escalates the engine result.
          if (/violation|prohibited|freeze|blocked|denied/i.test(g.answer || '')) {
            res.reasons = [...(res.reasons || []), 'Foundry IQ policy match: ' + g.answer.slice(0, 160)];
            if (res.riskLevel !== 'critical') res.riskLevel = 'high';
          }
        } catch (e) {
          if (e instanceof GroundingUnavailableError) {
            res.blocked = true;
            res.grounding = { source: 'Foundry IQ', unavailable: true, error: e.message, citations: [] };
            res.reasons = [...(res.reasons || []), 'Policy grounding unavailable — failing closed (no decision without cited policy).'];
          } else { throw e; }
        }
      }
      state.approver.lastRisk = { ...res, ts: Date.now() };
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
      try { return parsePs1Output(await runPsAsync(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: _pf, WhatIf: w })); }
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
      try { return parsePs1Output(await runPsAsync(path.join(AGENTS_DIR, 'enroller', 'Invoke-EnrollerProcess.ps1'), { PayloadPath: _pfEnr, WhatIf: w })); }
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
        try { return parsePs1Output(await runPsAsync(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: _pf, WhatIf: w })); }
        finally { try { fs.unlinkSync(_pf); } catch {} }
      }
    case 'submit_leaver_soft':
    case 'submit_leaver_hard':
    case 'submit_leaver_delete': {
      const _stage = toolName === 'submit_leaver_hard' ? 'Hard'
        : toolName === 'submit_leaver_delete' ? 'Delete' : 'Soft';
      // Destructive offboards (Hard removal, permanent Delete) need an admin's
      // final say — a non-admin operator queues them for approval. Soft leavers
      // pass through (the PS1 still blocks privileged-role holders).
      const _destructive = _stage === 'Hard' || _stage === 'Delete';
      const _isAdmin = (currentRole || 'viewer').toLowerCase() === 'admin';
      if (!_isAdmin && _destructive && !w) {
        const _tok = routeBlockedLeaverToApproval(input, _stage,
          `${_stage}-stage leaver submitted by ${currentRole || 'operator'} — admin sign-off required before execution.`,
          'admin');
        return { approvalQueued: true, token: _tok, message: `${_stage} leavers require admin approval. Request queued — an admin operator must approve from the Approvals tab.` };
      }
      if (!_isAdmin && _destructive && w) {
        return { approvalRequired: true, message: `${_stage}-stage leavers require admin approval in Live mode. This request would be queued for admin sign-off.` };
      }
      try {
        return parsePs1Output(await runPsAsync(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
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
      let pendingText = '';
      try {
        response = await provider.streamTurn({
          system:      systemPrompt,
          tools,
          messages:    agentState.messages,
          signal:      ac.signal,
          onText:      (text) => { pendingText += text; },
          onToolStart: (toolName) => { sender.send('msg-chunk', { agent, type: 'tool_start', toolName }); }
        });
      } catch (err) {
        if (ac.signal.aborted) break; // operator pressed Stop — end the turn quietly
        throw err;
      }

      const textBlocks = response.content.filter(b => b.type === 'text');
      if (textBlocks.length) {
        const text = textBlocks.map(b => b.text || '').join('');
        // Grounding guard is for the AUDITOR (read-only tenant reporting), where
        // fabricated UPNs/counts are the risk. The APPROVER legitimately proposes
        // NEW identities (a joiner's UPN does not exist yet) and explains the
        // firstname.lastname@domain format, so gating it on UPN/number grounding
        // wrongly blocks its normal replies. Only validate the auditor.
        let safeText = stripQueryEcho(text, userText);
        if (agent === 'auditor') {
          const facts = collectGroundingFacts(collectConversationToolContents(agentState.messages));
          const validation = validateGroundedAssistantText(safeText || pendingText, facts);
          // Hard block (fabricated UPNs / numbers with no tool data) → replace.
          // Soft caveat (figures that don't tie out exactly) → keep + append note.
          // Keep the echo-stripped safeText as the base (don't revert to `text`).
          safeText = !validation.ok
            ? groundedFallback(validation.reason)
            : (validation.caveat ? `${safeText}\n\n> ⚠ ${validation.caveat}` : safeText);
        }
        response.content = [
          ...response.content.filter(b => b.type !== 'text'),
          { type: 'text', text: safeText }
        ];
        sender.send('msg-chunk', { agent, type: 'text', text: safeText });
        _fullText += safeText;
      }

      agentState.messages.push({ role: 'assistant', content: response.content });
      if (response.trace) recordAITrace(agent, response.trace);

      if (response.stopReason === 'end_turn') break;

      const toolCalls  = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const tool of toolCalls) {
        let operation = null;
        if (isLifecycleSubmitTool(tool.name)) {
          operation = {
            id: crypto.randomUUID(),
            agent: tool.name.replace(/^submit_/, '').replace(/_(soft|hard|delete)$/, ''),
            toolName: tool.name,
            stage: lifecycleStageForTool(tool.name),
            subject: operationSubject(tool.input),
            operator: currentOperator || process.env.JML_CONSOLE_OPERATOR,
            whatif: !!agentState.whatif,
            status: 'running',
            outcome: null,
            error: null,
            // Carry the Foundry IQ policy grounding from the gating score_risk
            // onto the operation so the Glass Screen details drawer can cite it.
            grounding: state.approver.lastRisk?.grounding || null,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          activeOperations.set(operation.id, operation);
          emitOperation(sender, operation);
        }
        sender.send('msg-chunk', { agent, type: 'tool_running', toolName: tool.name });
        let result;
        let toolError = null;
        try {
          result = await executeTool(agent, tool.name, tool.input, agentState.whatif);
          const classified = classifyToolResult(result);
          // Pass structured result for cards that render it (risk score, provisioning suggestions)
          const sendResult = (tool.name === 'score_risk' || tool.name === 'suggest_provisioning') ? result : undefined;
          sender.send('msg-chunk', { agent, type: 'tool_done', toolName: tool.name, success: classified.status === 'succeeded', result: sendResult });
        } catch (err) {
          toolError = err;
          result = { error: err.message };
          sender.send('msg-chunk', { agent, type: 'tool_done', toolName: tool.name, success: false });
        }
        if (operation) {
          const classified = classifyToolResult(result, toolError);
          operation = {
            ...operation,
            ...classified,
            // Carry the concrete per-stage outcome (which licenses/groups were
            // actually added/removed, account state) so the Glass Screen Execute
            // detail shows what happened on THIS entry, not a generic call list.
            details: { ...(operation.details || {}), ...operationDetailsFromResult(result, tool.input) },
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
          activeOperations.delete(operation.id);
          emitOperation(sender, operation, true);
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

// Canonical hash-chain verification matching shared/Verify-AuditLog.ps1:
// entry.prevHash === sha256(previous raw line) (or 'genesis' for the first).
// Runs over the raw lines (only the main process has them); the renderer just
// displays the verdict. rawLines[i] must align with entries[i].
function auditChainStatus(rawLines, entries) {
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  let breaks = 0, brokenAt = -1;
  for (let i = 0; i < entries.length; i++) {
    const expected = i === 0 ? 'genesis' : sha(rawLines[i - 1]);
    if (entries[i].prevHash !== expected) { breaks++; if (brokenAt < 0) brokenAt = i; }
  }
  const head = entries[entries.length - 1] || null; // newest = last appended
  return {
    configured: true, total: entries.length, verified: breaks === 0, breaks, brokenAt,
    headHash: head ? head.hash : null, lastSeal: head ? head.timestamp : null,
  };
}

// Demo/capture audit is trusted, pre-sealed sample data — report it verified.
function demoChainStatus() {
  const head = (typeof MOCK_AUDIT !== 'undefined' && MOCK_AUDIT[0]) || null;
  return { configured: true, total: (typeof MOCK_AUDIT !== 'undefined' ? MOCK_AUDIT.length : 0),
    verified: true, breaks: 0, headHash: head ? head.hash : null, lastSeal: head ? head.timestamp : null };
}

ipcMain.on('get-audit-log', (event) => {
  const auditPath = path.join(AGENTS_DIR, 'audit.jsonl');
  if (!fs.existsSync(auditPath)) {
    event.sender.send('audit-log-data', []);
    event.sender.send('audit-chain-status', { configured: false, total: 0, verified: true, breaks: 0 });
    return;
  }
  // Build rawLines and entries together so indices stay aligned (a line that
  // fails to parse is skipped from BOTH).
  const rawLines = [], entries = [];
  for (const l of fs.readFileSync(auditPath, 'utf8').split('\n')) {
    const t = l.trim(); if (!t) continue;
    let e; try { e = JSON.parse(t); } catch { continue; }
    rawLines.push(t); entries.push(e);
  }
  event.sender.send('audit-log-data', entries.slice().reverse());
  event.sender.send('audit-chain-status', auditChainStatus(rawLines, entries));
});

ipcMain.on('get-operation-statuses', (event) => {
  event.sender.send('operation-statuses', readOperations());
});

// ── Evidence packet export ──────────────────────────────────────────────────────
// Assembles a tamper-evident compliance evidence packet from selected audit entries.
// Integrity is proven by shelling out to the authoritative Verify-AuditLog.ps1 (the
// PowerShell verifier reproduces the exact hash format the writer used) rather than
// re-implementing the hash in JS, which would be fragile across PS/JSON formatting.
ipcMain.handle('export-evidence-packet', async (event, payload) => {
  if (PRESENTATION_MODE) {
    return demoReceipt('export-evidence-packet', {
      count: Array.isArray(payload?.hashes) ? payload.hashes.length : MOCK_AUDIT.length,
      integrity: 'simulated verified chain',
    });
  }
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
      const out = await runPsAsync(verifyScript, { AuditLogPath: auditPath });
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
  if (PRESENTATION_MODE) {
    event.sender.send('exports-status', {
      blob: { status: 'healthy', lastRun: _iso(18), exported: 3142, demo: true },
      sentinel: { status: 'healthy', lastRun: _iso(4), ingested: 3142, demo: true },
    });
    return;
  }
  function readStatus(file) {
    try { return readJson(file); } catch { return null; }
  }
  const base = path.join(REPORTS_DIR);
  event.sender.send('exports-status', {
    blob:     readStatus(path.join(base, 'blob-export-status.json')),
    sentinel: readStatus(path.join(base, 'sentinel-ingest-status.json')) || readStatus(path.join(base, 'sentinel-status.json'))
  });
});

// Run an export/ingest on demand so the tab works after sign-in instead of
// sitting blank until a scheduled job happens to run. Invokes the real auditor
// script; a missing destination config surfaces a clear error the operator can act on.
async function _runExport(event, type, scriptName) {
  try {
    const script = path.join(AGENTS_DIR, 'auditor', scriptName);
    if (!fs.existsSync(script)) {
      event.sender.send('export-run-result', { ok: false, type, error: `${scriptName} not found` });
      return;
    }
    // The scripts need a destination config; without it they error noisily.
    // Surface a clear, actionable message instead.
    const cfgName = type === 'sentinel' ? 'sentinel.config.json' : 'blob-export.config.json';
    if (!fs.existsSync(path.join(AGENTS_DIR, 'auditor', cfgName))) {
      event.sender.send('export-run-result', { ok: false, type, configured: false,
        error: `Not configured — create auditor/${cfgName} (copy the .example) with your ${type === 'sentinel' ? 'Log Analytics workspace' : 'storage account'} details, then run again.` });
      return;
    }
    const raw = await runPsAsync(script, {});
    event.sender.send('export-run-result', { ok: true, type, output: stripAnsi(raw).slice(-300) });
  } catch (err) {
    const detail = stripAnsi((err && (err.stdout || err.message)) || String(err))
      .trim().split('\n').filter(Boolean).slice(-3).join(' ');
    event.sender.send('export-run-result', { ok: false, type, error: detail || 'export failed' });
  }
}
ipcMain.on('run-blob-export', (event) => {
  if (PRESENTATION_MODE) { event.sender.send('export-run-result', { ok: true, type: 'blob', demo: true }); return; }
  _runExport(event, 'blob', 'Invoke-BlobExport.ps1');
});
ipcMain.on('run-sentinel-ingest', (event) => {
  if (PRESENTATION_MODE) { event.sender.send('export-run-result', { ok: true, type: 'sentinel', demo: true }); return; }
  _runExport(event, 'sentinel', 'Invoke-SentinelIngest.ps1');
});

ipcMain.on('run-blob-export', async (event) => {
  if (PRESENTATION_MODE) {
    event.sender.send('export-run-result', {
      type: 'blob',
      ...demoReceipt('run-blob-export'),
    });
    return;
  }
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
  if (PRESENTATION_MODE) {
    event.sender.send('export-run-result', {
      type: 'sentinel',
      ...demoReceipt('run-sentinel-ingest'),
    });
    return;
  }
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
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'scheduled operation write');
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

ipcMain.handle('panel-approve-pending', async (event, { id, writeToken }) => {
  if (PRESENTATION_MODE) {
    const approval = removeDemoApproval(id);
    return demoReceipt('approve-pending', {
      upn: approval?.input?.userPrincipalName || id,
      writeTokenAccepted: writeToken === 'demo-simulated-token',
    });
  }
  const role = (currentRole || 'viewer').toLowerCase();
  if (role === 'viewer' || role === 'guest') return { ok: false, error: 'Read-only role — blocked' };
  if (!writeToken) return { ok: false, error: 'PIN verification required' };
  const check = consumeWriteToken(writeToken, currentOperator);
  if (!check.ok) return { ok: false, error: 'Invalid write token: ' + check.reason };
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    if (!fs.existsSync(file)) return { ok: false, error: 'Request not found' };
    const op   = readJson(file);
    // Separation of duties: admin-only final say + cannot approve own request.
    const gate = approvalGate(op);
    if (!gate.ok) return { ok: false, error: gate.error };
    markApprovalRunning(id);
    const inp  = op.input || op;
    const tool = (op.tool || '').toLowerCase();
    let raw;
    if (tool === 'submit_joiner') {
      const pf = writePayloadFile({ givenName: inp.givenName, surname: inp.surname, userPrincipalName: inp.userPrincipalName, department: inp.department, jobTitle: inp.jobTitle, usageLocation: inp.usageLocation });
      try { raw = await runPsAsync(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: pf }); }
      finally { try { fs.unlinkSync(pf); } catch {} }
    } else {
      const stage = inp.stage || (tool.includes('delete') ? 'Delete' : tool.includes('hard') ? 'Hard' : 'Soft');
      const params = { UserPrincipalName: inp.userPrincipalName, Stage: stage, OperatorRole: 'admin' };
      if (inp.ticketRef) params.TicketRef = inp.ticketRef;
      raw = await runPsAsync(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), params);
    }
    parsePs1Output(raw);
    fs.unlinkSync(file);
    resolveApprovalOperation(id, 'success');
    sendToast('Approval Executed', (inp.userPrincipalName || id) + ' completed successfully.');
    setTimeout(pollTrayApprovals, 400);
    return { ok: true, upn: inp.userPrincipalName };
  } catch (err) {
    resolveApprovalOperation(id, 'failed', err.message);
    sendToast('Approval Failed', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('panel-reject-pending', (_, { id }) => {
  if (PRESENTATION_MODE) {
    const approval = removeDemoApproval(id);
    return demoReceipt('reject-pending', {
      upn: approval?.input?.userPrincipalName || id,
    });
  }
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    let upn = '';
    try { upn = readJson(file).input?.userPrincipalName || ''; } catch {}
    if (fs.existsSync(file)) fs.unlinkSync(file);
    resolveApprovalOperation(id, 'failed', 'Rejected by ' + (currentOperator || 'an admin') + ' — no tenant change.');
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
    maybeStartApprovalTimers();
    pruneExpiredApprovals();
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

ipcMain.on('approve-pending', async (event, payload) => {
  if (PRESENTATION_MODE) {
    const approval = removeDemoApproval(payload?.id);
    event.sender.send('approve-result', demoReceipt('approve-pending', {
      result: { subject: approval?.input?.userPrincipalName || payload?.id },
    }));
    return;
  }
  if (!requireWriteToken(event, payload, 'approve-result')) return;
  const { id } = payload || {};
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    if (!fs.existsSync(file)) { event.sender.send('approve-result', { ok: false, error: 'Not found' }); return; }
    const op   = readJson(file);

    // Separation of duties: admin-only final say (fail closed) + cannot
    // approve your own request. Enforced identically on every approval surface.
    const gate = approvalGate(op);
    if (!gate.ok) {
      event.sender.send('approve-result', { ok: false, error: gate.error });
      return;
    }
    markApprovalRunning(id);

    const inp  = op.input || op;
    const tool = (op.tool || '').toLowerCase();
    let raw;
    if (tool === 'submit_joiner') {
      const pf = writePayloadFile({ givenName: inp.givenName, surname: inp.surname, userPrincipalName: inp.userPrincipalName, department: inp.department, jobTitle: inp.jobTitle, usageLocation: inp.usageLocation });
      try { raw = await runPsAsync(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: pf }); }
      finally { try { fs.unlinkSync(pf); } catch {} }
    } else {
      const stage = inp.stage || (tool.includes('delete') ? 'Delete' : tool.includes('hard') ? 'Hard' : 'Soft');
      const params = { UserPrincipalName: inp.userPrincipalName, Stage: stage, OperatorRole: 'admin' };
      if (inp.ticketRef) params.TicketRef = inp.ticketRef;
      raw = await runPsAsync(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), params);
    }
    const result = parsePs1Output(raw);
    fs.unlinkSync(file);
    resolveApprovalOperation(id, 'success');
    sendToast('Approval Executed', (inp.userPrincipalName || 'Operation') + ' leaver completed successfully.');
    event.sender.send('approve-result', { ok: true, result });
  } catch (err) {
    resolveApprovalOperation(id, 'failed', err.message);
    sendToast('Approval Failed', err.message);
    event.sender.send('approve-result', { ok: false, error: err.message });
  }
});

ipcMain.on('reject-pending', (event, { id }) => {
  if (PRESENTATION_MODE) {
    removeDemoApproval(id);
    event.sender.send('reject-result', demoReceipt('reject-pending'));
    return;
  }
  try {
    const file = path.join(PENDING_DIR, id + '.json');
    let upn = '';
    try { upn = readJson(file).input?.userPrincipalName || ''; } catch {}
    if (fs.existsSync(file)) fs.unlinkSync(file);
    resolveApprovalOperation(id, 'failed', 'Rejected by ' + (currentOperator || 'an admin') + ' — no tenant change.');
    sendToast('Approval Rejected', (upn || 'Request') + ' was rejected and removed from the queue.');
    event.sender.send('reject-result', { ok: true });
  } catch (err) {
    event.sender.send('reject-result', { ok: false, error: err.message });
  }
});

// ── Operations tab ────────────────────────────────────────────────────────────
ipcMain.on('run-bulk-import', async (event, { rows, whatif }) => {
  if (PRESENTATION_MODE) {
    rows.forEach((row, index) => {
      event.sender.send('bulk-import-progress', {
        index,
        status: 'done',
        upn: row.userPrincipalName,
        result: demoReceipt(`bulk-${row.operation || 'operation'}`, {
          subject: row.userPrincipalName,
          mode: whatif ? 'safe' : 'live',
        }),
      });
    });
    event.sender.send('bulk-import-complete', {
      total: rows.length,
      demo: true,
      committed: false,
    });
    return;
  }
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
        try { raw = await runPsAsync(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: _pf2, WhatIf: !!whatif }); }
        finally { try { fs.unlinkSync(_pf2); } catch {} }
      } else if (op === 'leaver') {
        raw = await runPsAsync(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
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
        try { raw = await runPsAsync(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: _pfMover, WhatIf: !!whatif }); }
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
  if (PRESENTATION_MODE) {
    event.sender.send('scheduled-ops', demoScheduledOps);
    return;
  }
  event.sender.send('scheduled-ops', loadScheduled());
});

ipcMain.on('save-scheduled-op', (event, { op }) => {
  if (PRESENTATION_MODE) {
    demoScheduledOps.push({
      ...op,
      id: `demo-${Date.now().toString(36)}`,
      status: 'pending',
      demo: true,
    });
    event.sender.send('scheduled-ops', demoScheduledOps);
    return;
  }
  const ops = loadScheduled();
  const newOp = Object.assign({}, op, {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: 'pending',
    // Capture who scheduled it so a destructive run fired later is gated on
    // the scheduler's role, not whoever happens to be logged in at fire time.
    requestedBy: currentOperator,
    requestedByRole: currentRole
  });
  ops.push(newOp);
  saveScheduled(ops);
  event.sender.send('scheduled-ops', ops);
});

ipcMain.on('delete-scheduled-op', (event, { id }) => {
  if (PRESENTATION_MODE) {
    const index = demoScheduledOps.findIndex((op) => op.id === id);
    if (index >= 0) demoScheduledOps.splice(index, 1);
    event.sender.send('scheduled-ops', demoScheduledOps);
    return;
  }
  const ops = loadScheduled().filter(o => o.id !== id);
  saveScheduled(ops);
  event.sender.send('scheduled-ops', ops);
});

// ── Certifications tab ────────────────────────────────────────────────────────
ipcMain.on('run-certification', async (event, { campaignType, whatif }) => {
  if (PRESENTATION_MODE) {
    event.sender.send('certification-result', {
      ...demoReceipt('run-certification', {
        campaignType,
        mode: whatif ? 'safe' : 'live',
      }),
      campaigns: [{
        id: 'demo-cert-q2',
        name: `${campaignType || 'Quarterly'} access review`,
        status: 'simulated',
        reviewed: 42,
      }],
      lines: ['[DEMO] Certification campaign simulated. No access decision was committed.'],
    });
    return;
  }
  try {
    const raw    = await runPsAsync(CERT_SCRIPT, { CampaignType: campaignType, WhatIf: !!whatif });
    const lines  = raw.trim().split('\n')
      .filter(l => /\[Certifier\]/.test(l))
      .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\] /, '').trim());
    const parsed = _parseMultilineJson(raw, 'No certification campaign output');
    const rawCamps = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.campaigns)) ? parsed.campaigns : [];
    // The certifier emits { campaign, groupId, reviewId, name }; map it to the
    // schema the renderer expects so campaigns don't render as "unknown".
    const campaigns = rawCamps.map(c => ({
      ...c,
      id:              c.reviewId || c.id || c.groupId || null,
      displayName:     c.name || c.displayName || c.reviewId || 'Access review',
      type:            c.campaign || c.type || campaignType || 'user-groups',
      status:          c.status || (whatif ? 'preview' : 'active'),
      createdDateTime: c.createdDateTime || c.createdAt || new Date().toISOString(),
    }));
    event.sender.send('certification-result', { ok: true, campaigns, lines });
  } catch (err) {
    event.sender.send('certification-result', { ok: false, error: err.message, campaigns: [], lines: [] });
  }
});

ipcMain.on('get-cert-history', (event) => {
  if (PRESENTATION_MODE) {
    event.sender.send('cert-history', MOCK_AUDIT.filter((entry) => entry.agent === 'certifier'));
    return;
  }
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
  if (PRESENTATION_MODE) {
    event.sender.send('policy-data', {
      policies: {
        freezeWindows: [{ name: 'Quarter close', active: false }],
        approvalThreshold: 'high',
      },
      sod: {
        conflicts: [['Finance-Admins', 'Payroll-Operators']],
      },
      demo: true,
    });
    return;
  }
  try {
    const policies = fs.existsSync(POLICIES_FILE) ? readJson(POLICIES_FILE) : {};
    const sod      = fs.existsSync(SOD_FILE)       ? readJson(SOD_FILE) : {};
    event.sender.send('policy-data', { policies, sod });
  } catch (err) {
    event.sender.send('policy-data', { error: err.message });
  }
});

ipcMain.on('save-policy', (event, { policies, sod }) => {
  if (PRESENTATION_MODE) {
    event.sender.send('policy-saved', demoReceipt('save-policy'));
    return;
  }
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
  if (PRESENTATION_MODE) {
    MOCK_OPERATORS.operators = { ...operators };
    MOCK_OPERATORS.roles = { ...roles };
    event.sender.send('operators-saved', demoReceipt('save-operators'));
    event.sender.send('operators-data', MOCK_OPERATORS);
    return;
  }
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
  if (PRESENTATION_MODE) {
    return {
      provider: 'azure-foundry',
      'azure-foundry': {
        endpoint: 'https://demo-foundry.services.ai.azure.com',
        deployment: 'gpt-4.1',
        apiKey: '••••',
      },
      demo: true,
    };
  }
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
  if (PRESENTATION_MODE) return demoReceipt('save-ai-provider-config');
  try {
    _ensureProviderConfig();
    // Merge: preserve existing API keys when the UI sends back masked '••••' placeholders
    const merged = JSON.parse(JSON.stringify(_aiProviderConfig));
    merged.provider = config.provider;
    for (const key of ['claude', 'openai', 'azure-foundry', 'azure-openai', 'ollama', 'lmstudio', 'qwen']) {
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
  if (PRESENTATION_MODE) {
    return {
      ...demoReceipt('test-ai-provider'),
      provider: 'Seeded demo provider',
      text: 'connected',
    };
  }
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
  if (PRESENTATION_MODE) {
    const user = MOCK_USERS.find((candidate) => candidate.userPrincipalName === upn) || MOCK_USERS[0];
    return {
      ok: true,
      demo: true,
      snapshot: {
        displayName: user.displayName,
        accountEnabled: user.accountEnabled,
        department: user.department,
        jobTitle: user.jobTitle,
        licenses: user.assignedLicenses,
        groups: ['Engineering-All'],
      },
    };
  }
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
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
    const raw = (await runAuditorGraph(ps)).split(String.fromCharCode(0xFEFF)).join('');
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
ipcMain.handle('simulate-policy', async (_, payload) => {
  const { operation, userPrincipalName, licenses, groups, newDepartment } = payload || {};
  if (!operation || !userPrincipalName) {
    return { ok: false, error: 'operation and userPrincipalName are required' };
  }
  if (PRESENTATION_MODE) {
    return {
      ...demoReceipt('simulate-policy', { subject: userPrincipalName }),
      decision: /hard|privileged/i.test(operation) ? 'requires_approval' : 'allow',
      riskLevel: /hard|privileged/i.test(operation) ? 'high' : 'low',
      matchedPolicies: ['Separation of Duties', 'Human Approval Gate'],
    };
  }
  try {
    const raw = await runPsAsync(path.join(AGENTS_DIR, 'auditor', 'Invoke-RiskScore.ps1'), {
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
  if (PRESENTATION_MODE) {
    return demoReceipt('quarantine-agent', {
      agent,
      reason,
      revoke: !!revoke,
      mode: whatif ? 'safe' : 'live',
    });
  }
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
    const raw = await runPsAsync(path.join(AGENTS_DIR, 'provisioner', 'Invoke-AgentQuarantine.ps1'), args);
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
// Wipe the previous operator's chat transcript from memory and every chat
// surface when the operator changes — no session should inherit another
// operator's conversation. Clears both the agent message state and the
// overlay/docked display history, then tells each window to reset its UI.
function resetConversationsForOperatorChange() {
  for (const agent of ['approver', 'auditor']) {
    if (state[agent]) state[agent].messages = [];
    _convHistory[agent] = [];
  }
  for (const w of [win, overlayWin, dockedWin]) {
    if (w && !w.isDestroyed()) { try { w.webContents.send('conversation-reset'); } catch {} }
  }
}

ipcMain.on('sign-out', () => {
  resetConversationsForOperatorChange();
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
// Fail closed: no authenticated session means no privileges. A real role is
// granted only by a server-verified sign-in (Entra device-code or PIN). The
// OOBE bootstrap guards explicitly allow the null (pre-session) case, and all
// RBAC checks coerce null → viewer via `(currentRole || 'viewer')`.
let currentRole     = null;
// Server-verified operator→role bindings, populated only by authenticated
// sign-ins. select-operator/switch-operator derive the session role from here
// (plus operators.json) instead of trusting a renderer-supplied role.
const _verifiedRoles = new Map();
function demoPreloadArgs() {
  return (PRESENTATION_MODE || DEMO_STATE_MODE || DEMO_DRIVE_MODE || HACKATHON_CAPTURE_MODE ||
    CAPTURE_MODE || CAPTURE_CHROME_MODE || GLASS_CAPTURE_MODE)
    ? ['--jml-demo-operator']
    : [];
}
function deriveSessionRole(name) {
  if (!name) return 'viewer';
  if (_verifiedRoles.has(name)) return _verifiedRoles.get(name);
  try {
    const ops = readJson(OPERATORS_FILE).operators || {};
    return ops[name] || ops[String(name).split('@')[0]] || 'viewer';
  } catch { return 'viewer'; }
}

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
      sandbox: true,
      additionalArguments: demoPreloadArgs()
    }
  });
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
}

// Auto-update via electron-updater (GitHub provider). Only active in a packaged
// build; no-ops in dev. Notifies the renderer when an update is available and
// downloaded, and applies it on the operator's request.
let _autoUpdaterStarted = false;
function initAutoUpdater() {
  if (_autoUpdaterStarted || !app.isPackaged) return;
  _autoUpdaterStarted = true;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.warn('electron-updater unavailable:', e.message); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const notify = (payload) => { if (win && !win.isDestroyed()) win.webContents.send('update-status', payload); };
  autoUpdater.on('update-available',  (info) => notify({ state: 'available',  version: info.version }));
  autoUpdater.on('update-downloaded', (info) => notify({ state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => console.warn('autoUpdater error:', err && err.message));
  ipcMain.removeAllListeners('apply-update');
  ipcMain.on('apply-update', () => { try { autoUpdater.quitAndInstall(); } catch (e) { console.warn('quitAndInstall failed:', e.message); } });
  // Check shortly after launch, then every 6 hours.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

function createMainWindow() {
  // Clamp to the work area so the title-bar controls are never offscreen
  // (e.g. on small laptops or high DPI scaling where 1200x780 overflows).
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: Math.min(1200, wa.width), height: Math.min(780, wa.height),
    x: wa.x + Math.max(0, Math.floor((wa.width  - Math.min(1200, wa.width))  / 2)),
    y: wa.y + Math.max(0, Math.floor((wa.height - Math.min(780, wa.height)) / 2)),
    minWidth: 900, minHeight: 600,
    frame: false,
    icon: APP_ICON,
    // Crisp transparent floating shell (user decision 2026-06-11): the desktop
    // shows through the island gutters unblurred. Deliberately NO
    // backgroundMaterial — acrylic/mica blur was tried and rejected, and it
    // also goes solid gray whenever the window loses focus.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: demoPreloadArgs()
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setIcon(APP_ICON);
  initAutoUpdater();

  // QC flag: `--theme=glass` forces a theme at load for visual checks.
  const themeArg = process.argv.find(a => a.startsWith('--theme='));
  if (themeArg) {
    const theme = themeArg.split('=')[1];
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(
        `localStorage.setItem('jmlTheme', ${JSON.stringify(theme)});` +
        `document.documentElement.dataset.theme = ${JSON.stringify(theme)};`
      ).catch(() => {});
    });
  }

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
      sandbox: true,
      additionalArguments: demoPreloadArgs()
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
  // Report viewer for display when no session is active, but DON'T persist it —
  // mutating currentRole here would defeat the null (pre-session) OOBE guards.
  return { name: currentOperator, role: currentRole || 'viewer' };
});

// Resolve the local operator username for the preload. Sourced here (not in the
// preload) so the preload needs no Node modules and every window can run with
// sandbox: true. Synchronous because the renderer reads window.api.currentUser
// at load. Mirrors the demo/capture overrides the preload used to apply.
ipcMain.on('resolve-current-user', (event) => {
  const demoOrCapture = process.argv.some(arg => [
    '--jml-demo-operator', '--demo', '--demo-state', '--demo-drive',
    '--hackathon-capture', '--capture', '--capture-jml-input',
    '--capture-chrome', '--capture-glass-screen',
  ].includes(arg));
  try {
    event.returnValue = demoOrCapture ? 'Demo Operator' : os.userInfo().username;
  } catch {
    event.returnValue = 'Operator';
  }
});

// Decode a JWT payload (no signature check — used only to read non-sensitive
// claims like `tid` from a token we just received over TLS for our own use).
function decodeJwtClaims(jwt) {
  try {
    const part = String(jwt || '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

// Entra directory roles → app role. A user who already holds an admin-tier
// directory role in the tenant should not need a hand-maintained operators.json
// entry to operate the console — their tenant privilege is the source of truth.
// Keyed by the role *template* GUID (stable across tenants); see
// https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference
const ENTRA_ROLE_TEMPLATE_TO_APP_ROLE = {
  '62e90394-69f5-4237-9190-012177145e10': 'admin',    // Global Administrator
  'e8611ab8-c189-46e8-94e1-60213ab1f814': 'admin',    // Privileged Role Administrator
  'fe930be7-5e62-47db-91af-98c3a49a38b1': 'admin',    // User Administrator
  '729827e3-9c14-49f7-bb1b-9608f156bbb8': 'helpdesk', // Helpdesk Administrator
  '966707d0-3269-4727-9be2-8c3a10f19b9d': 'helpdesk', // Password Administrator
};
const APP_ROLE_RANK = { viewer: 0, helpdesk: 1, admin: 2 };

// Resolve the strongest app role granted by the signed-in user's *active*
// Entra directory roles. Uses transitiveMemberOf so roles assigned via a
// role-assignable group are caught too (not just directly assigned ones).
// Least-privileged scope is User.Read — already granted — so no extra consent.
// Returns null when the user holds no mapped *active* directory role, or on any
// error; callers fall back to the local operators.json mapping. Note: a role
// that is PIM-eligible but not currently activated is NOT a membership and will
// not appear here until the operator activates it.
async function entraDirectoryAppRole(token) {
  try {
    // OData cast → only directory roles (a short list). Cast counts as an
    // advanced query, so ConsistencyLevel: eventual + $count are required.
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.directoryRole?$select=roleTemplateId&$count=true',
      { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
    if (!res.ok) return null;
    const body = await res.json();
    let best = null;
    for (const r of (body.value || [])) {
      const mapped = ENTRA_ROLE_TEMPLATE_TO_APP_ROLE[String(r.roleTemplateId || '').toLowerCase()];
      if (mapped && (!best || APP_ROLE_RANK[mapped] > APP_ROLE_RANK[best])) best = mapped;
    }
    return best;
  } catch { return null; }
}

// ── Entra operator sign-in (device code) ──────────────────────────────────────
// Authenticates the human operator against Entra ID instead of trusting the
// local Windows username: device code → Graph /me → role from the tenant's
// directory roles (admins are auto-elevated) or operators.json (keyed by UPN,
// display name, or UPN local part), whichever is higher. The audit chain then
// carries a real directory identity. Windows/PIN selection remains beside it.
ipcMain.on('entra-signin-start', async (event) => {
  const send = (ch, d) => { try { event.sender.send(ch, d); } catch {} };
  if (PRESENTATION_MODE) {
    send('entra-signin-result', {
      ok: true,
      name: DEMO_ADMIN,
      displayName: 'Demo Administrator',
      role: 'admin',
      demo: true,
      committed: false,
    });
    return;
  }
  try {
    // Resolve the tenant from the durable tenant.json first; fall back to an
    // agent config if one exists. When NOTHING is configured yet (fresh install)
    // we don't block — we sign in against the `organizations` authority (any
    // work/school account) and discover + persist the tenant from the resulting
    // token. This breaks the chicken-and-egg: sign-in no longer requires a
    // pre-connected tenant, and setup no longer requires a prior sign-in.
    const configuredTenant = readTenantConfig().tenantId || (() => {
      try { return readJson(path.join(AGENTS_DIR, 'auditor', 'config.json')).TenantId; } catch { return ''; }
    })();
    const authority = configuredTenant || 'organizations';
    const clientId = '14d82eec-204b-4c2f-b7e8-296a70dab67e'; // Microsoft Graph public client
    const form = body => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const dc = await (await fetch(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/devicecode`,
      form({ client_id: clientId, scope: 'User.Read openid profile' }))).json();
    if (!dc.device_code) throw new Error(dc.error_description || 'Could not start device-code sign-in');
    send('entra-device-code', { userCode: dc.user_code, verificationUri: dc.verification_uri || 'https://microsoft.com/devicelogin' });

    // In-app sign-in popup: loads the real Microsoft device-auth page with the
    // code pre-filled (otc param), so the operator only confirms and signs in.
    // Sandboxed, no preload — it is a plain Microsoft login page.
    let authWin = new BrowserWindow({
      width: 480, height: 680,
      // Parent to whichever shell launched sign-in: operator-select normally, or
      // the first-run setup window during OOBE tenant onboarding.
      parent: (operatorWin && !operatorWin.isDestroyed()) ? operatorWin
            : (setupWin && !setupWin.isDestroyed()) ? setupWin : undefined,
      autoHideMenuBar: true,
      title: 'Microsoft Entra sign-in',
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    authWin.on('closed', () => { authWin = null; });
    authWin.loadURL(`https://login.microsoftonline.com/${authority}/oauth2/deviceauth?otc=${encodeURIComponent(dc.user_code)}`);
    const closeAuthWin = () => { try { if (authWin && !authWin.isDestroyed()) authWin.close(); } catch {} };

    const deadline = Date.now() + (dc.expires_in || 900) * 1000;
    let interval = Math.max(5, dc.interval || 5) * 1000;
    let token = null;
    let idToken = null;
    while (Date.now() < deadline) {
      await sleep(interval);
      const tok = await (await fetch(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
        form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: dc.device_code }))).json();
      if (tok.access_token) { token = tok.access_token; idToken = tok.id_token || null; break; }
      if (tok.error === 'authorization_pending') continue;
      if (tok.error === 'slow_down') { interval += 5000; continue; }
      closeAuthWin();
      throw new Error(tok.error_description || tok.error || 'Sign-in failed');
    }
    closeAuthWin();
    if (!token) throw new Error('Sign-in timed out — try again');

    const me = await (await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,userPrincipalName',
      { headers: { Authorization: `Bearer ${token}` } })).json();
    const upn = me.userPrincipalName || '';
    if (!upn) throw new Error((me.error && me.error.message) || 'Could not resolve the signed-in identity');

    let localRole = 'viewer';
    try {
      const ops = readJson(OPERATORS_FILE).operators || {};
      localRole = ops[upn] || ops[me.displayName] || ops[upn.split('@')[0]] || 'viewer';
    } catch {}
    // Tenant admins are auto-elevated: take the stronger of the directory-role
    // grant and the local operators.json mapping (never downgrades a configured
    // operator, never locks out a real tenant admin who isn't in operators.json).
    const tenantRole = await entraDirectoryAppRole(token);
    const role = (tenantRole && (APP_ROLE_RANK[tenantRole] || 0) > (APP_ROLE_RANK[localRole] || 0))
      ? tenantRole : localRole;
    // Bind this verified identity → role so select-operator grants it server-side
    // (covers tenant admins auto-elevated via directory role, not in operators.json).
    _verifiedRoles.set(upn, role);
    if (me.displayName) _verifiedRoles.set(me.displayName, role);
    _verifiedRoles.set(upn.split('@')[0], role);

    // Auto-connect the tenant when none was configured: read the tenant id from
    // the sign-in token (id_token `tid`) and persist it so the console is now
    // bound to the tenant the operator actually signed into.
    let tenantConnected = null;
    if (!configuredTenant) {
      const claims = decodeJwtClaims(idToken || token);
      const tid = claims && claims.tid;
      if (tid && /^[0-9a-f-]{32,36}$/i.test(tid)) {
        try {
          writeTenantConfig({ tenantId: tid, primaryDomain: upn.split('@')[1] || '' });
          tenantConnected = tid;
        } catch {}
      }
    }
    logOperatorActivity('entra.signin', { target: upn, role, tenantRole: tenantRole || null, tenantConnected });
    send('entra-signin-result', { ok: true, name: upn, displayName: me.displayName || upn, role, tenantConnected });
  } catch (e) {
    send('entra-signin-result', { ok: false, error: e.message });
  }
});

ipcMain.on('select-operator', (event, { name }) => {
  const changed = name !== currentOperator;
  currentOperator = name;
  // Role comes from server-verified state + operators.json, never the payload.
  currentRole     = deriveSessionRole(name);
  process.env.JML_CONSOLE_OPERATOR = name;
  if (changed) resetConversationsForOperatorChange();
  if (operatorWin && !operatorWin.isDestroyed()) { operatorWin.close(); operatorWin = null; }
  if (!win) createMainWindow();
});

ipcMain.on('switch-operator', (event, { name }) => {
  const changed = name !== currentOperator;
  currentOperator = name;
  currentRole     = deriveSessionRole(name);
  process.env.JML_CONSOLE_OPERATOR = name;
  if (changed) resetConversationsForOperatorChange();
  if (win && !win.isDestroyed()) win.webContents.send('operator-switched', { name, role: currentRole });
});

// ── Operator authentication (PIN / Windows) — gates write-mode operations ────
function readOperatorAuth() {
  try { return readJson(OPERATOR_AUTH_FILE) || {}; } catch { return {}; }
}
function writeOperatorAuth(data) {
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'operator authentication write');
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
  if (PRESENTATION_MODE) return demoReceipt('set-operator-auth-pin', { user });
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
  if (PRESENTATION_MODE) return demoReceipt('set-operator-auth-windows', { user });
  if (!user) return { ok: false, error: 'user required' };
  const data = readOperatorAuth();
  data[user] = { mode: 'windows', updatedAt: new Date().toISOString() };
  writeOperatorAuth(data);
  logOperatorActivity('auth.windows.set', { target: user });
  return { ok: true };
});

// ── Tenant onboarding: read/write each agent's config.json TenantId ──────────
ipcMain.handle('get-tenant-config', () => {
  if (PRESENTATION_MODE) {
    return {
      tenantId: '00000000-0000-0000-0000-000000000000',
      primaryDomain: 'contoso.onmicrosoft.com',
      region: 'US',
      clientIds: {},
      agents: AGENT_DIRS.map((agent) => ({
        agent,
        exists: true,
        hasCert: !['approver', 'auditor'].includes(agent),
        identityType: ['approver', 'auditor'].includes(agent) ? 'Agent ID / FMI' : 'Execution SP / certificate',
      })),
      configured: true,
      demo: true,
    };
  }
  // tenant.json is the source of truth; agent config.json values fill any gaps.
  const t = readTenantConfig();
  const out = {
    tenantId: t.tenantId || '', primaryDomain: t.primaryDomain || '',
    region: t.region || '', clientIds: {}, agents: [], configured: !!t.tenantId
  };
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
  // The durable tenant.json is always part of the diff so the save flow has
  // something to apply even on a fresh install where no agent config.json
  // files exist yet — otherwise the renderer reports "no changes" and the
  // tenant is never written.
  const cur = readTenantConfig();
  const tdiff = {};
  if (tenantId && (cur.tenantId || '') !== tenantId) tdiff.TenantId = { from: cur.tenantId || '', to: tenantId };
  if (primaryDomain && (cur.primaryDomain || '') !== primaryDomain) tdiff.PrimaryDomain = { from: cur.primaryDomain || '', to: primaryDomain };
  if (region && (cur.region || '') !== region) tdiff.Region = { from: cur.region || '', to: region };
  changes.push({ agent: 'tenant.json', exists: true, diff: tdiff });
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
  if (PRESENTATION_MODE) {
    return demoReceipt('save-tenant-config', {
      tenantId,
      primaryDomain,
      region,
      updated: [],
      skipped: AGENT_DIRS,
      errors: [],
    });
  }
  if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    return { ok: false, error: 'Tenant ID must be a GUID' };
  }
  // Persist to the durable source of truth first — this is what makes the save
  // succeed on a fresh install where no agent config.json files exist yet.
  let tenantConfigError = null;
  try {
    writeTenantConfig({ tenantId, primaryDomain: primaryDomain || '', region: region || '' });
  } catch (e) { tenantConfigError = e.message; }

  const updated = []; const skipped = []; const errors = [];
  if (tenantConfigError) errors.push({ agent: 'tenant.json', error: tenantConfigError });
  // Opportunistically mirror into any agent configs that already exist.
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
  // Saved to tenant.json even if every agent config was absent → ok unless the
  // durable write itself failed.
  return { ok: !tenantConfigError, updated, skipped, errors };
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
  if (PRESENTATION_MODE) {
    return {
      entries: MOCK_AUDIT.slice(0, Math.max(1, Math.min(50, limit || 20))).map((entry) => ({
        timestamp: entry.timestamp,
        operator: entry.operator,
        role: entry.operator === 'system' ? 'system' : 'admin',
        event: entry.action,
        details: { subject: entry.subject, ticketRef: entry.ticketRef },
      })),
      demo: true,
    };
  }
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
// Tenant onboarding signs into the TARGET tenant via the OAuth device-code flow
// over direct HTTPS — the same proven path as operator sign-in. The earlier
// approach spawned Connect-MgGraph and screen-scraped its console output, which
// silently hangs on Windows PowerShell 5.1: the device-code line is block-
// buffered in the redirected stdout pipe while Connect-MgGraph blocks on auth,
// so the code never reaches the renderer. The token obtained here is handed to
// the Step-2/Step-3 PowerShell via Connect-MgGraph -AccessToken.
let _signinProc = null; // identity object for the in-flight flow (abort/supersede)
let _signinState = { status: 'idle', deviceCode: '', verificationUrl: '', tenantId: '', account: '', error: '' };
let _wizardToken = null;     // Graph access token for downstream PowerShell steps
let _wizardTokenExp = 0;
const WIZARD_GRAPH_CLIENT = '14d82eec-204b-4c2f-b7e8-296a70dab67e'; // Microsoft Graph Command Line Tools (public client)
const WIZARD_GRAPH_SCOPES = 'Application.ReadWrite.All Directory.ReadWrite.All User.Read.All offline_access openid profile';

async function startWizardDeviceCode() {
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'tenant device-code sign-in');
  _signinState = { status: 'pending', deviceCode: '', verificationUrl: '', tenantId: '', account: '', error: '' };
  _wizardToken = null; _wizardTokenExp = 0;
  const myProc = {};
  _signinProc = myProc;
  const aborted = () => _signinProc !== myProc;
  const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  // Sign into the configured tenant if known, else 'organizations' so any
  // work/school admin can sign in; the real tenant id is read from the token.
  const authority = readTenantConfig().tenantId || 'organizations';
  try {
    const dc = await (await fetch(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/devicecode`,
      form({ client_id: WIZARD_GRAPH_CLIENT, scope: WIZARD_GRAPH_SCOPES }))).json();
    if (!dc.device_code) throw new Error(dc.error_description || 'Could not start device-code sign-in');
    if (aborted()) return;
    _signinState.deviceCode = dc.user_code;
    _signinState.verificationUrl = dc.verification_uri || 'https://microsoft.com/devicelogin';
    const deadline = Date.now() + (dc.expires_in || 900) * 1000;
    let interval = Math.max(5, dc.interval || 5) * 1000;
    while (Date.now() < deadline) {
      await sleep(interval);
      if (aborted()) return;
      const tok = await (await fetch(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
        form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: WIZARD_GRAPH_CLIENT, device_code: dc.device_code }))).json();
      if (tok.access_token) {
        const claims = decodeJwtClaims(tok.id_token || tok.access_token) || {};
        let account = claims.preferred_username || '';
        try {
          const me = await (await fetch('https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,displayName',
            { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
          account = me.userPrincipalName || me.displayName || account;
        } catch {}
        _wizardToken = tok.access_token;
        _wizardTokenExp = Date.now() + ((tok.expires_in || 3600) - 60) * 1000;
        _signinState.status = 'success';
        _signinState.tenantId = claims.tid || '';
        _signinState.account = account;
        if (claims.tid && /^[0-9a-f-]{32,36}$/i.test(claims.tid)) {
          try { writeTenantConfig({ tenantId: claims.tid, primaryDomain: (account.split('@')[1] || '') }); } catch {}
        }
        return;
      }
      if (tok.error === 'authorization_pending') continue;
      if (tok.error === 'slow_down') { interval += 5000; continue; }
      throw new Error(tok.error_description || tok.error || 'Sign-in failed');
    }
    throw new Error('Sign-in timed out — try again');
  } catch (e) {
    if (aborted()) return;
    _signinState.status = 'error';
    _signinState.error = e.message;
  } finally {
    if (_signinProc === myProc) _signinProc = null;
  }
}

// Token guard for the Step-2/Step-3 PowerShell steps that need a Graph session.
function wizardGraphTokenOrThrow() {
  if (!_wizardToken || Date.now() > _wizardTokenExp) {
    throw new Error('Tenant sign-in expired — run Step 1 (sign in) again');
  }
  return _wizardToken;
}

ipcMain.handle('start-device-code-signin', () => {
  if (PRESENTATION_MODE) {
    _signinState = {
      status: 'success',
      deviceCode: 'DEMO-CODE',
      verificationUrl: 'https://microsoft.com/devicelogin',
      tenantId: '00000000-0000-0000-0000-000000000000',
      account: DEMO_ADMIN,
      demo: true,
    };
    return demoReceipt('start-device-code-signin');
  }
  // Allow sign-in when there's no operator session yet (fresh PC setup) as
  // well as when the current operator is admin. Block viewer/helpdesk only.
  if (currentRole !== null && currentRole !== undefined && currentRole !== 'admin') {
    return { ok: false, error: 'admin required' };
  }
  _signinProc = null;        // supersede any in-flight flow
  startWizardDeviceCode();   // runs in the background, updating _signinState
  logOperatorActivity('tenant.wizard.signin.start', {});
  return { ok: true };
});

ipcMain.handle('check-device-code-status', () => {
  return _signinState;
});

ipcMain.handle('create-agent-app-registrations', (event, { agentNames }) => {
  if (PRESENTATION_MODE) {
    const names = Array.isArray(agentNames) && agentNames.length ? agentNames : AGENT_DIRS;
    return {
      ...demoReceipt('create-agent-app-registrations'),
      created: names.map((agent) => ({
        agent,
        appId: `demo-${agent}-app-id`,
        objectId: `demo-${agent}-object-id`,
        spId: `demo-${agent}-sp-id`,
      })),
      errors: [],
      tenantId: '00000000-0000-0000-0000-000000000000',
    };
  }
  if (currentRole !== null && currentRole !== undefined && currentRole !== 'admin') {
    return { ok: false, error: 'admin required' };
  }
  if (_signinState.status !== 'success') return { ok: false, error: 'sign in to the target tenant first' };
  let wizToken;
  try { wizToken = wizardGraphTokenOrThrow(); } catch (e) { return { ok: false, error: e.message }; }
  const names = Array.isArray(agentNames) && agentNames.length ? agentNames : AGENT_DIRS;
  const created = []; const errors = [];
  for (const agent of names) {
    try {
      const script = `
        $ErrorActionPreference = 'Stop'
        Import-Module Microsoft.Graph.Applications -ErrorAction Stop
        Connect-MgGraph -AccessToken (ConvertTo-SecureString $env:JML_WIZ_TOKEN -AsPlainText -Force) -NoWelcome
        $app = New-MgApplication -DisplayName "jml-fleet-${agent}"
        $sp = New-MgServicePrincipal -AppId $app.AppId
        @{ agent='${agent}'; appId=$app.AppId; objectId=$app.Id; spId=$sp.Id } | ConvertTo-Json -Compress
      `;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, JML_WIZ_TOKEN: wizToken } });
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

// ── Agent certificate deployment (new-PC setup) ─────────────────────────────
// Creates a self-signed cert in Cert:\CurrentUser\My for each agent, uploads
// the public key to its Entra app registration, and writes CertThumbprint +
// CertExpiry back to the agent's config.json. Requires an active Graph session
// (start-device-code-signin must have succeeded first).
ipcMain.handle('deploy-agent-certificates', async (event, { agents }) => {
  if (PRESENTATION_MODE) {
    const names = (agents || AGENT_DIRS).map(a => typeof a === 'string' ? a : a.agent);
    return {
      ok: true, demo: true,
      results: names.map(agent => ({
        agent, ok: true,
        thumbprint: 'DEMO' + Math.random().toString(16).slice(2, 10).toUpperCase(),
        expiry: new Date(Date.now() + 2 * 365 * 86400 * 1000).toISOString(),
      })),
    };
  }
  if (currentRole !== null && currentRole !== undefined && currentRole !== 'admin') {
    return { ok: false, error: 'admin required' };
  }
  if (_signinState.status !== 'success') {
    return { ok: false, error: 'complete device-code sign-in (Step 1) before deploying certificates' };
  }
  let wizToken;
  try { wizToken = wizardGraphTokenOrThrow(); } catch (e) { return { ok: false, error: e.message }; }

  const agentList = (agents || AGENT_DIRS).map(a => typeof a === 'string'
    ? { agent: a, clientId: null }
    : { agent: a.agent, clientId: a.clientId || null });

  const results = [];
  for (const { agent, clientId } of agentList) {
    const configPath = path.join(AGENTS_DIR, agent, 'config.json');
    const resolvedClientId = clientId
      || (fs.existsSync(configPath) ? (readJson(configPath) || {}).ClientId : null);

    if (!resolvedClientId) {
      results.push({ agent, ok: false, error: 'no ClientId in config.json — run Step 2 first' });
      continue;
    }
    // Defense-in-depth: only a well-formed GUID may reach the Graph $filter below.
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(resolvedClientId))) {
      results.push({ agent, ok: false, error: 'ClientId is not a valid GUID — refusing to query Graph' });
      continue;
    }

    // One synchronous PowerShell call per agent. Connects with the wizard's
    // device-code access token (passed via the JML_WIZ_TOKEN env var).
    const escaped = agent.replace(/[^a-z0-9-]/gi, '');
    const agentsRoot = AGENTS_DIR.replace(/\\/g, '\\\\');
    const script = `
$ErrorActionPreference = 'Stop'
try {
  Import-Module Microsoft.Graph.Applications -ErrorAction Stop
  Connect-MgGraph -AccessToken (ConvertTo-SecureString $env:JML_WIZ_TOKEN -AsPlainText -Force) -NoWelcome
  $certSubject = 'CN=JML-${escaped}'
  # Remove any previous cert with this subject so we don't accumulate stale ones
  Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq $certSubject } | Remove-Item -Force -ErrorAction SilentlyContinue
  # Create new 2-year self-signed cert (non-exportable private key)
  $cert = New-SelfSignedCertificate -Subject $certSubject -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(2)
  # Look up the app registration by ClientId
  $app = Get-MgApplication -Filter "AppId eq '${resolvedClientId}'" -ErrorAction Stop
  if (-not $app) { throw "App registration not found for ClientId ${resolvedClientId}" }
  # Build updated keyCredentials list: keep non-JML-${escaped} existing creds, add new one
  $keyBytes = [System.Convert]::ToBase64String($cert.GetRawCertData())
  $newKey = @{
    type        = 'AsymmetricX509Cert'
    usage       = 'Verify'
    key         = $cert.GetRawCertData()
    displayName = $certSubject
  }
  $existing = @($app.KeyCredentials | Where-Object { $_.DisplayName -ne $certSubject })
  $allKeys  = @($existing) + @([PSCustomObject]$newKey)
  Update-MgApplication -ApplicationId $app.Id -KeyCredentials $allKeys -ErrorAction Stop
  # Write thumbprint + expiry back to config.json
  $configPath = "${agentsRoot}\\${escaped}\\config.json"
  if (Test-Path $configPath) {
    $cfg = Get-Content $configPath | ConvertFrom-Json
    $cfg | Add-Member -Force -NotePropertyName CertThumbprint -NotePropertyValue $cert.Thumbprint
    $cfg | Add-Member -Force -NotePropertyName CertExpiry    -NotePropertyValue $cert.NotAfter.ToString('o')
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
  }
  @{ ok=$true; agent='${escaped}'; thumbprint=$cert.Thumbprint; expiry=$cert.NotAfter.ToString('o') } | ConvertTo-Json -Compress
} catch {
  @{ ok=$false; agent='${escaped}'; error=$_.Exception.Message } | ConvertTo-Json -Compress
}
`.trim();

    const { spawnSync } = require('child_process');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, JML_WIZ_TOKEN: wizToken },
    });
    const lastLine = (r.stdout || '').trim().split(/\r?\n/).reverse().find(l => l.trim().startsWith('{'));
    if (!lastLine) {
      results.push({ agent, ok: false, error: (r.stderr || r.stdout || 'no output').slice(0, 200) });
    } else {
      try { results.push(JSON.parse(lastLine)); }
      catch { results.push({ agent, ok: false, error: 'could not parse PowerShell result' }); }
    }
  }

  const succeeded = results.filter(r => r.ok).length;
  logOperatorActivity('tenant.certs.deployed', { total: agentList.length, succeeded });
  return { ok: true, results };
});

// ── Notification routing rules ──────────────────────────────────────────────
const NOTIFICATION_RULES_FILE = path.join(AGENTS_DIR, 'approver', 'notification-rules.json');
ipcMain.handle('get-notification-rules', () => {
  if (PRESENTATION_MODE) {
    return {
      rules: [
        { event: 'operation.failed', channels: ['Teams', 'Sentinel'], severity: 'critical' },
        { event: 'approval.waiting', channels: ['Teams'], severity: 'warning' },
      ],
      demo: true,
    };
  }
  try {
    if (!fs.existsSync(NOTIFICATION_RULES_FILE)) return { rules: [] };
    return readJson(NOTIFICATION_RULES_FILE) || { rules: [] };
  } catch (e) { return { rules: [], error: e.message }; }
});
ipcMain.handle('save-notification-rules', (event, { rules }) => {
  if (PRESENTATION_MODE) return demoReceipt('save-notification-rules', { count: rules?.length || 0 });
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
  if (PRESENTATION_MODE) return;
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
  assertExternalExecutionAllowed(PRESENTATION_MODE, 'Windows credential verification');
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
  // Bind this PIN-verified operator → role so select-operator grants it server-side.
  try {
    const ops = readJson(OPERATORS_FILE).operators || {};
    _verifiedRoles.set(user, ops[user] || ops[String(user).split('@')[0]] || 'viewer');
  } catch {}
  // Mint a write token the renderer can attach to subsequent write IPC calls
  const token = mintWriteToken(user);
  return { ok: true, writeToken: token, ttlMs: WRITE_TOKEN_TTL_MS };
});

// ── Screenshot capture mode (npm start -- --capture) ─────────────────────────
const INPUT_CAPTURE_ONLY = process.argv.includes('--capture-jml-input');
const CAPTURE_MODE = process.argv.includes('--capture') || INPUT_CAPTURE_ONLY;
const DEMO_DRIVE_MODE = process.argv.includes('--demo-drive');
const DEMO_STATE_MODE = process.argv.includes('--demo');
const CAPTURE_CHROME_MODE = process.argv.includes('--capture-chrome');
const RENDER_DIAGRAM_MODE = process.argv.includes('--render-diagram');
const HACKATHON_CAPTURE_MODE = process.argv.includes('--hackathon-capture');
const GLASS_CAPTURE_MODE = process.argv.includes('--glass-qc');
const GS_STATES_QC_MODE = process.argv.includes('--gs-states');
const CAPTURE_OUT = GLASS_CAPTURE_MODE
  ? path.join(__dirname, '..', '.superpowers', 'glass-qc')
  : path.join(__dirname, '..', 'docs', 'images');

// Mock data pushed directly to renderer for tabs that need Graph/PS connections.
// Org-scale numbers so the console reads like a real mid-size tenant.
const _dmin = (m) => new Date(Date.now() - m * 60000).toISOString();
const MOCK_DASHBOARD = {
  users:    { total: 1284, enabled: 1197, disabled: 63, guests: 24 },
  licenses: { licenses: [
    { sku: 'Microsoft 365 E5',     total: 500,  assigned: 472 },
    { sku: 'Microsoft 365 E3',     total: 750,  assigned: 631 },
    { sku: 'Power BI Pro',         total: 250,  assigned: 188 },
    { sku: 'EMS E5',               total: 500,  assigned: 401 },
    { sku: 'Intune Device',        total: 300,  assigned: 96  }
  ]},
  activity: { totalEntries: 3142, recentEntries: [
    { action: 'graph.user.disable',        agent: 'leaver',   subject: 'robert.martinez@contoso.onmicrosoft.com', outcome: 'success', timestamp: _dmin(3),   details: { ticketRef: 'INC-1042' } },
    { action: 'approval.granted',          agent: 'approver', subject: 'robert.martinez@contoso.onmicrosoft.com', outcome: 'success', timestamp: _dmin(4),   details: { rule: 'dual-approval' } },
    { action: 'graph.user.create',         agent: 'joiner',   subject: 'alex.nguyen@contoso.onmicrosoft.com',     outcome: 'success', timestamp: _dmin(46),  details: { ticketRef: 'INC-1025' } },
    { action: 'graph.group.update',        agent: 'mover',    subject: 'lena.fischer@contoso.onmicrosoft.com',    outcome: 'partial', timestamp: _dmin(140), details: { pending: 2 } },
    { action: 'license.assign',            agent: 'enroller', subject: 'priya.shah@contoso.onmicrosoft.com',      outcome: 'success', timestamp: _dmin(205), details: {} }
  ]}
};
const MOCK_AGENT_HEALTH = [
  { name:'joiner',      status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*2).toISOString(),  lastOutcome:'success' },
  { name:'mover',       status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*7).toISOString(),  lastOutcome:'success' },
  { name:'leaver',      status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*5).toISOString(),  lastOutcome:'success' },
  { name:'enroller',    status:'warning',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*6).toISOString(),  lastOutcome:'partial' },
  { name:'approver',    status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*1).toISOString(),  lastOutcome:'success' },
  { name:'provisioner', status:'unconfigured', credentialType:'certificate', daysUntilExpiry:null, lastActivity: null, lastOutcome: null },
  { name:'auditor',     status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*0.5).toISOString(), lastOutcome:'success' },
  { name:'certifier',   status:'healthy',      credentialType:'certificate', daysUntilExpiry:312, lastActivity: new Date(Date.now()-86400000*3).toISOString(),  lastOutcome:'success' }
];
const MOCK_CERT_EXPIRY = [
  { agent:'joiner',      thumbprint:'A1B2C3D4E5F6',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'mover',       thumbprint:'B2C3D4E5F6A1',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'leaver',      thumbprint:'C3D4E5F6A1B2',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'enroller',    thumbprint:'D4E5F6A1B2C3',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'approver',    thumbprint:'E5F6A1B2C3D4',  expiry: new Date(Date.now()+86400000*47).toISOString(),  daysLeft:47  },
  { agent:'provisioner', thumbprint:null,             expiry: null, daysLeft: null },
  { agent:'auditor',     thumbprint:'F6A1B2C3D4E5',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 },
  { agent:'certifier',   thumbprint:'A7B8C9D0E1F2',  expiry: new Date(Date.now()+86400000*312).toISOString(), daysLeft:312 }
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
  },
  {
    id: 'INC-1031', token: 'INC-1031',
    tool: 'submit_mover', severity: 'warn',
    requestedBy: 'helpdesk2', requestedByRole: 'helpdesk',
    requestedAt: new Date(Date.now()-3600000*5).toISOString(),
    status: 'pending',
    input: {
      userPrincipalName: 'lena.fischer@contoso.onmicrosoft.com',
      stage: 'Transfer', ticketRef: 'INC-1031',
      givenName: 'Lena', surname: 'Fischer',
      department: 'Platform', jobTitle: 'Engineering Manager',
      groupsToAdd: ['Platform-Leads'], groupsToRemove: ['Engineering-IC'],
    },
    note: 'Department transfer touches a sensitive group — separation-of-duties review required.'
  },
  {
    id: 'INC-1034', token: 'INC-1034',
    tool: 'submit_leaver_soft', severity: 'warn',
    requestedBy: 'helpdesk1', requestedByRole: 'helpdesk',
    requestedAt: new Date(Date.now()-3600000*7).toISOString(),
    status: 'pending',
    input: {
      userPrincipalName: 'marcus.johnson@contoso.onmicrosoft.com',
      stage: 'Soft', ticketRef: 'INC-1034',
      givenName: 'Marcus', surname: 'Johnson',
    },
    note: 'Contractor end-of-engagement — soft disable pending manager confirmation.'
  },
  {
    id: 'INC-1037', token: 'INC-1037',
    tool: 'submit_enroller', severity: 'info',
    requestedBy: 'helpdesk2', requestedByRole: 'helpdesk',
    requestedAt: new Date(Date.now()-3600000*9).toISOString(),
    status: 'pending',
    input: {
      userPrincipalName: 'priya.shah@contoso.onmicrosoft.com',
      stage: 'Enroll', ticketRef: 'INC-1037',
      givenName: 'Priya', surname: 'Shah',
      department: 'Sales', jobTitle: 'Account Executive',
      licenses: ['Microsoft 365 E5'],
    },
    note: 'Device enrollment + license — routine, awaiting batch sign-off.'
  }
];
const demoScheduledOps = [];

function removeDemoApproval(id) {
  const index = MOCK_APPROVALS.findIndex((approval) => approval.id === id || approval.token === id);
  if (index < 0) return null;
  const [approval] = MOCK_APPROVALS.splice(index, 1);
  const update = { approvals: MOCK_APPROVALS.length, pendingList: MOCK_APPROVALS };
  pushPanelUpdate(update);
  pushOverlayUpdate(update);
  if (win && !win.isDestroyed()) win.webContents.send('pending-approvals', MOCK_APPROVALS);
  return approval;
}

// ── Demo-drive seed data ──────────────────────────────────────────────────────
// A coherent, realistic fixture so EVERY tab shows a working product during a
// recording (no OOBE empty states, no Graph errors). Pushed/served only in
// --demo-drive mode. Synthetic identities on the contoso demo domain.
const _iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const MOCK_USERS = [
  { id: 'u1', displayName: 'Sarah Chen', userPrincipalName: 'sarah.chen@contoso.onmicrosoft.com', department: 'Engineering', jobTitle: 'Staff Engineer', accountEnabled: true,  assignedLicenses: ['Microsoft 365 E3', 'Power BI Pro'], riskLevel: 'low',    riskScore: 12, signInActivity: { lastSignInDateTime: _iso(38) } },
  { id: 'u2', displayName: 'Robert Martinez', userPrincipalName: 'robert.martinez@contoso.onmicrosoft.com', department: 'Finance', jobTitle: 'Controller', accountEnabled: false, assignedLicenses: [], riskLevel: 'high', riskScore: 82, signInActivity: { lastSignInDateTime: _iso(1620) } },
  { id: 'u3', displayName: 'Dev Patel', userPrincipalName: 'dev.patel@contoso.onmicrosoft.com', department: 'Engineering', jobTitle: 'Senior Engineer', accountEnabled: true, assignedLicenses: ['Microsoft 365 E3'], riskLevel: 'low', riskScore: 8, signInActivity: { lastSignInDateTime: _iso(12) } },
  { id: 'u4', displayName: 'Lena Fischer', userPrincipalName: 'lena.fischer@contoso.onmicrosoft.com', department: 'Platform', jobTitle: 'Engineering Manager', accountEnabled: true, assignedLicenses: ['Microsoft 365 E5'], riskLevel: 'medium', riskScore: 44, signInActivity: { lastSignInDateTime: _iso(95) } },
  { id: 'u5', displayName: 'Yusuf Demir', userPrincipalName: 'yusuf.demir@contoso.onmicrosoft.com', department: 'Security', jobTitle: 'Security Analyst', accountEnabled: true, assignedLicenses: ['Microsoft 365 E5', 'EMS E5'], riskLevel: 'low', riskScore: 5, signInActivity: { lastSignInDateTime: _iso(7) } },
  { id: 'u6', displayName: 'Marcus Johnson', userPrincipalName: 'marcus.johnson@contoso.onmicrosoft.com', department: 'Contractors', jobTitle: 'Contract Developer', accountEnabled: true, assignedLicenses: ['Microsoft 365 E3'], riskLevel: 'medium', riskScore: 51, signInActivity: { lastSignInDateTime: _iso(220) } },
  { id: 'u7', displayName: 'Priya Shah', userPrincipalName: 'priya.shah@contoso.onmicrosoft.com', department: 'Sales', jobTitle: 'Account Executive', accountEnabled: true, assignedLicenses: ['Microsoft 365 E5'], riskLevel: 'low', riskScore: 9, signInActivity: { lastSignInDateTime: _iso(21) } },
  { id: 'u8', displayName: 'Alex Nguyen', userPrincipalName: 'alex.nguyen@contoso.onmicrosoft.com', department: 'Engineering', jobTitle: 'Software Engineer', accountEnabled: true, assignedLicenses: ['Microsoft 365 E3', 'Power BI Pro'], riskLevel: 'low', riskScore: 6, signInActivity: { lastSignInDateTime: _iso(15) } },
  { id: 'u9', displayName: 'Dana Whitfield', userPrincipalName: 'dana.whitfield@contoso.onmicrosoft.com', department: 'Finance', jobTitle: 'Finance Director', accountEnabled: true, assignedLicenses: ['Microsoft 365 E5'], riskLevel: 'low', riskScore: 11, signInActivity: { lastSignInDateTime: _iso(64) } },
  { id: 'u10', displayName: 'Omar Haddad', userPrincipalName: 'omar.haddad@contoso.onmicrosoft.com', department: 'IT', jobTitle: 'Systems Administrator', accountEnabled: true, assignedLicenses: ['Microsoft 365 E5', 'EMS E5'], riskLevel: 'medium', riskScore: 38, signInActivity: { lastSignInDateTime: _iso(48) } },
  { id: 'u11', displayName: 'Grace Okafor', userPrincipalName: 'grace.okafor@contoso.onmicrosoft.com', department: 'HR', jobTitle: 'HR Business Partner', accountEnabled: true, assignedLicenses: ['Microsoft 365 E3'], riskLevel: 'low', riskScore: 7, signInActivity: { lastSignInDateTime: _iso(133) } },
  { id: 'u12', displayName: 'Tom Becker', userPrincipalName: 'tom.becker@contoso.onmicrosoft.com', department: 'Engineering', jobTitle: 'Principal Engineer', accountEnabled: false, assignedLicenses: [], riskLevel: 'low', riskScore: 4, signInActivity: { lastSignInDateTime: _iso(8800) } },
];
const _ev = (subject, agent, minAgo) => ({ subject, agent, timestamp: _iso(minAgo) });
const MOCK_SECURITY = {
  ueba: { summary: { critical: 1, warning: 2, info: 1 }, findings: [
    { severity: 'critical', ruleId: 'UEBA-07', title: 'After-hours privileged offboarding', events: [_ev('robert.martinez@contoso.onmicrosoft.com', 'leaver', 18), _ev('robert.martinez@contoso.onmicrosoft.com', 'leaver', 22)] },
    { severity: 'warning', ruleId: 'UEBA-03', title: 'Leaver followed by group add', events: [_ev('lena.fischer@contoso.onmicrosoft.com', 'mover', 140)] },
    { severity: 'warning', ruleId: 'UEBA-11', title: 'Unusual license assignment burst', events: [_ev('dev.patel@contoso.onmicrosoft.com', 'joiner', 320)] },
    { severity: 'info', ruleId: 'UEBA-01', title: 'New device enrollment', events: [_ev('yusuf.demir@contoso.onmicrosoft.com', 'enroller', 410)] },
  ]},
  drift: { summary: { critical: 0, warning: 1, info: 2 }, findings: [
    { severity: 'warning', ruleId: 'DRIFT-04', title: 'Group membership drift vs. baseline', events: [_ev('Finance-Admins', 'auditor', 60)] },
    { severity: 'info', ruleId: 'DRIFT-02', title: 'License SKU reallocation', events: [_ev('Engineering-All', 'auditor', 180)] },
  ]},
  riskyUsers: { summary: { critical: 1, warning: 1, info: 0 }, users: [
    { displayName: 'Robert Martinez', upn: 'robert.martinez@contoso.onmicrosoft.com', riskLevel: 'high' },
    { displayName: 'Lena Fischer', upn: 'lena.fischer@contoso.onmicrosoft.com', riskLevel: 'medium' },
  ]},
};
const MOCK_AUDIT = [
  { timestamp: _iso(3),   agent: 'leaver',   action: 'graph.user.disable',           subject: 'robert.martinez@contoso.onmicrosoft.com', operator: 'Nick', outcome: 'success', ticketRef: 'INC-1042', whatif: false, details: { stage: 'Hard' } },
  { timestamp: _iso(3),   agent: 'leaver',   action: 'graph.user.revokeSessions',    subject: 'robert.martinez@contoso.onmicrosoft.com', operator: 'Nick', outcome: 'success', ticketRef: 'INC-1042', whatif: false, details: { sessions: 3 } },
  { timestamp: _iso(4),   agent: 'approver', action: 'approval.granted',             subject: 'robert.martinez@contoso.onmicrosoft.com', operator: 'Nick', outcome: 'success', ticketRef: 'INC-1042', whatif: false, details: { rule: 'dual-approval' } },
  { timestamp: _iso(4),   agent: 'approver', action: 'risk.scored',                  subject: 'robert.martinez@contoso.onmicrosoft.com', operator: 'Nick', outcome: 'success', ticketRef: 'INC-1042', whatif: false, details: { score: 68, grounded: true } },
  { timestamp: _iso(46),  agent: 'joiner',   action: 'graph.user.create',            subject: 'alex.nguyen@contoso.onmicrosoft.com',     operator: 'helpdesk1', outcome: 'success', ticketRef: 'INC-1025', whatif: false, details: {} },
  { timestamp: _iso(46),  agent: 'joiner',   action: 'license.assign',               subject: 'alex.nguyen@contoso.onmicrosoft.com',     operator: 'helpdesk1', outcome: 'success', ticketRef: 'INC-1025', whatif: false, details: { sku: 'Microsoft 365 E3' } },
  { timestamp: _iso(47),  agent: 'joiner',   action: 'graph.group.add',              subject: 'alex.nguyen@contoso.onmicrosoft.com',     operator: 'helpdesk1', outcome: 'success', ticketRef: 'INC-1025', whatif: false, details: { groups: 2 } },
  { timestamp: _iso(92),  agent: 'enroller', action: 'device.enroll',                subject: 'priya.shah@contoso.onmicrosoft.com',      operator: 'helpdesk2', outcome: 'success', ticketRef: 'INC-1009', whatif: false, details: {} },
  { timestamp: _iso(140), agent: 'mover',    action: 'graph.group.update',           subject: 'lena.fischer@contoso.onmicrosoft.com',    operator: 'Nick', outcome: 'partial', ticketRef: 'INC-1018', whatif: false, details: { pending: 2 } },
  { timestamp: _iso(168), agent: 'approver', action: 'risk.scored',                  subject: 'lena.fischer@contoso.onmicrosoft.com',    operator: 'Nick', outcome: 'success', ticketRef: 'INC-1018', whatif: false, details: { score: 41, grounded: true } },
  { timestamp: _iso(205), agent: 'leaver',   action: 'graph.user.disable',           subject: 'tom.becker@contoso.onmicrosoft.com',      operator: 'helpdesk1', outcome: 'success', ticketRef: 'INC-1002', whatif: false, details: { stage: 'Soft' } },
  { timestamp: _iso(206), agent: 'leaver',   action: 'license.remove',               subject: 'tom.becker@contoso.onmicrosoft.com',      operator: 'helpdesk1', outcome: 'success', ticketRef: 'INC-1002', whatif: false, details: { reclaimed: 1 } },
  { timestamp: _iso(280), agent: 'mover',    action: 'graph.user.update',            subject: 'omar.haddad@contoso.onmicrosoft.com',     operator: 'Nick', outcome: 'success', ticketRef: 'INC-0994', whatif: false, details: { field: 'department' } },
  { timestamp: _iso(355), agent: 'enroller', action: 'license.assign',               subject: 'grace.okafor@contoso.onmicrosoft.com',    operator: 'helpdesk2', outcome: 'success', ticketRef: 'INC-0988', whatif: false, details: { sku: 'Microsoft 365 E3' } },
  { timestamp: _iso(410), agent: 'auditor',  action: 'audit.write',                  subject: 'fleet integrity check',                   operator: 'system', outcome: 'success', ticketRef: '', whatif: false, details: {} },
  { timestamp: _iso(520), agent: 'certifier',action: 'review.campaign.start',        subject: 'Q2 access review · Finance',               operator: 'Nick', outcome: 'success', ticketRef: '', whatif: false, details: { scope: 'Finance-Admins' } },
  { timestamp: _iso(640), agent: 'provisioner', action: 'cert.rotate',               subject: 'jml-fleet-mover',                         operator: 'system', outcome: 'success', ticketRef: '', whatif: false, details: {} },
];
// Give the demo entries a coherent hash chain so the Chain Integrity panel shows
// a realistic, verifiable chain (newest-first: each entry's prevHash === the
// next/older entry's hash). Deterministic 64-hex synthesis — demo only.
(function chainMockAudit() {
  const synth = (s) => {
    let h = 0x811c9dc5 >>> 0, out = '';
    for (let k = 0; k < 64; k++) {
      h ^= (s.charCodeAt(k % s.length) || (k + 7));
      h = Math.imul(h, 0x01000193) >>> 0;
      out += ((h >>> (k % 24)) & 0xf).toString(16);
    }
    return out;
  };
  for (let i = MOCK_AUDIT.length - 1; i >= 0; i--) {
    const e = MOCK_AUDIT[i];
    e.prevHash = (i === MOCK_AUDIT.length - 1) ? '0'.repeat(64) : MOCK_AUDIT[i + 1].hash;
    e.hash = synth(e.timestamp + '|' + e.agent + '|' + e.action + '|' + e.subject + '|' + e.prevHash);
  }
})();
// HRIS inbound queue (dashboard "identity work origin" lane + Integrations tab)
const MOCK_HR = { queueDepth: 3, processing: 1, dlq: 0, events: [
  { eventType: 'employee.terminated', upn: 'robert.martinez@contoso.onmicrosoft.com', status: 'processed',  timestamp: _iso(4),  source: 'bamboohr', subject: 'robert.martinez@contoso.onmicrosoft.com', type: 'employee.terminated', agent: 'leaver' },
  { eventType: 'employee.hired',      upn: 'alex.nguyen@contoso.onmicrosoft.com',     status: 'processed',  timestamp: _iso(47), source: 'bamboohr', subject: 'alex.nguyen@contoso.onmicrosoft.com', type: 'employee.hired', agent: 'joiner' },
  { eventType: 'employee.transferred',upn: 'lena.fischer@contoso.onmicrosoft.com',    status: 'processing', timestamp: _iso(2),  source: 'workday',  subject: 'lena.fischer@contoso.onmicrosoft.com', type: 'employee.transferred', agent: 'mover' },
  { eventType: 'employee.hired',      upn: 'priya.shah@contoso.onmicrosoft.com',      status: 'queued',     timestamp: _iso(1),  source: 'bamboohr', subject: 'priya.shah@contoso.onmicrosoft.com', type: 'employee.hired', agent: 'joiner' },
]};
// Live operations (Glass Screen + dashboard Live Operations strip)
const _opIso = (s) => new Date(Date.now() - s * 1000).toISOString();
const MOCK_OPERATIONS = [
  { id: 'op-1042', agent: 'leaver',   toolName: 'submit_leaver_hard', stage: 'complete', subject: 'robert.martinez@contoso.onmicrosoft.com', status: 'succeeded', outcome: 'success', startedAt: _opIso(210), updatedAt: _opIso(180), completedAt: _opIso(180), details: { ticketRef: 'INC-1042' } },
  { id: 'op-1018', agent: 'mover',    toolName: 'submit_mover',       stage: 'execute',  subject: 'lena.fischer@contoso.onmicrosoft.com',    status: 'running',   outcome: null,      startedAt: _opIso(35),  updatedAt: _opIso(2),   details: { ticketRef: 'INC-1018' } },
  { id: 'op-1025', agent: 'joiner',   toolName: 'submit_joiner',      stage: 'complete', subject: 'alex.nguyen@contoso.onmicrosoft.com',     status: 'succeeded', outcome: 'success', startedAt: _opIso(2900),updatedAt: _opIso(2860),completedAt: _opIso(2860), details: { ticketRef: 'INC-1025' } },
];
// Operator roster for the demo: a clear admin account (plus helpdesk/viewer for
// RBAC realism). The demo boots as the admin so admin-level tasks are available.
const DEMO_ADMIN = 'admin@contoso.onmicrosoft.com';
const MOCK_OPERATORS = { operators: {
  [DEMO_ADMIN]:                              'admin',
  'demo.admin@contoso.onmicrosoft.com':      'admin',
  'grace.okafor@contoso.onmicrosoft.com':    'helpdesk',
  'omar.haddad@contoso.onmicrosoft.com':     'helpdesk',
  'dana.whitfield@contoso.onmicrosoft.com':  'viewer',
}, roles: {} };

function executeDemoTool(agent, toolName, input = {}, whatif = true) {
  const subject = operationSubject(input);

  if (toolName.startsWith('submit_')) {
    const receipt = demoReceipt(toolName, {
      subject,
      mode: whatif ? 'safe' : 'live',
      outcome: 'simulated',
      lines: [
        `[DEMO] ${toolName} simulated for ${subject}.`,
        '[DEMO] No Microsoft Graph or tenant write was attempted.',
      ],
      data: { subject, toolName, mode: whatif ? 'safe' : 'live' },
    });
    return receipt;
  }

  switch (toolName) {
    case 'lookup_user':
    case 'query_user_detail': {
      const q = String(input.upnOrName || input.userPrincipalName || '').toLowerCase();
      const user = MOCK_USERS.find((candidate) =>
        candidate.userPrincipalName.toLowerCase() === q
        || candidate.displayName.toLowerCase().includes(q),
      ) || MOCK_USERS[0];
      return { ...user, demo: true };
    }
    case 'list_available_licenses':
    case 'query_license_report':
      return { ...MOCK_DASHBOARD.licenses, demo: true };
    case 'list_groups':
      return {
        groups: [
          { displayName: 'Engineering-All', securityEnabled: true },
          { displayName: 'Finance-Admins', securityEnabled: true },
          { displayName: 'Platform-Leads', securityEnabled: true },
          { displayName: 'Sg1-users', securityEnabled: true },
        ],
        demo: true,
      };
    case 'suggest_provisioning':
      return {
        licenses: ['Microsoft 365 E5'],
        groups: ['Engineering-All'],
        rationale: 'Synthetic demo recommendation based on the seeded role profile.',
        demo: true,
      };
    case 'score_risk': {
      const result = {
        riskLevel: /leaver|hard/i.test(input.operation || '') ? 'high' : 'low',
        score: /leaver|hard/i.test(input.operation || '') ? 68 : 18,
        blocked: false,
        reasons: ['Synthetic demo policy evaluation'],
        grounding: {
          source: 'Foundry IQ',
          summary: 'Demo policy match: human approval and separation of duties are required before privileged execution.',
          citations: [
            { title: 'JML Offboarding Playbook', uri: 'demo://policy/offboarding' },
            { title: 'Separation of Duties Policy', uri: 'demo://policy/sod' },
          ],
        },
        demo: true,
      };
      state.approver.lastRisk = { ...result, ts: Date.now() };
      return result;
    }
    case 'query_recent_joins':
      return { users: MOCK_USERS.filter((user) => user.accountEnabled).slice(0, input.topN || 5), demo: true };
    case 'query_recent_leavers':
      return { users: MOCK_USERS.filter((user) => !user.accountEnabled).slice(0, input.topN || 5), demo: true };
    case 'query_hard_leavers':
      return { days: input.days || 30, count: 1, events: [
        { target: DEMO_ADMIN, time: _iso(72), outcome: 'success', operator: DEMO_ADMIN, licensesRemoved: ['Microsoft_Entra_Suite'], groupsRemoved: ['All Company'] },
      ], demo: true };
    case 'query_stale_accounts':
      return { accounts: MOCK_USERS.filter((user) => !user.accountEnabled), demo: true };
    case 'query_guest_users':
      return { users: [], demo: true };
    case 'query_member_users': {
      const users = MOCK_USERS
        .filter((user) => !input.enabledOnly || user.accountEnabled)
        .slice(0, input.topN || 20);
      return { enabledOnly: !!input.enabledOnly, count: users.length, users, demo: true };
    }
    case 'query_unlicensed_users': {
      const users = MOCK_USERS
        .filter((user) => !(user.assignedLicenses && user.assignedLicenses.length))
        .filter((user) => !input.enabledOnly || user.accountEnabled)
        .map((u) => ({ displayName: u.displayName, userPrincipalName: u.userPrincipalName, accountEnabled: u.accountEnabled }));
      return { enabledOnly: !!input.enabledOnly, count: users.length, users, demo: true };
    }
    case 'query_jml_activity':
      return { entries: MOCK_AUDIT.slice(0, input.topN || 5), demo: true };
    case 'query_admin_roles':
      return { roles: [{ displayName: 'Global Administrator', members: [DEMO_ADMIN] }], demo: true };
    case 'query_group_summary':
      return { total: 184, security: 126, microsoft365: 42, dynamic: 16, demo: true };
    case 'query_user_summary':
    default:
      return demoReceipt(toolName, {
        agent,
        result: { users: MOCK_DASHBOARD.users, licenses: MOCK_DASHBOARD.licenses },
      });
  }
}

function seedDemoData(w) {
  w.webContents.send('operators-data',    MOCK_OPERATORS);
  w.webContents.send('dashboard-stats',   MOCK_DASHBOARD);
  w.webContents.send('agent-health',      MOCK_AGENT_HEALTH);
  w.webContents.send('cert-expiry', { certs: MOCK_CERT_EXPIRY.map(c => ({ ...c, daysRemaining: c.daysLeft })) });
  w.webContents.send('pending-approvals', MOCK_APPROVALS);
  w.webContents.send('security-reports',  MOCK_SECURITY);
  w.webContents.send('audit-log-data',    MOCK_AUDIT);
  w.webContents.send('audit-chain-status', demoChainStatus());
  w.webContents.send('hr-queue',          MOCK_HR);
  w.webContents.send('operation-statuses', MOCK_OPERATIONS);
}
// Replace live IPC handlers with seed responders so tabs that fetch on demand
// (Users search, Security re-scan, Audit refresh, HR queue, live ops) never hit
// Graph/Azure in a demo.
function installDemoHandlers() {
  // Fail closed: these handlers seed mock data and (in capture) elevate the
  // session to admin. They must NEVER register on a normal production launch.
  if (!(PRESENTATION_MODE || DEMO_STATE_MODE || DEMO_DRIVE_MODE || HACKATHON_CAPTURE_MODE ||
        CAPTURE_MODE || CAPTURE_CHROME_MODE || GLASS_CAPTURE_MODE)) {
    console.warn('installDemoHandlers() called without a demo/capture flag — ignoring for safety.');
    return;
  }
  // Override every fetch the renderer makes on a timer or on tab-activation, so
  // the seed is never overwritten by an empty live response.
  for (const ch of ['search-users', 'get-security-reports', 'get-audit-log', 'get-hr-queue',
                    'get-operation-statuses', 'get-pending-approvals', 'get-dashboard-stats',
                    'get-agent-health', 'get-cert-expiry', 'get-operators']) ipcMain.removeAllListeners(ch);
  ipcMain.on('get-operators', (e) => e.sender.send('operators-data', MOCK_OPERATORS));
  ipcMain.on('search-users', (e, { query }) => {
    const q = (query || '').toLowerCase();
    const users = q ? MOCK_USERS.filter(u => (u.displayName + ' ' + u.userPrincipalName + ' ' + u.department).toLowerCase().includes(q)) : MOCK_USERS;
    e.sender.send('user-search-results', { users });
  });
  ipcMain.on('get-security-reports', (e) => e.sender.send('security-reports', MOCK_SECURITY));
  ipcMain.on('get-audit-log', (e) => { e.sender.send('audit-log-data', MOCK_AUDIT); e.sender.send('audit-chain-status', demoChainStatus()); });
  ipcMain.on('get-hr-queue', (e) => e.sender.send('hr-queue', MOCK_HR));
  ipcMain.on('get-operation-statuses', (e) => e.sender.send('operation-statuses', MOCK_OPERATIONS));
  ipcMain.on('get-pending-approvals', (e) => e.sender.send('pending-approvals', MOCK_APPROVALS));
  ipcMain.on('get-dashboard-stats', (e) => e.sender.send('dashboard-stats', MOCK_DASHBOARD));
  ipcMain.on('get-agent-health', (e) => e.sender.send('agent-health', MOCK_AGENT_HEALTH));
  ipcMain.on('get-cert-expiry', (e) => e.sender.send('cert-expiry', { certs: MOCK_CERT_EXPIRY.map(c => ({ ...c, daysRemaining: c.daysLeft })) }));
  // Invoke handlers (must remove the old handler before re-registering).
  ipcMain.removeHandler('get-operators-for-login');
  ipcMain.handle('get-operators-for-login', () => ({ operators: MOCK_OPERATORS.operators }));
  // Auto-pass the demo PIN gate without minting a production-capable token.
  // Mutating demo handlers recognize this marker and return simulated receipts.
  ipcMain.removeHandler('verify-operator-pin');
  ipcMain.handle('verify-operator-pin', () => ({
    ok: true,
    writeToken: 'demo-simulated-token',
    ttlMs: WRITE_TOKEN_TTL_MS,
    demo: true,
    committed: false,
  }));
  ipcMain.removeHandler('get-operator-auth');
  ipcMain.handle('get-operator-auth', () => {
    const out = {};
    for (const u of Object.keys(MOCK_OPERATORS.operators)) out[u] = { mode: 'pin', set: true };
    return out;
  });
  // Keep the session admin (the real handler reads the empty operators file and
  // would downgrade to viewer).
  ipcMain.removeHandler('get-current-operator');
  ipcMain.handle('get-current-operator', () => { currentRole = 'admin'; return { name: currentOperator, role: 'admin' }; });
}

// JS injected into renderer for tabs that show empty state by default
const TAB_INJECT = {
  'glass-screen': `(function(){ window.JmlGlassScreen?.captureState('running'); })();`,
  // Pre-submission "Input" state: keep the welcome panel + assist-bar, drop a
  // request into the composer, and highlight the matching operation chip.
  'jml-fleet-input': `
    (function(){
      const c = document.getElementById('messages-approver');
      // Reset to the welcome state so no transcript leaks into this capture.
      if (c) {
        c.innerHTML = \`
          <div class="welcome-msg">
            <div class="welcome-title">Approver Agent</div>
            <div class="welcome-body">Describe the identity change you need. I'll gather the required information, run risk scoring, and submit it for you under your operator token.</div>
            <div class="welcome-examples">
              <span class="example-chip">Onboard a new hire</span>
              <span class="example-chip">Move someone to a new department</span>
              <span class="example-chip">Offboard a leaver</span>
            </div>
          </div>
        \`;
      }
      const ia = document.getElementById('input-approver');
      if (ia) {
        ia.value = 'Offboard Robert Martinez — INC-1020, terminated yesterday. Soft stage first.';
        ia.focus();
      }
      // Mark the Soft Leave assist chip as the active intent.
      document.querySelectorAll('#approver-assist-bar .assist-chip').forEach(b => b.classList.remove('active'));
      const soft = Array.from(document.querySelectorAll('#approver-assist-bar .assist-chip'))
        .find(b => /Soft Leave/i.test(b.textContent));
      if (soft) soft.classList.add('active');
      window.__jmlSetApproverInputLifecycle?.();
    })();
  `,
  approver: `
    (function(){
      const c = document.getElementById('messages-approver');
      const ia = document.getElementById('input-approver');
      if (ia) ia.value = '';
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

// Capture the docked panel (full / sections-collapsed / slim) and the overlay
// as PII-safe demo screenshots for docs/images. Runs in demo mode so all data
// is mock (contoso). `electron . --capture-windows`.
async function runCaptureWindows() {
  const OUT = path.join(__dirname, '..', 'docs', 'images');
  fs.mkdirSync(OUT, { recursive: true });
  currentOperator = 'Demo Operator';
  const snap = async (w, name) => {
    if (!w || w.isDestroyed()) { console.error('window missing for', name); return; }
    await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))').catch(() => {});
    await sleep(400);
    let img; for (let a = 0; a < 3; a++) { try { img = await w.webContents.capturePage(); break; } catch { await sleep(400); } }
    if (img) { fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); console.log('Captured:', name); }
    else console.error('capturePage failed for', name);
  };

  // ── Docked panel ─────────────────────────────────────────────
  createDockedPanel();
  await new Promise(r => dockedWin.webContents.once('did-finish-load', r));
  pollTrayApprovals(); pushPanelUpdate({ approvals: 2, mode: 'safe' });
  await sleep(1200);
  await snap(dockedWin, 'docked-panel-full');

  // Sections collapsed (.section.collapsed hides each .section-body)
  await dockedWin.webContents.executeJavaScript(`
    document.querySelectorAll('.section').forEach(s => s.classList.add('collapsed'));
  `).catch(() => {});
  await sleep(500);
  await snap(dockedWin, 'docked-panel-collapsed');

  // Slim edge-tab (collapsed sidebar)
  await dockedWin.webContents.executeJavaScript(`document.body.classList.add('slim-mode');`).catch(() => {});
  await sleep(500);
  await snap(dockedWin, 'slim-hub');

  // ── Overlay ──────────────────────────────────────────────────
  createOverlayWindow();
  await new Promise(r => overlayWin.webContents.once('did-finish-load', r));
  pushOverlayUpdate({ approvals: 2, pendingList: MOCK_APPROVALS, mode: 'safe' });
  await sleep(1200);
  await snap(overlayWin, 'overlay-mode');

  await sleep(300);
  app.quit();
}

async function runCapture() {
  fs.mkdirSync(CAPTURE_OUT, { recursive: true });

  // Use a generic demo operator (never the real OS username) so captures never
  // leak a person's name in the "Continue as …" action.
  currentOperator = 'Demo Operator';
  process.env.JML_CONSOLE_OPERATOR = 'Demo Operator';
  installDemoHandlers();

  // ── Operator selector ──────────────────────────────────────────────────────
  createOperatorWindow();
  await new Promise(r => operatorWin.webContents.once('did-finish-load', r));
  // Always set the theme explicitly so the OOBE brand mark matches the capture
  // theme — otherwise a stale localStorage jmlTheme from a prior run leaks the
  // wrong logo (e.g. glass logo on a default-theme capture).
  const opTheme = (process.argv.find(a => a.startsWith('--theme=')) || '').split('=')[1] || '';
  await operatorWin.webContents.executeJavaScript(`
    try {
      if (${JSON.stringify(opTheme)}) { localStorage.setItem('jmlTheme', ${JSON.stringify(opTheme)}); document.documentElement.dataset.theme = ${JSON.stringify(opTheme)}; }
      else { localStorage.removeItem('jmlTheme'); delete document.documentElement.dataset.theme; }
    } catch (_) {}
  `).catch(() => {});
  await sleep(1000);
  // Redact any real operator UPN/domain shown in the local-operator list.
  await operatorWin.webContents.executeJavaScript(SANITIZE_TENANT).catch(() => {});
  let selImg; for (let a=0;a<3;a++){try{selImg=await operatorWin.webContents.capturePage();break;}catch(e){await sleep(600);}}
  if (selImg) fs.writeFileSync(path.join(CAPTURE_OUT, 'operator-select.png'), selImg.toPNG());
  console.log('Captured: operator-select');
  operatorWin.close(); operatorWin = null;

  // ── Main window (tall for full-page shots) ────────────────────────────────
  win = new BrowserWindow({
    width: 1440, height: 1800,
    frame: false,
    icon: APP_ICON,
    transparent: GLASS_CAPTURE_MODE,
    backgroundColor: GLASS_CAPTURE_MODE ? '#00000000' : '#11131a',
    ...(GLASS_CAPTURE_MODE ? { backgroundMaterial: 'mica' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  // Theme: honor `--theme=glass|preview` for clean per-theme screenshot sets;
  // default (no flag) captures the Warm theme. --glass-qc still forces glass.
  const _capTheme = (process.argv.find(a => a.startsWith('--theme=')) || '').split('=')[1]
    || (GLASS_CAPTURE_MODE ? 'glass' : '');
  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('jml-sidebar-collapsed', '0');
      document.querySelector('.layout')?.classList.remove('sidebar-collapsed');
      var th = ${JSON.stringify(_capTheme)};
      if (th) { localStorage.setItem('jmlTheme', th); document.documentElement.dataset.theme = th; }
      else { localStorage.removeItem('jmlTheme'); delete document.documentElement.dataset.theme; }
    } catch (_) {}
  `);
  await sleep(1200);

  // Full demo seed so EVERY tab is populated for screenshots (security, users,
  // audit, operators, HR queue, live ops) — not just dashboard/approvals.
  installDemoHandlers();
  seedDemoData(win);
  await sleep(400);

  // Remove overflow constraints so all content is visible in tall screenshots.
  // IMPORTANT: do NOT set height:auto on .content or .layout — those are flex/grid
  // shell containers and height:auto causes .view.active{flex:1} to collapse to 0.
  // Instead: (1) remove overflow clipping on shells, (2) expand the active view and
  // any tab-specific scroller directly.
  // Public-repo screenshot hygiene: replace the real tenant domain / operator
  // UPN with a neutral demo label everywhere it renders, so committed docs
  // images don't expose tenant topology. (SANITIZE_TENANT is module-scoped so
  // --demo-drive recordings get the same scrub.)

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
    ['glass-screen',   null, 1400],
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
    ['integrations',   null, 1500],
  ];

  // Capture the Approver agent in its INPUT state: the welcome panel, the
  // operation assist-bar, and a request typed into the composer but not yet
  // submitted. This is intentionally distinct from the `approver.png` capture
  // below, which shows the resulting conversation transcript.
  win.webContents.send('operator-switched', { name: DEMO_ADMIN, role: 'admin' });
  await sleep(150);
  const activeViewId = await win.webContents.executeJavaScript(`
    (function(){
      if (typeof switchTab === 'function') switchTab('approver');
      else document.querySelector('[data-tab="approver"]')?.click();
      return document.querySelector('.view.active')?.id || '';
    })()
  `);
  if (activeViewId !== 'view-approver') {
    throw new Error('JML input capture could not activate the Approver view');
  }
  try { await win.webContents.executeJavaScript(TAB_INJECT['jml-fleet-input']); } catch (_) {}
  await win.webContents.executeJavaScript(SANITIZE_TENANT);
  await sleep(900);
  {
    win.webContents.invalidate();
    await sleep(600);
    let img; for (let a=0;a<3;a++){try{img=await win.webContents.capturePage();break;}catch(e){await sleep(600);}}
    if (img) { fs.writeFileSync(path.join(CAPTURE_OUT, 'jml-fleet-input.png'), img.toPNG()); console.log('Captured: jml-fleet-input'); }
  }
  if (INPUT_CAPTURE_ONLY) {
    app.quit();
    return;
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
    await win.webContents.executeJavaScript(SANITIZE_TENANT);
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

// Public-repo hygiene: replace the real tenant domain / UPNs with a neutral
// demo label everywhere they render. Shared by --capture and --demo-drive.
const SANITIZE_TENANT = `
  (function(){
    var DEMO_DOMAIN = 'contoso.onmicrosoft.com';
    var FAKE_GUID   = '00000000-0000-0000-0000-000000000000';
    var FAKE_THUMB  = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0';
    function scrub(t){
      if (!t) return t;
      return String(t)
        // tenant/client/object id GUIDs
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, FAKE_GUID)
        // certificate thumbprints (SHA-1, 40 hex)
        .replace(/\\b[0-9A-Fa-f]{40}\\b/g, FAKE_THUMB)
        // real .onmicrosoft.com domains (keep any local-part of a UPN)
        .replace(/[a-z0-9.-]+\\.onmicrosoft\\.com/gi, function(m, off, s){
          var at = s.lastIndexOf('@', off);
          return DEMO_DOMAIN;
        });
    }
    document.querySelectorAll('*').forEach(function(el){
      if (el.children.length === 0 && el.textContent) {
        var s = scrub(el.textContent);
        if (s !== el.textContent) el.textContent = s;
      }
      // Tenant ID / Client ID / domain are rendered as input or textarea values.
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) {
        var v = scrub(el.value);
        if (v !== el.value) el.value = v;
      }
    });
    ['sidebar-tenant-domain','topbar-tenant-domain'].forEach(function(id){
      var el = document.getElementById(id);
      if (el && /onmicrosoft/i.test(el.textContent)) el.textContent = DEMO_DOMAIN;
    });
  })();
`;

// ── Demo drive (npm start -- --demo-drive) ────────────────────────────────────
// Records real, moving app-usage clips for the demo video: a scripted cursor
// glides/clicks through the UI, types into inputs, and each scene is captured
// to a webm via MediaRecorder on the app's own window. Output:
// ../.superpowers/jml-demo-video/public/clips/<scene>.webm

// ── Chrome capture (docked panel + overlay) for hackathon screenshots ─────────
async function runCaptureChrome() {
  currentOperator = DEMO_ADMIN; currentRole = 'admin'; process.env.JML_CONSOLE_OPERATOR = DEMO_ADMIN;
  installDemoHandlers();
  const OUT = path.join(__dirname, '..', 'docs', 'images');
  const glass = (w) => w.webContents.executeJavaScript(`try{localStorage.setItem('jmlTheme','glass');document.documentElement.dataset.theme='glass';}catch(_){}`);
  const shot = async (w, name) => {
    let img; for (let i = 0; i < 3; i++) { try { img = await w.webContents.capturePage(); break; } catch (e) { await sleep(500); } }
    if (img) fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('Captured:', name);
  };

  // Docked panel — expanded then slim
  createDockedPanel();
  await new Promise(r => dockedWin.webContents.once('did-finish-load', r));
  await glass(dockedWin); await sleep(500);
  pushPanelUpdate(buildMockPanelData()); await sleep(1300);
  await shot(dockedWin, 'docked-expanded.png');
  await dockedWin.webContents.executeJavaScript(`try{localStorage.setItem('jml-docked-slim','1');}catch(_){} document.body.classList.add('slim-mode','slim-right');`);
  dockedWin.setSize(200, 240); await sleep(1000);
  await shot(dockedWin, 'docked-slim.png');
  try { dockedWin.close(); } catch (_) {} dockedWin = null;

  // Overlay — active then idle
  createOverlayWindow();
  await new Promise(r => overlayWin.webContents.once('did-finish-load', r));
  await glass(overlayWin); await sleep(500);
  pushPanelUpdate(buildMockPanelData()); await sleep(1200);
  await shot(overlayWin, 'overlay-active.png');
  pushPanelUpdate({ approvals: 0, oldestApproval: null, pendingList: [], recentEvents: [], hrQueue: { count: 0, oldestMin: 0 } });
  await sleep(900);
  await shot(overlayWin, 'overlay-idle.png');
  try { overlayWin.close(); } catch (_) {} overlayWin = null;

  await sleep(400);
  console.log('CHROME CAPTURE COMPLETE');
  app.quit();
}

async function runDemoDrive() {
  const { desktopCapturer } = require('electron');
  const OUT = path.join(__dirname, '..', '.superpowers', 'jml-demo-video', 'public', 'clips');
  fs.mkdirSync(OUT, { recursive: true });
  currentOperator = 'Nick';
  process.env.JML_CONSOLE_OPERATOR = 'Nick';

  // Fill the primary display so a full-SCREEN capture == the app, full-bleed.
  // (Screen capture uses DXGI duplication, which is far more reliable than the
  // per-window WGC capturer that intermittently fails with E_INVALIDARG.)
  const _disp = screen.getPrimaryDisplay();
  const SW = _disp.size.width, SH = _disp.size.height;
  win = new BrowserWindow({
    width: SW, height: SH, x: 0, y: 0,
    frame: false, transparent: false, backgroundColor: '#070b13',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  win.show(); win.focus(); win.moveTop();
  win.setAlwaysOnTop(true);   // stay composited/foreground so WGC capture starts

  // Capture THIS WINDOW (not the screen): window capture records the app's own
  // surface regardless of what is layered on top, so a browser/other window in
  // front can never leak into the recording. The recStart retry handles the
  // occasional WGC cold-start failure.
  win.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['window'] });
    const me = sources.find(s => s.name && /JML/i.test(s.name)) || sources[0];
    callback({ video: me });
  }, { useSystemPicker: false });

  ipcMain.handle('demo-clip-save', (e, { name, buf }) => {
    fs.writeFileSync(path.join(OUT, `${name}.webm`), Buffer.from(buf));
    console.log('CLIP SAVED:', name);
    return true;
  });

  await win.webContents.executeJavaScript(`
    try { localStorage.setItem('jmlTheme','glass'); document.documentElement.dataset.theme='glass'; } catch(_){}
  `);
  installDemoHandlers();
  await sleep(1200);
  seedDemoData(win);
  await win.webContents.executeJavaScript(SANITIZE_TENANT);
  await sleep(400);

  // Inject the visible demo cursor + interaction driver.
  await win.webContents.executeJavaScript(`
    (() => {
      if (window.__drv) return;
      const cur = document.createElement('div');
      cur.id = 'demo-cursor';
      cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 2 L5 19 L9.6 15 L12.6 21.6 L15.4 20.3 L12.4 13.8 L19 13.4 Z" fill="#f4f8ff" stroke="#0a1018" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      cur.style.cssText = 'position:fixed;left:1200px;top:900px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 6px rgba(0,0,0,.6))';
      document.body.appendChild(cur);
      let cx = 1200, cy = 900;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const ease = t => t < .5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2;
      async function moveTo(x, y, ms) {
        const sx = cx, sy = cy, t0 = performance.now();
        return new Promise(res => {
          (function step(now) {
            const t = Math.min(1, (now - t0) / ms), e = ease(t);
            cx = sx + (x - sx) * e; cy = sy + (y - sy) * e - Math.sin(e * Math.PI) * 18;
            cur.style.left = cx + 'px'; cur.style.top = cy + 'px';
            if (t < 1) requestAnimationFrame(step); else res();
          })(t0);
        });
      }
      function ripple() {
        const r = document.createElement('div');
        r.style.cssText = 'position:fixed;left:'+cx+'px;top:'+cy+'px;width:12px;height:12px;border:2px solid #6fe3ff;border-radius:50%;z-index:2147483646;pointer-events:none;transform:translate(-50%,-50%);transition:all .55s ease-out;opacity:.95';
        document.body.appendChild(r);
        requestAnimationFrame(() => { r.style.transform = 'translate(-50%,-50%) scale(5)'; r.style.opacity = '0'; });
        setTimeout(() => r.remove(), 650);
      }
      async function clickEl(sel, ms = 700) {
        const el = document.querySelector(sel);
        if (!el) { console.warn('drv: missing', sel); return; }
        const b = el.getBoundingClientRect();
        await moveTo(b.left + b.width / 2, b.top + Math.min(b.height / 2, 30), ms);
        ripple(); await sleep(160); el.click();
      }
      async function hoverEl(sel, ms = 650) {
        const el = document.querySelector(sel);
        if (!el) { console.warn('drv: missing', sel); return; }
        const b = el.getBoundingClientRect();
        await moveTo(b.left + b.width / 2, b.top + b.height / 2, ms);
      }
      async function typeInto(sel, text, cps = 14) {
        const el = document.querySelector(sel);
        if (!el) { console.warn('drv: missing', sel); return; }
        const b = el.getBoundingClientRect();
        await moveTo(b.left + 30, b.top + b.height / 2, 600);
        ripple(); el.focus();
        for (const ch of text) {
          el.value += ch;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(1000 / cps + Math.random() * 40);
        }
      }
      async function scrollView(sel, dy, ms) {
        const el = document.querySelector(sel);
        if (!el) return;
        const start = el.scrollTop, t0 = performance.now();
        return new Promise(res => {
          (function step(now) {
            const t = Math.min(1, (now - t0) / ms);
            el.scrollTop = start + dy * ease(t);
            if (t < 1) requestAnimationFrame(step); else res();
          })(t0);
        });
      }
      let rec = null, chunks = [], stream = null;
      async function recStart() {
        if (!stream) {
          for (let i = 0; i < 4 && !stream; i++) {
            try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: 1920, height: 1080 }, audio: false }); }
            catch (e) { console.warn('getDisplayMedia retry', i, e.message); await sleep(900); }
          }
          if (!stream) throw new Error('screen capture failed after retries');
        }
        chunks = [];
        rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 12_000_000 });
        rec.ondataavailable = e => chunks.push(e.data);
        rec.start();
      }
      async function recStop(name) {
        await new Promise(res => { rec.onstop = res; rec.stop(); });
        const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
        await window.api.demoClipSave(name, new Uint8Array(buf));
      }
      window.__drv = { moveTo, clickEl, hoverEl, typeInto, scrollView, recStart, recStop, sleep };
    })();
  `);

  const run = (js) => win.webContents.executeJavaScript(`(async () => { const d = window.__drv; ${js} })()`);

  // Line-level choreography: every spoken line carries an action that fires the
  // instant that line begins, then we pad to the line's real audio length (+GAP)
  // so the recording tracks the voiceover word-for-word. Timings come straight
  // from scenes.json (written by generate-narration-lines.py).
  const GAP = 0.18, TAIL = 0.8;
  const sceneData = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '.superpowers', 'jml-demo-video', 'public', 'scenes.json'), 'utf8'));
  const byAct = (act) => sceneData.filter(s => s.act === act);

  const j = (v) => JSON.stringify(v);
  const actionJs = (a) => {
    switch (a.do) {
      case 'hover':  return `await d.hoverEl(${j(a.sel)}, 850);`;
      case 'click':  return `await d.clickEl(${j(a.sel)}, 850);`;
      case 'type':   return `await d.typeInto(${j(a.sel)}, ${j(a.text)}, 16);`;
      case 'search': return `await d.typeInto(${j(a.sel)}, ${j(a.text)}, 16); await d.sleep(350); await d.clickEl('#btn-user-search', 700);`;
      case 'scroll': return `await d.scrollView(${j(a.sel)}, ${a.dy || 320}, 1800);`;
      case 'replay': return `window.JmlGlassScreen?.captureState('replay'); await d.sleep(650); await d.clickEl('#gs-replay', 850);`;
      case 'approve_btn': return `{ const ap=[...document.querySelectorAll('#view-approvals button')].find(b=>/approve/i.test(b.textContent)); if(ap){const b=ap.getBoundingClientRect(); await d.moveTo(b.left+b.width/2, b.top+b.height/2, 950);} }`;
      default:       return `await d.sleep(120);`; // dwell
    }
  };

  async function playLine(line) {
    const t0 = Date.now();
    if (line.act && line.act.do === 'inject') {
      if (line.act.what === 'approver') await win.webContents.executeJavaScript(TAB_INJECT.approver);
    } else if (line.act) {
      await run(actionJs(line.act));
    }
    const left = (line.duration + GAP) * 1000 - (Date.now() - t0);
    if (left > 0) await sleep(left);
  }

  async function recordAct(act) {
    console.log('ACT', act);
    await run(`await d.recStart(); await d.sleep(400);`);
    const recStartWall = Date.now();   // t0 of the recording in wall-clock ms
    const timing = [];                 // real offset each line's action fires
    for (const scene of byAct(act)) {
      // re-assert on-demand seed data as we enter data tabs
      if (scene.id === 'security-evidence') win.webContents.send('security-reports', MOCK_SECURITY);
      if (scene.id === 'tamper-evident')   { win.webContents.send('audit-log-data', MOCK_AUDIT); win.webContents.send('audit-chain-status', demoChainStatus()); }
      for (let li = 0; li < scene.lines.length; li++) {
        timing.push({ scene: scene.id, line: li, offsetMs: Date.now() - recStartWall });
        await playLine(scene.lines[li]);
      }
      await sleep(TAIL * 1000);
      console.log('  scene done:', scene.id);
    }
    await run(`await d.recStop(${j(act)});`);
    // Real timing -> apply-timing.py aligns audio/captions to the footage exactly.
    fs.writeFileSync(path.join(OUT, `${act}.timing.json`), JSON.stringify(timing, null, 2));
    console.log('  timing saved:', act);
  }

  await recordAct('core');
  await recordAct('capabilities');

  await sleep(800);
  console.log('DEMO DRIVE COMPLETE');
  app.quit();
}

// ── Glass Screen state QC (npm start -- --gs-states) ─────────────────────────
// Renders every Command Center fixture state via JmlGlassScreen.captureState
// and saves review artifacts for the design acceptance gate. Review-only:
// output goes to .superpowers/glass-screen-qc/, never docs/images.
async function runGlassScreenQc() {
  const OUT = path.join(__dirname, '..', '.superpowers', 'glass-screen-qc');
  fs.mkdirSync(OUT, { recursive: true });
  currentOperator = 'Nick';
  process.env.JML_CONSOLE_OPERATOR = 'Nick';

  win = new BrowserWindow({
    width: 1440, height: 1000,
    frame: false,
    icon: APP_ICON,
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('jmlTheme', 'glass');
      document.documentElement.dataset.theme = 'glass';
      document.querySelector('[data-tab="glass-screen"]')?.click();
    } catch (_) {}
  `);
  await sleep(900);

  async function snap(name) {
    win.webContents.invalidate();
    await win.webContents.executeJavaScript(
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'
    );
    await sleep(350);
    let img;
    for (let a = 0; a < 3; a++) {
      try { img = await win.webContents.capturePage(); break; }
      catch { await sleep(500); }
    }
    if (img) { fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); console.log('Captured:', name); }
    else console.error('capturePage failed for', name);
  }

  const STATES = ['idle', 'running', 'awaiting-approval', 'failed', 'partial', 'success', 'replay'];
  for (const state of STATES) {
    await win.webContents.executeJavaScript(`window.JmlGlassScreen.captureState(${JSON.stringify(state)})`);
    // let one-shot settles finish so screenshots show the resting state
    await sleep(state === 'failed' ? 700 : 600);
    await snap(state);
  }

  // Deliberate replay in motion: capture mid-sequence
  await win.webContents.executeJavaScript(`
    window.JmlGlassScreen.captureState('replay');
    document.getElementById('gs-replay')?.click();
  `);
  await sleep(1400);
  await snap('replay-in-motion');

  // Details drawer open on the failed state
  await win.webContents.executeJavaScript(`
    window.JmlGlassScreen.captureState('failed');
    document.getElementById('gs-details')?.setAttribute('open', '');
  `);
  await sleep(700);
  await snap('failed-details-open');

  // Narrow-window layouts
  for (const [w, h] of [[1100, 800], [900, 760]]) {
    win.setSize(w, h, false);
    await win.webContents.executeJavaScript(`window.JmlGlassScreen.captureState('running')`);
    await sleep(700);
    await snap(`running-${w}x${h}`);
  }
  win.setSize(1440, 1000, false);

  // Reduced motion: emulate the media feature, state must appear immediately
  try {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await win.webContents.executeJavaScript(`window.JmlGlassScreen.captureState('running')`);
    await sleep(500);
    await snap('running-reduced-motion');
    win.webContents.debugger.detach();
  } catch (e) { console.error('Reduced-motion emulation failed:', e.message); }

  app.quit();
}

// ── First-run setup ───────────────────────────────────────────────────────────
ipcMain.handle('complete-first-run', (event, { winAuth, tenantId, primaryDomain, entraOperator } = {}) => {
  if (PRESENTATION_MODE) return demoReceipt('complete-first-run', { tenantId, primaryDomain });
  try {
    fs.writeFileSync(SETUP_FILE, JSON.stringify({
      firstRunComplete: true, completedAt: new Date().toISOString(), skipped: false
    }, null, 2), 'utf8');

    let opsData = {};
    try { opsData = readJson(OPERATORS_FILE); } catch {}
    if (!opsData.operators) opsData.operators = {};

    if (entraOperator && entraOperator.name) {
      const name = String(entraOperator.name).slice(0, 200);
      const role = ['admin', 'helpdesk', 'viewer'].includes(String(entraOperator.role || '').toLowerCase())
        ? String(entraOperator.role).toLowerCase()
        : 'viewer';
      if (!opsData.operators[name]) opsData.operators[name] = role;
      _verifiedRoles.set(name, role);
      if (entraOperator.displayName) _verifiedRoles.set(String(entraOperator.displayName).slice(0, 200), role);
      if (name.includes('@')) _verifiedRoles.set(name.split('@')[0], role);
      logOperatorActivity('first_run.entra_operator_registered', { target: name, role });
    }

    if (winAuth) {
      const username = os.userInfo().username;
      if (!opsData.operators[username]) opsData.operators[username] = 'admin';
      const authData = readOperatorAuth();
      if (!authData[username]) authData[username] = { mode: 'windows', updatedAt: new Date().toISOString() };
      writeOperatorAuth(authData);
    }
    if (Object.keys(opsData.operators).length) {
      fs.writeFileSync(OPERATORS_FILE, JSON.stringify(opsData, null, 2), 'utf8');
    }

    if (tenantId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      const domain = primaryDomain ? String(primaryDomain).slice(0, 200) : '';
      // Durable source of truth — persists even when no agent config.json exists.
      try { writeTenantConfig({ tenantId, primaryDomain: domain }); } catch {}
      // Mirror into any agent configs that already exist.
      for (const agent of AGENT_DIRS) {
        const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
        if (!fs.existsSync(cfgPath)) continue;
        try {
          const cfg = readJson(cfgPath);
          cfg.TenantId = tenantId;
          if (domain) cfg.PrimaryDomain = domain;
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
  if (PRESENTATION_MODE) return demoReceipt('skip-first-run');
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
  sentinel: { enabled: false, workspaceName: '', tableName: '' },
  splunk:   { enabled: false, hecEndpoint: '', index: '' },
  servicenow: { enabled: false, instanceUrl: '', table: 'incident' },
  jira:     { enabled: false, siteUrl: '', projectKey: '' }
};

ipcMain.handle('get-integrations-config', () => {
  if (PRESENTATION_MODE) {
    return {
      ok: true,
      demo: true,
      config: {
        bamboohr: { enabled: true, label: 'BambooHR demo webhook' },
        teams: { enabled: true, channel: 'Identity Operations', oncallHandle: 'IAM On Call' },
        sentinel: { enabled: true, workspaceName: 'jml-demo-workspace', tableName: 'JMLAudit_CL' },
        splunk: { enabled: true, hecEndpoint: 'https://splunk.example/services/collector', index: 'identity' },
        servicenow: { enabled: true, instanceUrl: 'https://example.service-now.com', table: 'incident' },
        jira: { enabled: true, siteUrl: 'https://example.atlassian.net', projectKey: 'IAM' },
      },
    };
  }
  try {
    if (!fs.existsSync(INT_CONFIG_FILE)) return { ok: true, config: INT_CONFIG_DEFAULTS };
    return { ok: true, config: readJson(INT_CONFIG_FILE) };
  } catch { return { ok: true, config: INT_CONFIG_DEFAULTS }; }
});

ipcMain.handle('save-integrations-config', (event, { config } = {}) => {
  if (PRESENTATION_MODE) return demoReceipt('save-integrations-config');
  if (currentRole !== 'admin') return { ok: false, error: 'admin role required' };
  const str = (v, max = 200) => typeof v === 'string' ? v.slice(0, max) : '';
  const c = config || {};
  const sanitized = {
    bamboohr: { enabled: !!(c.bamboohr && c.bamboohr.enabled), label: str(c.bamboohr && c.bamboohr.label) },
    teams:    { enabled: !!(c.teams && c.teams.enabled), channel: str(c.teams && c.teams.channel), oncallHandle: str(c.teams && c.teams.oncallHandle) },
    sentinel: { enabled: !!(c.sentinel && c.sentinel.enabled), workspaceName: str(c.sentinel && c.sentinel.workspaceName), tableName: str(c.sentinel && c.sentinel.tableName) },
    splunk:   { enabled: !!(c.splunk && c.splunk.enabled), hecEndpoint: str(c.splunk && c.splunk.hecEndpoint, 500), index: str(c.splunk && c.splunk.index, 80) },
    servicenow: { enabled: !!(c.servicenow && c.servicenow.enabled), instanceUrl: str(c.servicenow && c.servicenow.instanceUrl, 500), table: str(c.servicenow && c.servicenow.table, 80) || 'incident' },
    jira:     { enabled: !!(c.jira && c.jira.enabled), siteUrl: str(c.jira && c.jira.siteUrl, 500), projectKey: str(c.jira && c.jira.projectKey, 40) }
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
  if (process.argv.includes('--capture-windows')) { runCaptureWindows().catch(e => { console.error('Window capture error:', e); app.quit(); process.exitCode = 1; }); return; }
  if (GS_STATES_QC_MODE) { runGlassScreenQc().catch(e => { console.error('Glass QC error:', e); app.quit(); process.exitCode = 1; }); return; }
  if (CAPTURE_MODE) { runCapture().catch(e => { console.error('Capture error:', e); app.quit(); process.exitCode = 1; }); return; }
  if (DEMO_DRIVE_MODE) { runDemoDrive().catch(e => { console.error('Demo drive error:', e); app.quit(); process.exitCode = 1; }); return; }
  if (CAPTURE_CHROME_MODE) { runCaptureChrome().catch(e => { console.error('Chrome capture error:', e); app.quit(); process.exitCode = 1; }); return; }
  if (RENDER_DIAGRAM_MODE) {
    (async () => {
      const w = new BrowserWindow({ width: 1600, height: 900, show: false, backgroundColor: '#070b13', webPreferences: { offscreen: false } });
      await w.loadFile(path.join(__dirname, '..', 'docs', 'architecture.html'));
      await sleep(900);
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, '..', 'docs', 'images', 'JML AI Agent Architecture.png'), img.toPNG());
      console.log('DIAGRAM RENDERED');
      app.quit();
    })().catch(e => { console.error('Diagram render error:', e); app.quit(); process.exitCode = 1; });
    return;
  }
  if (DEMO_STATE_MODE) {
    // Interactive, fully-seeded demo: the normal app window populated with the
    // same fixture the recorder uses (users, security, audit, brain), so it can
    // be clicked through by hand to pilot or screenshot. No auto-drive.
    ensureDataDirs();
    currentOperator = DEMO_ADMIN;
    currentRole = 'admin';
    process.env.JML_CONSOLE_OPERATOR = DEMO_ADMIN;
    installDemoHandlers();
    createMainWindow();
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript(`try{localStorage.setItem('jmlTheme','glass');document.documentElement.dataset.theme='glass';}catch(_){}`);
      setTimeout(() => seedDemoData(win), 1200);
    });
    return;
  }
  createTray();
  ensureDataDirs();
  // QC bypass: `electron . --operator=Nick` skips the selector window so
  // automated visual checks can reach the main window directly.
  const opArg = process.argv.find(a => a.startsWith('--operator='));
  if (opArg) {
    const name = opArg.split('=')[1] || os.userInfo().username;
    currentOperator = name;
    try { currentRole = readJson(OPERATORS_FILE).operators?.[name] || 'admin'; } catch { currentRole = 'admin'; }
    process.env.JML_CONSOLE_OPERATOR = name;
    createMainWindow();
  } else if (isFirstRun()) { createSetupWindow(); } else { createOperatorWindow(); }

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

  setInterval(async () => {
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
          const _domain = getActiveTenantDomain();
          const _upn = payload.userPrincipalName
            || `${payload.givenName}.${payload.surname}@${_domain}`.toLowerCase().replace(/\s+/g, '');
          const _pf3 = writePayloadFile({
            givenName: payload.givenName, surname: payload.surname,
            userPrincipalName: _upn, department: payload.department,
            jobTitle: payload.jobTitle, usageLocation: payload.usageLocation, manager: payload.manager
          });
          try { raw = await runPsAsync(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: _pf3, WhatIf: w }); }
          finally { try { fs.unlinkSync(_pf3); } catch {} }
        } else if (opName === 'leaver') {
          const _stage = payload.stage || 'Soft';
          const _destructive = _stage === 'Hard' || _stage === 'Delete';
          const _schedRole = String(op.requestedByRole || 'viewer').toLowerCase();
          // A scheduled Hard/Delete offboard created by a non-admin must not
          // fire unattended — queue it for admin sign-off instead of executing.
          if (_destructive && _schedRole !== 'admin' && !w) {
            const _tok = routeBlockedLeaverToApproval(
              { userPrincipalName: payload.userPrincipalName, ticketRef: payload.ticketRef },
              _stage,
              `Scheduled ${_stage}-stage leaver created by ${op.requestedByRole || 'a non-admin operator'} — admin sign-off required before execution.`,
              'admin', op.requestedBy, op.requestedByRole);
            op.status = 'awaiting-approval';
            op.approvalToken = _tok;
            changed = true;
            if (win) win.webContents.send('scheduled-op-fired', op);
            continue;
          }
          raw = await runPsAsync(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
            UserPrincipalName: payload.userPrincipalName, Stage: _stage,
            TicketRef: payload.ticketRef, WhatIf: w, OperatorRole: op.requestedByRole
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
          try { raw = await runPsAsync(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: _pfMover, WhatIf: w }); }
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
app.on('will-quit', () => { globalShortcut.unregisterAll(); _graphSession?.dispose(); });

// ── Feature: User Lookup ──────────────────────────────────────────────────────
let _userSearchSeq = 0;
ipcMain.on('search-users', async (event, { query }) => {
  const seq = ++_userSearchSeq;
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const cfg = readJson(cfgPath);
    const ps = `
$q = '${query.replace(/'/g, "''")}'
$uri = "https://graph.microsoft.com/v1.0/users?\`$search=\`"displayName:$q\`" OR \`"userPrincipalName:$q\`"&\`$select=id,displayName,userPrincipalName,accountEnabled&\`$top=25&\`$count=true"
$resp = Invoke-MgGraphRequest -Method GET -Uri $uri -Headers @{'ConsistencyLevel'='eventual'} -ErrorAction Stop
if ($resp.value -and @($resp.value).Count -gt 0) { @($resp.value) | ConvertTo-Json -Depth 2 -Compress } else { '[]' }
`;
    const raw = (await runAuditorGraph(ps)).split(String.fromCharCode(0xFEFF)).join('');
    if (seq !== _userSearchSeq) return; // superseded by a newer keystroke
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
    if (seq !== _userSearchSeq) return;
    event.sender.send('user-search-results', { users: [], error: err.message });
  }
});

ipcMain.on('get-user-detail', async (event, { userId }) => {
  if (PRESENTATION_MODE) {
    const user = MOCK_USERS.find((candidate) => candidate.id === userId || candidate.userPrincipalName === userId)
      || MOCK_USERS[0];
    event.sender.send('user-detail', {
      user,
      licenses: user.assignedLicenses,
      groups: ['Engineering-All'],
      manager: { displayName: 'Demo Administrator', userPrincipalName: DEMO_ADMIN },
      demo: true,
    });
    return;
  }
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
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
    const raw = (await runAuditorGraph(ps)).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{') || l.startsWith('[')).slice(-1)[0] || '';
    let detail = {};
    try { if (jsonLine) detail = JSON.parse(jsonLine); } catch {}
    event.sender.send('user-detail', detail);
  } catch (err) {
    event.sender.send('user-detail', { error: err.message });
  }
});

// ── Feature: Quick Joiner ─────────────────────────────────────────────────────
ipcMain.on('run-quick-joiner', async (event, payload) => {
  if (PRESENTATION_MODE) {
    event.sender.send('quick-op-result', {
      type: 'joiner',
      lines: ['[DEMO] Joiner operation simulated. No tenant change was committed.'],
      data: demoReceipt('run-quick-joiner', { subject: [payload?.givenName, payload?.surname].filter(Boolean).join(' ') }),
    });
    return;
  }
  if (!requireWriteToken(event, payload, 'quick-op-result')) return;
  const { givenName, surname, department, jobTitle, usageLocation, manager, whatif } = payload || {};
  if (!givenName || !surname) {
    event.sender.send('quick-op-result', { type: 'joiner', lines: ['First and last name are required.'], data: null, error: true });
    return;
  }
  // UPN is auto-generated firstname.lastname@<tenant-domain>, matching the agent.
  const domain = getActiveTenantDomain();
  const userPrincipalName = `${givenName}.${surname}@${domain}`.toLowerCase().replace(/\s+/g, '');
  const pf = writePayloadFile({
    givenName, surname, userPrincipalName,
    department:    department    || null,
    jobTitle:      jobTitle      || null,
    usageLocation: usageLocation || 'US',
    manager:       manager       || null,
  });
  try {
    const raw    = await runPsAsync(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), { PayloadPath: pf, WhatIf: !!whatif });
    const result = parsePs1Output(raw);
    event.sender.send('quick-op-result', { type: 'joiner', lines: result.lines, data: result.data });
  } catch (err) {
    event.sender.send('quick-op-result', { type: 'joiner', lines: [err.message], data: null, error: true });
  } finally {
    try { fs.unlinkSync(pf); } catch {}
  }
});

// ── Feature: Quick Mover ──────────────────────────────────────────────────────
ipcMain.on('run-quick-mover', async (event, payload) => {
  if (PRESENTATION_MODE) {
    event.sender.send('quick-op-result', {
      type: 'mover',
      lines: ['[DEMO] Mover operation simulated. No tenant change was committed.'],
      data: demoReceipt('run-quick-mover', { subject: payload?.upn }),
    });
    return;
  }
  if (!requireWriteToken(event, payload, 'quick-op-result')) return;
  const { upn, newDepartment, newJobTitle, newManager, whatif } = payload || {};
  const pf = writePayloadFile({
    userPrincipalName: upn,
    department: newDepartment || null,
    jobTitle:   newJobTitle   || null,
    manager:    newManager    || null
  });
  try {
    const raw    = await runPsAsync(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), { PayloadPath: pf, WhatIf: !!whatif });
    const result = parsePs1Output(raw);
    event.sender.send('quick-op-result', { type: 'mover', lines: result.lines, data: result.data });
  } catch (err) {
    event.sender.send('quick-op-result', { type: 'mover', lines: [err.message], data: null, error: true });
  } finally {
    try { fs.unlinkSync(pf); } catch {}
  }
});

// ── Feature: Quick Leaver ─────────────────────────────────────────────────────
ipcMain.on('run-quick-leaver', async (event, payload) => {
  if (PRESENTATION_MODE) {
    event.sender.send('quick-op-result', {
      type: 'leaver',
      lines: ['[DEMO] Leaver operation simulated. No tenant change was committed.'],
      data: demoReceipt('run-quick-leaver', { subject: payload?.upn }),
    });
    return;
  }
  if (!requireWriteToken(event, payload, 'quick-op-result')) return;
  const { upn, stage, reason, whatif } = payload || {};
  const _stg = stage || 'Soft';
  // Destructive offboards (Hard / Both) require an admin's final say. A non-admin
  // running one in Live mode queues it for admin approval instead of executing.
  if (!whatif && (_stg === 'Hard' || _stg === 'Both' || _stg === 'Delete') && (currentRole || 'viewer').toLowerCase() !== 'admin') {
    const tok = routeBlockedLeaverToApproval(
      { userPrincipalName: upn, ticketRef: reason }, _stg,
      `${_stg}-stage leaver submitted by ${currentRole || 'operator'} — admin approval required before execution.`,
      'admin');
    event.sender.send('quick-op-result', { type: 'leaver', approvalQueued: true, token: tok,
      lines: [`[APPROVAL] ${_stg} offboard requires an admin's final approval — request queued for an admin operator.`] });
    return;
  }
  try {
    const raw    = await runPsAsync(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'), {
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
ipcMain.on('get-stale-accounts', async (event, { days }) => {
  if (PRESENTATION_MODE) {
    event.sender.send('stale-accounts', {
      accounts: MOCK_USERS.filter((user) => !user.accountEnabled).map((user) => ({
        id: user.id,
        displayName: user.displayName,
        upn: user.userPrincipalName,
        lastSignIn: user.signInActivity?.lastSignInDateTime || null,
      })),
      days: days || 90,
      demo: true,
    });
    return;
  }
  try {
    const script = path.join(AGENTS_DIR, 'auditor', 'Invoke-AuditorQuery.ps1');
    if (!fs.existsSync(script)) { event.sender.send('stale-accounts', { accounts: [], error: 'Auditor not configured' }); return; }
    const raw      = await runPsAsync(script, { QueryType: 'StaleAccounts', Days: days || 90, TopN: 100 });
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

ipcMain.on('disable-stale-accounts', async (event, { userIds }) => {
  if (PRESENTATION_MODE) {
    event.sender.send('stale-disable-result', {
      ...demoReceipt('disable-stale-accounts'),
      disabled: Array.isArray(userIds) ? userIds.length : 0,
    });
    return;
  }
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
    const raw = await runPsCommand(ps, { timeout: 120000 });
    const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    let result = { disabled: 0 };
    try { if (jsonLine) result = JSON.parse(jsonLine); } catch {}
    event.sender.send('stale-disable-result', { ok: true, disabled: result.disabled });
  } catch (err) {
    event.sender.send('stale-disable-result', { ok: false, error: err.message });
  }
});

// ── Feature: License Utilization ──────────────────────────────────────────────
ipcMain.on('get-license-utilization', async (event) => {
  if (PRESENTATION_MODE) {
    event.sender.send('license-utilization', {
      skus: MOCK_DASHBOARD.licenses.licenses.map((license) => ({
        ...license,
        available: license.total - license.assigned,
      })),
      demo: true,
    });
    return;
  }
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
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
    const raw = (await runAuditorGraph(ps)).split(String.fromCharCode(0xFEFF)).join('');
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
      // Use the SAME credential source + day math as get-agent-health so the
      // dashboard fleet tiles and this Agent Certs table never disagree.
      const credType = cfg.CertThumbprint ? 'certificate' : cfg.SecretExpiry ? 'secret' : 'unknown';
      const expiry   = credType === 'certificate' ? (cfg.CertExpiry || null) : (cfg.SecretExpiry || null);
      if (!cfg.CertThumbprint && !expiry) continue;
      let daysRemaining = null;
      if (expiry) {
        daysRemaining = Math.floor((new Date(expiry) - Date.now()) / 86400000);
      }
      results.push({
        agent:          agentName,
        credentialType: credType,
        thumbprint:     cfg.CertThumbprint || '',
        expiry:         expiry,
        daysRemaining:  daysRemaining
      });
    }
    event.sender.send('cert-expiry', { certs: results });
  } catch (err) {
    event.sender.send('cert-expiry', { certs: [], error: err.message });
  }
});

ipcMain.handle('rotate-agent-certificate', async (event, { agent, whatif } = {}) => {
  if (PRESENTATION_MODE) {
    return demoReceipt('rotate-agent-certificate', {
      agent: agent || 'all',
      whatif: !!whatif,
      note: 'Provisioner rotation simulated.',
    });
  }
  if ((currentRole || 'viewer') !== 'admin') return { ok: false, error: 'admin role required' };
  const script = path.join(AGENTS_DIR, 'provisioner', 'New-AgentCertificates.ps1');
  if (!fs.existsSync(script)) return { ok: false, error: 'Provisioner certificate script not found.' };
  try {
    const raw = await runPsAsync(script, whatif ? { WhatIf: true } : {});
    logOperatorActivity('cert.rotation.queued', { target: agent || 'all', whatif: !!whatif });
    return { ok: true, agent: agent || 'all', whatif: !!whatif, lines: stripAnsi(raw).trim().split('\n').filter(Boolean).slice(-12) };
  } catch (err) {
    const detail = stripAnsi((err && (err.stdout || err.message)) || String(err))
      .trim().split('\n').filter(Boolean).slice(-3).join(' ');
    return { ok: false, error: detail || 'rotation failed' };
  }
});

// ── Feature: SoD Conflict Tester ─────────────────────────────────────────────
ipcMain.on('test-sod-conflict', async (event, { groupA, groupB, upn }) => {
  if (PRESENTATION_MODE) {
    const conflict = /finance|payroll/i.test(`${groupA} ${groupB}`);
    event.sender.send('sod-result', {
      conflict,
      userPrincipalName: upn,
      groups: [groupA, groupB],
      reason: conflict ? 'Synthetic separation-of-duties conflict' : 'No seeded conflict',
      demo: true,
    });
    return;
  }
  try {
    const script = path.join(AGENTS_DIR, 'shared', 'Invoke-SoDCheck.ps1');
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
$result = & '${script.replace(/\\/g, '\\\\')}' -UserPrincipalName '${(upn || 'test@test.com').replace(/'/g, "''")}' -IncomingGroups @('${groupA.replace(/'/g, "''")}','${groupB.replace(/'/g, "''")}')
$result | ConvertTo-Json -Depth 3 -Compress
`;
    const raw = (await runAuditorGraph(ps)).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).slice(-1)[0];
    let result = {};
    try { if (jsonLine) result = JSON.parse(jsonLine); } catch {}
    event.sender.send('sod-result', result);
  } catch (err) {
    event.sender.send('sod-result', { error: err.message });
  }
});

// ── Feature: Graph Query Runner ───────────────────────────────────────────────
ipcMain.on('run-graph-query', async (event, payload) => {
  try {
    const { method, url, body } = payload || {};
    const verb = String(method || 'GET').toUpperCase();
    if (!url) { event.sender.send('graph-query-result', { ok: false, error: 'Graph URL is required' }); return; }
    if (PRESENTATION_MODE) {
      event.sender.send('graph-query-result', {
        ...demoReceipt('run-graph-query', {
          method: verb,
          url,
          result: verb === 'GET'
            ? { value: MOCK_USERS.slice(0, 5) }
            : { requestBody: body || null },
        }),
      });
      return;
    }
    if (/^(POST|PATCH|DELETE)$/.test(verb) && !requireWriteToken(event, payload, 'graph-query-result')) return;
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const safeUrl  = url.replace(/'/g, "''");
    const safeBody = body ? JSON.stringify(body) : '';
    const bodyBlock = (verb === 'POST' || verb === 'PATCH') && safeBody
      ? `-Body ('${safeBody.replace(/'/g, "''")}' | ConvertFrom-Json)`
      : '';
    const ps = `
$resp = Invoke-GraphWithRetry -Method ${verb} -Uri '${safeUrl}' ${bodyBlock}
$resp | ConvertTo-Json -Depth 6 -Compress
`;
    const raw = (await runAuditorGraph(ps)).split(String.fromCharCode(0xFEFF)).join('');
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
ipcMain.on('get-pim-roles', async (event) => {
  if (PRESENTATION_MODE) {
    event.sender.send('pim-roles', {
      ok: true,
      demo: true,
      roles: [
        { roleDefinitionId: 'demo-global-reader', roleName: 'Global Reader', status: 'Eligible', expiry: null },
        { roleDefinitionId: 'demo-user-admin', roleName: 'User Administrator', status: 'Active', expiry: new Date(Date.now() + 3600000).toISOString() },
      ],
    });
    return;
  }
  try {
    const cfgPath = path.join(AGENTS_DIR, 'auditor', 'config.json');
    const ps = `
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
    const raw = (await runAuditorGraph(ps)).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).slice(-1)[0];
    let data = { ok: false, roles: [] };
    try { if (jsonLine) data = JSON.parse(jsonLine); } catch {}
    event.sender.send('pim-roles', data);
  } catch (err) {
    event.sender.send('pim-roles', { ok: false, roles: [], error: err.message });
  }
});

ipcMain.on('activate-pim-role', async (event, { roleDefinitionId, justification, durationHours }) => {
  if (PRESENTATION_MODE) {
    event.sender.send('pim-activate-result', demoReceipt('activate-pim-role', {
      roleDefinitionId,
      justification,
      durationHours,
    }));
    return;
  }
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
    const raw = (await runPsCommand(ps)).split(String.fromCharCode(0xFEFF)).join('');
    const jsonLine = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).slice(-1)[0];
    let result = { ok: false };
    try { if (jsonLine) result = JSON.parse(jsonLine); } catch {}
    event.sender.send('pim-activate-result', result);
  } catch (err) {
    event.sender.send('pim-activate-result', { ok: false, error: err.message });
  }
});

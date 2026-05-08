'use strict';

const Anthropic        = require('@anthropic-ai/sdk');
const readline         = require('readline');
const { execFileSync } = require('child_process');
const path             = require('path');
const fs               = require('fs');
const chalk            = require('chalk');
const ora              = require('ora');
const boxen            = require('boxen');
const crypto           = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────────────
// When running as pkg exe: execPath = agents/approver/dist/JML-Approver.exe
//   APPROVER_DIR = agents/approver  (one level up from dist/)
//   AGENTS_DIR   = agents/          (two levels up from dist/)
const APPROVER_DIR = process.pkg
  ? path.resolve(path.dirname(process.execPath), '..')
  : __dirname;

const AGENTS_DIR = process.pkg
  ? path.resolve(path.dirname(process.execPath), '..', '..')
  : path.resolve(__dirname, '..');

const APPROVE_TOKEN = (process.argv.find(a => a.startsWith('--approve=')) || '').replace('--approve=', '');
const WHATIF        = process.argv.includes('--whatif') || process.argv.includes('-WhatIf');
const TENANT_DOMAIN = 'contoso.onmicrosoft.com';
const PENDING_DIR   = path.join(APPROVER_DIR, 'pending');

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are the Approver Agent for a JML (Joiner, Mover, Leaver) identity lifecycle management system.
You are the intelligent gatekeeper for identity change requests in Microsoft Entra ID.

Your responsibilities:
1. Interpret operator requests in natural language - they may be vague or partial
2. Identify the type of request: Joiner, Mover, Leaver, or Enroller
3. Gather all required information - ask for missing details clearly and conversationally
4. Confirm the full details with the operator before submitting
5. Call the appropriate tool once all required fields are confirmed

--- JOINER (new hire account creation) ---
Required: givenName, surname, userPrincipalName, department, jobTitle, usageLocation
Optional: manager (UPN), licenses (array of SKU part numbers), groups (array of group display names), mobilePhone, officeLocation
Notes:
- userPrincipalName MUST follow the format: firstname.lastname@${TENANT_DOMAIN}
  All lowercase, no spaces. e.g. "John Smith" -> john.smith@${TENANT_DOMAIN}
  Auto-generate this from givenName and surname if the operator does not provide it.
  Confirm the generated UPN with the operator before submitting.
- usageLocation is a 2-letter ISO country code (e.g. "US", "GB", "CA")
- Common license SKUs in this tenant: Microsoft_Entra_Suite, INTUNE_D

--- ENROLLER (post-join device/license enrollment) ---
Required: userPrincipalName
Optional: licenses (array of SKU part numbers), groups (array of group display names)
Notes: Run after a Joiner completes. Verifies account is active, assigns enrollment licenses, adds to enrollment groups, and inventories Azure AD registered devices.

--- MOVER (role/department change) ---
Required: userPrincipalName
At least one change must be specified: newDepartment, newJobTitle, newManager, licensesToAdd, licensesToRemove, groupsToAdd, groupsToRemove

--- LEAVER (offboarding) ---
Required: userPrincipalName, ticketRef (incident/change ticket number, e.g. INC-1234 or CHG-5678)
This is a two-stage process. Stage 1 (Soft) disables the account and revokes sessions. Stage 2 (Hard) removes licenses and group memberships. Always confirm the UPN carefully before submitting - offboarding cannot be undone automatically.
Notes:
- ticketRef is MANDATORY for all leavers — always ask for it before submitting
- Never submit a leaver without a ticket reference

Rules:
- Never invent or guess values - ask if unsure
- Always confirm the full set of details before submitting
- If the operator is missing critical info, list exactly what is needed
- Keep responses concise and professional
`.trim();

// ── Tool definitions ──────────────────────────────────────────────────────────
const tools = [
  {
    name: 'submit_joiner',
    description: 'Submit a complete, validated joiner request. Only call this once all required fields are confirmed with the operator.',
    input_schema: {
      type: 'object',
      properties: {
        givenName:         { type: 'string' },
        surname:           { type: 'string' },
        userPrincipalName: { type: 'string' },
        department:        { type: 'string' },
        jobTitle:          { type: 'string' },
        usageLocation:     { type: 'string', description: '2-letter ISO country code' },
        manager:           { type: 'string', description: 'Manager UPN (optional)' },
        licenses:          { type: 'array', items: { type: 'string' } },
        groups:            { type: 'array', items: { type: 'string' } },
        mobilePhone:       { type: 'string' },
        officeLocation:    { type: 'string' },
        ticketRef:         { type: 'string', description: 'Optional HR request or ticket reference (e.g. HR-1234)' }
      },
      required: ['givenName', 'surname', 'userPrincipalName', 'department', 'jobTitle', 'usageLocation']
    }
  },
  {
    name: 'submit_enroller',
    description: 'Submit an enrollment request for a user who has already been joined.',
    input_schema: {
      type: 'object',
      properties: {
        userPrincipalName: { type: 'string' },
        licenses:  { type: 'array', items: { type: 'string' } },
        groups:    { type: 'array', items: { type: 'string' } },
        ticketRef: { type: 'string', description: 'Optional ticket reference' }
      },
      required: ['userPrincipalName']
    }
  },
  {
    name: 'submit_mover',
    description: 'Submit a complete mover request for a user changing role, department, or access.',
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
        groupsToRemove:    { type: 'array', items: { type: 'string' } },
        ticketRef:         { type: 'string', description: 'Recommended: change/ticket reference (e.g. CHG-5678)' }
      },
      required: ['userPrincipalName']
    }
  },
  {
    name: 'submit_leaver',
    description: 'Submit a leaver offboarding request. Requires a ticket reference. This triggers a two-stage process - confirm both UPN and ticket carefully.',
    input_schema: {
      type: 'object',
      properties: {
        userPrincipalName: { type: 'string' },
        ticketRef:         { type: 'string', description: 'Incident or change ticket reference (e.g. INC-1234). REQUIRED for audit compliance.' }
      },
      required: ['userPrincipalName', 'ticketRef']
    }
  }
];

// ── UI helpers ────────────────────────────────────────────────────────────────
function printBanner() {
  const modeLabel = WHATIF
    ? chalk.black.bgYellow(' WHATIF — No changes will be made ')
    : chalk.black.bgRed(' LIVE — Actions execute against the directory ');
  console.log(boxen(
    chalk.bold.cyan('JML Approver Agent') + '\n' +
    chalk.dim('Tenant: ' + TENANT_DOMAIN) + '\n\n' +
    modeLabel,
    { padding: 1, margin: { top: 1, bottom: 0 }, borderStyle: 'round', borderColor: WHATIF ? 'yellow' : 'red' }
  ));
  console.log(chalk.dim("  Type 'exit' to quit.\n"));
}

function printModeReminder() {
  if (WHATIF) {
    console.log(chalk.bgYellow.black(' WHATIF ') + chalk.yellow(' No directory changes will be committed.\n'));
  } else {
    console.log(chalk.bgRed.white(' LIVE ') + chalk.red(' This will make real changes to the directory.\n'));
  }
}

function printAgentText(text) {
  console.log('');
  text.split('\n').forEach(line => console.log(chalk.white('  ' + line)));
}

function printDispatchHeader(name, input) {
  const labels = {
    submit_joiner:   chalk.green('  ● CREATE  '),
    submit_leaver:   chalk.red('  ● OFFBOARD'),
    submit_mover:    chalk.yellow('  ● MOVE    '),
    submit_enroller: chalk.blue('  ● ENROLL  ')
  };
  const label   = labels[name] || chalk.cyan('  ● ' + name.toUpperCase());
  const subject = chalk.bold(input.userPrincipalName || '');
  console.log('\n' + label + '  ' + subject);
}

function printPsOutput(output) {
  const lines = output.split('\n');
  let hasOutput = false;
  lines.forEach(line => {
    const m = line.match(/\[\d{2}:\d{2}:\d{2}\]\s+\[(\w+)\]\s+(.*)/);
    if (!m) return;
    const [, status, msg] = m;
    if (status === 'ACTION') { console.log(chalk.green('  ✔ ' + msg)); hasOutput = true; }
    else if (status === 'ERROR')  { console.log(chalk.red('  ✖ ' + msg));    hasOutput = true; }
    else if (status === 'WARN')   { console.log(chalk.yellow('  ⚠ ' + msg)); hasOutput = true; }
    else if (status === 'WHATIF') { console.log(chalk.cyan('  ~ ' + msg));   hasOutput = true; }
  });
  if (!hasOutput) {
    const last = lines.filter(l => l.trim()).pop() || '';
    if (last) console.log(chalk.dim('  ' + last));
  }
}

function printError(msg)   { console.log('\n' + chalk.red('  ✖ ') + chalk.red(msg)); }
function printWarning(msg) { console.log(chalk.yellow('  ⚠ ' + msg)); }
function printSuccess(msg) { console.log(chalk.green('  ✔ ' + msg)); }
function printInfo(msg)    { console.log(chalk.dim('  ' + msg)); }

// ── Risk-01: Mode reinforcement ───────────────────────────────────────────────
function dispatchModeWarning() {
  if (WHATIF) {
    console.log('\n' + boxen(
      chalk.yellow('WHATIF MODE — no tenant changes will occur'),
      { padding: { left: 2, right: 2, top: 0, bottom: 0 }, borderColor: 'yellow', borderStyle: 'classic' }
    ));
  }
}

// ── Risk-05: Operator auth + role-based access ────────────────────────────────
let _operatorRole = null;

function checkOperatorAuth() {
  const opsPath = path.join(APPROVER_DIR, 'operators.json');
  if (!fs.existsSync(opsPath)) return;
  try {
    const ops     = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
    const current = (process.env.USERNAME || '').toLowerCase();

    // Support both old allowedOperators format and new role-based format
    if (ops.allowedOperators) {
      const allowed = ops.allowedOperators.map(u => u.toLowerCase());
      if (allowed.length > 0 && !allowed.includes(current)) {
        console.error(boxen(chalk.red('Access denied.\n') + chalk.dim(`"${current}" is not an authorised operator.`),
          { padding: 1, borderColor: 'red', borderStyle: 'round' }));
        process.exit(1);
      }
      _operatorRole = 'admin';
    } else if (ops.operators) {
      const role = ops.operators[current];
      if (!role) {
        console.error(boxen(chalk.red('Access denied.\n') + chalk.dim(`"${current}" is not an authorised operator.`),
          { padding: 1, borderColor: 'red', borderStyle: 'round' }));
        process.exit(1);
      }
      _operatorRole = role;
    }
  } catch {}
}

function checkOperatorPermission(toolName) {
  if (!_operatorRole) return; // no role system configured
  const opsPath = path.join(APPROVER_DIR, 'operators.json');
  if (!fs.existsSync(opsPath)) return;
  try {
    const ops         = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
    const allowedTools = (ops.roles || {})[_operatorRole] || [];
    if (!allowedTools.includes(toolName)) {
      throw new Error(`Your role "${_operatorRole}" does not have permission to execute "${toolName}". Contact an admin.`);
    }
  } catch (err) {
    if (err.message.includes('does not have permission')) throw err;
  }
}

// ── Freeze window check ───────────────────────────────────────────────────────
function checkFreezeWindow() {
  const polPath = path.join(APPROVER_DIR, 'policies.json');
  if (!fs.existsSync(polPath)) return;
  try {
    const pol     = JSON.parse(fs.readFileSync(polPath, 'utf8'));
    const windows = pol.freezeWindows || [];
    const now     = new Date();
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
    const hhmm    = now.getHours() * 100 + now.getMinutes();

    for (const w of windows) {
      const days = w.days || [];
      if (!days.includes(dayName)) continue;
      if (w.allDay) {
        throw new Error(`Freeze window active: "${w.name}" — ${w.message}`);
      }
      if (w.start && w.end) {
        const [sh, sm] = w.start.split(':').map(Number);
        const [eh, em] = w.end.split(':').map(Number);
        const start = sh * 100 + sm;
        const end   = eh * 100 + em;
        const inWindow = start <= end ? (hhmm >= start && hhmm < end) : (hhmm >= start || hhmm < end);
        if (inWindow) throw new Error(`Freeze window active: "${w.name}" — ${w.message}`);
      }
    }
  } catch (err) {
    if (err.message.includes('Freeze window')) throw err;
  }
}

// ── Risk-06: Policy check ─────────────────────────────────────────────────────
function checkPolicies(toolName, input) {
  const polPath = path.join(APPROVER_DIR, 'policies.json');
  if (!fs.existsSync(polPath)) return [];
  const warnings = [];
  try {
    const pol = JSON.parse(fs.readFileSync(polPath, 'utf8'));
    const sensLic   = pol.sensitiveLicenses || [];
    const sensGroup = pol.sensitiveGroups   || [];

    const licenses = [
      ...(input.licenses        || []),
      ...(input.licensesToAdd   || [])
    ];
    const groups = [
      ...(input.groups          || []),
      ...(input.groupsToAdd     || [])
    ];

    licenses.forEach(l => {
      if (sensLic.map(s => s.toLowerCase()).includes(l.toLowerCase())) {
        warnings.push(`Sensitive license flagged by policy: ${l}`);
      }
    });
    groups.forEach(g => {
      if (sensGroup.map(s => s.toLowerCase()).includes(g.toLowerCase())) {
        warnings.push(`Sensitive group flagged by policy: ${g}`);
      }
    });
  } catch {}
  return warnings;
}

// ── Risk-02: Input validation via Graph ───────────────────────────────────────
function runValidation(toolName, input) {
  const validateScript = path.join(APPROVER_DIR, 'Invoke-ValidateInputs.ps1');
  if (!fs.existsSync(validateScript)) return null;

  const payload = { ...input };
  if (['submit_leaver', 'submit_mover', 'submit_enroller'].includes(toolName)) {
    payload.validateSubjectExists = true;
  }

  try {
    const raw = execFileSync('powershell',
      ['-NonInteractive', '-File', validateScript, '-PayloadJson', JSON.stringify(payload)],
      { encoding: 'utf8', timeout: 30000 }
    );
    const lines = raw.trim().split('\n');
    const jsonLine = lines.filter(l => l.trim().startsWith('{')).pop();
    return jsonLine ? JSON.parse(jsonLine) : null;
  } catch {
    return null;
  }
}

// ── Risk-03: Dual approval ────────────────────────────────────────────────────
function requiresDualApproval(toolName) {
  const polPath = path.join(APPROVER_DIR, 'policies.json');
  if (!fs.existsSync(polPath)) return false;
  try {
    const pol = JSON.parse(fs.readFileSync(polPath, 'utf8'));
    return (pol.requireDualApproval || []).includes(toolName);
  } catch { return false; }
}

function generateToken() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
}

function savePending(token, toolName, input) {
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
  const pending = {
    token,
    created:   new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    tool:      toolName,
    input,
    requestedBy: (process.env.USERNAME || 'unknown')
  };
  fs.writeFileSync(path.join(PENDING_DIR, token + '.json'), JSON.stringify(pending, null, 2));
  return pending;
}

function loadPending(token) {
  const file = path.join(PENDING_DIR, token.toUpperCase() + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (new Date(p.expiresAt) < new Date()) return null; // expired
    return p;
  } catch { return null; }
}

function deletePending(token) {
  try { fs.unlinkSync(path.join(PENDING_DIR, token.toUpperCase() + '.json')); } catch {}
}

// ── PS execution ──────────────────────────────────────────────────────────────
function runPs(scriptPath, args) {
  try {
    return execFileSync('powershell', ['-NonInteractive', '-File', scriptPath, ...args],
      { encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '');
  }
}

function dispatchTool(name, input, extraArgs = []) {
  const whatifFlag = WHATIF ? ['-WhatIf'] : [];

  if (name === 'submit_joiner') {
    const p = path.join(AGENTS_DIR, 'joiner', 'approver-payload.json');
    fs.writeFileSync(p, JSON.stringify(input, null, 2));
    return runPs(path.join(AGENTS_DIR, 'joiner', 'Invoke-JoinerProcess.ps1'), ['-PayloadPath', p, ...whatifFlag]);
  }
  if (name === 'submit_leaver') {
    const stage      = extraArgs.find(a => a.startsWith('-Stage')) ? extraArgs : ['-Stage', extraArgs[0] || 'Both'];
    const ticketArgs = input.ticketRef ? ['-TicketRef', input.ticketRef] : [];
    return runPs(path.join(AGENTS_DIR, 'leaver', 'Invoke-LeaverProcess.ps1'),
      ['-UserPrincipalName', input.userPrincipalName, ...stage, ...ticketArgs, ...whatifFlag]);
  }
  if (name === 'submit_enroller') {
    const p = path.join(AGENTS_DIR, 'enroller', 'approver-payload.json');
    fs.writeFileSync(p, JSON.stringify(input, null, 2));
    return runPs(path.join(AGENTS_DIR, 'enroller', 'Invoke-EnrollerProcess.ps1'), ['-PayloadPath', p, ...whatifFlag]);
  }
  if (name === 'submit_mover') {
    const payload = { userPrincipalName: input.userPrincipalName };
    if (input.newDepartment)    payload.department       = input.newDepartment;
    if (input.newJobTitle)      payload.jobTitle         = input.newJobTitle;
    if (input.newManager)       payload.manager          = input.newManager;
    if (input.licensesToAdd)    payload.licensesToAdd    = input.licensesToAdd;
    if (input.licensesToRemove) payload.licensesToRemove = input.licensesToRemove;
    if (input.groupsToAdd)      payload.groupsToAdd      = input.groupsToAdd;
    if (input.groupsToRemove)   payload.groupsToRemove   = input.groupsToRemove;
    const p = path.join(AGENTS_DIR, 'mover', 'approver-payload.json');
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
    return runPs(path.join(AGENTS_DIR, 'mover', 'Invoke-MoverProcess.ps1'), ['-PayloadPath', p, ...whatifFlag]);
  }
  return `Unknown tool: ${name}`;
}

// ── Audit log ─────────────────────────────────────────────────────────────────
function appendAuditLog(entry) {
  try {
    fs.appendFileSync(
      path.join(AGENTS_DIR, 'audit.jsonl'),
      JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'
    );
  } catch {}
}

// ── Risk-01: Credential expiry ─────────────────────────────────────────────────
function checkCredentialExpiry() {
  const warnDays = 60;
  const now = new Date();
  ['joiner', 'mover', 'leaver', 'enroller', 'approver', 'provisioner'].forEach(dir => {
    const cfgPath = path.join(AGENTS_DIR, dir, 'config.json');
    if (!fs.existsSync(cfgPath)) return;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.SecretExpiry) {
        const daysLeft = Math.ceil((new Date(cfg.SecretExpiry) - now) / 86400000);
        if (daysLeft <= warnDays) printWarning(`${cfg.AppName} secret expires ${cfg.SecretExpiry} (${daysLeft} days)`);
      }
    } catch {}
  });
}

function validateUPN(upn) {
  if (!upn) return null;
  if (!upn.toLowerCase().endsWith('@' + TENANT_DOMAIN.toLowerCase()))
    return `UPN "${upn}" must end with @${TENANT_DOMAIN}`;
  return null;
}

// ── --approve mode (Risk-03 second approver) ──────────────────────────────────
async function runApproveMode(token) {
  console.log(boxen(chalk.bold.cyan('JML Approver') + '  ' + chalk.yellow('DUAL APPROVAL'),
    { padding: 1, borderStyle: 'round', borderColor: 'yellow', margin: { top: 1, bottom: 0 } }));

  const pending = loadPending(token);
  if (!pending) {
    printError(`Token ${token} not found or expired. Pending approvals expire after 30 minutes.`);
    process.exit(1);
  }

  console.log('\n' + chalk.bold('  Pending request:'));
  console.log(chalk.dim('  Requested by : ') + pending.requestedBy);
  console.log(chalk.dim('  Operation    : ') + chalk.yellow(pending.tool.replace('submit_', '').toUpperCase()));
  console.log(chalk.dim('  Subject      : ') + chalk.bold(pending.input.userPrincipalName));
  console.log(chalk.dim('  Created      : ') + pending.created);
  console.log('');

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    const confirm = await ask(chalk.yellow('  Approve this operation? Type YES to confirm: '));
    if (confirm.trim().toUpperCase() !== 'YES') {
      printInfo('Approval declined. Request remains pending.');
      rl.close();
      process.exit(0);
    }

    const spinner = ora({ color: 'cyan' });
    printDispatchHeader(pending.tool, pending.input);

    // Risk-04: Leaver gets staged even in approval mode
    if (pending.tool === 'submit_leaver') {
      spinner.text = chalk.dim('Stage 1 — disabling account...');
      spinner.start();
      const s1 = dispatchTool('submit_leaver', pending.input, ['-Stage', 'Soft']);
      spinner.stop();
      printPsOutput(s1);
      dispatchModeWarning();

      console.log('\n' + chalk.yellow('  Stage 1 complete. Proceed with license and group removal?'));
      console.log(chalk.red('  ⚠ This step is irreversible.'));
      const s2confirm = await ask(chalk.yellow('  Type YES for full offboard or anything else to stop: '));
      if (s2confirm.trim().toUpperCase() === 'YES') {
        spinner.text = chalk.dim('Stage 2 — removing licenses and groups...');
        spinner.start();
        const s2 = dispatchTool('submit_leaver', pending.input, ['-Stage', 'Hard']);
        spinner.stop();
        printPsOutput(s2);
        dispatchModeWarning();
      } else {
        printInfo('Stopped after Stage 1. Licenses and group memberships retained.');
      }
    } else {
      spinner.text = chalk.dim('Running...');
      spinner.start();
      const output = dispatchTool(pending.tool, pending.input);
      spinner.stop();
      printPsOutput(output);
      dispatchModeWarning();
    }

    appendAuditLog({ source: 'approver-dual', tool: pending.tool, subject: pending.input.userPrincipalName, whatif: WHATIF, outcome: 'approved', approvedBy: process.env.USERNAME });
    deletePending(token);
    printSuccess('Request completed.');
  } finally {
    rl.close();
  }
}

// ── Main conversational loop ──────────────────────────────────────────────────
async function main() {
  // Risk-05: operator auth
  checkOperatorAuth();

  // --approve mode
  if (APPROVE_TOKEN) {
    await runApproveMode(APPROVE_TOKEN);
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('ERROR: ANTHROPIC_API_KEY environment variable not set.'));
    process.exit(1);
  }

  const client   = new Anthropic.default({ apiKey });
  const messages = [];

  printBanner();
  checkCredentialExpiry();

  const sessionId         = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionStart      = new Date().toISOString();
  const sessionDispatches = [];

  const rl      = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask     = (q) => new Promise(resolve => rl.question(q, resolve));
  const spinner = ora({ color: 'cyan' });

  try {
    while (true) {
      let userInput;
      try { userInput = await ask(chalk.cyan('Operator') + chalk.dim(' ❯ ')); }
      catch { break; }

      userInput = userInput.trim();
      if (!userInput) continue;
      if (['exit', 'quit', 'q'].includes(userInput.toLowerCase())) break;

      messages.push({ role: 'user', content: userInput });

      try {
        while (true) {
          spinner.text = chalk.dim('Thinking...');
          spinner.start();
          const response = await client.messages.create({
            model: 'claude-sonnet-4-6', max_tokens: 2048,
            system: SYSTEM_PROMPT, tools, messages
          });
          spinner.stop();

          const textBlocks = response.content.filter(b => b.type === 'text');
          const toolUses   = response.content.filter(b => b.type === 'tool_use');

          if (textBlocks.length > 0) printAgentText(textBlocks.map(b => b.text).join('\n'));

          messages.push({ role: 'assistant', content: response.content });
          if (toolUses.length === 0) break;

          const toolResults = [];

          for (const tu of toolUses) {
            // Risk-03 UPN validation
            let blocked = false;
            for (const field of ['userPrincipalName', 'manager', 'newManager']) {
              if (tu.input[field]) {
                const err = validateUPN(tu.input[field]);
                if (err) {
                  printError(err);
                  toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Blocked: ${err}` });
                  blocked = true; break;
                }
              }
            }
            if (blocked) continue;

            printDispatchHeader(tu.name, tu.input);

            // Role-based access control
            try { checkOperatorPermission(tu.name); } catch (err) {
              printError(err.message);
              toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Blocked: ' + err.message });
              continue;
            }

            // Freeze window check
            try { checkFreezeWindow(); } catch (err) {
              printWarning(err.message);
              toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Blocked: ' + err.message });
              continue;
            }

            // Risk-02: Input validation
            spinner.text = chalk.dim('Validating inputs...');
            spinner.start();
            const validation = runValidation(tu.name, tu.input);
            spinner.stop();

            if (validation) {
              if (validation.errors && validation.errors.length > 0) {
                validation.errors.forEach(e => printError(e));
                printError('Submission blocked due to validation errors.');
                toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Blocked by validation: ${validation.errors.join('; ')}` });
                continue;
              }
              if (validation.warnings && validation.warnings.length > 0) {
                validation.warnings.forEach(w => printWarning(w));
              }
              if (validation.resolved) {
                Object.entries(validation.resolved).forEach(([k, v]) => printInfo(`Resolved ${k}: ${v}`));
              }
            }

            // Risk-06: Policy check
            const policyWarnings = checkPolicies(tu.name, tu.input);
            policyWarnings.forEach(w => printWarning('[POLICY] ' + w));

            // Risk-01: Mode reminder at dispatch time
            console.log('');
            printModeReminder();

            // Risk-03: Dual approval for sensitive operations
            if (!WHATIF && requiresDualApproval(tu.name)) {
              const token = generateToken();
              savePending(token, tu.name, tu.input);
              console.log(boxen(
                chalk.bold('Dual approval required\n\n') +
                chalk.dim('Approval token: ') + chalk.bold.yellow(token) + '\n\n' +
                chalk.dim('A second approver must run:\n') +
                chalk.cyan(`  JML-Approver.exe --approve=${token}`) + '\n\n' +
                chalk.dim('Token expires in 30 minutes.'),
                { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
              ));
              appendAuditLog({ source: 'approver', tool: tu.name, subject: tu.input.userPrincipalName, whatif: false, outcome: 'pending-dual-approval', token });
              toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Pending dual approval. Token: ${token}. A second approver must run JML-Approver.exe --approve=${token}` });
              continue;
            }

            // Risk-04: Staged leaver
            if (tu.name === 'submit_leaver') {
              // Live mode confirmation
              if (!WHATIF) {
                const liveConfirm = await ask(chalk.red('  Type YES to begin offboarding or anything else to cancel: '));
                if (liveConfirm.trim().toUpperCase() !== 'YES') {
                  printInfo('Cancelled.');
                  toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Cancelled by operator.' });
                  continue;
                }
              }

              // Stage 1
              console.log(chalk.dim('\n  Stage 1/2 — disabling account and revoking sessions...'));
              spinner.text = chalk.dim('Running stage 1...');
              spinner.start();
              const s1out = dispatchTool('submit_leaver', tu.input, ['-Stage', 'Soft']);
              spinner.stop();
              printPsOutput(s1out);
              dispatchModeWarning();

              // Prompt for stage 2
              console.log('\n' + chalk.yellow('  Stage 1 complete — account disabled, sessions revoked.'));
              console.log(chalk.red('  ⚠ Stage 2 will remove all licenses and group memberships. This cannot be auto-reversed.'));
              const s2ans = await ask(chalk.yellow('  Proceed with full offboard? Type YES or NO: '));

              let s2out = '';
              if (s2ans.trim().toUpperCase() === 'YES') {
                console.log(chalk.dim('\n  Stage 2/2 — removing licenses and groups...'));
                spinner.text = chalk.dim('Running stage 2...');
                spinner.start();
                s2out = dispatchTool('submit_leaver', tu.input, ['-Stage', 'Hard']);
                spinner.stop();
                printPsOutput(s2out);
                dispatchModeWarning();
                printSuccess('Full offboard complete.');
              } else {
                printInfo('Stopped after Stage 1. Licenses and groups retained. Re-run to complete when ready.');
              }

              sessionDispatches.push({ tool: tu.name, input: tu.input, timestamp: new Date().toISOString(), whatif: WHATIF });
              appendAuditLog({ source: 'approver', tool: tu.name, subject: tu.input.userPrincipalName, whatif: WHATIF, outcome: 'dispatched', stage: s2ans.trim().toUpperCase() === 'YES' ? 'both' : 'soft-only' });
              toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: s1out + '\n' + s2out });
              continue;
            }

            // Standard operations — live confirmation
            if (!WHATIF) {
              const confirm = await ask(chalk.yellow('  Type YES to confirm or anything else to cancel: '));
              if (confirm.trim().toUpperCase() !== 'YES') {
                printInfo('Cancelled.');
                toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Cancelled by operator.' });
                continue;
              }
            }

            spinner.text = chalk.dim('Running...');
            spinner.start();
            const output = dispatchTool(tu.name, tu.input);
            spinner.stop();
            printPsOutput(output);
            dispatchModeWarning();

            sessionDispatches.push({ tool: tu.name, input: tu.input, timestamp: new Date().toISOString(), whatif: WHATIF });
            appendAuditLog({ source: 'approver', tool: tu.name, subject: tu.input.userPrincipalName, whatif: WHATIF, outcome: 'dispatched' });
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
          }

          messages.push({ role: 'user', content: toolResults });
        }
      } catch (apiErr) {
        spinner.stop();
        printError(apiErr.message || String(apiErr));
        messages.pop();
      }

      if (messages.length > 30) messages.splice(0, messages.length - 30);
    }
  } finally {
    rl.close();
  }

  // Session summary
  console.log('\n' + chalk.dim('─'.repeat(50)));
  if (sessionDispatches.length > 0) printSuccess(`${sessionDispatches.length} dispatch(es) this session`);

  try {
    const sessionsDir = path.join(APPROVER_DIR, 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    const sf = path.join(sessionsDir, sessionId + '.json');
    fs.writeFileSync(sf, JSON.stringify({
      sessionId, startTime: sessionStart, endTime: new Date().toISOString(),
      whatif: WHATIF, tenant: TENANT_DOMAIN,
      operator: process.env.USERNAME || 'unknown',
      turnCount: messages.length, dispatches: sessionDispatches
    }, null, 2));
    printInfo('Session log: ' + sf);
  } catch {}

  console.log(chalk.dim('Session ended.'));
}

main().catch(err => {
  console.error(chalk.red('Fatal: ' + (err.message || err)));
  process.exit(1);
});

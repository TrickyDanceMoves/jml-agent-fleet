'use strict';

// Locks the device-lifecycle toolset + the live Identity Protection path.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const agentsRoot = path.join(root, '..');

test('PowerShell device scripts exist (read + action)', () => {
  assert.ok(fs.existsSync(path.join(agentsRoot, 'auditor', 'Invoke-DeviceQuery.ps1')), 'device read script');
  assert.ok(fs.existsSync(path.join(agentsRoot, 'enroller', 'Invoke-DeviceAction.ps1')), 'device action script');
});

test('device read tools are advertised to both agents and dispatched shared', () => {
  const auditor = main.match(/const AUDITOR_TOOLS = \[[\s\S]*?\n\];/)[0];
  for (const t of ['list_user_devices', 'query_device_detail', 'query_stale_devices']) {
    assert.match(auditor, new RegExp("name: '" + t + "'"), `missing read tool ${t}`);
  }
  assert.match(main, /const DEVICE_READ_TOOLS = \{/);
  assert.match(main, /Invoke-DeviceQuery\.ps1/);
  const fn = main.match(/async function executeTool\([\s\S]*?if \(agent === 'auditor'\)/)[0];
  assert.match(fn, /DEVICE_READ_TOOLS\[toolName\]/);
  assert.match(fn, /return await deviceReadQuery\(toolName, input/);
});

test('manage_device is an approver-only write tool with RBAC-gated destructive actions', () => {
  const approver = main.match(/const APPROVER_TOOLS = \[[\s\S]*?\n\];/)[0];
  assert.match(approver, /name: 'manage_device'/);
  // Auditor must NOT have the write tool.
  const auditor = main.match(/const AUDITOR_TOOLS = \[[\s\S]*?\n\];/)[0];
  assert.ok(!/manage_device/.test(auditor), 'auditor stays read-only');
  // Code-enforced RBAC + two-person rule: read-only roles blocked; irreversible
  // wipe/delete from the agent always queue for a second admin (no self-auth).
  assert.match(main, /toolName === 'manage_device'/);
  assert.match(main, /device management requires a helpdesk or admin account/);
  assert.match(main, /const IRREVERSIBLE_DEVICE_ACTIONS = new Set\(\['wipe', 'delete'\]\)/);
  assert.match(main, /IRREVERSIBLE_DEVICE_ACTIONS\.has\(action\)[\s\S]*?routeDeviceActionToApproval/);
  assert.match(main, /Invoke-DeviceAction\.ps1/);
});

test('irreversible actions require an admin: admin runs directly, non-admin queues', () => {
  // Approve path can execute approved device actions.
  assert.match(main, /tool === 'manage_device'[\s\S]*?Invoke-DeviceAction\.ps1/);
  // Device IPC: admin executes directly; non-admin queues for an admin.
  assert.match(main, /IRREVERSIBLE_DEVICE_ACTIONS\.has\(act\) && role !== 'admin'/);
  // No mandatory two-person / break-glass override anymore.
  assert.ok(!/security\.override/.test(main), 'override path removed');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.ok(!/destructiveChoice|dd-override/.test(app), 'UI override path removed');
  assert.match(app, /approvalQueued/);
});

test('live Identity Protection path exists and the posture tools expose live', () => {
  assert.match(main, /async function liveRiskyUsersGraph\(\)/);
  assert.match(main, /async function liveSigninDetectionsGraph\(\)/);
  assert.match(main, /identityProtection\/riskyUsers/);
  assert.match(main, /identityProtection\/riskDetections/);
  // Tool schemas advertise live; the query honors it.
  assert.match(main, /live: \{ type: 'boolean'/);
  assert.match(main, /const live = !!input\.live/);
});

test('demo mode answers the new device tools', () => {
  const fn = main.match(/function executeDemoTool\([\s\S]*?\n\}/)[0];
  for (const t of ['list_user_devices', 'query_device_detail', 'query_stale_devices', 'manage_device']) {
    assert.match(fn, new RegExp("case '" + t + "'"), `demo case missing for ${t}`);
  }
  assert.match(main, /const MOCK_DEVICES = \[/);
});

test('Devices tab is wired end to end (UI + preload + main IPC)', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  // Nav + view + key controls (single search/ask bar).
  assert.match(html, /data-tab="devices"/);
  assert.match(html, /id="view-devices"/);
  assert.match(html, /class="dev-bar"/);
  assert.match(html, /id="dev-ask-input"/);
  assert.match(html, /id="btn-dev-stale"/);
  assert.match(html, /id="dev-summary"/);
  // AI-assisted search (Graph autocomplete) + per-card Safe mode (not on the bar).
  assert.match(app, /setupUserAutocomplete\(askInput/);
  assert.match(app, /dev-card-whatif/);
  assert.ok(!/id="dev-whatif"/.test(html), 'global Safe toggle moved off the search bar');
  assert.match(html, /id="dev-assist-note"/);
  // Renderer registration + module.
  assert.match(app, /devices: 'Devices'/);
  assert.match(app, /TABS_WITH_MODE = new Set\(\[[^\]]*'devices'/);
  assert.match(app, /function initDevicesTab\(\)/);
  assert.match(app, /window\.api\.deviceAction\(/);
  // Scoped assistant answers device questions in place and refers out otherwise.
  assert.match(app, /function handleDeviceAsk\(text\)/);
  assert.match(app, /I only answer device questions here/);
  assert.match(app, /Open Approver agent/);
  // Richer cards: More menu + new lifecycle actions + summary.
  assert.match(app, /class="dev-more"/);
  assert.match(app, /mi\('restart'/);
  assert.match(app, /mi\('lock'/);
  assert.match(app, /mi\('bitlocker'/);
  assert.match(app, /mi\('rename'/);
  assert.match(app, /function renderSummary/);
  // New actions reach the backend (tool enum + action script).
  assert.match(main, /'restart', 'lock', 'bitlocker'/);
  const ps = fs.readFileSync(path.join(agentsRoot, 'enroller', 'Invoke-DeviceAction.ps1'), 'utf8');
  assert.match(ps, /rebootNow/);
  assert.match(ps, /remoteLock/);
  assert.match(ps, /rotateBitLockerKeys/);
  // No colourful emoji icons left on the tab - OS icons are inline SVGs.
  assert.match(app, /function osIcon\(os\)[\s\S]*?<svg/);
  assert.ok(!/['"`]🪟|🧨|🧹|📋/.test(app), 'no emoji glyphs in the devices module');
  // Preload bridges.
  assert.match(preload, /getUserDevices:[\s\S]*?invoke\('get-user-devices'/);
  assert.match(preload, /deviceAction:[\s\S]*?invoke\('device-action'/);
  // Main IPC handlers + RBAC on the write path.
  assert.match(main, /ipcMain\.handle\('get-user-devices'/);
  assert.match(main, /ipcMain\.handle\('device-action'/);
  assert.match(main, /Device management requires a helpdesk or admin account/);
  assert.match(main, /PIN verification required for Live device actions/);
});

test('user profile has a Devices jump that opens the tab for that user', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.match(html, /id="udp-btn-devices"/);
  assert.match(app, /window\.JmlDevices\s*=\s*\{/);
  assert.match(app, /openForUser\(upn\)/);
  assert.match(app, /switchTab\('devices'\)[\s\S]*?JmlDevices\?\.openForUser\(_selectedUser\.upn\)/);
});

test('both prompts describe device capabilities', () => {
  const auditor = main.match(/function buildAuditorSystem\([\s\S]*?\.trim\(\); \}/)[0];
  const approver = main.match(/function buildApproverSystem\([\s\S]*?\.trim\(\); \}/)[0];
  assert.match(auditor, /list_user_devices/);
  assert.match(approver, /manage_device/);
  assert.match(approver, /require[s]? an admin/i);
});

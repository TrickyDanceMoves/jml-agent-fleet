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
  // Code-enforced RBAC: read-only roles blocked, wipe/delete require admin.
  assert.match(main, /toolName === 'manage_device'/);
  assert.match(main, /device management requires a helpdesk or admin account/);
  assert.match(main, /action === 'wipe' \|\| action === 'delete'\) && role !== 'admin'/);
  assert.match(main, /Invoke-DeviceAction\.ps1/);
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

test('both prompts describe device capabilities', () => {
  const auditor = main.match(/function buildAuditorSystem\([\s\S]*?\.trim\(\); \}/)[0];
  const approver = main.match(/function buildApproverSystem\([\s\S]*?\.trim\(\); \}/)[0];
  assert.match(auditor, /list_user_devices/);
  assert.match(approver, /manage_device/);
  assert.match(approver, /destructive and irreversible/i);
});

'use strict';

// Locks the chat agents' security-posture toolset. The auditor/approver must be
// able to answer "any risky users or anomalous sign-ins?" from the same security
// scan the Security tab uses — not decline for lack of tools.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const POSTURE = ['query_risky_users', 'query_signin_anomalies', 'query_config_drift', 'query_security_posture'];

test('auditor toolset advertises the four security-posture tools', () => {
  const block = main.match(/const AUDITOR_TOOLS = \[[\s\S]*?\n\];/);
  assert.ok(block, 'AUDITOR_TOOLS must exist');
  for (const t of POSTURE) assert.match(block[0], new RegExp("name: '" + t + "'"), `missing tool ${t}`);
});

test('approver inherits the posture tools (push excludes only query_user_detail)', () => {
  assert.match(main, /APPROVER_TOOLS\.push\(\.\.\.AUDITOR_TOOLS\.filter\(t => t\.name !== 'query_user_detail'\)\)/);
});

test('posture tools are executed by a shared read path before the agent branches', () => {
  assert.match(main, /const SECURITY_POSTURE_TOOLS = new Set\(\[/);
  assert.match(main, /async function securityPostureQuery\(toolName, input/);
  assert.match(main, /function latestSecurityReport\(prefix\)/);
  // The shared dispatch must sit inside executeTool ahead of the auditor branch.
  const fn = main.match(/async function executeTool\([\s\S]*?if \(agent === 'auditor'\)/);
  assert.ok(fn, 'executeTool prelude must exist');
  assert.match(fn[0], /SECURITY_POSTURE_TOOLS\.has\(toolName\)/);
  assert.match(fn[0], /return await securityPostureQuery\(toolName, input/);
});

test('each posture tool reads the matching scan report', () => {
  assert.match(main, /latestSecurityReport\('risky-users-'\)/);
  assert.match(main, /latestSecurityReport\('ueba-'\)/);
  assert.match(main, /latestSecurityReport\('drift-'\)/);
});

test('demo mode answers the posture tools from MOCK_SECURITY', () => {
  const fn = main.match(/function executeDemoTool\([\s\S]*?\n\}/);
  assert.ok(fn, 'executeDemoTool must exist');
  for (const t of POSTURE) assert.match(fn[0], new RegExp("case '" + t + "'"), `demo case missing for ${t}`);
});

test('both system prompts tell the agents they can report security risk', () => {
  const auditor = main.match(/function buildAuditorSystem\([\s\S]*?\.trim\(\); \}/);
  const approver = main.match(/function buildApproverSystem\([\s\S]*?\.trim\(\); \}/);
  assert.ok(auditor && approver);
  assert.match(auditor[0], /query_risky_users/);
  assert.match(auditor[0], /never claim you lack access to risky users/i);
  assert.match(approver[0], /query_security_posture/);
});

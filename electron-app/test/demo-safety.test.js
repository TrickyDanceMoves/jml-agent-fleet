'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DemoWriteBlockedError,
  assertExternalExecutionAllowed,
  demoReceipt,
  isDemoMode,
} = require('../lib/demo-safety');

test('recognizes every seeded presentation mode as demo mode', () => {
  assert.equal(isDemoMode(['electron', '.', '--demo']), true);
  assert.equal(isDemoMode(['electron', '.', '--demo-drive']), true);
  assert.equal(isDemoMode(['electron', '.', '--hackathon-capture']), true);
  assert.equal(isDemoMode(['electron', '.', '--capture']), false);
  assert.equal(isDemoMode(['electron', '.']), false);
});

test('blocks external execution before a demo child process can start', () => {
  assert.throws(
    () => assertExternalExecutionAllowed(true, 'PowerShell agent execution'),
    (error) => {
      assert.ok(error instanceof DemoWriteBlockedError);
      assert.equal(error.code, 'DEMO_WRITE_BLOCKED');
      assert.match(error.message, /PowerShell agent execution/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertExternalExecutionAllowed(false, 'normal execution'));
});

test('simulated receipts can never claim a committed tenant change', () => {
  const receipt = demoReceipt('submit_joiner', {
    subject: 'alex.nguyen@contoso.onmicrosoft.com',
    committed: true,
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.demo, true);
  assert.equal(receipt.simulated, true);
  assert.equal(receipt.committed, false);
  assert.equal(receipt.action, 'submit_joiner');
  assert.equal(receipt.subject, 'alex.nguyen@contoso.onmicrosoft.com');
});

test('main process guards PowerShell and submit execution in presentation modes', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.match(main, /const PRESENTATION_MODE = isDemoMode\(process\.argv\)/);
  assert.match(main, /function runPsAsync[\s\S]*?assertExternalExecutionAllowed\(PRESENTATION_MODE,/);
  assert.match(main, /function runPsCommand[\s\S]*?assertExternalExecutionAllowed\(PRESENTATION_MODE,/);
  assert.match(main, /async function executeTool[\s\S]*?toolName\.startsWith\('submit_'\)[\s\S]*?demoReceipt\(/);
  assert.doesNotMatch(
    main,
    /ipcMain\.handle\('verify-operator-pin'[\s\S]*?PRESENTATION_MODE[\s\S]*?mintWriteToken/,
  );
});

test('every renderer mutation channel has an explicit presentation-mode branch', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const channels = [
    'export-evidence-packet',
    'run-blob-export',
    'run-sentinel-ingest',
    'panel-approve-pending',
    'panel-reject-pending',
    'approve-pending',
    'reject-pending',
    'run-bulk-import',
    'save-scheduled-op',
    'delete-scheduled-op',
    'run-certification',
    'save-policy',
    'save-operators',
    'save-ai-provider-config',
    'quarantine-agent',
    'set-operator-auth-pin',
    'set-operator-auth-windows',
    'save-tenant-config',
    'start-device-code-signin',
    'create-agent-app-registrations',
    'save-notification-rules',
    'complete-first-run',
    'skip-first-run',
    'save-integrations-config',
    'run-quick-mover',
    'run-quick-leaver',
    'disable-stale-accounts',
    'run-graph-query',
    'activate-pim-role',
  ];

  for (const channel of channels) {
    const marker = new RegExp(`ipcMain\\.(?:on|handle)\\('${channel}'`);
    const match = marker.exec(main);
    assert.ok(match, `${channel} handler must exist`);
    const nextHandler = main.indexOf('\nipcMain.', match.index + match[0].length);
    const body = main.slice(match.index, nextHandler < 0 ? undefined : nextHandler);
    assert.match(body, /PRESENTATION_MODE/, `${channel} must branch for presentation mode`);
  }
});

test('presentation mode prevents local operational persistence', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.match(main, /function persistOperation[\s\S]*?if \(PRESENTATION_MODE\) return/);
  assert.match(main, /function recordAITrace[\s\S]*?if \(PRESENTATION_MODE\) return/);
  assert.match(main, /function savePanelBounds[\s\S]*?if \(PRESENTATION_MODE\) return/);
  assert.match(main, /function logOperatorActivity[\s\S]*?if \(PRESENTATION_MODE\) return/);
  assert.match(main, /function writeTenantConfig[\s\S]*?assertExternalExecutionAllowed\(PRESENTATION_MODE,/);
  assert.match(main, /function writeOperatorAuth[\s\S]*?assertExternalExecutionAllowed\(PRESENTATION_MODE,/);
  assert.match(main, /function saveScheduled[\s\S]*?assertExternalExecutionAllowed\(PRESENTATION_MODE,/);
});

test('preload exposes a generic current user in demo and capture modes', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // The username override moved out of the preload (so the preload needs no
  // Node modules and every window runs sandbox: true); main resolves it.
  assert.match(preload, /currentUser:\s*ipcRenderer\.sendSync\('resolve-current-user'\)/);
  assert.doesNotMatch(preload, /require\('os'\)/);
  assert.match(main, /ipcMain\.on\('resolve-current-user'/);
  assert.match(main, /'Demo Operator'/);
  assert.match(main, /--jml-demo-operator/);
  assert.match(main, /os\.userInfo\(\)\.username/);
  assert.match(main, /additionalArguments:\s*demoPreloadArgs\(\)/);
  assert.doesNotMatch(main, /nick\.bohanan@contoso\.onmicrosoft\.com/);
});

test('presentation chat sanitizes tenant identity before and after provider calls', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('async function runAgentLoop');
  const end = main.indexOf("\nipcMain.on('send-message'", start);
  const loop = start >= 0 && end > start ? main.slice(start, end) : '';

  assert.ok(loop, 'runAgentLoop must exist');
  assert.match(loop, /getPresentationTenantSanitizerOptions/);
  assert.match(loop, /sanitizeTenantPayload\(agentState\.messages/);
  assert.match(loop, /sanitizeTenantIdentity\(text/);
  assert.match(loop, /system:\s+tenantSanitizer\s+\?\s+sanitizeTenantIdentity\(systemPrompt/);
  assert.match(loop, /sanitizeTenantPayload\(sendResult/);
  assert.ok(
    loop.indexOf('sanitizeTenantIdentity(text') < loop.indexOf("type: 'text', text: safeText"),
    'model text must be sanitized before it is rendered',
  );

  const sendStart = main.indexOf("ipcMain.on('send-message'");
  const sendEnd = main.indexOf("\nipcMain.on('abort-agent'", sendStart);
  const sendHandler = sendStart >= 0 && sendEnd > sendStart ? main.slice(sendStart, sendEnd) : '';
  assert.match(sendHandler, /sanitizeTenantIdentity\(text/);
  assert.match(sendHandler, /sanitizeTenantIdentity\(err\.message/);
  assert.ok(
    sendHandler.indexOf('sanitizeTenantIdentity(text') < sendHandler.indexOf('_pushConvTurn'),
    'operator text must be sanitized before it enters the rendered transcript',
  );
});

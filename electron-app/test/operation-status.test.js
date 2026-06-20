'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyToolResult,
  isLifecycleSubmitTool,
  lifecycleStageForTool,
} = require('../lib/operation-status');

test('classifies thrown and structured errors as failed', () => {
  assert.equal(classifyToolResult(undefined, new Error('certificate failed')).status, 'failed');
  assert.equal(classifyToolResult({ error: 'Graph authentication failed' }).status, 'failed');
  assert.equal(classifyToolResult({ outcome: 'failed' }).status, 'failed');
  assert.equal(classifyToolResult({ lines: ['[ERROR] User creation failed'], data: { outcome: 'failed' } }).status, 'failed');
});

test('classifies partial, approval, and successful results', () => {
  assert.equal(classifyToolResult({ outcome: 'partial', errors: ['group failed'] }).status, 'partial');
  assert.equal(classifyToolResult({ approvalRequired: true }).status, 'awaiting_approval');
  assert.equal(classifyToolResult({ approvalQueued: true }).status, 'awaiting_approval');
  assert.equal(classifyToolResult({ outcome: 'success' }).status, 'succeeded');
  assert.equal(classifyToolResult({ created: true }).status, 'succeeded');
});

test('a completed run with non-fatal sub-errors is partial, not failed', () => {
  // The agent scripts exit 2 and print a results object (PascalCase Errors)
  // alongside [ERROR] log lines for incidental sub-steps. The run completed,
  // so it must classify as partial — not failed (regression: Execute showed
  // "failed" inconsistently for runs that actually completed).
  const partialRun = classifyToolResult({
    lines: ['[ACTION] User created', '[ERROR] Group not found: Marketing'],
    data: { AccountCreated: true, GroupsAdded: [], Errors: ['Group not found: Marketing'] },
  });
  assert.equal(partialRun.status, 'partial');
  assert.equal(partialRun.outcome, 'partial');
  assert.match(partialRun.error, /Group not found/);
});

test('a clean completed run is succeeded even if it ran to a results object', () => {
  const cleanRun = classifyToolResult({
    lines: ['[ACTION] User created', '[ACTION] Assigned 1 license(s)'],
    data: { AccountCreated: true, GroupsAdded: ['All Staff'], Errors: [] },
  });
  assert.equal(cleanRun.status, 'succeeded');
  assert.equal(cleanRun.outcome, 'success');
});

test('only provisioning submit tools create lifecycle operations', () => {
  assert.equal(isLifecycleSubmitTool('submit_joiner'), true);
  assert.equal(isLifecycleSubmitTool('lookup_user'), false);
  assert.equal(lifecycleStageForTool('submit_joiner'), 'provision');
  assert.equal(lifecycleStageForTool('submit_mover'), 'transfer');
});

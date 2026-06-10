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
  assert.equal(classifyToolResult({ outcome: 'success' }).status, 'succeeded');
  assert.equal(classifyToolResult({ created: true }).status, 'succeeded');
});

test('only provisioning submit tools create lifecycle operations', () => {
  assert.equal(isLifecycleSubmitTool('submit_joiner'), true);
  assert.equal(isLifecycleSubmitTool('lookup_user'), false);
  assert.equal(lifecycleStageForTool('submit_joiner'), 'provision');
  assert.equal(lifecycleStageForTool('submit_mover'), 'transfer');
});

'use strict';

// Locks the Glass Screen operation view-model: how raw operation-status
// records map onto the five-stage Command Center pipeline and the
// live/replay/idle presentation contract.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PIPELINE_STAGES,
  buildGlassScreenViewModel,
  selectActiveOperation,
  recentTerminalOperations,
  formatCurrentDecision,
  mapPipeline,
} = require('../renderer/glass-screen-model');

const T0 = Date.parse('2026-06-10T12:00:00.000Z');

function op(overrides = {}) {
  return {
    id: overrides.id || 'op-1',
    agent: 'joiner',
    toolName: 'submit_joiner',
    stage: 'provision',
    subject: 'Tapiwa Ngungu',
    operator: 'Nick',
    whatif: false,
    status: 'running',
    outcome: null,
    error: null,
    startedAt: new Date(T0 - 78000).toISOString(),
    updatedAt: new Date(T0 - 1000).toISOString(),
    ...overrides,
  };
}

function stageState(stages, id) {
  return stages.find(s => s.id === id)?.state;
}

test('PIPELINE_STAGES are the five stable lifecycle stages', () => {
  assert.deepEqual(PIPELINE_STAGES, ['request', 'risk', 'execute', 'verify', 'complete']);
});

test('running execute operation activates Execute and leaves later stages pending', () => {
  const stages = mapPipeline(op({ status: 'running' }));
  assert.equal(stageState(stages, 'request'), 'succeeded');
  assert.equal(stageState(stages, 'risk'), 'succeeded');
  assert.equal(stageState(stages, 'execute'), 'active');
  assert.equal(stageState(stages, 'verify'), 'pending');
  assert.equal(stageState(stages, 'complete'), 'pending');
});

test('failed execution never marks Verify or Complete succeeded', () => {
  const stages = mapPipeline(op({ status: 'failed', outcome: 'failed', error: 'Graph certificate authentication failed' }));
  assert.equal(stageState(stages, 'execute'), 'failed');
  assert.notEqual(stageState(stages, 'verify'), 'succeeded');
  assert.notEqual(stageState(stages, 'complete'), 'succeeded');
  // Failure must never receive a completion checkmark
  for (const s of stages) {
    if (s.id === 'verify' || s.id === 'complete') {
      assert.notEqual(s.state, 'succeeded');
    }
  }
});

test('awaiting approval pauses at Risk with an amber decision', () => {
  const operation = op({ status: 'awaiting_approval', outcome: 'queued' });
  const stages = mapPipeline(operation);
  assert.equal(stageState(stages, 'risk'), 'awaiting-approval');
  assert.equal(stageState(stages, 'execute'), 'pending');
  const vm = buildGlassScreenViewModel({ operations: [operation], now: T0 });
  assert.equal(vm.eyebrow, 'AWAITING APPROVAL');
  assert.match(vm.currentDecision.toLowerCase(), /approv/);
});

test('successful operation reaches Complete with every stage succeeded', () => {
  const stages = mapPipeline(op({ status: 'succeeded', outcome: 'success' }));
  assert.ok(stages.every(s => s.state === 'succeeded'));
});

test('partial outcome names completed work and remaining follow-up', () => {
  const operation = op({ status: 'partial', outcome: 'partial', error: 'group assignment failed' });
  const stages = mapPipeline(operation);
  // Not styled as fully successful: the final stage is not a green success.
  assert.notEqual(stageState(stages, 'complete'), 'succeeded');
  assert.equal(stageState(stages, 'complete'), 'partial');
  const vm = buildGlassScreenViewModel({ operations: [operation], now: T0 });
  assert.ok(vm.recovery, 'partial outcome should surface a follow-up');
  assert.match(`${vm.recovery.message} ${vm.recovery.detail || ''}`.toLowerCase(), /follow|remain|group/);
});

test('active operation wins over selected historical replay', () => {
  const active = op({ id: 'live-1', status: 'running' });
  const past = op({ id: 'old-1', status: 'succeeded', outcome: 'success', updatedAt: new Date(T0 - 9e5).toISOString() });
  const vm = buildGlassScreenViewModel({ operations: [past, active], selectedId: 'old-1', now: T0 });
  assert.equal(vm.mode, 'live');
  assert.equal(vm.operation.id, 'live-1');
});

test('selecting history with no active operation enters replay mode', () => {
  const past = op({ id: 'old-1', status: 'succeeded', outcome: 'success' });
  const older = op({ id: 'old-2', status: 'failed', outcome: 'failed', updatedAt: new Date(T0 - 9e5).toISOString() });
  const vm = buildGlassScreenViewModel({ operations: [past, older], selectedId: 'old-2', now: T0 });
  assert.equal(vm.mode, 'replay');
  assert.equal(vm.operation.id, 'old-2');
});

test('idle with no active operation shows Fleet Ready and the last completed run', () => {
  const past = op({ id: 'old-1', status: 'succeeded', outcome: 'success' });
  const vm = buildGlassScreenViewModel({ operations: [past], now: T0 });
  assert.equal(vm.mode, 'idle');
  assert.equal(vm.eyebrow, 'FLEET READY');
});

test('selectActiveOperation returns the newest running or awaiting operation', () => {
  const ops = [
    op({ id: 'done', status: 'succeeded', outcome: 'success', updatedAt: new Date(T0 - 5000).toISOString() }),
    op({ id: 'live-old', status: 'running', updatedAt: new Date(T0 - 4000).toISOString() }),
    op({ id: 'live-new', status: 'awaiting_approval', updatedAt: new Date(T0 - 1000).toISOString() }),
  ];
  assert.equal(selectActiveOperation(ops).id, 'live-new');
  assert.equal(selectActiveOperation([]), null);
});

test('recent terminal operations are newest first and limited to three', () => {
  const ops = [];
  for (let i = 0; i < 6; i++) {
    ops.push(op({ id: `t-${i}`, status: 'succeeded', outcome: 'success', updatedAt: new Date(T0 - i * 1000).toISOString(), completedAt: new Date(T0 - i * 1000).toISOString() }));
  }
  ops.push(op({ id: 'running', status: 'running' }));
  const recent = recentTerminalOperations(ops, 3);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].id, 't-0');
  assert.ok(recent.every(o => o.id !== 'running'), 'running operations are not terminal');
});

test('formatCurrentDecision produces a human sentence, never a raw tool name', () => {
  const decision = formatCurrentDecision(op({ status: 'running' }));
  assert.doesNotMatch(decision, /submit_joiner/);
  assert.ok(decision.length > 0);
});

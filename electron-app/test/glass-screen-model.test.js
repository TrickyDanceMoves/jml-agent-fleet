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
  stageDetail,
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

test('awaiting-approval does not block replaying a selected historical run', () => {
  const awaiting = op({ id: 'app-1', status: 'awaiting-approval' });
  const past = op({ id: 'old-1', status: 'succeeded', outcome: 'success', updatedAt: new Date(T0 - 9e5).toISOString() });
  const vm = buildGlassScreenViewModel({ operations: [past, awaiting], selectedId: 'old-1', now: T0 });
  assert.equal(vm.mode, 'replay');
  assert.equal(vm.operation.id, 'old-1');
});

test('awaiting-approval still owns the hero when nothing is selected', () => {
  const awaiting = op({ id: 'app-1', status: 'awaiting-approval' });
  const past = op({ id: 'old-1', status: 'succeeded', outcome: 'success', updatedAt: new Date(T0 - 9e5).toISOString() });
  const vm = buildGlassScreenViewModel({ operations: [past, awaiting], now: T0 });
  assert.equal(vm.mode, 'live');
  assert.equal(vm.operation.id, 'app-1');
});

test('selecting history with no active operation enters replay mode', () => {
  const past = op({ id: 'old-1', status: 'succeeded', outcome: 'success' });
  const older = op({ id: 'old-2', status: 'failed', outcome: 'failed', updatedAt: new Date(T0 - 9e5).toISOString() });
  const vm = buildGlassScreenViewModel({ operations: [past, older], selectedId: 'old-2', now: T0 });
  assert.equal(vm.mode, 'replay');
  assert.equal(vm.operation.id, 'old-2');
});

test('idle with stale history shows Fleet Ready and the last completed run', () => {
  const past = op({
    id: 'old-1', status: 'succeeded', outcome: 'success',
    updatedAt: new Date(T0 - 30 * 60 * 1000).toISOString(),
    completedAt: new Date(T0 - 30 * 60 * 1000).toISOString(),
  });
  const vm = buildGlassScreenViewModel({ operations: [past], now: T0 });
  assert.equal(vm.mode, 'idle');
  assert.equal(vm.eyebrow, 'FLEET READY');
  assert.match(vm.currentDecision.toLowerCase(), /appear here automatically/);
});

test('a just-failed operation holds ACTION FAILED before relaxing to Fleet Ready', () => {
  const failed = op({
    id: 'f-1', status: 'failed', outcome: 'failed',
    error: 'Graph certificate authentication failed',
    updatedAt: new Date(T0 - 8000).toISOString(),
    completedAt: new Date(T0 - 8000).toISOString(),
  });
  const vm = buildGlassScreenViewModel({ operations: [failed], now: T0 });
  assert.equal(vm.eyebrow, 'ACTION FAILED');
  assert.match(vm.currentDecision.toLowerCase(), /failed/);
  assert.ok(vm.recovery, 'failure must surface a recovery action');
});

test('a just-completed operation holds COMPLETED before relaxing to Fleet Ready', () => {
  const done = op({
    id: 'd-1', status: 'succeeded', outcome: 'success',
    updatedAt: new Date(T0 - 8000).toISOString(),
    completedAt: new Date(T0 - 8000).toISOString(),
  });
  const vm = buildGlassScreenViewModel({ operations: [done], now: T0 });
  assert.equal(vm.eyebrow, 'COMPLETED');
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

test('stageDetail returns owner, purpose, and concrete activities per stage', () => {
  const running = op({ status: 'running' });
  const exec = stageDetail('execute', running);
  assert.equal(exec.label, 'Execute');
  assert.ok(exec.owner.length > 0);
  assert.ok(exec.purpose.length > 0);
  assert.ok(exec.activities.length >= 1);
  // joiner execute shows the create-identity Graph call
  assert.ok(exec.activities.some(a => /\/users/.test(a.name)));
});

test('stageDetail execute calls differ by agent and leaver stage', () => {
  const joiner = stageDetail('execute', op({ agent: 'joiner', status: 'running' }));
  assert.ok(joiner.activities.some(a => /POST \/users/.test(a.name)), 'joiner creates a user');

  const leaverSoft = stageDetail('execute', op({ agent: 'leaver', stage: 'soft', status: 'running' }));
  assert.ok(leaverSoft.activities.some(a => /revokeSignInSessions/.test(a.name)), 'soft leaver revokes sessions');

  const leaverHard = stageDetail('execute', op({ agent: 'leaver', stage: 'hard', status: 'running' }));
  assert.ok(leaverHard.activities.some(a => /assignLicense/.test(a.name)), 'hard leaver removes licenses');
});

test('stageDetail risk surfaces Foundry IQ grounding when present', () => {
  const grounded = op({
    status: 'running',
    grounding: { source: 'Foundry IQ', citations: [{ title: 'SoD Policy' }] },
  });
  const risk = stageDetail('risk', grounded);
  const iq = risk.activities.find(a => /Foundry IQ/.test(a.name));
  assert.ok(iq, 'risk stage should list the IQ grounding activity');
  assert.match(iq.note, /SoD Policy/);
});

test('stageDetail marks pending stages as not-yet-run', () => {
  const running = op({ status: 'running' }); // verify + complete are pending
  const verify = stageDetail('verify', running);
  assert.equal(verify.state, 'pending');
  assert.ok(verify.activities.every(a => a.status === 'pending'));
});

test('stageDetail failed execute marks its calls failed, not done', () => {
  const failed = op({ status: 'failed', outcome: 'failed', error: 'boom' });
  const exec = stageDetail('execute', failed);
  assert.equal(exec.state, 'failed');
  assert.ok(exec.activities.every(a => a.status === 'failed'));
  // and a downstream stage never shows done on a failure
  assert.notEqual(stageDetail('complete', failed).state, 'succeeded');
});

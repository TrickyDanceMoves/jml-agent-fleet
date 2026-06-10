'use strict';

// Locks the Glass Screen controller's pure state helpers: how live
// operation-status updates merge into controller state, when a live
// operation interrupts a historical replay selection, and how raw
// evidence is bounded before it reaches the details drawer.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeOperationUpdate,
  liveOperationInterruptsReplay,
  detailsRowsForOperation,
  enrichOperation,
} = require('../renderer/glass-screen');

function op(overrides = {}) {
  return {
    id: 'op-1',
    agent: 'joiner',
    toolName: 'submit_joiner',
    stage: 'provision',
    subject: 'amelia.chen@contoso.com',
    operator: 'Nick',
    whatif: false,
    status: 'running',
    outcome: null,
    error: null,
    startedAt: '2026-06-10T18:00:00.000Z',
    updatedAt: '2026-06-10T18:00:00.000Z',
    ...overrides,
  };
}

test('same operation id is replaced by fresher updatedAt', () => {
  const initial = [op()];
  const fresher = op({ status: 'succeeded', outcome: 'success', updatedAt: '2026-06-10T18:01:00.000Z' });
  const merged = mergeOperationUpdate(initial, fresher);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'succeeded');
});

test('stale update never overwrites a fresher record', () => {
  const terminal = op({ status: 'succeeded', outcome: 'success', updatedAt: '2026-06-10T18:02:00.000Z' });
  const stale = op({ status: 'running', updatedAt: '2026-06-10T18:00:30.000Z' });
  const merged = mergeOperationUpdate([terminal], stale);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'succeeded');
});

test('unknown operation id is prepended as a new record', () => {
  const merged = mergeOperationUpdate([op()], op({ id: 'op-2' }));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'op-2');
});

test('terminal update removes the active state and preserves history', () => {
  const model = require('../renderer/glass-screen-model');
  const done = op({ status: 'failed', outcome: 'failed', error: 'boom', updatedAt: '2026-06-10T18:03:00.000Z', completedAt: '2026-06-10T18:03:00.000Z' });
  const merged = mergeOperationUpdate([op()], done);
  assert.equal(model.selectActiveOperation(merged), null);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'failed');
});

test('new running operation interrupts replay selection', () => {
  assert.equal(liveOperationInterruptsReplay('op-old', op({ id: 'op-new', status: 'running' })), true);
  assert.equal(liveOperationInterruptsReplay('op-old', op({ id: 'op-new', status: 'awaiting_approval' })), true);
});

test('terminal update does not interrupt replay selection', () => {
  assert.equal(liveOperationInterruptsReplay('op-old', op({ status: 'succeeded' })), false);
  assert.equal(liveOperationInterruptsReplay(null, op({ status: 'running' })), false);
});

test('details rows sanitize and bound raw error text', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const noisy = 'line one ' + ESC + '[31mred' + ESC + '[0m ' + BEL + ' bell ' + 'x'.repeat(1200);
  const rows = detailsRowsForOperation(op({ status: 'failed', outcome: 'failed', error: noisy }));
  const errRow = rows.find(r => /error/i.test(r.label));
  assert.ok(errRow, 'failed operation must expose an error row');
  assert.ok(errRow.value.length <= 600, 'raw error must be bounded');
  const hasControl = [...errRow.value].some(ch => {
    const c = ch.charCodeAt(0);
    return c <= 8 || (c >= 11 && c <= 31) || c === 127;
  });
  assert.equal(hasControl, false, 'control sequences must be stripped');
});

test('details rows include lifecycle evidence fields', () => {
  const rows = detailsRowsForOperation(op({ status: 'succeeded', outcome: 'success', completedAt: '2026-06-10T18:05:00.000Z' }));
  const labels = rows.map(r => r.label.toLowerCase());
  for (const expected of ['started', 'operator', 'mode', 'tool']) {
    assert.ok(labels.some(l => l.includes(expected)), `missing ${expected} row`);
  }
});

test('audit enrichment adds evidence but never overwrites fresher operation-status outcome', () => {
  const operation = op({ status: 'failed', outcome: 'failed', error: 'cert failure' });
  const audit = [{
    id: 'op-1',
    timestamp: '2026-06-10T18:00:05.000Z',
    outcome: 'success', // older audit record claims success — must not win
    hash: 'a3f8c1d92b4e6708',
    details: { ticketRef: 'INC-1042' },
  }];
  const enriched = enrichOperation(operation, audit);
  assert.equal(enriched.status, 'failed');
  assert.equal(enriched.outcome, 'failed');
  assert.equal(enriched.hash, 'a3f8c1d92b4e6708');
  assert.equal(enriched.details.ticketRef, 'INC-1042');
});

test('audit enrichment matches by subject and time when ids are absent', () => {
  const operation = op({ status: 'succeeded', outcome: 'success' });
  const audit = [{
    timestamp: '2026-06-10T18:00:30.000Z',
    subject: 'amelia.chen@contoso.com',
    hash: 'be71d40a9c25f3e8',
  }];
  const enriched = enrichOperation(operation, audit);
  assert.equal(enriched.hash, 'be71d40a9c25f3e8');
});

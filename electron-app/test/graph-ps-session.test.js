'use strict';

// Locks the warm Graph session protocol: request/response correlation,
// script errors vs session errors, worker death recovery, and timeouts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { GraphPsSession } = require('../lib/graph-ps-session');

function mockSession() {
  return new GraphPsSession({
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures', 'mock-graph-worker.js')],
  });
}

test('round-trips a script and resolves with its output', async () => {
  const s = mockSession();
  try {
    assert.equal(await s.run('Get-Thing'), 'echo:Get-Thing');
    // second request reuses the same worker
    assert.equal(await s.run('Get-Other'), 'echo:Get-Other');
  } finally { s.dispose(); }
});

test('script errors reject without sessionError (no cold retry)', async () => {
  const s = mockSession();
  try {
    await assert.rejects(() => s.run('fail'), err => {
      assert.equal(err.message, 'boom');
      assert.ok(!err.sessionError, 'script errors must not be marked as session failures');
      return true;
    });
  } finally { s.dispose(); }
});

test('worker death rejects with sessionError and next run restarts', async () => {
  const s = mockSession();
  try {
    await assert.rejects(() => s.run('die'), err => err.sessionError === true);
    assert.equal(await s.run('Get-Again'), 'echo:Get-Again');
  } finally { s.dispose(); }
});

test('timeout rejects with sessionError and kills the hung worker', async () => {
  const s = mockSession();
  try {
    await assert.rejects(() => s.run('hang', { timeout: 300 }), err => err.sessionError === true);
    assert.equal(await s.run('Get-Fresh'), 'echo:Get-Fresh');
  } finally { s.dispose(); }
});

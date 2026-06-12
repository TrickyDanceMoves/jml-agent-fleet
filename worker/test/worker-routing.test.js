'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { dispatch, buildJoinerPayload, buildMoverPayload, EVENT_TYPE_TO_AGENT } =
  require('../src/agent-dispatcher');
const { createMessageHandler } = require('../src/message-handler');

// ---------- agent-dispatcher ----------

function makeEvent(eventType, extra = {}) {
  return {
    eventId: `${eventType}-event-1`,
    eventType,
    effectiveDate: '2026-06-12',
    ticketRef: 'JML-123',
    employee: {
      firstName: 'Ava',
      lastName: 'Nguyen',
      email: 'ava.nguyen@contoso.onmicrosoft.com',
      department: 'Engineering',
      jobTitle: 'Engineer',
    },
    ...extra,
  };
}

// Stubs that record calls instead of spawning PowerShell or touching PIM.
function makeOverrides() {
  const ps1Calls = [];
  const pimCalls = [];
  return {
    ps1Calls,
    pimCalls,
    overrides: {
      invokePs1: (scriptPath, args) => {
        ps1Calls.push({ scriptPath, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      invokePIM: (action, agentName, justification) => {
        pimCalls.push({ action, agentName, justification });
      },
    },
  };
}

test('dispatch routes hire, terminate, and transfer to joiner/leaver/mover scripts', () => {
  assert.deepEqual(EVENT_TYPE_TO_AGENT, { hire: 'joiner', terminate: 'leaver', transfer: 'mover' });

  for (const [eventType, agent, script] of [
    ['hire', 'joiner', 'Invoke-JoinerProcess.ps1'],
    ['terminate', 'leaver', 'Invoke-LeaverProcess.ps1'],
    ['transfer', 'mover', 'Invoke-MoverProcess.ps1'],
  ]) {
    const { ps1Calls, pimCalls, overrides } = makeOverrides();
    const result = dispatch(makeEvent(eventType), overrides);

    assert.equal(result.exitCode, 0);
    assert.equal(ps1Calls.length, 1, `${eventType} should invoke exactly one script`);
    assert.equal(path.basename(ps1Calls[0].scriptPath), script);
    assert.ok(ps1Calls[0].scriptPath.includes(`${path.sep}${agent}${path.sep}`),
      `${eventType} script should live under the ${agent} agent dir`);

    // PIM activates the right agent before dispatch and deactivates after.
    assert.deepEqual(pimCalls.map((c) => [c.action, c.agentName]),
      [['Activate', agent], ['Deactivate', agent]]);
  }
});

test('dispatch passes leaver params directly and joiner/mover payloads by file', () => {
  const { ps1Calls, overrides } = makeOverrides();
  dispatch(makeEvent('terminate'), overrides);
  assert.deepEqual(ps1Calls[0].args, [
    '-UserPrincipalName', 'ava.nguyen@contoso.onmicrosoft.com',
    '-Stage', 'Both',
    '-TicketRef', 'JML-123',
  ]);

  const hire = makeOverrides();
  dispatch(makeEvent('hire'), hire.overrides);
  assert.equal(hire.ps1Calls[0].args[0], '-PayloadPath');
  assert.match(hire.ps1Calls[0].args[1], /payload-hire-event-1\.json$/);

  const xfer = makeOverrides();
  dispatch(makeEvent('transfer'), xfer.overrides);
  assert.equal(xfer.ps1Calls[0].args[0], '-PayloadPath');
});

test('dispatch rejects unknown event types before activating PIM', () => {
  const { ps1Calls, pimCalls, overrides } = makeOverrides();
  assert.throws(() => dispatch(makeEvent('promote'), overrides), /Unknown eventType: promote/);
  assert.equal(ps1Calls.length, 0);
  assert.equal(pimCalls.length, 0);
});

test('dispatch deactivates PIM even when the agent script throws', () => {
  const pimCalls = [];
  const overrides = {
    invokePs1: () => { throw new Error('script exploded'); },
    invokePIM: (action, agentName) => pimCalls.push([action, agentName]),
  };
  assert.throws(() => dispatch(makeEvent('terminate'), overrides), /script exploded/);
  assert.deepEqual(pimCalls, [['Activate', 'leaver'], ['Deactivate', 'leaver']]);
});

test('payload builders map canonical events to agent payload shapes', () => {
  const joiner = buildJoinerPayload(makeEvent('hire'));
  assert.equal(joiner.userPrincipalName, 'ava.nguyen@contoso.onmicrosoft.com');
  assert.equal(joiner.department, 'Engineering');
  assert.equal(joiner.ticketRef, 'JML-123');

  const mover = buildMoverPayload(makeEvent('transfer', {
    changes: { newDepartment: 'Platform', newTitle: 'Senior Engineer' },
  }));
  assert.equal(mover.department, 'Platform');
  assert.equal(mover.jobTitle, 'Senior Engineer');
});

// ---------- message handler (queue semantics) ----------

const silentLog = { log: () => {}, error: () => {} };

function queueMessage(event, dequeueCount = 1) {
  return {
    messageId: 'msg-1',
    popReceipt: 'pop-1',
    dequeueCount,
    messageText: Buffer.from(JSON.stringify(event)).toString('base64'),
  };
}

function makeHandler({ dispatch, maxRetries = 3 }) {
  const deleted = [];
  const statuses = [];
  const handler = createMessageHandler({
    queueClient: { deleteMessage: async (id, pop) => deleted.push({ id, pop }) },
    tableClient: { upsertEntity: async (entity) => statuses.push(entity) },
    dispatch,
    maxRetries,
    log: silentLog,
  });
  return { handler, deleted, statuses };
}

test('successful dispatch marks the event completed and deletes the message', async () => {
  const { handler, deleted, statuses } = makeHandler({
    dispatch: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  await handler.processMessage(queueMessage(makeEvent('hire')));

  assert.equal(deleted.length, 1, 'completed message should be deleted from the queue');
  assert.deepEqual(statuses.map((s) => s.status), ['processing', 'completed']);
});

test('failed dispatch leaves the message in the queue for retry', async () => {
  const { handler, deleted, statuses } = makeHandler({
    dispatch: () => ({ exitCode: 1, stdout: '', stderr: 'agent failed' }),
  });
  await handler.processMessage(queueMessage(makeEvent('terminate')));

  assert.equal(deleted.length, 0, 'failed message must stay queued for retry');
  assert.deepEqual(statuses.map((s) => s.status), ['processing', 'failed']);
  assert.equal(statuses[1].stderr, 'agent failed');
});

test('a message past maxRetries is dead-lettered and removed without dispatching', async () => {
  let dispatched = 0;
  const { handler, deleted, statuses } = makeHandler({
    dispatch: () => { dispatched += 1; return { exitCode: 0, stdout: '', stderr: '' }; },
    maxRetries: 3,
  });
  await handler.processMessage(queueMessage(makeEvent('hire'), 4));

  assert.equal(dispatched, 0, 'dead-lettered events must not reach the agents');
  assert.equal(deleted.length, 1, 'dead-lettered message should be deleted');
  assert.deepEqual(statuses.map((s) => s.status), ['dead-lettered']);
});

test('a dispatch exception marks the event failed and keeps it queued', async () => {
  const { handler, deleted, statuses } = makeHandler({
    dispatch: () => { throw new Error('PIM activation failed'); },
  });
  await handler.processMessage(queueMessage(makeEvent('transfer')));

  assert.equal(deleted.length, 0);
  assert.deepEqual(statuses.map((s) => s.status), ['processing', 'failed']);
  assert.match(statuses[1].error, /PIM activation failed/);
});

test('an unparseable message is discarded without status writes', async () => {
  const { handler, deleted, statuses } = makeHandler({
    dispatch: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  await handler.processMessage({
    messageId: 'bad-1', popReceipt: 'pop-bad', dequeueCount: 1, messageText: 'not-base64-json',
  });

  assert.equal(deleted.length, 1, 'garbage message should be deleted, not retried forever');
  assert.equal(statuses.length, 0);
});

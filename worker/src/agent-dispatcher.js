'use strict';

/**
 * Maps canonical HR events to PS1 agent invocations.
 *
 * Joiner/Mover: writes a temp payload JSON to the agent's logs/ dir, passes
 *   -PayloadPath to the script, then removes the temp file.
 * Leaver: passes -UserPrincipalName, -TicketRef, -Stage directly as params.
 *
 * PIM: before each dispatch, invokes the PIM helper script to request
 *   time-bound group activation. After dispatch, deactivates immediately.
 *   If pim-config.json has no groupIds yet (setup not run), PIM is skipped
 *   gracefully and permanent roles remain in use.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// agents/ root — agent-dispatcher.js lives at agents/worker/src/
const AGENTS_ROOT = path.resolve(__dirname, '..', '..');

function buildJoinerPayload(event) {
  const emp = event.employee;
  return {
    givenName:          emp.firstName,
    surname:            emp.lastName,
    userPrincipalName:  emp.email,
    department:         emp.department   || 'General',
    jobTitle:           emp.jobTitle     || '',
    usageLocation:      emp.usageLocation || 'US',
    manager:            emp.manager      || null,
    groups:             emp.groups       || [],
    licenses:           emp.licenses     || [],
    ticketRef:          event.ticketRef  || ''
  };
}

function buildMoverPayload(event) {
  const emp = event.employee;
  const chg = event.changes || {};
  return {
    userPrincipalName: emp.email,
    department:        chg.newDepartment  || emp.department  || '',
    jobTitle:          chg.newTitle       || emp.jobTitle    || '',
    officeLocation:    emp.officeLocation || '',
    groupsToAdd:       chg.groupsToAdd    || [],
    groupsToRemove:    chg.groupsToRemove || [],
    ticketRef:         event.ticketRef    || ''
  };
}

function writePayloadFile(agentName, eventId, payload) {
  const dir = path.join(AGENTS_ROOT, agentName, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `payload-${eventId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function invokePs1(scriptPath, args) {
  const result = spawnSync(
    'powershell.exe',
    ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 300_000 }
  );
  return {
    exitCode: result.status ?? -1,
    stdout:   result.stdout || '',
    stderr:   result.stderr || ''
  };
}

const PIM_HELPER = path.join(AGENTS_ROOT, 'shared', 'Invoke-PIMHelper.ps1');
const EVENT_TYPE_TO_AGENT = { hire: 'joiner', terminate: 'leaver', transfer: 'mover' };

function invokePIM(action, agentName, justification) {
  if (!fs.existsSync(PIM_HELPER)) return; // helper not present — skip silently
  const result = invokePs1(PIM_HELPER, ['-Action', action, '-AgentName', agentName, '-Justification', justification]);
  if (result.exitCode !== 0) {
    // PIM failure on deactivate is non-fatal; on activate it throws to the caller
    if (action === 'Activate') throw new Error(`PIM activation failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

function dispatch(event) {
  const { eventType, eventId } = event;
  const agentName   = EVENT_TYPE_TO_AGENT[eventType];
  const justification = `JML ${eventType} ${event.ticketRef || event.eventId}`;

  if (!agentName) throw new Error(`Unknown eventType: ${eventType}`);

  invokePIM('Activate', agentName, justification);

  try {
    if (eventType === 'hire') {
      const payload     = buildJoinerPayload(event);
      const payloadPath = writePayloadFile('joiner', eventId, payload);
      const scriptPath  = path.join(AGENTS_ROOT, 'joiner', 'Invoke-JoinerProcess.ps1');
      try {
        return invokePs1(scriptPath, ['-PayloadPath', payloadPath]);
      } finally {
        fs.rmSync(payloadPath, { force: true });
      }
    }

    if (eventType === 'terminate') {
      const scriptPath = path.join(AGENTS_ROOT, 'leaver', 'Invoke-LeaverProcess.ps1');
      const args = ['-UserPrincipalName', event.employee.email, '-Stage', 'Both'];
      if (event.ticketRef) args.push('-TicketRef', event.ticketRef);
      return invokePs1(scriptPath, args);
    }

    if (eventType === 'transfer') {
      const payload     = buildMoverPayload(event);
      const payloadPath = writePayloadFile('mover', eventId, payload);
      const scriptPath  = path.join(AGENTS_ROOT, 'mover', 'Invoke-MoverProcess.ps1');
      try {
        return invokePs1(scriptPath, ['-PayloadPath', payloadPath]);
      } finally {
        fs.rmSync(payloadPath, { force: true });
      }
    }
  } finally {
    invokePIM('Deactivate', agentName, justification);
  }
}

module.exports = { dispatch };

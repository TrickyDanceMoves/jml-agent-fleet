'use strict';

const DEMO_FLAGS = new Set(['--demo', '--demo-drive', '--hackathon-capture']);

class DemoWriteBlockedError extends Error {
  constructor(action) {
    super(`Demo mode blocked external execution: ${action}`);
    this.name = 'DemoWriteBlockedError';
    this.code = 'DEMO_WRITE_BLOCKED';
  }
}

function isDemoMode(argv = []) {
  return argv.some((arg) => DEMO_FLAGS.has(arg));
}

function assertExternalExecutionAllowed(demoMode, action) {
  if (demoMode) throw new DemoWriteBlockedError(action);
}

function demoReceipt(action, details = {}) {
  return {
    ok: true,
    ...details,
    action,
    demo: true,
    simulated: true,
    committed: false,
    message: details.message || 'Simulated in demo mode. No tenant change was committed.',
  };
}

module.exports = {
  DemoWriteBlockedError,
  assertExternalExecutionAllowed,
  demoReceipt,
  isDemoMode,
};


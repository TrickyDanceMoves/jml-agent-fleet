'use strict';

const LIFECYCLE_TOOLS = {
  submit_joiner: 'provision',
  submit_enroller: 'enroll',
  submit_mover: 'transfer',
  submit_leaver_soft: 'soft',
  submit_leaver_hard: 'hard',
  submit_leaver_delete: 'delete',
};

function isLifecycleSubmitTool(toolName) {
  return Object.prototype.hasOwnProperty.call(LIFECYCLE_TOOLS, toolName);
}

function lifecycleStageForTool(toolName) {
  return LIFECYCLE_TOOLS[toolName] || null;
}

function resultError(result, thrownError) {
  if (thrownError) return thrownError.message || String(thrownError);
  if (!result || typeof result !== 'object') return null;
  if (result.data && typeof result.data === 'object') {
    const nested = resultError(result.data);
    if (nested) return nested;
  }
  if (result.error) return typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
  const errorLine = Array.isArray(result.lines)
    ? result.lines.find(line => /\[ERROR\]|\berror\b/i.test(String(line))) : null;
  if (errorLine) return String(errorLine).replace(/^\[ERROR\]\s*/i, '');
  if (String(result.outcome || '').toLowerCase() === 'failed') {
    return result.message || result.reason || 'Operation failed';
  }
  return null;
}

// The agent scripts record their non-fatal errors in a results object whose
// field is PascalCase `Errors` (PowerShell convention); accept `errors` too.
function collectErrors(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = Array.isArray(payload.errors) ? payload.errors
            : Array.isArray(payload.Errors) ? payload.Errors : [];
  return raw.filter(Boolean);
}

function errorsText(errors) {
  return errors.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('; ') || null;
}

function classifyToolResult(result, thrownError) {
  // A thrown error = the agent process hard-failed (exit 1, timeout, spawn
  // error). runPsAsync resolves exit code 2 (the scripts' "completed with
  // non-fatal errors" signal), so a thrown error is always a real failure.
  if (thrownError) {
    return { status: 'failed', outcome: 'failed', error: thrownError.message || String(thrownError) };
  }

  const payload = result?.data && typeof result.data === 'object' ? result.data : result;

  // Control-plane results that defer execution to an approver.
  if (payload?.approvalRequired === true || payload?.approvalQueued === true
      || payload?.status === 'awaiting_approval') {
    return { status: 'awaiting_approval', outcome: 'queued', error: null };
  }

  const declaredOutcome = String(payload?.outcome || payload?.Outcome || '').toLowerCase();
  const errors = collectErrors(payload);

  // A parsed results object (or an explicit outcome) means the agent ran to its
  // summary. That is the authoritative "the operation executed" signal — stray
  // [ERROR] log lines are non-fatal sub-step warnings (e.g. "group not found")
  // and must NOT downgrade a completed run to failed. Only an explicit
  // outcome:'failed' or a thrown error counts as a hard failure here.
  const ranToCompletion = !!(result?.data && typeof result.data === 'object');
  if (ranToCompletion || declaredOutcome) {
    if (declaredOutcome === 'failed') {
      return { status: 'failed', outcome: 'failed', error: errorsText(errors) || 'Operation failed' };
    }
    if (declaredOutcome === 'partial' || errors.length) {
      return { status: 'partial', outcome: 'partial', error: errorsText(errors) };
    }
    return { status: 'succeeded', outcome: 'success', error: null };
  }

  // No results object: the script exited before completing (a precondition
  // failure such as "user not found"). Treat any surfaced error as a hard fail.
  const error = resultError(result);
  if (error) return { status: 'failed', outcome: 'failed', error };
  return { status: 'succeeded', outcome: 'success', error: null };
}

module.exports = {
  classifyToolResult,
  isLifecycleSubmitTool,
  lifecycleStageForTool,
};

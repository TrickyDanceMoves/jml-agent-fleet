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

function classifyToolResult(result, thrownError) {
  const error = resultError(result, thrownError);
  if (error) return { status: 'failed', outcome: 'failed', error };

  const payload = result?.data && typeof result.data === 'object' ? result.data : result;
  const outcome = String(payload?.outcome || '').toLowerCase();
  const errors = Array.isArray(payload?.errors) ? payload.errors.filter(Boolean) : [];
  if (outcome === 'partial' || errors.length) {
    return {
      status: 'partial',
      outcome: 'partial',
      error: errors.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('; ') || null,
    };
  }
  if (payload?.approvalRequired === true || payload?.status === 'awaiting_approval') {
    return { status: 'awaiting_approval', outcome: 'queued', error: null };
  }
  return { status: 'succeeded', outcome: 'success', error: null };
}

module.exports = {
  classifyToolResult,
  isLifecycleSubmitTool,
  lifecycleStageForTool,
};

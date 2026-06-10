'use strict';

/*
 * Glass Screen operation view-model.
 *
 * Pure, side-effect-free mapping from operation-status records onto the
 * five-stage Command Center pipeline and the live/replay/idle presentation
 * contract. No DOM, no timers — this module is the single source of truth
 * for "what does this operation mean", and it is exercised directly by the
 * Node test runner. The renderer and motion controller consume its output;
 * they never re-derive lifecycle truth themselves.
 */

(function (global) {
  const PIPELINE_STAGES = ['request', 'risk', 'execute', 'verify', 'complete'];

  const STAGE_LABELS = {
    request: 'Request',
    risk: 'Risk',
    execute: 'Execute',
    verify: 'Verify',
    complete: 'Complete',
  };

  // Active (non-terminal) operations own the page.
  const ACTIVE_STATUSES = new Set(['running', 'awaiting_approval', 'awaiting-approval']);

  function normalizeStatus(operation) {
    const raw = String(operation?.status || '').toLowerCase();
    if (raw === 'running') return 'running';
    if (raw === 'awaiting_approval' || raw === 'awaiting-approval') return 'awaiting-approval';
    if (raw === 'failed') return 'failed';
    if (raw === 'partial') return 'partial';
    if (raw === 'succeeded' || raw === 'success') return 'succeeded';
    // Audit-only records carry `outcome` but no live status.
    const outcome = String(operation?.outcome || '').toLowerCase();
    if (outcome === 'failed') return 'failed';
    if (outcome === 'partial') return 'partial';
    if (outcome === 'queued') return 'awaiting-approval';
    if (outcome === 'success') return 'succeeded';
    return 'succeeded';
  }

  function isActive(operation) {
    return ACTIVE_STATUSES.has(String(operation?.status || '').toLowerCase());
  }

  function timeOf(operation) {
    const t = operation?.completedAt || operation?.updatedAt || operation?.timestamp || operation?.startedAt;
    const ms = t ? Date.parse(t) : NaN;
    return Number.isNaN(ms) ? 0 : ms;
  }

  function selectActiveOperation(operations) {
    if (!Array.isArray(operations)) return null;
    const active = operations.filter(isActive);
    if (!active.length) return null;
    return active.slice().sort((a, b) => timeOf(b) - timeOf(a))[0];
  }

  function recentTerminalOperations(operations, limit = 3) {
    if (!Array.isArray(operations)) return [];
    return operations
      .filter(op => op && !isActive(op))
      .slice()
      .sort((a, b) => timeOf(b) - timeOf(a))
      .slice(0, limit);
  }

  // ── Pipeline mapping ───────────────────────────────────────────────────────
  // The backend does not emit granular per-stage events, so the pipeline is
  // derived conservatively from the operation's lifecycle status. An operation
  // record is only created once the Approver has scored risk and submitted the
  // tool — so Request and Risk are already satisfied for anything that reached
  // Execute. Failure stops at the failing stage and is never promoted to a
  // completion checkmark.
  function stageMapFor(status) {
    switch (status) {
      case 'running':
        return { request: 'succeeded', risk: 'succeeded', execute: 'active', verify: 'pending', complete: 'pending' };
      case 'awaiting-approval':
        return { request: 'succeeded', risk: 'awaiting-approval', execute: 'pending', verify: 'pending', complete: 'pending' };
      case 'failed':
        return { request: 'succeeded', risk: 'succeeded', execute: 'failed', verify: 'pending', complete: 'pending' };
      case 'partial':
        return { request: 'succeeded', risk: 'succeeded', execute: 'succeeded', verify: 'succeeded', complete: 'partial' };
      case 'succeeded':
        return { request: 'succeeded', risk: 'succeeded', execute: 'succeeded', verify: 'succeeded', complete: 'succeeded' };
      default:
        return { request: 'pending', risk: 'pending', execute: 'pending', verify: 'pending', complete: 'pending' };
    }
  }

  function mapPipeline(operation) {
    if (!operation) {
      return PIPELINE_STAGES.map(id => ({ id, label: STAGE_LABELS[id], state: 'pending' }));
    }
    const states = stageMapFor(normalizeStatus(operation));
    return PIPELINE_STAGES.map(id => ({ id, label: STAGE_LABELS[id], state: states[id] }));
  }

  // ── Presentation formatting ────────────────────────────────────────────────
  const AGENT_ACTIONS = {
    joiner: 'Provisioning',
    enroller: 'Enrolling',
    mover: 'Moving',
    leaver: 'Offboarding',
    provisioner: 'Provisioning',
    approver: 'Processing',
  };

  function subjectName(operation) {
    const subject = operation?.subject || 'the identity';
    return String(subject).split('@')[0] || subject;
  }

  function titleFor(operation) {
    if (!operation) return 'No active operation';
    const agent = String(operation.agent || '').toLowerCase();
    const stage = String(operation.stage || '').toLowerCase();
    let verb = AGENT_ACTIONS[agent] || 'Processing';
    if (agent === 'leaver' && stage === 'hard') verb = 'Removing access for';
    if (agent === 'mover') verb = 'Moving';
    return `${verb} ${subjectName(operation)}`;
  }

  function eyebrowFor(mode, operation) {
    if (mode === 'idle') return 'FLEET READY';
    const status = normalizeStatus(operation);
    switch (status) {
      case 'running': return 'LIVE OPERATION';
      case 'awaiting-approval': return 'AWAITING APPROVAL';
      case 'failed': return 'ACTION FAILED';
      default: return 'COMPLETED';
    }
  }

  function metadataFor(operation) {
    if (!operation) return { agent: null, operator: null, mode: null, ticket: null };
    return {
      agent: operation.agent ? String(operation.agent).toUpperCase() : null,
      operator: operation.operator ? String(operation.operator).toUpperCase() : null,
      mode: operation.whatif ? 'SAFE' : 'LIVE',
      ticket: operation.details?.ticketRef || operation.ticketRef || null,
    };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function elapsedLabelFor(operation, now) {
    if (!operation) return '';
    const start = operation.startedAt ? Date.parse(operation.startedAt) : NaN;
    if (Number.isNaN(start)) return '';
    const end = operation.completedAt ? Date.parse(operation.completedAt) : now;
    const secs = Math.max(0, Math.round((end - start) / 1000));
    const mins = Math.floor(secs / 60);
    return `${pad2(mins)}:${pad2(secs % 60)}`;
  }

  // Plain-language activity sentence. Centralized so raw tool names never leak
  // into the hero. Failure surfaces a cleaned, bounded error phrase.
  const RUNNING_DECISIONS = {
    joiner: 'Creating the Entra identity',
    provisioner: 'Provisioning licenses and group access',
    enroller: 'Enrolling the credential',
    mover: 'Applying manager and group changes',
  };

  function leaverRunningDecision(stage) {
    return stage === 'hard'
      ? 'Removing licenses and group memberships'
      : 'Disabling the account and revoking sessions';
  }

  function cleanError(error) {
    if (!error) return '';
    const firstLine = String(error).split('\n')[0].trim();
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
  }

  function failureDecision(operation) {
    const error = cleanError(operation?.error);
    if (/certificate|cert\b/i.test(error)) return 'Graph certificate authentication failed';
    if (/auth|token|credential|401|403/i.test(error)) return 'Graph authentication failed';
    if (error) return error;
    return 'The operation failed before completion';
  }

  function formatCurrentDecision(operation) {
    if (!operation) return 'Live actions will appear here automatically';
    const status = normalizeStatus(operation);
    const agent = String(operation.agent || '').toLowerCase();
    const stage = String(operation.stage || '').toLowerCase();
    switch (status) {
      case 'running':
        if (agent === 'leaver') return leaverRunningDecision(stage);
        return RUNNING_DECISIONS[agent] || 'Executing the requested change';
      case 'awaiting-approval':
        return 'Waiting for a second approver';
      case 'failed':
        return failureDecision(operation);
      case 'partial':
        return 'Completed with follow-ups remaining';
      case 'succeeded':
        return 'Verified account and group membership';
      default:
        return 'Live actions will appear here automatically';
    }
  }

  function recoveryFor(operation) {
    if (!operation) return null;
    const status = normalizeStatus(operation);
    const agent = String(operation.agent || '').toLowerCase();
    if (status === 'failed') {
      const committed = agent === 'joiner'
        ? 'No identity was created.'
        : 'No tenant change was committed.';
      return {
        tone: 'failed',
        message: `${failureDecision(operation)}. ${committed}`,
        detail: cleanError(operation.error) || null,
        action: { label: 'Open Security', target: 'security' },
      };
    }
    if (status === 'partial') {
      return {
        tone: 'partial',
        message: 'Core change applied; follow-up remains.',
        detail: cleanError(operation.error) || 'Some group or license assignments need a retry.',
        action: { label: 'Open Operations', target: 'operations' },
      };
    }
    return null;
  }

  function relativeTime(operation, now) {
    const ms = timeOf(operation);
    if (!ms) return '—';
    const diff = Math.max(0, now - ms);
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  }

  function outcomeKey(operation) {
    const status = normalizeStatus(operation);
    if (status === 'failed') return 'failed';
    if (status === 'partial') return 'partial';
    if (status === 'awaiting-approval') return 'awaiting';
    return 'success';
  }

  function recentRowFor(operation, now) {
    return {
      id: operation.id || null,
      outcome: outcomeKey(operation),
      title: titleFor(operation),
      subject: subjectName(operation),
      agent: operation.agent ? String(operation.agent).toUpperCase() : '—',
      mode: operation.whatif ? 'Safe' : 'Live',
      relative: relativeTime(operation, now),
    };
  }

  function buildGlassScreenViewModel({ operations = [], selectedId = null, now = Date.now() } = {}) {
    const active = selectActiveOperation(operations);
    const recentOps = recentTerminalOperations(operations, 3);

    let mode;
    let operation;
    if (active) {
      // Live always wins — a fresh live operation interrupts any historical
      // replay the user had selected.
      mode = 'live';
      operation = active;
    } else if (selectedId) {
      operation = operations.find(o => o && o.id === selectedId) || null;
      mode = operation ? 'replay' : 'idle';
    } else {
      mode = 'idle';
      operation = recentOps[0] || null;
    }

    return {
      mode,
      operation,
      eyebrow: eyebrowFor(mode, operation),
      title: titleFor(operation),
      metadata: metadataFor(operation),
      elapsedLabel: elapsedLabelFor(operation, now),
      currentDecision: mode === 'idle' && operation
        ? 'Live actions will appear here automatically'
        : formatCurrentDecision(operation),
      // A failed or partial last-completed run keeps its follow-up visible even
      // while the fleet is idle — recoveryFor returns null for clean successes.
      recovery: recoveryFor(operation),
      // In idle, `operation` is the last completed run (or null when there is
      // no history at all) — either way mapPipeline tells the truth.
      stages: mapPipeline(operation),
      recent: recentOps.map(o => recentRowFor(o, now)),
    };
  }

  const api = {
    PIPELINE_STAGES,
    STAGE_LABELS,
    selectActiveOperation,
    recentTerminalOperations,
    buildGlassScreenViewModel,
    formatCurrentDecision,
    mapPipeline,
    normalizeStatus,
    titleFor,
    eyebrowFor,
    metadataFor,
    elapsedLabelFor,
    recoveryFor,
    relativeTime,
    isActiveOperation: isActive,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.JmlGlassScreenModel = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

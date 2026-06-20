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

  // ── Per-stage detail ───────────────────────────────────────────────────────
  // The pipeline shows WHAT advanced; this fills in WHAT each stage actually
  // does for a given operation — the concrete Graph calls, risk checks,
  // verification read-backs, and audit seal. These activities are deterministic
  // from the agent + tool (they ARE the calls each agent makes), so the detail
  // is accurate without the backend emitting granular per-stage events.

  const STAGE_OWNERS = {
    request:  'Operator',
    risk:     'Approver agent',
    execute:  null,            // per-agent, resolved below
    verify:   'Auditor agent',
    complete: 'Audit chain',
  };

  const STAGE_PURPOSE = {
    request:  'Operator captures intent and submits the change under their identity.',
    risk:     'Approver scores risk, checks policy, and gates the operation.',
    execute:  'The lifecycle agent applies the change to Microsoft Entra over Graph.',
    verify:   'Auditor reads tenant state back to confirm the change landed.',
    complete: 'Outcome is hash-chained to the audit log and replicated to SIEM.',
  };

  // The Graph calls each agent performs in Execute, keyed by agent (+ leaver stage).
  function executeCalls(operation) {
    const agent = String(operation?.agent || '').toLowerCase();
    const stage = String(operation?.stage || '').toLowerCase();
    switch (agent) {
      case 'joiner': return [
        { name: 'POST /users', note: 'create the Entra identity' },
        { name: 'POST /users/{id}/assignLicense', note: 'assign licenses' },
        { name: 'POST /groups/{id}/members/$ref', note: 'add group memberships' },
      ];
      case 'mover': return [
        { name: 'PATCH /users/{id}', note: 'update department, title, manager' },
        { name: 'POST /users/{id}/assignLicense', note: 'add / remove licenses' },
        { name: 'POST · DELETE /groups/{id}/members', note: 'reconcile group membership' },
      ];
      case 'leaver': return stage === 'hard'
        ? [
            { name: 'POST /users/{id}/assignLicense', note: 'remove all licenses' },
            { name: 'DELETE /groups/{id}/members/{uid}', note: 'remove group memberships' },
          ]
        : [
            { name: 'PATCH /users/{id}', note: 'set accountEnabled = false' },
            { name: 'POST /users/{id}/revokeSignInSessions', note: 'revoke active sessions' },
          ];
      case 'enroller': return [
        { name: 'POST /deviceManagement/enroll', note: 'enroll the device' },
        { name: 'POST /groups/{id}/members/$ref', note: 'add to compliance group' },
      ];
      default: return [
        { name: 'Microsoft Graph', note: 'apply the requested change' },
      ];
    }
  }

  function verifyChecks(operation) {
    const agent = String(operation?.agent || '').toLowerCase();
    if (agent === 'leaver') return [
      { name: 'GET /users/{id}?$select=accountEnabled', note: 'confirm account disabled' },
      { name: 'GET /users/{id}/licenseDetails', note: 'confirm licenses removed' },
      { name: 'GET /users/{id}/memberOf', note: 'confirm group removal' },
    ];
    return [
      { name: 'GET /users/{id}', note: 'confirm attributes applied' },
      { name: 'GET /users/{id}/licenseDetails', note: 'confirm license state' },
      { name: 'GET /users/{id}/memberOf', note: 'confirm group membership' },
    ];
  }

  // Map a stage's lifecycle state onto an activity status.
  function activityStatusFor(stageState) {
    if (stageState === 'succeeded') return 'done';
    if (stageState === 'active')    return 'running';
    if (stageState === 'failed')    return 'failed';
    if (stageState === 'partial')   return 'partial';
    if (stageState === 'awaiting-approval') return 'awaiting';
    return 'pending';
  }

  function stageDetail(stageId, operation, now = Date.now()) {
    const stages = mapPipeline(operation);
    const stage  = stages.find(s => s.id === stageId);
    if (!stage) return null;
    const st  = stage.state;
    const aSt = activityStatusFor(st);
    const meta = metadataFor(operation);
    let activities = [];

    switch (stageId) {
      case 'request':
        activities = [
          { name: 'Operator intent', note: titleFor(operation), status: 'done' },
          { name: 'Mode', note: meta.mode === 'SAFE' ? 'Safe (WhatIf) — no tenant writes' : 'Live', status: 'done' },
          { name: 'Ticket', note: meta.ticket || 'none', status: meta.ticket ? 'done' : 'pending' },
        ];
        break;
      case 'risk': {
        activities = [
          { name: 'Invoke-RiskScore.ps1', note: 'baseline risk, sensitive licenses/groups', status: aSt },
          { name: 'SoD policy check', note: 'separation-of-duties conflicts', status: aSt },
          { name: 'Freeze-window check', note: 'active change-freeze policy', status: aSt },
        ];
        const g = operation?.grounding;
        if (g && !g.unavailable) {
          activities.push({ name: 'Foundry IQ grounding', note: (g.citations || []).map(c => c.title).filter(Boolean).join(', ') || 'policy corpus', status: 'done' });
        } else if (g && g.unavailable) {
          activities.push({ name: 'Foundry IQ grounding', note: 'unavailable — failed closed', status: 'failed' });
        }
        if (st === 'awaiting-approval') {
          activities.push({ name: 'Dual approval', note: 'awaiting a second approver', status: 'awaiting' });
        }
        break;
      }
      case 'execute':
        activities = executeCalls(operation).map(c => ({ ...c, status: aSt }));
        break;
      case 'verify':
        activities = verifyChecks(operation).map(c => ({ ...c, status: aSt }));
        break;
      case 'complete':
        activities = [
          { name: 'Write-AuditEntry', note: 'hash-chained JSONL + Windows Event Log', status: aSt === 'pending' ? 'pending' : 'done' },
          { name: 'Sentinel · Blob export', note: 'replicate evidence to SIEM', status: aSt === 'pending' ? 'pending' : 'done' },
          { name: 'Audit hash', note: operation?.hash || 'sealed on completion', status: operation?.hash ? 'done' : (aSt === 'pending' ? 'pending' : 'done') },
        ];
        break;
      default:
        activities = [];
    }

    const owner = STAGE_OWNERS[stageId] ||
      (operation?.agent ? String(operation.agent).toUpperCase() + ' agent' : 'agent');

    return {
      id: stageId,
      label: stage.label,
      state: st,
      stateLabel: st,
      owner,
      purpose: STAGE_PURPOSE[stageId] || '',
      activities,
    };
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
    // Certifier subjects are often raw group GUIDs — keep the title readable.
    if (agent === 'certifier') {
      const subj = subjectName(operation);
      const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subj);
      return isGuid ? 'Access review' : `Access review · ${subj}`;
    }
    let verb = AGENT_ACTIONS[agent] || 'Processing';
    if (agent === 'leaver' && stage === 'hard') verb = 'Removing access for';
    if (agent === 'leaver' && stage === 'delete') verb = 'Deleting';
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
    if (stage === 'delete') return 'Permanently deleting the account';
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
    if (status === 'awaiting-approval') {
      return {
        tone: 'partial',
        message: 'This action is held until a second approver releases it.',
        detail: null,
        action: { label: 'Open Approvals', target: 'approvals' },
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

  // Past-tense "what it did" line for a finished run, mirroring the running
  // decisions above. Agent-aware so the recent strip reads as an outcome, not
  // a raw status. Failures reuse the cleaned error phrase.
  const DONE_SUMMARIES = {
    joiner: 'Created the Entra identity and applied starter access',
    provisioner: 'Provisioned licenses and group access',
    enroller: 'Enrolled the credential',
    mover: 'Applied manager and group changes',
    certifier: 'Recertified group access',
  };

  function leaverDoneSummary(stage) {
    if (stage === 'delete') return 'Permanently deleted the account';
    return stage === 'hard'
      ? 'Removed licenses and group memberships'
      : 'Disabled the account and revoked sessions';
  }

  function recentSummaryFor(operation) {
    const status = normalizeStatus(operation);
    const agent = String(operation.agent || '').toLowerCase();
    const stage = String(operation.stage || '').toLowerCase();
    if (status === 'failed') return failureDecision(operation);
    if (status === 'partial') return 'Core change applied; follow-up remains';
    if (status === 'awaiting-approval') return 'Held for a second approver';
    if (agent === 'leaver') return leaverDoneSummary(stage);
    return DONE_SUMMARIES[agent] || 'Completed the requested change';
  }

  function recentRowFor(operation, now) {
    return {
      id: operation.id || null,
      outcome: outcomeKey(operation),
      title: titleFor(operation),
      subject: subjectName(operation),
      summary: recentSummaryFor(operation),
      agent: operation.agent ? String(operation.agent).toUpperCase() : '—',
      operator: operation.operator ? String(operation.operator).split('@')[0] : '—',
      mode: operation.whatif ? 'Safe' : 'Live',
      relative: relativeTime(operation, now),
      when: timeOf(operation) ? new Date(timeOf(operation)).toLocaleString() : '',
    };
  }

  // A terminal operation keeps owning the hero (ACTION FAILED / COMPLETED)
  // for a short window after it finishes, so the outcome is readable before
  // the page relaxes to FLEET READY.
  const RECENT_HOLD_MS = 10 * 60 * 1000;

  // Recent-runs filter: by write mode (live/safe) and/or outcome. Applies only
  // to the recent list — the live hero always reflects the active operation.
  function matchesRecentFilter(op, f) {
    if (!f) return true;
    if (f.mode === 'live' && op.whatif) return false;
    if (f.mode === 'safe' && !op.whatif) return false;
    if (f.outcome && f.outcome !== 'all' && outcomeKey(op) !== f.outcome) return false;
    if (f.agent && f.agent !== 'all' && String(op.agent || '').toLowerCase() !== f.agent) return false;
    return true;
  }

  function buildGlassScreenViewModel({ operations = [], selectedId = null, now = Date.now(), recentLimit = 3, recentFilter = null, recentSort = 'recent' } = {}) {
    // Only a RUNNING operation owns the live hero. A pending approval is not a
    // "run that's going" — it never dominates the default state; it appears in
    // the recent-runs list (⏸ held) instead, keeping tab entry clean.
    const running = operations
      .filter(o => o && normalizeStatus(o) === 'running')
      .sort((a, b) => timeOf(b) - timeOf(a))[0] || null;
    // Recent list = everything not currently running (awaiting, succeeded,
    // failed, partial), newest first.
    const nonRunning = operations
      .filter(o => o && normalizeStatus(o) !== 'running')
      .sort((a, b) => timeOf(b) - timeOf(a));
    let recentPool = nonRunning;
    if (recentFilter) recentPool = recentPool.filter(o => matchesRecentFilter(o, recentFilter));
    // Sort by JML operation (agent A→Z, newest within each) when requested;
    // otherwise keep the default newest-first ordering.
    if (recentSort === 'operation') {
      recentPool = recentPool.slice().sort((a, b) => {
        const ag = String(a.agent || '').toLowerCase().localeCompare(String(b.agent || '').toLowerCase());
        return ag !== 0 ? ag : timeOf(b) - timeOf(a);
      });
    }
    const recentOps = recentPool.slice(0, recentLimit);

    let mode;
    let operation;
    let recentHold = false;
    const selectedOp = selectedId ? (operations.find(o => o && o.id === selectedId) || null) : null;
    if (running) {
      // A live running op always owns the page (even over a historical selection).
      mode = 'live';
      operation = running;
    } else if (selectedOp) {
      operation = selectedOp;
      mode = 'replay';
    } else {
      // Idle: clean Fleet Ready, optionally holding the last COMPLETED run for a
      // short window. Pending approvals are skipped here so they never own the hero.
      mode = 'idle';
      operation = nonRunning.find(o => ['succeeded', 'failed', 'partial'].includes(normalizeStatus(o))) || null;
      recentHold = Boolean(operation) && (now - timeOf(operation)) < RECENT_HOLD_MS;
    }

    return {
      mode,
      operation,
      eyebrow: recentHold ? eyebrowFor('live', operation) : eyebrowFor(mode, operation),
      title: titleFor(operation),
      metadata: metadataFor(operation),
      elapsedLabel: elapsedLabelFor(operation, now),
      currentDecision: mode === 'idle' && operation && !recentHold
        ? 'Live actions will appear here automatically'
        : formatCurrentDecision(operation),
      // A failed or partial last-completed run keeps its follow-up visible even
      // while the fleet is idle — recoveryFor returns null for clean successes.
      recovery: recoveryFor(operation),
      // In idle, `operation` is the last completed run (or null when there is
      // no history at all) — either way mapPipeline tells the truth.
      stages: mapPipeline(operation),
      recent: recentOps.map(o => recentRowFor(o, now)),
      recentTotal: nonRunning.length,
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
    stageDetail,
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

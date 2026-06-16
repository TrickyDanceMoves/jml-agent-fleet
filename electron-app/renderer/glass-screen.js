'use strict';

/*
 * Glass Screen Command Center controller.
 *
 * Owns the controller state (operations, selection, replay) and all DOM
 * rendering for the Command Center view. Lifecycle truth comes exclusively
 * from glass-screen-model.js; this module decides *when* to re-render and
 * orchestrates one-shot, state-driven motion. Pure state helpers
 * (mergeOperationUpdate, liveOperationInterruptsReplay, enrichOperation,
 * detailsRowsForOperation) are exported for the Node test runner.
 */

(function (global) {
  const model = (typeof module !== 'undefined' && module.exports)
    ? require('./glass-screen-model')
    : global.JmlGlassScreenModel;

  // ── Pure state helpers ─────────────────────────────────────────────────────

  function recordTime(op) {
    const t = op?.updatedAt || op?.completedAt || op?.timestamp || op?.startedAt;
    const ms = t ? Date.parse(t) : NaN;
    return Number.isNaN(ms) ? 0 : ms;
  }

  // Replace the same operation id only with a fresher record; unknown ids are
  // prepended (newest first). Stale or out-of-order IPC events never regress
  // a terminal record back to running.
  function mergeOperationUpdate(operations, update) {
    const list = Array.isArray(operations) ? operations.slice() : [];
    if (!update || !update.id) return list;
    const idx = list.findIndex(op => op && op.id === update.id);
    if (idx === -1) return [update, ...list];
    if (recordTime(update) < recordTime(list[idx])) return list;
    list[idx] = update;
    return list;
  }

  // A live (running / awaiting approval) update interrupts any historical
  // replay the user had selected; terminal updates never steal the page.
  function liveOperationInterruptsReplay(selectedId, operation) {
    return Boolean(selectedId) && model.isActiveOperation(operation);
  }

  function sanitizeRaw(text, max = 600) {
    if (!text) return '';
    let s = String(text)
      .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g'), '')
      .split('')
      .filter(ch => {
        const c = ch.charCodeAt(0);
        return !(c <= 8 || (c >= 11 && c <= 31) || c === 127);
      })
      .join('');
    if (s.length > max) s = s.slice(0, max - 1) + '…';
    return s;
  }

  // Attach audit evidence (hash, ticket, action) to an operation record
  // without ever letting an audit row overwrite the operation's own
  // status/outcome/error — operation-status IPC is always fresher.
  function enrichOperation(operation, auditEntries) {
    if (!operation || !Array.isArray(auditEntries) || !auditEntries.length) return operation;
    const opTime = Date.parse(operation.startedAt || operation.updatedAt || 0) || 0;
    const match = auditEntries.find(e => e && e.id && e.id === operation.id)
      || auditEntries.find(e => {
        if (!e || !e.subject || e.subject !== operation.subject) return false;
        const t = Date.parse(e.timestamp || 0) || 0;
        return Math.abs(t - opTime) < 5 * 60 * 1000;
      });
    if (!match) return operation;
    return {
      ...operation,
      hash: operation.hash || match.hash || null,
      action: operation.action || match.action || null,
      details: {
        ...(match.details || {}),
        ...(operation.details || {}),
      },
    };
  }

  function fmtTs(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
  }

  // Structured evidence rows for the details drawer. Bounded, sanitized,
  // never an unstructured dump.
  function detailsRowsForOperation(operation, auditEntries) {
    if (!operation) return [];
    const op = enrichOperation(operation, auditEntries || []);
    const rows = [];
    const push = (label, value) => { if (value) rows.push({ label, value: String(value) }); };
    push('Started', fmtTs(op.startedAt || op.timestamp));
    push('Completed', fmtTs(op.completedAt));
    push('Agent', op.agent ? String(op.agent).toUpperCase() : null);
    push('Tool call', op.toolName || op.action || null);
    push('Lifecycle stage', op.stage || null);
    push('Subject', op.subject || null);
    push('Operator', op.operator || null);
    push('Mode', op.whatif === undefined ? null : (op.whatif ? 'Safe (WhatIf)' : 'Live'));
    push('Ticket', op.details?.ticketRef || op.ticketRef || null);
    push('Outcome', op.outcome || model.normalizeStatus(op));
    // Foundry IQ policy grounding — names the Microsoft IQ layer and its citations
    if (op.grounding) {
      if (op.grounding.unavailable) {
        push('Policy grounding', 'Foundry IQ unavailable — failed closed');
      } else {
        const cites = (op.grounding.citations || []).map(c => c.title).filter(Boolean).join(', ');
        push('Policy grounding', 'Foundry IQ' + (cites ? ' — ' + cites : ''));
        if (op.grounding.summary) push('Policy finding', sanitizeRaw(op.grounding.summary, 300));
      }
    }
    push('Raw error', sanitizeRaw(op.error));
    push('Audit hash', op.hash || null);
    return rows;
  }

  // ── Controller state ───────────────────────────────────────────────────────

  const glassScreenState = {
    operations: [],
    auditEntries: [],
    selectedId: null,
    selectedStageId: null,   // pinned pipeline stage for the detail card
    detailOpId: null,        // which operation the stage selection belongs to
    replaying: false,
    replayDone: false,
    recentExpanded: false,   // "show all runs" toggle for the recent-runs list
    lastRenderedStageKey: null,
    replayTimers: [],
    elapsedTimer: null,
  };

  function clearReplayTimers() {
    glassScreenState.replayTimers.forEach(t => clearTimeout(t));
    glassScreenState.replayTimers = [];
    glassScreenState.replaying = false;
  }

  // ── DOM rendering ──────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function el(id) {
    return (typeof document !== 'undefined') ? document.getElementById(id) : null;
  }

  function goTab(tab) {
    if (typeof global.switchTab === 'function') global.switchTab(tab);
  }

  const STAGE_GLYPHS = {
    pending: '○',
    active: '●',
    succeeded: '✓',
    partial: '◐',
    failed: '✕',
    'awaiting-approval': '⏸',
  };

  // Identity icons: each pipeline stage shows WHO owns it, not just state.
  // State is carried by orb color + the corner badge + the text sub-label.
  const ICON_SVG = (paths, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" ${extra}>${paths}</svg>`;

  const AGENT_ICONS = {
    joiner: ICON_SVG('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/>'),
    mover: ICON_SVG('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    leaver: ICON_SVG('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="16" y1="11" x2="22" y2="11"/>'),
    enroller: ICON_SVG('<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/>'),
    provisioner: ICON_SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    approver: ICON_SVG('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>'),
    auditor: ICON_SVG('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  };

  const STAGE_OWNER_ICONS = {
    request: op => `<span class="gs-op-initial">${esc(String(op?.operator || 'O').charAt(0).toUpperCase())}</span>`,
    risk: () => AGENT_ICONS.approver,
    execute: op => AGENT_ICONS[String(op?.agent || '').toLowerCase()] || AGENT_ICONS.provisioner,
    verify: () => AGENT_ICONS.auditor,
    complete: () => ICON_SVG('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  };

  // Corner badge keeps the state readable on top of the identity icon.
  const BADGE_GLYPHS = {
    succeeded: '✓',
    partial: '◐',
    failed: '✕',
    'awaiting-approval': '⏸',
  };

  const STAGE_STATE_LABELS = {
    pending: 'pending',
    active: 'in progress',
    succeeded: 'done',
    partial: 'partial',
    failed: 'failed',
    'awaiting-approval': 'awaiting approval',
  };

  function reachedState(state) {
    return state !== 'pending';
  }

  function renderPipeline(stages, enteredStageId, operation) {
    const wrap = el('gs-pipeline');
    if (!wrap) return;

    // In-place patch when the same stage set is already on screen: only update
    // each stage's data-state (and connector fill) on the EXISTING nodes so the
    // CSS transitions on .gs-stage-orb actually animate between frames. A full
    // innerHTML rebuild (below) makes brand-new nodes that can't transition —
    // which is why the replay looked instant instead of easing stage to stage.
    const existing = wrap.querySelectorAll('.gs-stage');
    const sameSet = existing.length === stages.length &&
      stages.every((s, i) => existing[i].dataset.stageId === String(s.id));
    if (sameSet) {
      const fills = wrap.querySelectorAll('.gs-connector-fill');
      stages.forEach((s, i) => {
        const btn = existing[i];
        if (btn.dataset.state !== String(s.state)) {
          btn.dataset.state = s.state;
          const orb = btn.querySelector('.gs-stage-orb');
          if (orb) {
            const icon = (STAGE_OWNER_ICONS[s.id] || (() => STAGE_GLYPHS[s.state] || '○'))(operation);
            const badge = BADGE_GLYPHS[s.state]
              ? `<span class="gs-stage-badge" data-state="${esc(s.state)}">${BADGE_GLYPHS[s.state]}</span>` : '';
            orb.innerHTML = icon + badge;
          }
          const st = btn.querySelector('.gs-stage-state');
          if (st) st.textContent = STAGE_STATE_LABELS[s.state] || '';
        }
        btn.dataset.entered = String(s.id === enteredStageId);
        btn.dataset.selected = String(s.id === glassScreenState.selectedStageId);
        if (i > 0 && fills[i - 1]) fills[i - 1].dataset.filled = String(reachedState(s.state));
      });
      return; // existing click/hover listeners stay valid on the same nodes
    }

    const parts = [];
    stages.forEach((s, i) => {
      if (i > 0) {
        const filled = reachedState(s.state);
        parts.push(`<div class="gs-connector"><div class="gs-connector-fill" data-filled="${filled}"></div></div>`);
      }
      const entered = s.id === enteredStageId;
      const icon = (STAGE_OWNER_ICONS[s.id] || (() => STAGE_GLYPHS[s.state] || '○'))(operation);
      const badge = BADGE_GLYPHS[s.state]
        ? `<span class="gs-stage-badge" data-state="${esc(s.state)}">${BADGE_GLYPHS[s.state]}</span>`
        : '';
      const selected = s.id === glassScreenState.selectedStageId;
      parts.push(`
        <button class="gs-stage" type="button" role="listitem" tabindex="0"
             data-stage-id="${esc(s.id)}" data-state="${esc(s.state)}" data-entered="${entered}"
             data-selected="${selected}"
             aria-label="${esc(s.label)} stage: ${esc(STAGE_STATE_LABELS[s.state] || s.state)}. Select for detail.">
          <div class="gs-stage-orb" aria-hidden="true">${icon}${badge}</div>
          <div class="gs-stage-label">${esc(s.label)}</div>
          <div class="gs-stage-state">${esc(STAGE_STATE_LABELS[s.state] || '')}</div>
        </button>`);
    });
    wrap.innerHTML = parts.join('');

    // Hover previews and click/keyboard selects the stage detail. Hover is
    // transient (restores the selected stage on leave); click pins it.
    wrap.querySelectorAll('.gs-stage').forEach(btn => {
      const id = btn.dataset.stageId;
      btn.addEventListener('mouseenter', () => renderStageDetail(id, operation, true));
      btn.addEventListener('mouseleave', () => renderStageDetail(glassScreenState.selectedStageId, operation, false));
      btn.addEventListener('focus', () => renderStageDetail(id, operation, true));
      btn.addEventListener('click', () => {
        glassScreenState.selectedStageId = (glassScreenState.selectedStageId === id) ? null : id;
        renderPipeline(stagesCache.stages, null, operation);
        renderStageDetail(glassScreenState.selectedStageId, operation, false);
      });
    });
  }

  // Cache the last-rendered stages so a click can re-render the pipeline
  // (to update the selected ring) without recomputing the view model.
  const stagesCache = { stages: [] };

  // Renders the per-stage detail card below the pipeline. `transient` hover
  // previews don't change the pinned selection.
  function renderStageDetail(stageId, operation, transient) {
    const box = el('gs-stage-detail');
    if (!box) return;
    if (!stageId || !operation) {
      if (!transient) { box.hidden = true; box.innerHTML = ''; }
      return;
    }
    const d = model.stageDetail(stageId, operation);
    if (!d) { box.hidden = true; box.innerHTML = ''; return; }
    const acts = (d.activities || []).map(a => `
      <li class="gs-act" data-status="${esc(a.status || 'pending')}">
        <span class="gs-act-dot" aria-hidden="true"></span>
        <span class="gs-act-name">${esc(a.name)}</span>
        <span class="gs-act-note">${esc(a.note || '')}</span>
      </li>`).join('');
    box.hidden = false;
    box.dataset.state = d.state;
    box.innerHTML = `
      <div class="gs-stage-detail-head">
        <span class="gs-sd-label">${esc(d.label)}</span>
        <span class="gs-sd-owner">${esc(d.owner)}</span>
        <span class="gs-sd-state" data-state="${esc(d.state)}">${esc(STAGE_STATE_LABELS[d.state] || d.state)}</span>
      </div>
      <div class="gs-sd-purpose">${esc(d.purpose)}</div>
      <ul class="gs-act-list">${acts}</ul>`;
  }

  function metaChips(vm) {
    const m = vm.metadata || {};
    const chips = [];
    if (m.agent) chips.push(`<span class="gs-chip">${esc(m.agent)}</span>`);
    if (m.operator) chips.push(`<span class="gs-chip">${esc(m.operator)}</span>`);
    if (m.mode) chips.push(`<span class="gs-chip" data-mode="${m.mode === 'LIVE' ? 'live' : 'safe'}">${esc(m.mode)}</span>`);
    if (m.ticket) chips.push(`<span class="gs-chip">${esc(m.ticket)}</span>`);
    if (vm.mode === 'replay') chips.push('<span class="gs-chip gs-chip-replay">REPLAY</span>');
    return chips.join('');
  }

  function renderRecovery(vm) {
    const box = el('gs-recovery');
    if (!box) return;
    const r = vm.recovery;
    if (!r) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.dataset.tone = r.tone;
    box.innerHTML = `
      <div class="gs-recovery-msg">${esc(r.message)}</div>
      ${r.detail ? `<div class="gs-recovery-detail">${esc(r.detail)}</div>` : ''}
      ${r.action ? `<button class="btn ghost gs-recovery-action" data-target="${esc(r.action.target)}">${esc(r.action.label)}</button>` : ''}`;
    box.querySelector('.gs-recovery-action')?.addEventListener('click', ev => {
      goTab(ev.currentTarget.dataset.target);
    });
  }

  function renderRecent(vm) {
    const list = el('gs-recent-runs');
    if (!list) return;
    if (!vm.recent.length) {
      list.innerHTML = '<div class="gs-recent-empty">No completed runs yet — live actions will appear here automatically.</div>';
      return;
    }
    list.innerHTML = vm.recent.map(r => `
      <button class="gs-recent-run${r.id && r.id === glassScreenState.selectedId ? ' sel' : ''}" data-op-id="${esc(r.id || '')}">
        <span class="gs-run-outcome" data-outcome="${esc(r.outcome)}" aria-hidden="true">${STAGE_GLYPHS[r.outcome === 'success' ? 'succeeded' : r.outcome === 'awaiting' ? 'awaiting-approval' : r.outcome] || '✓'}</span>
        <span class="gs-run-title">${esc(r.title)}</span>
        <span class="gs-run-rel">${esc(r.relative)}</span>
        <span class="gs-run-agent">${esc(r.agent)}</span>
        <span class="gs-run-mode">${esc(r.mode)}</span>
        <span class="visually-hidden">outcome ${esc(r.outcome)}</span>
      </button>`).join('');
    list.classList.toggle('expanded', glassScreenState.recentExpanded);
    list.querySelectorAll('.gs-recent-run').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.opId;
        if (!id) return;
        // Clicking a run shows its END RESULT (final pipeline state). It does
        // not auto-replay — the operator drives the animation via the Replay
        // button, so the outcome stays put until they ask to watch it again.
        clearReplayTimers();
        glassScreenState.selectedId = id;
        glassScreenState.replaying = false;
        glassScreenState.replayDone = false;
        render();
      });
    });

    // Center expand/collapse arrow — reveals all runs when there are more than
    // the default few. Hidden when everything already fits.
    const toggle = el('gs-recent-expand');
    if (toggle) {
      const hasMore = (vm.recentTotal || 0) > 3;
      toggle.hidden = !hasMore;
      if (hasMore) {
        const expanded = glassScreenState.recentExpanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.innerHTML = expanded
          ? '<span class="gs-chevron up" aria-hidden="true">⌃</span><span>Show fewer</span>'
          : `<span class="gs-chevron" aria-hidden="true">⌄</span><span>Show all ${vm.recentTotal} runs</span>`;
        toggle.onclick = () => {
          glassScreenState.recentExpanded = !glassScreenState.recentExpanded;
          render();
        };
      }
    }
  }

  function renderDetails(vm) {
    const body = el('gs-details-body');
    if (!body) return;
    const rows = detailsRowsForOperation(vm.operation, glassScreenState.auditEntries);
    if (!rows.length) {
      body.innerHTML = '<div class="gs-recent-empty">No run selected.</div>';
      return;
    }
    body.innerHTML = `
      <dl class="gs-details-grid">
        ${rows.map(r => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join('')}
      </dl>
      <div class="gs-details-links">
        <button class="btn-text-link" data-target="operations">Operations</button>
        <button class="btn-text-link" data-target="approvals">Approvals</button>
        <button class="btn-text-link" data-target="security">Security</button>
        <button class="btn-text-link" data-target="audit-log">Audit Log</button>
      </div>`;
    body.querySelectorAll('[data-target]').forEach(btn => {
      btn.addEventListener('click', () => goTab(btn.dataset.target));
    });
  }

  function setText(id, text) {
    const node = el(id);
    if (node) node.textContent = text;
  }

  function stopElapsedTicker() {
    if (glassScreenState.elapsedTimer) {
      clearInterval(glassScreenState.elapsedTimer);
      glassScreenState.elapsedTimer = null;
    }
  }

  function startElapsedTicker(operation) {
    stopElapsedTicker();
    glassScreenState.elapsedTimer = setInterval(() => {
      setText('gs-elapsed', model.elapsedLabelFor(operation, Date.now()));
    }, 1000);
  }

  function render(overrideStages) {
    const hero = el('gs-live-hero');
    if (!hero) return;
    const vm = model.buildGlassScreenViewModel({
      operations: glassScreenState.operations,
      selectedId: glassScreenState.selectedId,
      recentLimit: glassScreenState.recentExpanded ? Infinity : 3,
    });

    hero.dataset.mode = vm.mode;
    hero.dataset.state = vm.operation ? model.normalizeStatus(vm.operation) : 'idle';
    if (vm.mode === 'idle' && !vm.operation) hero.dataset.state = 'idle';

    setText('gs-eyebrow', vm.eyebrow);
    setText('gs-title', vm.title);
    setText('gs-elapsed', vm.elapsedLabel);
    const meta = el('gs-meta');
    if (meta) meta.innerHTML = metaChips(vm);
    setText('gs-current-decision', vm.currentDecision);

    // One-shot entrance animation: only the stage that newly became active
    // gets data-entered, and only when the backend actually advanced.
    const stages = overrideStages || vm.stages;
    const activeStage = stages.find(s => s.state === 'active' || s.state === 'awaiting-approval' || s.state === 'failed');
    const stageKey = `${vm.operation?.id || 'none'}:${activeStage ? activeStage.id + ':' + activeStage.state : 'none'}`;
    const entered = stageKey !== glassScreenState.lastRenderedStageKey ? activeStage?.id : null;
    glassScreenState.lastRenderedStageKey = stageKey;

    // Drop a pinned stage selection when the operation itself changes.
    if (glassScreenState.detailOpId !== (vm.operation?.id || null)) {
      glassScreenState.detailOpId = vm.operation?.id || null;
      glassScreenState.selectedStageId = null;
    }
    stagesCache.stages = stages;
    renderPipeline(stages, entered, vm.operation);
    renderStageDetail(glassScreenState.selectedStageId, vm.operation, false);

    renderRecovery(vm);
    renderRecent(vm);
    renderDetails(vm);

    const replayBtn = el('gs-replay');
    if (replayBtn) {
      replayBtn.hidden = vm.mode !== 'replay';
      replayBtn.textContent = glassScreenState.replayDone ? 'Replay again' : 'Replay';
      replayBtn.disabled = glassScreenState.replaying;
    }

    if (vm.mode === 'live') startElapsedTicker(vm.operation);
    else stopElapsedTicker();
    return vm;
  }

  // ── Deliberate historical replay ───────────────────────────────────────────
  // Sequences only the known final stage states (650ms cadence). Stops at a
  // failure / approval stage and never pretends to be live execution.

  // Demo-tuned: each stage holds long enough to read its label and owner icon.
  // Slowed from 750ms so the pipeline is comfortable to follow on replay.
  const REPLAY_INTERVAL = 1200;

  function prefersReducedMotion() {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function runReplay() {
    const vm = model.buildGlassScreenViewModel({
      operations: glassScreenState.operations,
      selectedId: glassScreenState.selectedId,
    });
    if (vm.mode !== 'replay' || !vm.operation) return;
    clearReplayTimers();

    const finalStages = vm.stages;
    const stopIdx = (() => {
      const i = finalStages.findIndex(s => s.state === 'failed' || s.state === 'awaiting-approval');
      return i === -1 ? finalStages.length - 1 : i;
    })();

    if (prefersReducedMotion()) {
      glassScreenState.replayDone = true;
      render();
      return;
    }

    glassScreenState.replaying = true;
    glassScreenState.replayDone = false;
    const btn = el('gs-replay');
    if (btn) btn.disabled = true;

    // Start from the run's default state — all stages pending — so the
    // replay visibly travels the pipeline instead of jumping in fully lit.
    renderPipeline(finalStages.map(s => ({ ...s, state: 'pending' })), null, vm.operation);

    for (let step = 0; step <= stopIdx; step++) {
      const timer = setTimeout(() => {
        const frame = finalStages.map((s, i) => ({
          ...s,
          state: i < step ? s.state
            : i === step ? (step === stopIdx ? s.state : 'active')
            : 'pending',
        }));
        renderPipeline(frame, finalStages[step].id, vm.operation);
        if (step === stopIdx) {
          glassScreenState.replaying = false;
          glassScreenState.replayDone = true;
          render(finalStages);
        }
      }, REPLAY_INTERVAL * (step + 1));
      glassScreenState.replayTimers.push(timer);
    }
  }

  // ── Event entry points (wired from app.js) ─────────────────────────────────

  function onOperationStatus(operation) {
    if (!operation || !operation.id) return;
    if (liveOperationInterruptsReplay(glassScreenState.selectedId, operation)) {
      // A fresh live operation owns the page — drop replay selection.
      clearReplayTimers();
      glassScreenState.selectedId = null;
      glassScreenState.replayDone = false;
    }
    glassScreenState.operations = mergeOperationUpdate(glassScreenState.operations, operation);
    if (isViewActive()) render();
  }

  function onOperationStatuses(operations) {
    glassScreenState.operations = Array.isArray(operations) ? operations.slice() : [];
    if (isViewActive()) render();
  }

  function onAuditEntries(entries) {
    glassScreenState.auditEntries = Array.isArray(entries) ? entries.slice(0, 100) : [];
    // Audit-only history backfills recent runs when operation history is
    // sparse — synthesize ids so rows are selectable for replay.
    const known = new Set(glassScreenState.operations.map(o => o.id));
    const backfill = glassScreenState.auditEntries
      .filter(e => e && e.agent && e.subject && (!e.id || !known.has(e.id)))
      .slice(0, 10)
      .map(e => ({
        ...e,
        id: e.id || `audit-${e.hash || e.timestamp}`,
        status: null,
        _audit: true,
      }));
    for (const entry of backfill) {
      if (!known.has(entry.id)) {
        glassScreenState.operations = mergeOperationUpdate(glassScreenState.operations, entry);
        known.add(entry.id);
      }
    }
    if (isViewActive()) render();
  }

  function isViewActive() {
    return typeof document !== 'undefined'
      && document.getElementById('view-glass-screen')?.classList.contains('active');
  }

  function onShow() {
    try { global.api?.getOperationStatuses?.(); } catch {}
    try { global.api?.getAuditLog?.(); } catch {}
    render();
  }

  // ── Capture fixtures (screenshot QC) ───────────────────────────────────────

  function fixtureOps(name) {
    const now = Date.now();
    const iso = ms => new Date(now - ms).toISOString();
    const base = {
      agent: 'joiner', toolName: 'submit_joiner', stage: 'provision',
      subject: 'amelia.chen@contoso.com', operator: 'Nick', whatif: false,
    };
    const history = [
      { ...base, id: 'fx-h1', agent: 'leaver', toolName: 'submit_leaver_soft', stage: 'soft', subject: 'robert.martinez@contoso.com', operator: 'Helpdesk', whatif: true, status: 'succeeded', outcome: 'success', startedAt: iso(54e5), updatedAt: iso(54e5 - 42000), completedAt: iso(54e5 - 42000) },
      { ...base, id: 'fx-h2', agent: 'mover', toolName: 'submit_mover', stage: 'transfer', subject: 'lena.fischer@contoso.com', status: 'partial', outcome: 'partial', error: 'Two group assignments need a retry', startedAt: iso(18e6), updatedAt: iso(18e6 - 30000), completedAt: iso(18e6 - 30000) },
      { ...base, id: 'fx-h3', agent: 'enroller', toolName: 'submit_enroller', stage: 'enroll', subject: 'dev.patel@contoso.com', whatif: true, status: 'succeeded', outcome: 'success', startedAt: iso(36e6), updatedAt: iso(36e6 - 21000), completedAt: iso(36e6 - 21000) },
    ];
    switch (name) {
      case 'idle':
        return { ops: history, selectedId: null };
      case 'running':
        return { ops: [{ ...base, id: 'fx-run', status: 'running', startedAt: iso(78000), updatedAt: iso(2000), details: { ticketRef: 'INC-1042' } }, ...history], selectedId: null };
      case 'awaiting-approval':
        return { ops: [{ ...base, id: 'fx-app', agent: 'leaver', toolName: 'submit_leaver_hard', stage: 'hard', subject: 'robert.martinez@contoso.com', status: 'awaiting_approval', startedAt: iso(125000), updatedAt: iso(5000), details: { ticketRef: 'INC-1020' } }, ...history], selectedId: null };
      case 'failed':
        return { ops: [{ ...base, id: 'fx-fail', status: 'failed', outcome: 'failed', error: 'Certificate-based authentication to Microsoft Graph failed: AADSTS700027', startedAt: iso(94000), updatedAt: iso(8000), completedAt: iso(8000) }, ...history], selectedId: null };
      case 'partial':
        return { ops: [{ ...base, id: 'fx-part', agent: 'leaver', toolName: 'submit_leaver_hard', stage: 'hard', subject: 'robert.martinez@contoso.com', status: 'partial', outcome: 'partial', error: 'License removal succeeded; 2 of 7 group removals pending', startedAt: iso(150000), updatedAt: iso(12000), completedAt: iso(12000) }, ...history], selectedId: null };
      case 'success':
        return { ops: [{ ...base, id: 'fx-ok', status: 'succeeded', outcome: 'success', startedAt: iso(102000), updatedAt: iso(6000), completedAt: iso(6000), details: { ticketRef: 'INC-1042' } }, ...history], selectedId: null };
      case 'replay':
        return { ops: history, selectedId: 'fx-h2' };
      default:
        return { ops: history, selectedId: null };
    }
  }

  function captureState(name) {
    clearReplayTimers();
    const fx = fixtureOps(name);
    glassScreenState.operations = fx.ops;
    glassScreenState.selectedId = fx.selectedId;
    glassScreenState.selectedStageId = null;
    glassScreenState.detailOpId = null;
    glassScreenState.replayDone = false;
    glassScreenState.lastRenderedStageKey = 'capture';
    el('gs-details')?.removeAttribute('open');
    render();
    // 'running' fixture also pins the active stage so the per-stage detail
    // card is visible in the QC capture.
    if (name === 'running') {
      glassScreenState.selectedStageId = 'execute';
      const vm = model.buildGlassScreenViewModel({ operations: glassScreenState.operations, selectedId: glassScreenState.selectedId });
      renderPipeline(stagesCache.stages, null, vm.operation);
      renderStageDetail('execute', vm.operation, false);
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  if (typeof document !== 'undefined') {
    document.getElementById('gs-replay')?.addEventListener('click', runReplay);
    document.getElementById('gs-view-audit')?.addEventListener('click', () => goTab('audit-log'));
  }

  const api = {
    mergeOperationUpdate,
    liveOperationInterruptsReplay,
    detailsRowsForOperation,
    enrichOperation,
    onShow,
    onOperationStatus,
    onOperationStatuses,
    onAuditEntries,
    render,
    captureState,
    _state: glassScreenState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.JmlGlassScreen = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

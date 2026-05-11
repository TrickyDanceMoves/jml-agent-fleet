'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab     = 'dashboard';
let isWhatif       = true;
let isWaiting      = { approver: false, auditor: false };
let currentMsgEl   = { approver: null, auditor: null };
const SUBMIT_LABELS = {
  submit_joiner:      { action: 'Creating user',   plural: 'users created'  },
  submit_enroller:    { action: 'Enrolling user',  plural: 'users enrolled' },
  submit_mover:       { action: 'Moving user',     plural: 'users moved'    },
  submit_leaver_soft: { action: 'Offboarding user',plural: 'users offboarded' },
  submit_leaver_hard: { action: 'Deleting user',   plural: 'users deleted'  },
};
const _submitBatch = {
  approver: {},
  auditor:  {}
};

// ── Agent avatars ─────────────────────────────────────────────────────────────
const AGENT_AVATARS = {
  approver: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`,
  auditor:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`
};

// ── Tab switching + auto-refresh ──────────────────────────────────────────────
let _tabRefreshTimers = {};

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + tab));
  currentTab = tab;
  // Clear existing auto-refresh timers
  Object.values(_tabRefreshTimers).forEach(clearInterval);
  _tabRefreshTimers = {};
  if (tab === 'audit-log')     loadAuditLog();
  if (tab === 'dashboard')     loadDashboard();
  if (tab === 'security')      loadSecurity();
  if (tab === 'exports')       loadExports();
  if (tab === 'approvals')     { loadApprovals();     _tabRefreshTimers.approvals     = setInterval(loadApprovals,     30000); }
  if (tab === 'operations')    loadOperations();
  if (tab === 'certifications'){ loadCertifications(); _tabRefreshTimers.certifications = setInterval(loadCertifications, 60000); }
  if (tab === 'settings')      loadSettings();
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Window controls ───────────────────────────────────────────────────────────
document.getElementById('btn-minimize').addEventListener('click', () => window.api.windowMinimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.api.windowMaximize());
document.getElementById('btn-close').addEventListener('click',    () => window.api.windowClose());

// ── Mode toggle (Approver) ────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    isWhatif = btn.dataset.mode === 'whatif';
    window.api.setMode(isWhatif);
    document.getElementById('mode-banner-whatif').classList.toggle('hidden', !isWhatif);
    document.getElementById('mode-banner-live').classList.toggle('hidden', isWhatif);
  });
});

// ── Example chips (auto-send) ─────────────────────────────────────────────────
document.querySelectorAll('.example-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const agent = chip.closest('#view-approver') ? 'approver' : 'auditor';
    const input = document.getElementById('input-' + agent);
    input.value = chip.textContent;
    input.focus();
    sendMessage(agent);
  });
});

// ── Clear history ─────────────────────────────────────────────────────────────
document.getElementById('clear-approver').addEventListener('click', () => window.api.clearHistory('approver'));
document.getElementById('clear-auditor').addEventListener('click',  () => window.api.clearHistory('auditor'));

window.api.onHistoryCleared(({ agent }) => {
  const container = document.getElementById('messages-' + agent);
  container.innerHTML = container.querySelector ? '' : '';
  container.innerHTML = '';
  appendWelcome(agent);
});

function appendWelcome(agent) {
  const msgs = document.getElementById('messages-' + agent);
  const titles   = { approver: 'Approver Agent', auditor: 'Audit Agent' };
  const subtitles = {
    approver: 'Describe the identity change you need.',
    auditor:  'Ask anything about the tenant directory.'
  };
  msgs.innerHTML = `
    <div class="welcome-msg">
      <div class="welcome-title">${titles[agent]}</div>
      <div class="welcome-body">${subtitles[agent]}</div>
    </div>`;
}

// ── Send message ──────────────────────────────────────────────────────────────
function sendMessage(agent) {
  if (isWaiting[agent]) return;
  const input = document.getElementById('input-' + agent);
  const text  = input.value.trim();
  if (!text) return;

  appendUserMessage(agent, text);
  input.value = '';
  setWaiting(agent, true);

  const placeholder = appendAssistantPlaceholder(agent);
  currentMsgEl[agent] = placeholder;

  window.api.sendMessage(agent, text);
}

['approver', 'auditor'].forEach(agent => {
  document.getElementById('send-' + agent).addEventListener('click', () => sendMessage(agent));
  document.getElementById('input-' + agent).addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(agent); }
  });
});

// ── Message rendering ─────────────────────────────────────────────────────────
function appendUserMessage(agent, text) {
  const msgs = document.getElementById('messages-' + agent);
  const el   = document.createElement('div');
  el.className = 'message user';
  el.innerHTML = `<div class="message-bubble">${escHtml(text)}</div>`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendAssistantPlaceholder(agent) {
  const msgs = document.getElementById('messages-' + agent);
  const el   = document.createElement('div');
  el.className = 'message assistant';
  const avatarSvg = AGENT_AVATARS[agent] || 'AI';
  el.innerHTML = `
    <div class="message-avatar avatar-${agent}">${avatarSvg}</div>
    <div class="message-body">
      <div class="message-text"></div>
      <div class="tool-indicators"></div>
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

function getOrCreateCurrentMsg(agent) {
  if (!currentMsgEl[agent] || !currentMsgEl[agent].isConnected) {
    currentMsgEl[agent] = appendAssistantPlaceholder(agent);
    _submitBatch[agent] = {};
  }
  return currentMsgEl[agent];
}

// ── Streaming chunk handler ───────────────────────────────────────────────────
window.api.onChunk(({ type, text, toolName, success }) => {
  const agent = currentTab === 'auditor' ? 'auditor' : 'approver';
  const msgEl = getOrCreateCurrentMsg(agent);
  const textEl = msgEl.querySelector('.message-text');
  const toolEl = msgEl.querySelector('.tool-indicators');
  const msgs   = msgEl.closest('.messages');

  if (type === 'text') {
    msgEl.querySelector('.typing-indicator').style.display = 'none';
    textEl.innerHTML = renderMarkdown(textEl.dataset.raw ? textEl.dataset.raw + text : text);
    textEl.dataset.raw = (textEl.dataset.raw || '') + text;
  }

  if (type === 'tool_start') {
    if (SUBMIT_LABELS[toolName]) {
      const lbl = SUBMIT_LABELS[toolName];
      if (!_submitBatch[agent][toolName]) _submitBatch[agent][toolName] = { el: null, started: 0, done: 0, failed: 0 };
      const b = _submitBatch[agent][toolName];
      b.started++;
      if (!b.el || !b.el.isConnected) {
        const ind = document.createElement('div');
        ind.className = 'tool-indicator running';
        ind.dataset.tool = toolName + '-batch';
        ind.innerHTML = `<span class="tool-spinner"></span><span class="tool-label">${lbl.action} (0 / ${b.started})</span>`;
        toolEl.appendChild(ind);
        b.el = ind;
      } else {
        b.el.querySelector('.tool-label').textContent = `${lbl.action} (${b.done + b.failed} / ${b.started})`;
      }
    } else {
      const ind = document.createElement('div');
      ind.className    = 'tool-indicator running';
      ind.dataset.tool = toolName;
      ind.innerHTML    = `<span class="tool-spinner"></span><span class="tool-label">${formatToolName(toolName)}</span>`;
      toolEl.appendChild(ind);
    }
  }

  if (type === 'tool_running') {
    if (!SUBMIT_LABELS[toolName]) {
      const ind = toolEl.querySelector('[data-tool="' + toolName + '"]');
      if (ind) ind.querySelector('.tool-label').textContent = formatToolName(toolName) + '…';
    }
  }

  if (type === 'tool_done') {
    if (SUBMIT_LABELS[toolName]) {
      const lbl = SUBMIT_LABELS[toolName];
      const b = _submitBatch[agent][toolName];
      if (!b) return;
      if (success) b.done++; else b.failed++;
      const finished = b.done + b.failed;
      if (b.el) {
        if (finished < b.started) {
          b.el.querySelector('.tool-label').textContent = `${lbl.action} (${finished} / ${b.started})`;
        } else {
          b.el.classList.remove('running');
          b.el.classList.add(b.failed > 0 ? 'failed' : 'done');
          b.el.querySelector('.tool-spinner').outerHTML = b.failed > 0
            ? '<span class="tool-status-icon">✗</span>'
            : '<span class="tool-status-icon">✓</span>';
          b.el.querySelector('.tool-label').textContent = b.failed > 0
            ? `${b.done} ${lbl.plural}, ${b.failed} failed`
            : `${b.done} ${lbl.plural}`;
        }
      }
    } else {
      const ind = toolEl.querySelector('[data-tool="' + toolName + '"]');
      if (ind) {
        ind.classList.remove('running');
        ind.classList.add(success ? 'done' : 'failed');
        ind.querySelector('.tool-spinner').outerHTML = success
          ? '<span class="tool-status-icon">✓</span>'
          : '<span class="tool-status-icon">✗</span>';
        ind.querySelector('.tool-label').textContent = formatToolName(toolName);
      }
    }
  }

  if (msgs) msgs.scrollTop = msgs.scrollHeight;
});

window.api.onComplete(({ agent }) => {
  setWaiting(agent, false);
  const msgEl = currentMsgEl[agent];
  if (msgEl) {
    msgEl.querySelector('.typing-indicator').style.display = 'none';
    currentMsgEl[agent] = null;
  }
});

window.api.onError(({ text }) => {
  ['approver', 'auditor'].forEach(agent => {
    if (isWaiting[agent]) {
      setWaiting(agent, false);
      const msgEl = currentMsgEl[agent];
      if (msgEl) {
        msgEl.querySelector('.typing-indicator').style.display = 'none';
        const textEl = msgEl.querySelector('.message-text');
        textEl.innerHTML = '<span class="error-text">Error: ' + escHtml(text) + '</span>';
        currentMsgEl[agent] = null;
      }
    }
  });
});

function setWaiting(agent, waiting) {
  isWaiting[agent] = waiting;
  document.getElementById('input-' + agent).disabled  = waiting;
  document.getElementById('send-' + agent).disabled   = waiting;
}

// ── Security dashboard ────────────────────────────────────────────────────────
document.getElementById('refresh-security').addEventListener('click', loadSecurity);

function loadSecurity() {
  window.api.getSecurityReports();
  window.api.getAgentHealth();
}

function buildCountBadges(crit, warn, info) {
  const parts = [];
  if (crit > 0) parts.push('<span class="count-badge critical">' + crit + ' critical</span>');
  if (warn > 0) parts.push('<span class="count-badge warning">'  + warn + ' warning</span>');
  if (info > 0) parts.push('<span class="count-badge info">'     + info + ' info</span>');
  if (parts.length === 0) return '<span class="count-badge ok">All clear</span>';
  return parts.join('');
}

window.api.onSecurityReports((data) => {
  // Update summary strip tiles
  function updateTile(id, report) {
    const countsEl = document.getElementById('sec-' + id + '-counts');
    const metaEl   = document.getElementById('sec-' + id + '-meta');
    const runEl    = document.getElementById('sec-' + id + '-run');
    const badgeEl  = document.getElementById('sec-' + id + '-badge');
    if (!report) {
      if (countsEl) countsEl.innerHTML = '<span class="scanner-no-report">No report</span>';
      return;
    }
    const s = report.summary || {};
    if (countsEl) countsEl.innerHTML = buildCountBadges(s.critical || 0, s.warning || 0, s.info || 0);
    const ts = report.timestamp ? new Date(report.timestamp).toLocaleString() : '';
    if (metaEl) metaEl.textContent = ts ? 'Last run: ' + ts : '';
    if (runEl)  runEl.textContent  = ts ? 'last run ' + ts : '';
    const total = (s.critical || 0) + (s.warning || 0) + (s.info || 0);
    if (badgeEl) {
      badgeEl.textContent = total ? total + ' finding' + (total !== 1 ? 's' : '') : 'All clear';
      badgeEl.className = 'sec-section-badge ' + (s.critical ? 'badge-critical' : s.warning ? 'badge-warning' : 'badge-clear');
    }
  }

  updateTile('ueba',  data.ueba);
  updateTile('drift', data.drift);
  updateTile('risky', data.riskyUsers);

  // Update dashboard security at-a-glance strip
  function updateDashTile(id, report) {
    const el = document.getElementById('dash-' + id + '-counts');
    if (!el) return;
    if (!report) { el.innerHTML = '<span class="count-badge loading">—</span>'; return; }
    const s = report.summary || {};
    el.innerHTML = buildCountBadges(s.critical || 0, s.warning || 0, s.info || 0);
  }
  updateDashTile('ueba',  data.ueba);
  updateDashTile('drift', data.drift);
  updateDashTile('risky', data.riskyUsers);

  // ── Render UEBA findings ───────────────────────────────────────────────────
  const uebaList = document.getElementById('sec-ueba-list');
  if (uebaList) {
    const findings = (data.ueba && data.ueba.findings) ? data.ueba.findings : [];
    if (!findings.length) {
      uebaList.innerHTML = '<div class="sec-clear-state"><span class="count-badge ok">&#x2713; No behavioral anomalies detected</span></div>';
    } else {
      const order = { critical: 0, warning: 1, info: 2 };
      findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
      uebaList.innerHTML = findings.map(f => {
        const subjects = [...new Set((f.events || []).map(e => e.subject).filter(Boolean))];
        const agents   = [...new Set((f.events || []).map(e => e.agent).filter(Boolean))];
        const latest   = (f.events || []).map(e => e.timestamp).filter(Boolean).sort().pop();
        const latestStr = latest ? new Date(latest).toLocaleString() : '';
        return '<div class="sec-finding-card sev-border-' + f.severity + '">'
          + '<div class="sec-finding-top">'
            + '<span class="sec-sev-chip sev-' + f.severity + '">' + f.severity.toUpperCase() + '</span>'
            + '<code class="sec-rule-id">' + escHtml(f.ruleId || '') + '</code>'
            + '<span class="sec-finding-title">' + escHtml(f.title) + '</span>'
            + '<span class="sec-finding-count">' + (f.events || []).length + ' event' + ((f.events||[]).length !== 1 ? 's' : '') + '</span>'
          + '</div>'
          + (subjects.length ? '<div class="sec-finding-chips">'
              + subjects.map(s => '<span class="sec-upn-chip">' + escHtml(s) + '</span>').join('')
              + '</div>' : '')
          + '<div class="sec-finding-footer">'
            + (agents.length ? '<span class="sec-agent-tag">via ' + escHtml(agents.join(', ')) + '</span>' : '')
            + (latestStr ? '<span class="sec-ts">' + latestStr + '</span>' : '')
          + '</div>'
        + '</div>';
      }).join('');
    }
  }

  // ── Render Drift findings ──────────────────────────────────────────────────
  const driftList = document.getElementById('sec-drift-list');
  if (driftList) {
    const findings = (data.drift && data.drift.findings) ? data.drift.findings : [];
    if (!findings.length) {
      driftList.innerHTML = '<div class="sec-clear-state"><span class="count-badge ok">&#x2713; No configuration drift detected</span></div>';
    } else {
      const order = { critical: 0, warning: 1, info: 2 };
      findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
      driftList.innerHTML = findings.map(f => {
        const items = f.items || [];
        const names = items.map(i => i.displayName || i.userPrincipalName || i.agent || i.group || '').filter(Boolean);
        return '<div class="sec-finding-card sev-border-' + f.severity + '">'
          + '<div class="sec-finding-top">'
            + '<span class="sec-sev-chip sev-' + f.severity + '">' + f.severity.toUpperCase() + '</span>'
            + '<code class="sec-rule-id">' + escHtml(f.checkId || '') + '</code>'
            + '<span class="sec-finding-title">' + escHtml(f.title) + '</span>'
            + '<span class="sec-finding-count">' + items.length + ' item' + (items.length !== 1 ? 's' : '') + '</span>'
          + '</div>'
          + (names.length ? '<div class="sec-finding-chips">'
              + names.map(n => '<span class="sec-upn-chip">' + escHtml(n) + '</span>').join('')
              + '</div>' : '')
          + (items[0] && items[0].note ? '<div class="sec-finding-note">' + escHtml(items[0].note) + '</div>' : '')
        + '</div>';
      }).join('');
    }
  }

  // ── Render Identity Protection findings ───────────────────────────────────
  const riskyList = document.getElementById('sec-risky-list');
  if (riskyList) {
    const findings = (data.riskyUsers && data.riskyUsers.findings) ? data.riskyUsers.findings : [];
    if (!findings.length) {
      riskyList.innerHTML = '<div class="sec-clear-state"><span class="count-badge ok">&#x2713; No risky users detected</span></div>';
    } else {
      // Flatten to per-user cards
      const userCards = [];
      findings.forEach(f => {
        (f.items || []).forEach(u => userCards.push({ sev: f.severity, title: f.title, user: u }));
      });
      riskyList.innerHTML = userCards.map(({ sev, title, user: u }) => {
        const initials = (u.displayName || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const riskStateLabel = {
          confirmedCompromised: 'Confirmed Compromised',
          atRisk:               'At Risk',
          dismissed:            'Dismissed',
          remediated:           'Remediated',
        }[u.riskState] || u.riskState || '—';
        const riskDetailLabel = (u.riskDetail || '').replace(/([A-Z])/g, ' $1').trim();
        const lastUpdated = u.riskLastUpdated ? new Date(u.riskLastUpdated).toLocaleDateString() : '';
        return '<div class="sec-risky-user-card sev-border-' + sev + '">'
          + '<div class="sec-risky-avatar">' + escHtml(initials) + '</div>'
          + '<div class="sec-risky-body">'
            + '<div class="sec-risky-top">'
              + '<span class="sec-risky-name">' + escHtml(u.displayName || u.userPrincipalName || '') + '</span>'
              + '<span class="sec-sev-chip sev-' + sev + '">' + escHtml((u.riskLevel || sev).toUpperCase()) + '</span>'
            + '</div>'
            + '<div class="sec-risky-upn">' + escHtml(u.userPrincipalName || '') + '</div>'
            + '<div class="sec-risky-meta">'
              + '<span class="sec-risky-state sev-' + sev + '">' + escHtml(riskStateLabel) + '</span>'
              + (riskDetailLabel ? '<span class="sec-risky-detail">' + escHtml(riskDetailLabel) + '</span>' : '')
              + (lastUpdated ? '<span class="sec-ts">Updated ' + lastUpdated + '</span>' : '')
            + '</div>'
          + '</div>'
        + '</div>';
      }).join('');
    }
  }
});

// ── Exports tab ───────────────────────────────────────────────────────────────
document.getElementById('refresh-exports').addEventListener('click', loadExports);

function loadExports() {
  document.getElementById('exports-last-updated').textContent = '';
  window.api.getExportsStatus();
  window.api.getHrQueue();
}

function applyExportStatus(id, status) {
  const chip    = document.getElementById(id + '-status-chip');
  const lastRun = document.getElementById(id + '-last-run');
  const errEl   = document.getElementById(id + '-error');

  if (!status) {
    chip.textContent = 'Unknown';
    chip.className   = 'export-status-chip chip-unknown';
    return;
  }

  if (!status.configured) {
    chip.textContent = 'Not configured';
    chip.className   = 'export-status-chip chip-unconfigured';
    lastRun.textContent = '—';
  } else if (status.error) {
    chip.textContent = 'Error';
    chip.className   = 'export-status-chip chip-error';
    errEl.textContent = status.error;
    lastRun.textContent = status.lastRun ? new Date(status.lastRun).toLocaleString() : '—';
  } else if (status.lastRun) {
    chip.textContent = 'OK';
    chip.className   = 'export-status-chip chip-ok';
    lastRun.textContent = new Date(status.lastRun).toLocaleString();
  } else {
    chip.textContent = 'Configured';
    chip.className   = 'export-status-chip chip-configured';
    lastRun.textContent = 'Never run';
  }
}

window.api.onExportsStatus((data) => {
  const now = new Date().toLocaleTimeString();
  document.getElementById('exports-last-updated').textContent = 'Updated ' + now;

  const b = data.blob;
  applyExportStatus('blob', b);
  if (b) {
    document.getElementById('blob-container').textContent = b.container || '—';
    document.getElementById('blob-entries').textContent   = b.entriesExported != null ? b.entriesExported + ' entries' : '—';
    if (!b.error) document.getElementById('blob-error').textContent = '';
  }

  const s = data.sentinel;
  applyExportStatus('sentinel', s);
  if (s) {
    document.getElementById('sentinel-workspace').textContent = s.workspaceId ? s.workspaceId.slice(0, 8) + '…' : '—';
    document.getElementById('sentinel-events').textContent    = s.eventsIngested != null ? s.eventsIngested + ' events' : '—';
    if (!s.error) document.getElementById('sentinel-error').textContent = '';
  }
});

function setRunning(type, running) {
  const btn = document.getElementById('btn-run-' + type);
  btn.disabled    = running;
  btn.textContent = running
    ? (type === 'blob' ? 'Exporting…' : 'Ingesting…')
    : (type === 'blob' ? 'Export Now' : 'Ingest Now');
}

document.getElementById('btn-run-blob').addEventListener('click', () => {
  setRunning('blob', true);
  window.api.runBlobExport();
});

document.getElementById('btn-run-sentinel').addEventListener('click', () => {
  setRunning('sentinel', true);
  window.api.runSentinelIngest();
});

window.api.onExportRunResult((result) => {
  setRunning(result.type, false);
  if (result.ok) {
    window.api.getExportsStatus();
  } else {
    const errEl = document.getElementById(result.type === 'blob' ? 'blob-error' : 'sentinel-error');
    errEl.textContent = result.error || 'Unknown error';
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────
document.getElementById('refresh-log').addEventListener('click', loadAuditLog);

function loadAuditLog() {
  document.getElementById('log-tbody').innerHTML = '<tr><td colspan="6" class="empty-row">Loading...</td></tr>';
  window.api.getAuditLog();
}

window.api.onAuditLogData((entries) => {
  const tbody    = document.getElementById('log-tbody');
  const countEl  = document.getElementById('log-count');
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No audit entries found.</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = entries.length + ' entries';
  tbody.innerHTML = entries.map(e => {
    const ts       = e.timestamp ? new Date(e.timestamp).toLocaleString() : '--';
    const outcome  = e.outcome || '--';
    const mode     = e.whatif ? '<span class="badge-whatif">WhatIf</span>' : '<span class="badge-live">Live</span>';
    const cls      = outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : outcome === 'failed' ? 'failed' : '';
    const ticket   = (e.details && e.details.ticketRef) ? escHtml(e.details.ticketRef) : '<span class="dim">—</span>';
    const operator = e.operator ? escHtml(e.operator) : '<span class="dim">—</span>';
    return `<tr>
      <td class="mono">${ts}</td>
      <td>${escHtml(e.agent || '--')}</td>
      <td class="mono">${escHtml(e.subject || '--')}</td>
      <td>${operator}</td>
      <td>${ticket}</td>
      <td><span class="outcome ${cls}">${escHtml(outcome)}</span></td>
      <td>${mode}</td>
    </tr>`;
  }).join('');
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
function loadDashboard() {
  window.api.getDashboardStats();
  window.api.getPendingApprovals();
  window.api.getSecurityReports();
}

window.api.onDashboardStats((data) => {
  ['stat-users-total','stat-users-detail','stat-licenses-total','stat-activity-total','stat-activity-detail']
    .forEach(id => document.getElementById(id).classList.remove('loading'));
  if (data.error) {
    document.getElementById('stat-users-detail').textContent = data.error;
    document.getElementById('stat-activity-detail').textContent = '';
    return;
  }

  if (data.users) {
    document.getElementById('stat-users-total').textContent = data.users.total || '--';
    document.getElementById('stat-users-detail').textContent =
      (data.users.enabled || 0) + ' enabled  ·  ' + (data.users.disabled || 0) + ' disabled  ·  ' + (data.users.guests || 0) + ' guests';
  }

  if (data.licenses && data.licenses.licenses) {
    const real     = data.licenses.licenses.filter(l => l.total > 0 && l.total < 10000);
    const total    = real.reduce((s, l) => s + l.total, 0);
    const assigned = real.reduce((s, l) => s + l.assigned, 0);
    document.getElementById('stat-licenses-total').textContent = assigned + ' / ' + total;
    const barsEl = document.getElementById('dash-license-bars');
    if (barsEl) {
      barsEl.innerHTML = real.map(l => {
        const pct = l.total > 0 ? Math.round((l.assigned / l.total) * 100) : 0;
        const cls = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
        return '<div class="dash-lic-row">'
          + '<div class="dash-lic-label"><span class="dash-lic-sku">' + escHtml(l.sku) + '</span><span>' + l.assigned + '/' + l.total + '</span></div>'
          + '<div class="dash-lic-track"><div class="dash-lic-fill ' + cls + '" style="width:' + pct + '%"></div></div>'
          + '</div>';
      }).join('');
    }
  }

  if (data.activity) {
    document.getElementById('stat-activity-total').textContent = data.activity.totalEntries || 0;
    const recent = (data.activity.recentEntries || []).slice(0, 5);
    const list   = document.getElementById('recent-activity-list');
    if (recent.length === 0) {
      list.innerHTML = '<div class="loading-hint">No activity recorded yet.</div>';
    } else {
      document.getElementById('stat-activity-detail').textContent = 'total operations';
      list.innerHTML = recent.map(e => buildActivityItem(e)).join('');
      list.querySelectorAll('.activity-item').forEach(el => {
        el.addEventListener('click', () => el.classList.toggle('expanded'));
      });
    }
  }
});

// ── Activity item builder ─────────────────────────────────────────────────────
function buildActivityItem(e) {
  const ts      = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
  const details = e.details || {};
  const pinned = [
    ['ticket', details.ticketRef],
    ['stage',  details.stage],
    ['mode',   e.whatif ? 'WhatIf' : 'Live'],
    ['time',   ts],
  ].filter(([, v]) => v);

  const extraKeys = Object.keys(details).filter(k => !['ticketRef','stage'].includes(k));
  const extra = extraKeys.map(k => {
    const v = typeof details[k] === 'object' ? JSON.stringify(details[k]) : String(details[k]);
    return [k, v];
  });

  const detailRows = [...pinned, ...extra]
    .map(([k, v]) => `<div class="activity-detail-row"><span class="activity-detail-key">${escHtml(k)}</span><span class="activity-detail-val">${escHtml(v)}</span></div>`)
    .join('');

  return `<div class="activity-item">
    <div class="activity-item-row">
      <span class="activity-agent">${escHtml(e.agent || '')}</span>
      <span class="activity-action">${escHtml(e.action || '')}</span>
      <span class="activity-subject">${escHtml(e.subject || '')}</span>
      <span class="activity-outcome ${e.outcome}">${escHtml(e.outcome || '')}</span>
      <span class="activity-time">${ts}</span>
      <span class="activity-expand-icon">&#x25B6;</span>
    </div>
    <div class="activity-detail">${detailRows}</div>
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatToolName(n) {
  return n.replace(/^(submit|query)_/, '').replace(/_/g, ' ');
}

// ── User autocomplete shared state ───────────────────────────────────────────
let _acHandler    = null;
let _userCache    = [];   // populated by full searches; autocomplete queries this instantly

function _acRenderUsers(drop, users, inputEl, opts) {
  if (!users.length) { drop.style.display = 'none'; return; }
  const r = inputEl.getBoundingClientRect();
  drop.style.left  = r.left   + 'px';
  drop.style.top   = (r.bottom + 2) + 'px';
  drop.style.width = r.width  + 'px';
  drop.innerHTML = users.slice(0, 7).map(u =>
    '<div class="ac-item" data-upn="' + escHtml(u.userPrincipalName || '') + '" data-name="' + escHtml(u.displayName || '') + '">' +
      '<span class="ac-name">' + escHtml(u.displayName || u.userPrincipalName || '—') + '</span>' +
      '<span class="ac-upn">'  + escHtml(u.userPrincipalName || '') + '</span>' +
    '</div>'
  ).join('');
  drop.style.display = 'block';
  drop.querySelectorAll('.ac-item').forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      inputEl.value = item.dataset.upn;
      drop.style.display = 'none';
      if (opts && opts.onSelect) opts.onSelect(item.dataset.upn, item.dataset.name);
    });
  });
}

function setupUserAutocomplete(inputEl, opts) {
  if (!inputEl) return;
  const drop = document.createElement('div');
  drop.className = 'ac-dropdown';
  drop.style.display = 'none';
  document.body.appendChild(drop);

  let _timer, _focused = false;

  inputEl.addEventListener('focus', () => { _focused = true; });
  inputEl.addEventListener('blur',  () => { _focused = false; setTimeout(() => { drop.style.display = 'none'; }, 200); });
  inputEl.addEventListener('keydown', e => { if (e.key === 'Escape') drop.style.display = 'none'; });

  inputEl.addEventListener('input', () => {
    clearTimeout(_timer);
    const q = inputEl.value.trim().toLowerCase();
    if (q.length < 2) { drop.style.display = 'none'; return; }

    // Instant results from cache
    const cached = _userCache.filter(u =>
      (u.displayName || '').toLowerCase().includes(q) ||
      (u.userPrincipalName || '').toLowerCase().includes(q)
    );
    if (cached.length) {
      _acRenderUsers(drop, cached, inputEl, opts);
    } else {
      // Show skeleton while waiting
      const r = inputEl.getBoundingClientRect();
      drop.style.left = r.left + 'px'; drop.style.top = (r.bottom + 2) + 'px'; drop.style.width = r.width + 'px';
      drop.innerHTML = '<div class="ac-loading">Searching…</div>';
      drop.style.display = 'block';
    }

    // Fresh search (debounced) — updates cache and refreshes dropdown if still focused
    _timer = setTimeout(() => {
      // Show "Searching…" while PS call is in flight (only if nothing cached yet)
      if (!_userCache.filter(u =>
        (u.displayName || '').toLowerCase().includes(q) ||
        (u.userPrincipalName || '').toLowerCase().includes(q)
      ).length) {
        const r = inputEl.getBoundingClientRect();
        drop.style.left = r.left + 'px'; drop.style.top = (r.bottom + 2) + 'px'; drop.style.width = r.width + 'px';
        drop.innerHTML = '<div class="ac-loading">Searching…</div>';
        drop.style.display = 'block';
      }
      _acHandler = data => {
        if (data.users && data.users.length) {
          const upns = new Set(_userCache.map(u => u.userPrincipalName));
          data.users.forEach(u => { if (!upns.has(u.userPrincipalName)) _userCache.push(u); });
          if (_userCache.length > 200) _userCache = _userCache.slice(-200);
        }
        if (!_focused) { drop.style.display = 'none'; return; }
        const q2 = inputEl.value.trim().toLowerCase();
        if (q2.length < 2) { drop.style.display = 'none'; return; }
        const hits = _userCache.filter(u =>
          (u.displayName || '').toLowerCase().includes(q2) ||
          (u.userPrincipalName || '').toLowerCase().includes(q2)
        );
        if (hits.length) {
          _acRenderUsers(drop, hits, inputEl, opts);
        } else if (data.error) {
          const r = inputEl.getBoundingClientRect();
          drop.style.left = r.left + 'px'; drop.style.top = (r.bottom + 2) + 'px'; drop.style.width = r.width + 'px';
          drop.innerHTML = '<div class="ac-loading" style="color:var(--clr-danger,#f87171)">Search error — check Graph connection</div>';
          drop.style.display = 'block';
        } else {
          drop.innerHTML = '<div class="ac-loading">No results</div>';
        }
      };
      window.api.searchUsers(inputEl.value.trim());
    }, 400);
  });
}

function highlightJson(text) {
  const e = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return e(text).replace(
    /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    m => {
      let c = 'gjn'; // number
      if (/^"/.test(m))          c = /:$/.test(m) ? 'gjk' : 'gjs';
      else if (/true|false/.test(m)) c = 'gjb';
      else if (m === 'null')         c = 'gjz';
      return `<span class="${c}">${m}</span>`;
    }
  );
}

function renderMarkdown(text) {
  // Parse GFM-style markdown into styled HTML
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Blank line
    if (!line.trim()) { i++; continue; }

    // Heading
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      const lvl = hm[1].length;
      out.push('<div class="md-h' + lvl + '">' + inlineMarkdown(hm[2]) + '</div>');
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push('<div class="md-hr"></div>'); i++; continue; }

    // Pipe table — collect all consecutive pipe rows
    if (line.trim().startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]); i++;
      }
      // Skip separator rows (---|---)
      const rows = tableLines.filter(l => !/^\s*\|[\s\-:|]+\|\s*$/.test(l));
      if (rows.length) {
        const parseRow = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const [header, ...body] = rows;
        out.push('<div class="md-table-wrap"><table class="md-table">');
        out.push('<thead><tr>' + parseRow(header).map(c => '<th>' + inlineMarkdown(c) + '</th>').join('') + '</tr></thead>');
        if (body.length) {
          out.push('<tbody>');
          body.forEach(r => out.push('<tr>' + parseRow(r).map(c => '<td>' + inlineMarkdown(c) + '</td>').join('') + '</tr>'));
          out.push('</tbody>');
        }
        out.push('</table></div>');
      }
      continue;
    }

    // Bullet list — collect consecutive items
    if (/^\s*[-*]\s/.test(line)) {
      out.push('<ul class="md-list">');
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        out.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
        i++;
      }
      out.push('</ul>');
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s/.test(line)) {
      out.push('<ol class="md-list">');
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        out.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
        i++;
      }
      out.push('</ol>');
      continue;
    }

    // Paragraph
    out.push('<p class="md-p">' + inlineMarkdown(line) + '</p>');
    i++;
  }

  return out.join('');
}

function inlineMarkdown(text) {
  return escHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/&#x2705;/g, '<span class="md-check">&#x2705;</span>')
    .replace(/&#x274C;/g, '<span class="md-cross">&#x274C;</span>')
    .replace(/✅/g, '<span class="md-check">✅</span>')
    .replace(/❌/g, '<span class="md-cross">❌</span>')
    .replace(/⚠️/g, '<span class="md-warn">⚠️</span>');
}

// ── Approvals tab ─────────────────────────────────────────────────────────────
document.getElementById('refresh-approvals').addEventListener('click', loadApprovals);

function loadApprovals() {
  document.getElementById('approvals-list').innerHTML = '<div class="loading-hint">Loading…</div>';
  window.api.getPendingApprovals();
}

window.api.onPendingApprovals((data) => {
  const listEl  = document.getElementById('approvals-list');
  const countEl = document.getElementById('approvals-count');
  if (data && data.error) {
    listEl.innerHTML = '<div class="loading-hint">Error: ' + escHtml(data.error) + '</div>';
    return;
  }
  const items = Array.isArray(data) ? data : [];
  if (countEl) countEl.textContent = items.length ? items.length + ' pending' : '';

  // Update dashboard approvals stat card
  const dashCnt = document.getElementById('stat-approvals-count');
  const dashDet = document.getElementById('stat-approvals-detail');
  if (dashCnt) { dashCnt.classList.remove('loading'); dashCnt.textContent = items.length || '0'; }
  if (dashDet) dashDet.textContent = items.length
    ? (items.length === 1 ? '1 action awaiting decision' : items.length + ' actions awaiting decision')
    : 'No pending approvals';
  if (items.length === 0) {
    listEl.innerHTML = '<div class="loading-hint">No pending approvals.</div>';
    return;
  }
  listEl.innerHTML = items.map(op => {
    const inp       = op.input || op;
    const token     = op.token || op.id || '';
    const tool      = (op.tool || '').toLowerCase();
    const now       = new Date();
    const expired   = op.expiresAt && new Date(op.expiresAt) < now;
    const expText   = op.expiresAt
      ? (expired ? 'Expired' : 'Expires ' + new Date(op.expiresAt).toLocaleString())
      : '';

    // Derive operation type and badge
    let opLabel, badgeClass;
    if (tool.includes('joiner'))      { opLabel = 'JOINER';    badgeClass = 'joiner'; }
    else if (tool.includes('hard'))   { opLabel = 'HARD LEAVER'; badgeClass = 'hard'; }
    else if (tool.includes('soft'))   { opLabel = 'SOFT LEAVER'; badgeClass = 'soft'; }
    else if (tool.includes('mover'))  { opLabel = 'MOVER';     badgeClass = 'soft'; }
    else                              { opLabel = 'PENDING';   badgeClass = 'soft'; }

    // Build detail rows
    const groups   = Array.isArray(inp.groups)   ? inp.groups.join(', ')   : '';
    const licenses = Array.isArray(inp.licenses) ? inp.licenses.join(', ') : '';
    const detailRows = [];
    if (inp.givenName || inp.surname) detailRows.push(['Name', escHtml((inp.givenName || '') + ' ' + (inp.surname || '')).trim()]);
    if (inp.department) detailRows.push(['Department', escHtml(inp.department)]);
    if (inp.jobTitle)   detailRows.push(['Job Title',  escHtml(inp.jobTitle)]);
    if (licenses)       detailRows.push(['Licenses',   escHtml(licenses)]);
    if (groups)         detailRows.push(['Groups',     escHtml(groups)]);
    if (inp.stage)      detailRows.push(['Stage',      escHtml(inp.stage)]);

    const detailHtml = detailRows.length
      ? '<table class="approval-detail-table">' +
          detailRows.map(([k, v]) => `<tr><td class="dim-label">${k}</td><td>${v}</td></tr>`).join('') +
        '</table>'
      : '';

    return `<div class="approval-card${expired ? ' expired' : ''}" data-id="${escHtml(token)}">
      <div class="approval-header">
        <span class="approval-upn">${escHtml(inp.userPrincipalName || '')}</span>
        <span class="approval-badge ${badgeClass}">${opLabel}</span>
        <span class="approval-token">TOKEN: ${escHtml(token)}</span>
        ${expired ? '<span class="approval-badge expired-badge">EXPIRED</span>' : ''}
      </div>
      <div class="approval-meta">
        <span><span class="dim-label">Ticket</span> ${escHtml(inp.ticketRef || '—')}</span>
        <span><span class="dim-label">Requested by</span> ${escHtml(op.requestedBy || '—')}</span>
        <span><span class="dim-label">Submitted</span> ${op.created ? new Date(op.created).toLocaleString() : '—'}</span>
        ${expText ? '<span class="' + (expired ? 'text-danger' : '') + '">' + escHtml(expText) + '</span>' : ''}
      </div>
      ${detailHtml}
      <div class="approval-risk">
        ${badgeClass === 'hard' ? '<span class="risk-chip risk-high">High risk — dual approval required for license + group removal</span>' : ''}
        ${badgeClass === 'joiner' ? '<span class="risk-chip risk-low">New hire provisioning — groups and licenses pre-assigned by Provisioner</span>' : ''}
      </div>
      <div class="approval-actions">
        ${!expired ? '<button class="btn-run btn-approve" data-id="' + escHtml(token) + '">Approve</button>' : ''}
        <button class="btn-danger btn-reject" data-id="${escHtml(token)}">Reject</button>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.btn-approve').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true; btn.textContent = 'Running…';
      window.api.approvePending(btn.dataset.id);
    });
  });
  listEl.querySelectorAll('.btn-reject').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true; btn.textContent = 'Rejecting…';
      window.api.rejectPending(btn.dataset.id);
    });
  });
});

window.api.onApproveResult((data) => { loadApprovals(); });
window.api.onRejectResult((data)  => { loadApprovals(); });

// ── Operations tab ────────────────────────────────────────────────────────────
function loadOperations() {
  window.api.getScheduledOps();
}

const _csvInput = document.getElementById('bulk-csv-input');
if (_csvInput) {
  _csvInput.addEventListener('input', () => {
    const rows = parseCsv(_csvInput.value);
    const el   = document.getElementById('bulk-preview-count');
    if (el) el.textContent = rows.length ? rows.length + ' row' + (rows.length !== 1 ? 's' : '') : '';
  });
}

document.getElementById('btn-run-bulk').addEventListener('click', () => {
  const raw    = document.getElementById('bulk-csv-input').value;
  const rows   = parseCsv(raw);
  if (!rows.length) return;
  const whatif = document.getElementById('bulk-whatif').checked;
  document.getElementById('bulk-progress-list').innerHTML = '';
  rows.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'bulk-progress-row';
    el.id = 'bulk-row-' + i;
    el.innerHTML = '<span class="bulk-icon">⏳</span><span class="bulk-upn">' + escHtml(r.userPrincipalName || '') + '</span><span class="bulk-status"></span>';
    document.getElementById('bulk-progress-list').appendChild(el);
  });
  window.api.runBulkImport(rows, whatif);
});

function parseCsv(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  const cols  = ['operation','userPrincipalName','givenName','surname','department','jobTitle','usageLocation','ticketRef','stage'];
  return lines.map(line => {
    const parts = line.split(',').map(s => s.trim());
    const obj   = {};
    cols.forEach((c, i) => { obj[c] = parts[i] || ''; });
    return obj;
  }).filter(r => r.operation && r.userPrincipalName);
}

window.api.onBulkImportProgress((data) => {
  const el = document.getElementById('bulk-row-' + data.index);
  if (!el) return;
  el.querySelector('.bulk-icon').textContent = data.status === 'done' ? '✓' : data.status === 'error' ? '✗' : '⏳';
  el.classList.toggle('done',  data.status === 'done');
  el.classList.toggle('error', data.status === 'error');
  const statusEl = el.querySelector('.bulk-status');
  if (statusEl && data.error) statusEl.textContent = data.error;
});

window.api.onBulkImportComplete((data) => {
  const el = document.getElementById('bulk-preview-count');
  if (el) el.textContent = 'Complete: ' + data.total + ' processed';
});

document.getElementById('btn-schedule').addEventListener('click', () => {
  const op     = document.getElementById('sched-op').value;
  const upn    = document.getElementById('sched-upn').value.trim();
  const when   = document.getElementById('sched-when').value;
  const whatif = document.getElementById('sched-whatif').checked;
  if (!op || !upn || !when) return;
  window.api.saveScheduledOp({
    operation: op,
    payload:   { userPrincipalName: upn },
    scheduledFor: new Date(when).toISOString(),
    createdBy: window.api.currentUser,
    whatif
  });
  document.getElementById('sched-upn').value  = '';
  document.getElementById('sched-when').value = '';
});

window.api.onScheduledOps((ops) => {
  const el = document.getElementById('sched-list');
  if (!Array.isArray(ops) || !ops.length) {
    el.innerHTML = '<div class="loading-hint">No scheduled operations.</div>';
    return;
  }
  el.innerHTML = ops.map(op => {
    const when = op.scheduledFor ? new Date(op.scheduledFor).toLocaleString() : '—';
    return `<div class="sched-item" data-id="${escHtml(op.id)}">
      <span class="sched-op">${escHtml(op.operation || '')}</span>
      <span class="sched-upn">${escHtml((op.payload && op.payload.userPrincipalName) || '')}</span>
      <span class="sched-when">${escHtml(when)}</span>
      <span class="sched-status ${escHtml(op.status || 'pending')}">${escHtml(op.status || 'pending')}</span>
      ${op.status === 'pending' ? '<button class="btn-danger btn-cancel-sched" data-id="' + escHtml(op.id) + '">Cancel</button>' : ''}
    </div>`;
  }).join('');
  el.querySelectorAll('.btn-cancel-sched').forEach(btn => {
    btn.addEventListener('click', () => window.api.deleteScheduledOp(btn.dataset.id));
  });
});

window.api.onScheduledOpFired((op) => {
  window.api.getScheduledOps();
});

// ── Certifications tab ────────────────────────────────────────────────────────
function loadCertifications() {
  window.api.getCertHistory();
}

document.getElementById('btn-refresh-certs').addEventListener('click', loadCertifications);

function runCert(type) {
  const whatif = document.getElementById('cert-whatif').checked;
  const resultEl = document.getElementById('cert-result');
  resultEl.style.display = 'none';
  document.getElementById('cert-result-lines').textContent = '';
  document.getElementById('cert-result-table-wrap').innerHTML = '';
  window.api.runCertification(type, whatif);
}

document.getElementById('btn-cert-all').addEventListener('click',        () => runCert('all'));
document.getElementById('btn-cert-user-groups').addEventListener('click', () => runCert('user-groups'));
document.getElementById('btn-cert-agent-pim').addEventListener('click',   () => runCert('agent-pim'));

window.api.onCertificationResult((data) => {
  const resultEl = document.getElementById('cert-result');
  resultEl.style.display = 'flex';

  // Summary line replaces the raw console dump
  const linesEl = document.getElementById('cert-result-lines');
  if (!data.ok) {
    linesEl.innerHTML = '<span style="color:var(--danger)">&#x2717; ' + escHtml(data.error || 'Campaign run failed') + '</span>';
  } else {
    const n = Array.isArray(data.campaigns) ? data.campaigns.length : 0;
    linesEl.innerHTML = '<span style="color:var(--success)">&#x2713; Campaign scan complete</span>'
      + (n ? ' <span style="color:var(--text-dim)">&#xB7; ' + n + ' campaign' + (n !== 1 ? 's' : '') + ' found</span>' : '');
  }

  const wrap = document.getElementById('cert-result-table-wrap');
  if (!data.ok) { wrap.innerHTML = ''; return; }

  const camps = Array.isArray(data.campaigns) ? data.campaigns : [];
  if (!camps.length) { wrap.innerHTML = '<div class="loading-hint">No campaigns returned.</div>'; return; }

  const STATUS_META = {
    active:    { cls: 'cert-status-active',    label: 'Active'    },
    completed: { cls: 'cert-status-completed',  label: 'Completed' },
    error:     { cls: 'cert-status-error',      label: 'Error'     },
  };
  const TYPE_ICONS = {
    'user-groups': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    'agent-pim':   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  };
  const defaultIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

  wrap.innerHTML = camps.map(c => {
    const statusKey = (c.status || '').toLowerCase();
    const sm = STATUS_META[statusKey] || { cls: 'cert-status-pending', label: c.status || 'Pending' };
    const typeKey = (c.type || '').toLowerCase();
    const typeIcon = TYPE_ICONS[typeKey] || defaultIcon;
    const created = c.createdDateTime
      ? new Date(c.createdDateTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : (c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
    const decisions = c.completedCount !== undefined
      ? c.completedCount + ' / ' + (c.totalCount || '?') + ' reviewed'
      : '';
    return '<div class="cert-campaign-card">'
      + '<div class="cert-campaign-header">'
        + '<div class="cert-campaign-type-icon">' + typeIcon + '</div>'
        + '<div class="cert-campaign-name">' + escHtml(c.displayName || c.id || 'Unnamed Campaign') + '</div>'
        + '<span class="cert-status-badge ' + sm.cls + '">' + sm.label + '</span>'
      + '</div>'
      + '<div class="cert-campaign-meta">'
        + '<span class="cert-meta-item"><span class="dim-label">Type</span> ' + escHtml(c.type || '—') + '</span>'
        + '<span class="cert-meta-item"><span class="dim-label">Created</span> ' + created + '</span>'
        + (decisions ? '<span class="cert-meta-item"><span class="dim-label">Progress</span> ' + escHtml(decisions) + '</span>' : '')
      + '</div>'
    + '</div>';
  }).join('');
});

window.api.onCertHistory((entries) => {
  const el = document.getElementById('cert-history-body');
  if (!entries || !entries.length) { el.innerHTML = '<div class="loading-hint">No history.</div>'; return; }
  el.innerHTML = entries.slice(0, 20).map(e => {
    const ts    = e.timestamp ? new Date(e.timestamp).toLocaleString() : '—';
    const ok    = e.outcome === 'success';
    const fail  = e.outcome === 'failed';
    const icon  = ok ? '&#x2713;' : fail ? '&#x2717;' : '&#x25CF;';
    const cls   = ok ? 'cert-hist-ok' : fail ? 'cert-hist-fail' : 'cert-hist-neutral';
    const mode  = e.whatif ? '<span class="badge-whatif">WhatIf</span>' : '<span class="badge-live">Live</span>';
    const subj  = e.subject ? escHtml(e.subject) : '<span class="text-dim">—</span>';
    return '<div class="cert-hist-entry">'
      + '<div class="cert-hist-icon ' + cls + '">' + icon + '</div>'
      + '<div class="cert-hist-body">'
        + '<div class="cert-hist-top">'
          + '<span class="cert-hist-subject">' + subj + '</span>'
          + mode
        + '</div>'
        + '<div class="cert-hist-ts">' + escHtml(ts) + '</div>'
      + '</div>'
    + '</div>';
  }).join('');
});

// ── Settings tab ──────────────────────────────────────────────────────────────
let _policies = {};
let _sod      = {};
let _operators = {};
let _roles     = {};

function loadSettings() {
  window.api.getPolicy();
  window.api.getOperators();
}

window.api.onPolicyData((data) => {
  if (data.error) return;
  _policies = data.policies || {};
  _sod      = data.sod      || {};
  renderPolicies();
  renderSod();
});

window.api.onOperatorsData((data) => {
  if (data.error) return;
  _operators = data.operators || {};
  _roles     = data.roles     || {};
  renderOperators();
});

function renderPolicies() {
  renderTagList('policy-sensitive-licenses', _policies.sensitiveLicenses || [], 'sensitiveLicenses');
  renderTagList('policy-sensitive-groups',   _policies.sensitiveGroups   || [], 'sensitiveGroups');
  renderFreezeTable(_policies.freezeWindows || []);
}

function renderTagList(containerId, items, field) {
  const el = document.getElementById(containerId);
  el.innerHTML = items.map((item, i) => `<span class="policy-tag">${escHtml(item)}<button class="policy-tag-remove" data-field="${escHtml(field)}" data-index="${i}" title="Remove">×</button></span>`).join('');
  el.querySelectorAll('.policy-tag-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      _policies[btn.dataset.field].splice(Number(btn.dataset.index), 1);
      renderPolicies();
    });
  });
}

function renderFreezeTable(windows) {
  const tbody = document.getElementById('freeze-tbody');
  tbody.innerHTML = windows.map((w, i) => `<tr>
    <td><input type="text" value="${escHtml(w.name || '')}" data-fi="${i}" data-fk="name"></td>
    <td><input type="text" value="${escHtml(w.days || '')}" data-fi="${i}" data-fk="days" style="width:80px"></td>
    <td style="text-align:center"><input type="checkbox" ${w.allDay ? 'checked' : ''} data-fi="${i}" data-fk="allDay"></td>
    <td><button class="btn-danger" data-fi="${i}" style="padding:3px 8px;font-size:11px">Del</button></td>
  </tr>`).join('');
  tbody.querySelectorAll('input[type="text"]').forEach(inp => {
    inp.addEventListener('change', () => {
      _policies.freezeWindows[Number(inp.dataset.fi)][inp.dataset.fk] = inp.value;
    });
  });
  tbody.querySelectorAll('input[type="checkbox"]').forEach(inp => {
    inp.addEventListener('change', () => {
      _policies.freezeWindows[Number(inp.dataset.fi)][inp.dataset.fk] = inp.checked;
    });
  });
  tbody.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      _policies.freezeWindows.splice(Number(btn.dataset.fi), 1);
      renderFreezeTable(_policies.freezeWindows);
    });
  });
}

document.getElementById('btn-add-freeze').addEventListener('click', () => {
  if (!_policies.freezeWindows) _policies.freezeWindows = [];
  _policies.freezeWindows.push({ name: 'New Window', days: '', allDay: true });
  renderFreezeTable(_policies.freezeWindows);
});

document.getElementById('btn-add-license').addEventListener('click', () => {
  const inp = document.getElementById('input-add-license');
  const val = inp.value.trim();
  if (!val) return;
  if (!_policies.sensitiveLicenses) _policies.sensitiveLicenses = [];
  _policies.sensitiveLicenses.push(val);
  inp.value = '';
  renderPolicies();
});

document.getElementById('btn-add-group').addEventListener('click', () => {
  const inp = document.getElementById('input-add-group');
  const val = inp.value.trim();
  if (!val) return;
  if (!_policies.sensitiveGroups) _policies.sensitiveGroups = [];
  _policies.sensitiveGroups.push(val);
  inp.value = '';
  renderPolicies();
});

document.getElementById('btn-save-policies').addEventListener('click', () => {
  window.api.savePolicy(_policies, _sod);
});

window.api.onPolicySaved((data) => {
  const el = document.getElementById('policies-save-status');
  el.textContent = data.ok ? 'Saved.' : ('Error: ' + escHtml(data.error || ''));
  setTimeout(() => { el.textContent = ''; }, 2500);
});

function renderSod() {
  const rules  = (_sod.rules || []);
  const tbody  = document.getElementById('sod-tbody');
  tbody.innerHTML = rules.map((r, i) => `<tr>
    <td>${escHtml(r.id || '')}</td>
    <td>${escHtml(r.description || '')}</td>
    <td>${escHtml(r.action || '')}</td>
    <td>${escHtml((r.conflictA && r.conflictA.displayName) || '')}</td>
    <td>${escHtml((r.conflictB && r.conflictB.displayName) || '')}</td>
    <td><button class="btn-danger btn-del-sod" data-i="${i}" style="padding:3px 8px;font-size:11px">Del</button></td>
  </tr>`).join('');
  tbody.querySelectorAll('.btn-del-sod').forEach(btn => {
    btn.addEventListener('click', () => {
      _sod.rules.splice(Number(btn.dataset.i), 1);
      renderSod();
    });
  });
}

document.getElementById('btn-add-sod-rule').addEventListener('click', () => {
  if (!_sod.rules) _sod.rules = [];
  _sod.rules.push({
    id:          document.getElementById('sod-id').value.trim(),
    description: document.getElementById('sod-desc').value.trim(),
    action:      document.getElementById('sod-action').value,
    conflictA:   { type: document.getElementById('sod-a-type').value.trim(), displayName: document.getElementById('sod-a-name').value.trim() },
    conflictB:   { type: document.getElementById('sod-b-type').value.trim(), displayName: document.getElementById('sod-b-name').value.trim() }
  });
  ['sod-id','sod-desc','sod-a-type','sod-a-name','sod-b-type','sod-b-name'].forEach(id => { document.getElementById(id).value = ''; });
  renderSod();
});

document.getElementById('btn-save-sod').addEventListener('click', () => {
  window.api.savePolicy(_policies, _sod);
});

window.api.onPolicySaved((data) => {
  const el = document.getElementById('sod-save-status');
  el.textContent = data.ok ? 'Saved.' : ('Error: ' + escHtml(data.error || ''));
  setTimeout(() => { el.textContent = ''; }, 2500);
});

function renderOperators() {
  const tbody = document.getElementById('op-tbody');
  tbody.innerHTML = Object.entries(_operators).map(([user, role]) => `<tr>
    <td class="mono">${escHtml(user)}</td>
    <td>${escHtml(role)}</td>
    <td><button class="btn-danger btn-del-op" data-user="${escHtml(user)}" style="padding:3px 8px;font-size:11px">Remove</button></td>
  </tr>`).join('') || '<tr><td colspan="3" class="empty-row">No operators configured.</td></tr>';
  tbody.querySelectorAll('.btn-del-op').forEach(btn => {
    btn.addEventListener('click', () => {
      delete _operators[btn.dataset.user];
      renderOperators();
    });
  });
}

document.getElementById('btn-add-operator').addEventListener('click', () => {
  const user = document.getElementById('input-add-op-user').value.trim();
  const role = document.getElementById('input-add-op-role').value;
  if (!user) return;
  _operators[user] = role;
  document.getElementById('input-add-op-user').value = '';
  renderOperators();
});

document.getElementById('btn-save-operators').addEventListener('click', () => {
  window.api.saveOperators(_operators, _roles);
});

window.api.onOperatorsSaved((data) => {
  const el = document.getElementById('operators-save-status');
  el.textContent = data.ok ? 'Saved.' : ('Error: ' + escHtml(data.error || ''));
  setTimeout(() => { el.textContent = ''; }, 2500);
});

// ── Agent Health ──────────────────────────────────────────────────────────────
window.api.onAgentHealth((data) => {
  const grid = document.getElementById('agent-health-grid');
  if (!grid) return;
  if (!data.agents || !data.agents.length) {
    grid.innerHTML = '<div class="loading-hint">No agent data.</div>';
    return;
  }
  grid.innerHTML = data.agents.map(a => {
    const credClass  = a.credentialType === 'certificate' ? 'cert' : a.credentialType === 'secret' ? 'secret' : 'unknown';
    const credLabel  = a.credentialType === 'certificate' ? 'Certificate' : a.credentialType === 'secret' ? 'Secret' : 'Unknown';
    let expiryHtml   = '<span class="health-expiry">No expiry info</span>';
    if (a.expiry) {
      const dClass = a.daysUntilExpiry < 0 ? 'days-critical' : a.daysUntilExpiry < 30 ? 'days-warning' : 'days-ok';
      const dLabel = a.daysUntilExpiry < 0 ? Math.abs(a.daysUntilExpiry) + 'd expired' : a.daysUntilExpiry + 'd remaining';
      expiryHtml = `<div class="health-expiry">Expires ${escHtml(new Date(a.expiry).toLocaleDateString())} <span class="${dClass}">(${dLabel})</span></div>`;
    }
    const lastAct = a.lastActivity ? new Date(a.lastActivity).toLocaleString() : 'Never';
    const outHtml = a.lastOutcome
      ? `<span class="health-outcome-badge ${a.lastOutcome}">${escHtml(a.lastOutcome)}</span>`
      : '';
    return `<div class="agent-health-card status-${a.status}">
      <div class="health-card-name">${escHtml(a.name)}</div>
      <span class="health-cred-badge ${credClass}">${credLabel}</span>
      ${expiryHtml}
      <div class="health-activity">${escHtml(lastAct)}${outHtml}</div>
    </div>`;
  }).join('');
});

// ── HR Event Queue ────────────────────────────────────────────────────────────
window.api.onHrQueue((data) => {
  const chip  = document.getElementById('hr-azurite-chip');
  const body  = document.getElementById('hr-queue-body');
  if (!chip || !body) return;

  if (data.error) {
    chip.textContent = 'Offline';
    chip.className   = 'export-status-chip chip-error';
    body.innerHTML   = '<div class="loading-hint">Azurite unavailable: ' + escHtml(data.error) + '</div>';
    return;
  }

  chip.textContent = 'Connected';
  chip.className   = 'export-status-chip chip-ok';

  const events = data.events || [];
  let html = '<div class="queue-depth-badge">Queue depth: ' + (data.queueDepth || 0) + '</div>';
  if (!events.length) {
    html += '<div class="loading-hint" style="margin-top:8px">No events found.</div>';
  } else {
    html += '<table class="queue-events-table"><thead><tr><th>Event Type</th><th>UPN</th><th>Status</th><th>Timestamp</th></tr></thead><tbody>'
      + events.map(e => `<tr>
        <td>${escHtml(e.eventType || '')}</td>
        <td class="mono">${escHtml(e.upn || '')}</td>
        <td>${escHtml(e.status || '')}</td>
        <td class="mono">${e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'}</td>
      </tr>`).join('')
      + '</tbody></table>';
  }
  body.innerHTML = html;
});

// ── Help drawer ───────────────────────────────────────────────────────────────
(function () {
  const drawer  = document.getElementById('help-drawer');
  const overlay = document.getElementById('help-overlay');

  function openHelp()  { drawer.classList.add('open'); overlay.classList.add('open'); }
  function closeHelp() { drawer.classList.remove('open'); overlay.classList.remove('open'); }

  document.getElementById('btn-help').addEventListener('click', openHelp);
  document.getElementById('btn-help-close').addEventListener('click', closeHelp);
  overlay.addEventListener('click', closeHelp);
})();

// ── Role-based UI ─────────────────────────────────────────────────────────────
function applyRoleUI(role) {
  const r = (role || 'viewer').toLowerCase();
  document.body.classList.remove('role-admin', 'role-helpdesk', 'role-viewer');
  document.body.classList.add('role-' + r);

  const badge = document.getElementById('sidebar-role-badge');
  if (badge) {
    badge.textContent = r.charAt(0).toUpperCase() + r.slice(1);
    badge.className   = 'role-badge role-' + r;
  }

  const banner = document.getElementById('role-access-banner');
  const bannerText = document.getElementById('role-access-text');
  if (banner) {
    if (r === 'viewer') {
      banner.classList.remove('hidden');
      if (bannerText) bannerText.textContent = 'Read-only viewer — all write operations are disabled.';
    } else if (r === 'helpdesk') {
      banner.classList.remove('hidden');
      if (bannerText) bannerText.textContent = 'Helpdesk role — restricted to joiner and enroller operations.';
    } else {
      banner.classList.add('hidden');
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.api.getCurrentOperator().then(d => {
  document.getElementById('sidebar-operator-name').textContent = d.name || window.api.currentUser;
  applyRoleUI(d.role);
}).catch(() => {
  document.getElementById('sidebar-operator-name').textContent = window.api.currentUser;
  applyRoleUI('viewer');
});

// ── Operator switch modal ─────────────────────────────────────────────────────
(function () {
  const overlay   = document.getElementById('op-switch-overlay');
  const list      = document.getElementById('op-switch-list');
  const cancelBtn = document.getElementById('op-switch-cancel');
  const switchBtn = document.getElementById('btn-switch-operator');

  function openSwitchModal() {
    window.api.getOperatorsForLogin().then(data => {
      const ops     = data.operators || {};
      const entries = Object.entries(ops);
      window.api.getCurrentOperator().then(cur => {
        const current = cur.name || window.api.currentUser;
        if (!entries.length) {
          list.innerHTML = '<div style="font-size:12px;color:var(--text-dim);text-align:center;padding:10px">No operators configured</div>';
        } else {
          list.innerHTML = entries.map(([name, role]) =>
            `<button class="op-switch-btn${name === current ? ' active' : ''}" data-name="${escHtml(name)}" data-role="${escHtml(role || '')}">
              <span>${escHtml(name)}</span>
              <span class="op-switch-role">${escHtml(role || 'user')}</span>
            </button>`
          ).join('');
          list.querySelectorAll('.op-switch-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              window.api.switchOperator(btn.dataset.name, btn.dataset.role);
              overlay.style.display = 'none';
            });
          });
        }
      });
      overlay.style.display = 'flex';
    });
  }

  switchBtn.addEventListener('click', openSwitchModal);
  cancelBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });

  window.api.onOperatorSwitched(d => {
    document.getElementById('sidebar-operator-name').textContent = d.name;
    applyRoleUI(d.role);
    switchTab('dashboard');
  });
})();

const _viewAllBtn = document.getElementById('btn-view-all-activity');
if (_viewAllBtn) _viewAllBtn.addEventListener('click', () => switchTab('audit-log'));

// ── JML Fleet assist bar + slash commands ─────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/joiner',      label: 'New Joiner',    desc: 'Onboard a new hire to the tenant',                          prompt: 'Onboard a new hire' },
  { cmd: '/mover',       label: 'Move User',     desc: 'Transfer a user to a new department or role',               prompt: 'Move a user to a new department' },
  { cmd: '/soft-leaver', label: 'Soft Offboard', desc: 'Disable account and revoke active sessions',                prompt: 'Soft offboard a user — disable their account and revoke sessions' },
  { cmd: '/hard-leaver', label: 'Hard Offboard', desc: 'Remove all licenses, groups, and delete the account',       prompt: 'Hard offboard a user — remove all access, licenses, and memberships' },
  { cmd: '/enroll',      label: 'Enroll MFA',    desc: 'Register a user for multi-factor authentication',           prompt: 'Enroll a user in MFA' },
  { cmd: '/check',       label: 'Check User',    desc: 'Retrieve current status and attributes for a user',         prompt: 'What is the current status of user ' },
  { cmd: '/whatif',      label: 'WhatIf',        desc: 'Simulate an operation without committing any changes',      prompt: 'WhatIf — what would happen if I ' },
  { cmd: '/bulk',        label: 'Bulk Import',   desc: 'Import multiple identities from a CSV payload',             prompt: 'I need to bulk onboard a group of new hires' },
];

const _slashDrop  = document.getElementById('slash-dropdown');
const _approverIn = document.getElementById('input-approver');
let _slashIdx = -1;

function _renderSlash(cmds) {
  _slashDrop.innerHTML = cmds.map(c =>
    `<button class="slash-item" data-prompt="${escHtml(c.prompt)}">` +
      `<span class="slash-cmd">${escHtml(c.cmd)}</span>` +
      `<span class="slash-label">${escHtml(c.label)}</span>` +
      `<span class="slash-desc">${escHtml(c.desc)}</span>` +
    `</button>`
  ).join('');
  _slashDrop.querySelectorAll('.slash-item').forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      _approverIn.value = item.dataset.prompt + ' ';
      _approverIn.focus();
      _slashDrop.classList.add('hidden');
      _slashIdx = -1;
    });
  });
}

function _slashItems() { return _slashDrop.querySelectorAll('.slash-item'); }
function _slashSetActive(idx) {
  _slashItems().forEach((el, i) => el.classList.toggle('active', i === idx));
}

if (_approverIn) {
  _approverIn.addEventListener('input', function () {
    const val = this.value;
    if (val.startsWith('/')) {
      const q = val.slice(1).toLowerCase();
      const matches = SLASH_COMMANDS.filter(c =>
        c.cmd.slice(1).startsWith(q) || c.label.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
      );
      if (matches.length) {
        _renderSlash(matches);
        _slashDrop.classList.remove('hidden');
      } else {
        _slashDrop.classList.add('hidden');
      }
      _slashIdx = -1;
    } else {
      _slashDrop.classList.add('hidden');
    }
  });

  _approverIn.addEventListener('keydown', function (e) {
    if (_slashDrop.classList.contains('hidden')) return;
    const items = _slashItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _slashIdx = Math.min(_slashIdx + 1, items.length - 1);
      _slashSetActive(_slashIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _slashIdx = Math.max(_slashIdx - 1, 0);
      _slashSetActive(_slashIdx);
    } else if ((e.key === 'Enter' || e.key === 'Tab') && _slashIdx >= 0) {
      e.preventDefault();
      items[_slashIdx].dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      _slashDrop.classList.add('hidden');
      _slashIdx = -1;
    }
  });
}

document.addEventListener('click', e => {
  if (!e.target.closest('#slash-dropdown') && !e.target.closest('#input-approver')) {
    if (_slashDrop) _slashDrop.classList.add('hidden');
  }
});

// Assist bar chips
document.querySelectorAll('#approver-assist-bar .assist-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (!_approverIn) return;
    _approverIn.value = chip.dataset.prompt;
    _approverIn.focus();
  });
});

// ── Dashboard quick actions ────────────────────────────────────────────────────
function _dashQuickAction(agent, prompt) {
  switchTab(agent);
  const input = document.getElementById('input-' + agent);
  if (input) { input.value = prompt; sendMessage(agent); }
}
document.getElementById('dash-action-joiner').addEventListener('click', () => _dashQuickAction('approver', 'Onboard a new hire'));
document.getElementById('dash-action-mover').addEventListener('click',  () => _dashQuickAction('approver', 'Move a user to a new department'));
document.getElementById('dash-action-leaver').addEventListener('click', () => _dashQuickAction('approver', 'Offboard a leaver'));
document.getElementById('dash-action-audit').addEventListener('click',  () => { switchTab('auditor'); document.getElementById('input-auditor').focus(); });
document.getElementById('dash-open-security').addEventListener('click', () => switchTab('security'));
document.querySelectorAll('.dash-sec-tile').forEach(btn => btn.addEventListener('click', () => switchTab('security')));

loadDashboard();

// ── Notification Centre ───────────────────────────────────────────────────────
let _notifications = [];

function addNotification(icon, title) {
  const n = { id: Date.now() + Math.random(), icon: icon, title: title, time: new Date() };
  _notifications.unshift(n);
  renderNotifications();
  showToast(title, 'info');
}

function renderNotifications() {
  const badge  = document.getElementById('notif-badge');
  const list   = document.getElementById('notif-list');
  const unread = _notifications.length;
  if (badge) {
    if (unread > 0) {
      badge.style.display = 'inline-block';
      badge.textContent   = unread > 9 ? '9+' : String(unread);
    } else {
      badge.style.display = 'none';
    }
  }
  if (!list) return;
  if (!_notifications.length) {
    list.innerHTML = '<div class="loading-hint">No notifications.</div>';
    return;
  }
  list.innerHTML = _notifications.map(n =>
    '<div class="notif-item" data-id="' + n.id + '">' +
      '<span class="notif-icon">' + escHtml(n.icon) + '</span>' +
      '<div class="notif-body">' +
        '<div class="notif-title">' + escHtml(n.title) + '</div>' +
        '<div class="notif-time">' + escHtml(n.time.toLocaleTimeString()) + '</div>' +
      '</div>' +
      '<button class="notif-dismiss" data-id="' + n.id + '" title="Dismiss">&#x2715;</button>' +
    '</div>'
  ).join('');
  list.querySelectorAll('.notif-dismiss').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _notifications = _notifications.filter(n => String(n.id) !== String(btn.dataset.id));
      renderNotifications();
    });
  });
}

(function () {
  const bell     = document.getElementById('btn-notif-bell');
  const dropdown = document.getElementById('notif-dropdown');
  const clearAll = document.getElementById('btn-notif-clear-all');
  if (!bell || !dropdown) return;

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dropdown.style.display !== 'none';
    dropdown.style.display = open ? 'none' : 'flex';
  });

  document.addEventListener('click', () => {
    if (dropdown) dropdown.style.display = 'none';
  });

  dropdown.addEventListener('click', (e) => e.stopPropagation());

  if (clearAll) {
    clearAll.addEventListener('click', () => {
      _notifications = [];
      renderNotifications();
    });
  }
})();

function showToast(message, type) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  const typeClass = type === 'success' ? 'toast-success' : type === 'warning' ? 'toast-warning' : type === 'danger' ? 'toast-danger' : '';
  el.className = 'toast' + (typeClass ? ' ' + typeClass : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3000);
}

// Hook scheduled op fired → notification
window.api.onScheduledOpFired((op) => {
  addNotification('⚡', 'Scheduled op fired: ' + (op.operation || '') + ' for ' + ((op.payload && op.payload.userPrincipalName) || ''));
});

// Hook bulk import complete → notification
window.api.onBulkImportComplete((data) => {
  addNotification('✅', 'Bulk import complete: ' + data.total + ' processed');
});

// ── Audit Log filters & Timeline ──────────────────────────────────────────────
let _allAuditEntries  = [];
let _timelineActive   = false;

window.api.onAuditLogData((entries) => {
  _allAuditEntries = entries;
  populateAgentFilter(entries);
  applyAuditFilters();
});

function populateAgentFilter(entries) {
  const sel = document.getElementById('log-filter-agent');
  if (!sel) return;
  const agents = [...new Set(entries.map(e => e.agent).filter(Boolean))].sort();
  const existing = Array.from(sel.options).map(o => o.value);
  agents.forEach(a => {
    if (!existing.includes(a)) {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      sel.appendChild(opt);
    }
  });
}

function applyAuditFilters() {
  const agentF   = (document.getElementById('log-filter-agent')    || {}).value || '';
  const outcomeF = (document.getElementById('log-filter-outcome')   || {}).value || '';
  const upnF     = ((document.getElementById('log-filter-upn')      || {}).value || '').trim().toLowerCase();
  const fromF    = (document.getElementById('log-filter-date-from') || {}).value || '';
  const toF      = (document.getElementById('log-filter-date-to')   || {}).value || '';

  let filtered = _allAuditEntries;
  if (agentF)   filtered = filtered.filter(e => e.agent   === agentF);
  if (outcomeF) filtered = filtered.filter(e => e.outcome === outcomeF);
  if (upnF)     filtered = filtered.filter(e => (e.subject || '').toLowerCase().includes(upnF));
  if (fromF)    filtered = filtered.filter(e => e.timestamp && new Date(e.timestamp) >= new Date(fromF));
  if (toF) {
    const toDate = new Date(toF);
    toDate.setHours(23, 59, 59, 999);
    filtered = filtered.filter(e => e.timestamp && new Date(e.timestamp) <= toDate);
  }

  const countEl = document.getElementById('log-count');
  if (countEl) countEl.textContent = filtered.length + ' entries';

  if (_timelineActive) {
    renderTimeline(filtered);
  } else {
    renderAuditTable(filtered);
  }
}

function renderAuditTable(entries) {
  const tbody    = document.getElementById('log-tbody');
  const tableEl  = document.getElementById('log-table');
  const timeline = document.getElementById('log-timeline');
  if (tableEl)  tableEl.style.display  = '';
  if (timeline) timeline.style.display = 'none';

  if (!tbody) return;
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No entries match.</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(e => {
    const ts       = e.timestamp ? new Date(e.timestamp).toLocaleString() : '--';
    const outcome  = e.outcome || '--';
    const mode     = e.whatif ? '<span class="badge-whatif">WhatIf</span>' : '<span class="badge-live">Live</span>';
    const cls      = outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : outcome === 'failed' ? 'failed' : '';
    const ticket   = (e.details && e.details.ticketRef) ? escHtml(e.details.ticketRef) : '<span class="dim">—</span>';
    const operator = e.operator ? escHtml(e.operator) : '<span class="dim">—</span>';
    return '<tr>' +
      '<td class="mono">' + ts + '</td>' +
      '<td>' + escHtml(e.agent || '--') + '</td>' +
      '<td class="mono">' + escHtml(e.subject || '--') + '</td>' +
      '<td>' + operator + '</td>' +
      '<td>' + ticket + '</td>' +
      '<td><span class="outcome ' + cls + '">' + escHtml(outcome) + '</span></td>' +
      '<td>' + mode + '</td>' +
    '</tr>';
  }).join('');
}

function renderTimeline(entries) {
  const tableEl  = document.getElementById('log-table');
  const timeline = document.getElementById('log-timeline');
  if (tableEl)  tableEl.style.display  = 'none';
  if (!timeline) return;
  timeline.style.display = 'block';

  if (!entries.length) {
    timeline.innerHTML = '<div class="loading-hint">No entries.</div>';
    return;
  }

  timeline.innerHTML = '<div class="timeline-list">' +
    entries.map((e, idx) => {
      const dotClass = e.outcome === 'success' ? 'success' :
                       e.outcome === 'partial'  ? 'partial'  :
                       e.outcome === 'failed'   ? 'failed'   :
                       e.whatif                 ? 'whatif'   : 'partial';
      const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
      const isLast = idx === entries.length - 1;
      return '<div class="timeline-item">' +
        '<div class="timeline-dot-wrap">' +
          '<div class="timeline-dot ' + dotClass + '"></div>' +
          (!isLast ? '<div class="timeline-line"></div>' : '') +
        '</div>' +
        '<div class="timeline-content">' +
          '<div class="timeline-header">' +
            '<span class="timeline-agent">' + escHtml(e.agent || '') + '</span>' +
            '<span class="timeline-action">' + escHtml(e.action || '') + '</span>' +
            '<span class="timeline-subject">' + escHtml(e.subject || '') + '</span>' +
            '<span class="timeline-time">' + escHtml(ts) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('') +
  '</div>';
}

(function () {
  const btnFilter = document.getElementById('btn-log-filter-apply');
  const btnClear  = document.getElementById('btn-log-filter-clear');
  const btnTimeline = document.getElementById('btn-toggle-timeline');

  if (btnFilter) btnFilter.addEventListener('click', applyAuditFilters);

  if (btnClear) {
    btnClear.addEventListener('click', () => {
      ['log-filter-agent','log-filter-outcome','log-filter-upn','log-filter-date-from','log-filter-date-to'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = el.tagName === 'SELECT' ? '' : '';
        if (el && el.tagName === 'SELECT') el.selectedIndex = 0;
      });
      applyAuditFilters();
    });
  }

  if (btnTimeline) {
    btnTimeline.addEventListener('click', () => {
      _timelineActive = !_timelineActive;
      btnTimeline.classList.toggle('active', _timelineActive);
      btnTimeline.style.color = _timelineActive ? 'var(--accent)' : '';
      applyAuditFilters();
    });
  }
})();

// ── User Lookup ───────────────────────────────────────────────────────────────
(function () {
  let _selectedUser = null;

  const searchInput = document.getElementById('user-search-input');
  const searchBtn   = document.getElementById('btn-user-search');

  function doSearch() {
    const q = (searchInput && searchInput.value.trim()) || '';
    if (!q) return;
    const countEl = document.getElementById('user-search-count');
    if (countEl) countEl.textContent = 'Searching…';
    document.getElementById('user-results-list').innerHTML = '<div class="loading-hint">Searching…</div>';
    window.api.searchUsers(q);
  }

  if (searchBtn)  searchBtn.addEventListener('click', doSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSearch();
    });
  }

  window.api.onUserSearchResults((data) => {
    if (_acHandler) { const h = _acHandler; _acHandler = null; h(data); return; }
    // Populate the autocomplete cache from full searches
    if (data.users && data.users.length) {
      const upns = new Set(_userCache.map(u => u.userPrincipalName));
      data.users.forEach(u => { if (!upns.has(u.userPrincipalName)) _userCache.push(u); });
    }
    const listEl  = document.getElementById('user-results-list');
    const countEl = document.getElementById('user-search-count');
    if (data.error) {
      listEl.innerHTML = '<div class="loading-hint">Error: ' + escHtml(data.error) + '</div>';
      if (countEl) countEl.textContent = '';
      return;
    }
    const users = data.users || [];
    if (countEl) countEl.textContent = users.length + ' result' + (users.length !== 1 ? 's' : '');
    if (!users.length) {
      listEl.innerHTML = '<div class="loading-hint">No users found.</div>';
      return;
    }
    listEl.innerHTML = users.map(u =>
      '<div class="user-result-item" data-id="' + escHtml(u.id) + '" data-upn="' + escHtml(u.userPrincipalName || '') + '">' +
        '<span class="user-result-badge ' + (u.accountEnabled ? 'enabled' : 'disabled') + '">' +
          (u.accountEnabled ? 'Enabled' : 'Disabled') +
        '</span>' +
        '<div class="user-result-name">' + escHtml(u.displayName || u.userPrincipalName || '') + '</div>' +
        '<div class="user-result-upn">'  + escHtml(u.userPrincipalName || '') + '</div>' +
      '</div>'
    ).join('');

    listEl.querySelectorAll('.user-result-item').forEach(item => {
      item.addEventListener('click', () => {
        listEl.querySelectorAll('.user-result-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        _selectedUser = { id: item.dataset.id, upn: item.dataset.upn };
        document.getElementById('user-detail-panel').style.display = 'flex';
        document.getElementById('udp-name').textContent = 'Loading…';
        document.getElementById('udp-upn').textContent  = item.dataset.upn;
        window.api.getUserDetail(item.dataset.id);
      });
    });
  });

  window.api.onUserDetail((data) => {
    if (data.error) {
      document.getElementById('udp-name').textContent = 'Error: ' + data.error;
      return;
    }
    const u = data.user || {};
    document.getElementById('udp-name').textContent = u.displayName || u.userPrincipalName || '—';
    document.getElementById('udp-upn').textContent  = u.userPrincipalName || '—';

    const badgeEl = document.getElementById('udp-badge');
    if (badgeEl) {
      badgeEl.textContent = u.accountEnabled ? 'Enabled' : 'Disabled';
      badgeEl.className   = 'user-detail-badge ' + (u.accountEnabled ? 'enabled' : 'disabled');
      badgeEl.style.background = u.accountEnabled ? 'var(--success-soft)' : 'var(--danger-soft)';
      badgeEl.style.color      = u.accountEnabled ? 'var(--success)'      : 'var(--danger)';
    }

    const detailsEl = document.getElementById('udp-details');
    const fields = [
      ['Department',  u.department     || '—'],
      ['Job Title',   u.jobTitle       || '—'],
      ['Office',      u.officeLocation || '—'],
      ['Location',    u.usageLocation  || '—'],
      ['Created',     u.createdDateTime ? new Date(u.createdDateTime).toLocaleDateString() : '—']
    ];
    detailsEl.innerHTML = fields.map(([k, v]) =>
      '<div class="user-detail-row"><span class="user-detail-key">' + escHtml(k) + '</span><span class="user-detail-val">' + escHtml(v) + '</span></div>'
    ).join('');

    const licensesEl = document.getElementById('udp-licenses');
    const lics = data.licenses || [];
    licensesEl.innerHTML = lics.length
      ? lics.map(l => '<span class="user-tag">' + escHtml(l) + '</span>').join('')
      : '<span class="loading-hint">None</span>';

    const groupsEl = document.getElementById('udp-groups');
    const grps = data.groups || [];
    groupsEl.innerHTML = grps.length
      ? grps.map(g => '<span class="user-tag">' + escHtml(g) + '</span>').join('')
      : '<span class="loading-hint">None</span>';

    const managerEl = document.getElementById('udp-manager');
    if (data.manager && data.manager.displayName) {
      managerEl.innerHTML = '<span class="user-tag">' + escHtml(data.manager.displayName) + '</span>' +
        '<span class="user-detail-val" style="font-size:11px;margin-left:6px;color:var(--text-muted)">' + escHtml(data.manager.userPrincipalName || '') + '</span>';
    } else {
      managerEl.innerHTML = '<span class="loading-hint">No manager</span>';
    }
  });

  // Quick action buttons
  const btnMover      = document.getElementById('udp-btn-mover');
  const btnLeaverSoft = document.getElementById('udp-btn-leaver-soft');
  const btnLeaverHard = document.getElementById('udp-btn-leaver-hard');

  function quickInitiate(prefix) {
    if (!_selectedUser) return;
    switchTab('operations');
    setTimeout(() => {
      const upnEl = document.getElementById(prefix + '-upn');
      if (upnEl) upnEl.value = _selectedUser.upn;
      const details = prefix === 'qm'
        ? document.getElementById('ops-quick-mover')
        : document.getElementById('ops-quick-leaver');
      if (details) details.setAttribute('open', '');
    }, 100);
  }

  // Autocomplete on main search input
  setupUserAutocomplete(document.getElementById('user-search-input'), {
    onSelect: (upn) => {
      const sb = document.getElementById('btn-user-search');
      if (sb) sb.click();
    }
  });

  if (btnMover)      btnMover.addEventListener('click',      () => quickInitiate('qm'));
  if (btnLeaverSoft) btnLeaverSoft.addEventListener('click', () => {
    if (!_selectedUser) return;
    switchTab('operations');
    setTimeout(() => {
      const upnEl = document.getElementById('ql-upn');
      if (upnEl) upnEl.value = _selectedUser.upn;
      const softRadio = document.querySelector('input[name="ql-stage"][value="Soft"]');
      if (softRadio) softRadio.checked = true;
      const det = document.getElementById('ops-quick-leaver');
      if (det) det.setAttribute('open', '');
    }, 100);
  });
  if (btnLeaverHard) btnLeaverHard.addEventListener('click', () => {
    if (!_selectedUser) return;
    switchTab('operations');
    setTimeout(() => {
      const upnEl = document.getElementById('ql-upn');
      if (upnEl) upnEl.value = _selectedUser.upn;
      const hardRadio = document.querySelector('input[name="ql-stage"][value="Hard"]');
      if (hardRadio) hardRadio.checked = true;
      const det = document.getElementById('ops-quick-leaver');
      if (det) det.setAttribute('open', '');
    }, 100);
  });
})();

// ── Quick Mover / Leaver ──────────────────────────────────────────────────────
(function () {
  const btnMover  = document.getElementById('btn-run-quick-mover');
  const btnLeaver = document.getElementById('btn-run-quick-leaver');

  if (btnMover) {
    btnMover.addEventListener('click', () => {
      const upn     = (document.getElementById('qm-upn')     || {}).value || '';
      const dept    = (document.getElementById('qm-dept')    || {}).value || '';
      const title   = (document.getElementById('qm-title')   || {}).value || '';
      const manager = (document.getElementById('qm-manager') || {}).value || '';
      const whatif  = (document.getElementById('qm-whatif')  || {}).checked !== false;
      if (!upn.trim()) { showToast('UPN is required', 'warning'); return; }
      const resultEl = document.getElementById('qm-result');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<span style="color:var(--text-dim)">Running…</span>'; }
      btnMover.disabled = true; btnMover.textContent = 'Running…';
      window.api.runQuickMover({ upn, newDepartment: dept, newJobTitle: title, newManager: manager, whatif });
    });
  }

  if (btnLeaver) {
    btnLeaver.addEventListener('click', () => {
      const upn    = (document.getElementById('ql-upn')    || {}).value || '';
      const stage  = (document.querySelector('input[name="ql-stage"]:checked') || {}).value || 'Soft';
      const reason = (document.getElementById('ql-reason') || {}).value || '';
      const whatif = (document.getElementById('ql-whatif') || {}).checked !== false;
      if (!upn.trim()) { showToast('UPN is required', 'warning'); return; }
      const resultEl = document.getElementById('ql-result');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<span style="color:var(--text-dim)">Running…</span>'; }
      btnLeaver.disabled = true; btnLeaver.textContent = 'Running…';
      window.api.runQuickLeaver({ upn, stage, reason, whatif });
    });
  }

  window.api.onQuickOpResult((data) => {
    const isLeaver = data.type === 'leaver';
    const btnEl    = document.getElementById(isLeaver ? 'btn-run-quick-leaver' : 'btn-run-quick-mover');
    const resultEl = document.getElementById(isLeaver ? 'ql-result' : 'qm-result');

    if (btnEl) { btnEl.disabled = false; btnEl.textContent = isLeaver ? 'Run Leaver' : 'Run Mover'; }

    if (!resultEl) return;
    resultEl.style.display = 'block';

    const lines = data.lines || [];
    if (!lines.length) {
      resultEl.innerHTML = data.error
        ? '<span class="qop-error">Error: ' + escHtml(String(lines[0] || 'Unknown error')) + '</span>'
        : '<span style="color:var(--text-dim)">No output.</span>';
      return;
    }

    resultEl.innerHTML = lines.map(line => {
      if (/\[ACTION\]/.test(line)) return '<div class="qop-action">' + escHtml(line) + '</div>';
      if (/\[WARN\]/.test(line))   return '<div class="qop-warn">'   + escHtml(line) + '</div>';
      if (/\[ERROR\]/.test(line))  return '<div class="qop-error">'  + escHtml(line) + '</div>';
      if (/\[WHATIF\]/.test(line)) return '<div class="qop-whatif">' + escHtml(line) + '</div>';
      return '<div style="color:var(--text-muted)">' + escHtml(line) + '</div>';
    }).join('');
  });
})();

// ── Stale Account Manager ─────────────────────────────────────────────────────
(function () {
  let _staleAccounts = [];

  const btnScan    = document.getElementById('btn-scan-stale');
  const btnDisable = document.getElementById('btn-disable-stale');

  if (btnScan) {
    btnScan.addEventListener('click', () => {
      const days = parseInt((document.getElementById('stale-days') || {}).value || '90', 10);
      document.getElementById('stale-results').innerHTML = '<div class="loading-hint">Scanning…</div>';
      if (btnDisable) btnDisable.style.display = 'none';
      btnScan.disabled = true; btnScan.textContent = 'Scanning…';
      window.api.getStaleAccounts(days);
    });
  }

  window.api.onStaleAccounts((data) => {
    if (btnScan) { btnScan.disabled = false; btnScan.textContent = 'Scan'; }
    const resultsEl = document.getElementById('stale-results');
    if (!resultsEl) return;

    if (data.error) {
      resultsEl.innerHTML = '<div class="loading-hint">Error: ' + escHtml(data.error) + '</div>';
      return;
    }

    _staleAccounts = data.accounts || [];
    if (!_staleAccounts.length) {
      resultsEl.innerHTML = '<div class="loading-hint">No stale accounts found.</div>';
      if (btnDisable) btnDisable.style.display = 'none';
      return;
    }

    const now = new Date();
    resultsEl.innerHTML =
      '<table class="stale-table">' +
        '<thead><tr>' +
          '<th style="width:28px"><input type="checkbox" id="stale-check-all" title="Select all"></th>' +
          '<th>Name</th><th>UPN</th><th>Last Sign-in</th><th>Days Idle</th>' +
        '</tr></thead>' +
        '<tbody>' +
          _staleAccounts.map(a => {
            const last     = a.lastSignIn ? new Date(a.lastSignIn) : null;
            const daysIdle = last ? Math.floor((now - last) / 86400000) : '?';
            const lastStr  = last ? last.toLocaleDateString() : 'Never';
            return '<tr>' +
              '<td><input type="checkbox" class="stale-check" data-id="' + escHtml(a.id) + '"></td>' +
              '<td>' + escHtml(a.displayName || '') + '</td>' +
              '<td class="mono">' + escHtml(a.upn || '') + '</td>' +
              '<td>' + escHtml(lastStr) + '</td>' +
              '<td>' + escHtml(String(daysIdle)) + '</td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>';

    if (btnDisable) btnDisable.style.display = 'inline-block';

    const checkAll = document.getElementById('stale-check-all');
    if (checkAll) {
      checkAll.addEventListener('change', () => {
        resultsEl.querySelectorAll('.stale-check').forEach(c => { c.checked = checkAll.checked; });
      });
    }
  });

  if (btnDisable) {
    btnDisable.addEventListener('click', () => {
      const checked = document.querySelectorAll('.stale-check:checked');
      const ids     = Array.from(checked).map(c => c.dataset.id).filter(Boolean);
      if (!ids.length) { showToast('No accounts selected', 'warning'); return; }
      btnDisable.disabled = true; btnDisable.textContent = 'Disabling…';
      window.api.disableStaleAccounts(ids);
    });
  }

  window.api.onStaleDisableResult((data) => {
    if (btnDisable) { btnDisable.disabled = false; btnDisable.textContent = 'Disable Selected'; }
    if (data.ok) {
      showToast('Disabled ' + data.disabled + ' account(s)', 'success');
      addNotification('🔒', 'Stale accounts disabled: ' + data.disabled);
      if (btnScan) btnScan.click();
    } else {
      showToast('Error: ' + (data.error || 'Unknown'), 'danger');
    }
  });
})();

// ── Certificate Expiry Dashboard ──────────────────────────────────────────────
(function () {
  const secCert = document.getElementById('sec-cert-expiry');
  if (secCert) {
    secCert.addEventListener('toggle', () => {
      if (secCert.open) window.api.getCertExpiry();
    });
  }

  window.api.onCertExpiry((data) => {
    const bodyEl = document.getElementById('cert-expiry-body');
    if (!bodyEl) return;

    if (data.error) {
      bodyEl.innerHTML = '<div class="loading-hint">Error: ' + escHtml(data.error) + '</div>';
      return;
    }

    const certs = data.certs || [];
    if (!certs.length) {
      bodyEl.innerHTML = '<div class="loading-hint">No certificate data found in agent configs.</div>';
      return;
    }

    // Fire notifications for certs expiring < 30 days
    certs.forEach(c => {
      if (c.daysRemaining !== null && c.daysRemaining < 30) {
        addNotification('⚠️', 'Cert expiring soon: ' + c.agent + ' (' + c.daysRemaining + 'd)');
      }
    });

    bodyEl.innerHTML =
      '<table class="cert-expiry-table">' +
        '<thead><tr><th>Agent</th><th>Thumbprint</th><th>Expiry</th><th>Days Remaining</th></tr></thead>' +
        '<tbody>' +
          certs.map(c => {
            const d     = c.daysRemaining;
            const dCls  = d === null ? '' : d < 30 ? 'days-critical' : d < 90 ? 'days-warning' : 'days-ok';
            const dText = d === null ? '—' : String(d) + 'd';
            const thumb = c.thumbprint ? (c.thumbprint.slice(0, 12) + '…') : '—';
            const exp   = c.expiry ? new Date(c.expiry).toLocaleDateString() : '—';
            return '<tr>' +
              '<td style="text-transform:capitalize">' + escHtml(c.agent) + '</td>' +
              '<td class="mono">' + escHtml(thumb) + '</td>' +
              '<td>' + escHtml(exp) + '</td>' +
              '<td><span class="' + dCls + '">' + escHtml(dText) + '</span></td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>';
  });
})();

// ── SoD Conflict Tester ───────────────────────────────────────────────────────
(function () {
  const btnTest = document.getElementById('btn-test-sod');
  if (btnTest) {
    btnTest.addEventListener('click', () => {
      const groupA = (document.getElementById('sod-test-group-a') || {}).value || '';
      const groupB = (document.getElementById('sod-test-group-b') || {}).value || '';
      const upn    = (document.getElementById('sod-test-upn')     || {}).value || '';
      if (!groupA.trim() || !groupB.trim()) { showToast('Both group names are required', 'warning'); return; }
      const resultEl = document.getElementById('sod-tester-result');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.className = 'sod-tester-result'; resultEl.innerHTML = 'Testing…'; }
      btnTest.disabled = true; btnTest.textContent = 'Testing…';
      window.api.testSodConflict({ groupA, groupB, upn });
    });
  }

  window.api.onSodResult((data) => {
    if (btnTest) { btnTest.disabled = false; btnTest.textContent = 'Test'; }
    const resultEl = document.getElementById('sod-tester-result');
    if (!resultEl) return;
    resultEl.style.display = 'block';

    if (data.error) {
      resultEl.className = 'sod-tester-result sod-result-block';
      resultEl.innerHTML = 'Error: ' + escHtml(data.error);
      return;
    }

    const passed   = data.Passed !== undefined ? data.Passed : true;
    const blocks   = data.Blocks   || [];
    const warnings = data.Warnings || [];
    const details  = data.Details  || [];

    let cls;
    let label;
    if (!passed || blocks.length > 0) {
      cls = 'sod-result-block'; label = 'BLOCK';
    } else if (warnings.length > 0) {
      cls = 'sod-result-warn'; label = 'WARN';
    } else {
      cls = 'sod-result-pass'; label = 'PASS';
    }

    resultEl.className = 'sod-tester-result ' + cls;
    const detailText = details.length ? details.join('; ') : (blocks.concat(warnings)).join(', ') || 'No conflicts found.';
    resultEl.innerHTML = label +
      '<div class="sod-result-details">' + escHtml(detailText) + '</div>';
  });
})();

// ── License Utilization ───────────────────────────────────────────────────────
(function () {
  const btnLoad = document.getElementById('btn-load-license-util');
  if (btnLoad) {
    btnLoad.addEventListener('click', () => {
      document.getElementById('license-util-body').innerHTML = '<div class="loading-hint">Loading…</div>';
      btnLoad.disabled = true; btnLoad.textContent = 'Loading…';
      window.api.getLicenseUtilization();
    });
  }

  window.api.onLicenseUtilization((data) => {
    if (btnLoad) { btnLoad.disabled = false; btnLoad.textContent = 'Refresh'; }
    const bodyEl = document.getElementById('license-util-body');
    if (!bodyEl) return;

    if (data.error) {
      bodyEl.innerHTML = '<div class="loading-hint">Error: ' + escHtml(data.error) + '</div>';
      return;
    }

    const skus = data.skus || [];
    if (!skus.length) {
      bodyEl.innerHTML = '<div class="loading-hint">No license data.</div>';
      return;
    }

    bodyEl.innerHTML =
      '<table class="license-util-table">' +
        '<thead><tr><th>SKU</th><th>Total</th><th>Assigned</th><th>Available</th><th>% Used</th></tr></thead>' +
        '<tbody>' +
          skus.map(s => {
            const pct    = s.total > 0 ? Math.round((s.assigned / s.total) * 100) : 0;
            const pctCls = pct > 95 ? 'util-crit' : pct > 80 ? 'util-warn' : 'util-ok';
            return '<tr>' +
              '<td class="mono">' + escHtml(s.sku || '') + '</td>' +
              '<td>' + (s.total    || 0) + '</td>' +
              '<td>' + (s.assigned || 0) + '</td>' +
              '<td>' + (s.available !== undefined ? s.available : '—') + '</td>' +
              '<td><span class="' + pctCls + '">' + pct + '%</span></td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>';
  });
})();

// ── PIM Role Activations ──────────────────────────────────────────────────────
(function () {
  const btnLoad = document.getElementById('btn-load-pim');
  if (btnLoad) {
    btnLoad.addEventListener('click', () => {
      document.getElementById('pim-roles-list').innerHTML = '<div class="loading-hint">Loading…</div>';
      btnLoad.disabled = true; btnLoad.textContent = 'Loading…';
      window.api.getPimRoles();
    });
  }

  window.api.onPimRoles((data) => {
    if (btnLoad) { btnLoad.disabled = false; btnLoad.textContent = 'Load PIM Roles'; }
    const listEl = document.getElementById('pim-roles-list');
    if (!listEl) return;

    if (!data.ok) {
      listEl.innerHTML = '<div class="loading-hint">PIM unavailable: ' + escHtml(data.error || 'P2 license may not be available') + '</div>';
      return;
    }

    const roles = data.roles || [];
    if (!roles.length) {
      listEl.innerHTML = '<div class="loading-hint">No PIM roles found.</div>';
      return;
    }

    listEl.innerHTML =
      '<table class="pim-role-table">' +
        '<thead><tr><th>Role</th><th>Status</th><th>Expiry</th><th>Action</th></tr></thead>' +
        '<tbody>' +
          roles.map((r, idx) => {
            const statusCls = r.status === 'Active' ? 'pim-status-active' : 'pim-status-eligible';
            const exp       = r.expiry ? new Date(r.expiry).toLocaleString() : '—';
            return '<tr id="pim-row-' + idx + '">' +
              '<td>' + escHtml(r.roleName || r.roleDefinitionId || '') + '</td>' +
              '<td><span class="' + statusCls + '">' + escHtml(r.status || '') + '</span></td>' +
              '<td>' + escHtml(exp) + '</td>' +
              '<td>' +
                (r.status === 'Eligible'
                  ? '<button class="btn-ghost btn-pim-activate" data-idx="' + idx + '" data-id="' + escHtml(r.roleDefinitionId || '') + '">Activate</button>'
                  : '<span style="color:var(--text-dim);font-size:12px">Active</span>') +
              '</td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>';

    listEl.querySelectorAll('.btn-pim-activate').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx  = btn.dataset.idx;
        const rdId = btn.dataset.id;
        const rowEl = document.getElementById('pim-row-' + idx);
        if (!rowEl) return;

        // Toggle inline form
        const existingForm = rowEl.nextElementSibling;
        if (existingForm && existingForm.classList.contains('pim-inline-form-row')) {
          existingForm.remove();
          return;
        }

        const formRow = document.createElement('tr');
        formRow.className = 'pim-inline-form-row';
        formRow.innerHTML =
          '<td colspan="4">' +
            '<div class="pim-activate-form">' +
              '<input class="chat-input" id="pim-just-' + idx + '" type="text" placeholder="Justification">' +
              '<div style="display:flex;gap:8px;align-items:center">' +
                '<label style="font-size:12px;color:var(--text-muted)">Duration (h):</label>' +
                '<input class="chat-input" id="pim-dur-' + idx + '" type="number" value="1" min="1" max="8" style="width:70px">' +
                '<button class="btn-run btn-pim-confirm" data-idx="' + idx + '" data-id="' + escHtml(rdId) + '">Confirm</button>' +
                '<button class="btn-ghost btn-pim-cancel">Cancel</button>' +
              '</div>' +
            '</div>' +
          '</td>';

        rowEl.insertAdjacentElement('afterend', formRow);

        formRow.querySelector('.btn-pim-cancel').addEventListener('click', () => formRow.remove());

        formRow.querySelector('.btn-pim-confirm').addEventListener('click', () => {
          const just     = (document.getElementById('pim-just-' + idx) || {}).value || '';
          const dur      = parseInt((document.getElementById('pim-dur-' + idx) || {}).value || '1', 10);
          const roleDefId = rdId;
          const confirmBtn = formRow.querySelector('.btn-pim-confirm');
          confirmBtn.disabled = true; confirmBtn.textContent = 'Activating…';
          window.api.activatePimRole({ roleDefinitionId: roleDefId, justification: just, durationHours: dur });
        });
      });
    });
  });

  window.api.onPimActivateResult((data) => {
    if (data.ok) {
      showToast('PIM role activated', 'success');
      addNotification('🔑', 'PIM role activated');
      // Reload the list
      if (btnLoad) btnLoad.click();
    } else {
      showToast('PIM activation failed: ' + (data.error || 'Unknown error'), 'danger');
    }
  });
})();

// ── Graph Query Runner ────────────────────────────────────────────────────────
(function () {
  const methodSel   = document.getElementById('graph-method');
  const urlInput    = document.getElementById('graph-url');
  const bodyArea    = document.getElementById('graph-body');
  const btnRun      = document.getElementById('btn-run-graph');
  const btnCopy     = document.getElementById('btn-copy-graph-resp');
  const recentWrap  = document.getElementById('graph-recent-wrap');
  const recentList  = document.getElementById('graph-recent-list');
  const respPanel   = document.getElementById('graph-response-panel');
  const respPre     = document.getElementById('graph-response-pre');
  const respMeta    = document.getElementById('graph-resp-meta');
  const assistInput = document.getElementById('graph-assist-input');
  const btnAssist   = document.getElementById('btn-graph-assist');

  // Quick-pick chips
  document.querySelectorAll('.graph-cq-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (methodSel) methodSel.value = chip.dataset.method || 'GET';
      if (urlInput)  urlInput.value  = chip.dataset.url   || '';
      toggleBodyArea();
    });
  });

  // AI suggest
  function runSuggest() {
    const desc = assistInput ? assistInput.value.trim() : '';
    if (!desc) return;
    if (btnAssist) { btnAssist.disabled = true; btnAssist.textContent = '…'; }
    window.api.suggestGraphQuery(desc);
  }
  if (btnAssist)   btnAssist.addEventListener('click', runSuggest);
  if (assistInput) assistInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSuggest(); });

  window.api.onGraphQuerySuggestion((data) => {
    if (btnAssist) { btnAssist.disabled = false; btnAssist.textContent = '✦ Suggest'; }
    if (!data.ok) { showToast('Suggest failed: ' + (data.error || 'Unknown'), 'danger'); return; }
    if (methodSel && data.method) methodSel.value = data.method;
    if (urlInput  && data.url)    urlInput.value  = data.url;
    if (bodyArea  && data.body && data.body !== null) {
      bodyArea.value = typeof data.body === 'string' ? data.body : JSON.stringify(data.body, null, 2);
    }
    toggleBodyArea();
    showToast('Suggestion applied', 'success');
  });

  const RECENT_KEY   = 'jml-graph-recent';
  const btnColorJson = document.getElementById('btn-color-json');
  const digestCard   = document.getElementById('graph-digest-card');
  const digestText   = document.getElementById('graph-digest-text');
  let _colorMode = true, _lastRespText = '', _lastMethod = 'GET', _lastUrl = '';
  if (btnColorJson) { btnColorJson.textContent = 'Plain'; btnColorJson.classList.add('active'); }

  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }

  function saveRecent(entries) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, 10)));
  }

  function renderRecent() {
    const entries = loadRecent();
    if (!recentWrap || !recentList) return;
    if (!entries.length) { recentWrap.style.display = 'none'; return; }
    recentWrap.style.display = 'block';
    recentList.innerHTML = entries.map((e, i) =>
      '<div class="graph-recent-item" data-idx="' + i + '">' +
        '<span class="graph-recent-method">' + escHtml(e.method) + '</span>' +
        '<span class="graph-recent-url">' + escHtml(e.url) + '</span>' +
      '</div>'
    ).join('');
    recentList.querySelectorAll('.graph-recent-item').forEach(item => {
      item.addEventListener('click', () => {
        const e = entries[parseInt(item.dataset.idx, 10)];
        if (!e) return;
        if (methodSel) methodSel.value = e.method;
        if (urlInput)  urlInput.value  = e.url;
        if (bodyArea && e.body) { bodyArea.value = e.body; bodyArea.style.display = ''; }
        toggleBodyArea();
      });
    });
  }

  function toggleBodyArea() {
    const method = methodSel ? methodSel.value : 'GET';
    if (bodyArea) bodyArea.style.display = (method === 'POST' || method === 'PATCH') ? '' : 'none';
  }

  if (methodSel) methodSel.addEventListener('change', toggleBodyArea);
  toggleBodyArea();
  renderRecent();

  if (btnRun) {
    btnRun.addEventListener('click', () => {
      const method = methodSel ? methodSel.value : 'GET';
      const url    = urlInput  ? urlInput.value.trim() : '';
      const body   = bodyArea  ? bodyArea.value.trim() : '';
      if (!url) { showToast('URL is required', 'warning'); return; }

      if (respPanel) respPanel.style.display = 'flex';
      if (respPre)   respPre.textContent = 'Running…';
      if (respMeta)  respMeta.textContent = '';
      if (btnCopy)   btnCopy.style.display = 'none';
      btnRun.disabled = true; btnRun.textContent = 'Running…';

      let parsedBody = null;
      if (body && (method === 'POST' || method === 'PATCH')) {
        try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
      }

      _lastMethod = method; _lastUrl = url;
      window.api.runGraphQuery({ method, url, body: parsedBody });

      // Save to recent
      const entries = loadRecent().filter(e => !(e.method === method && e.url === url));
      entries.unshift({ method, url, body: body || '' });
      saveRecent(entries);
      renderRecent();
    });
  }

  if (btnColorJson) {
    btnColorJson.addEventListener('click', () => {
      _colorMode = !_colorMode;
      btnColorJson.classList.toggle('active', _colorMode);
      btnColorJson.textContent = _colorMode ? 'Plain' : 'Color';
      if (respPre && _lastRespText) {
        if (_colorMode) { respPre.innerHTML = highlightJson(_lastRespText); }
        else            { respPre.textContent = _lastRespText; }
      }
    });
  }

  window.api.onGraphQueryResult((data) => {
    if (btnRun) { btnRun.disabled = false; btnRun.textContent = 'Run'; }
    if (!respPre) return;

    if (data.ok) {
      _lastRespText = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
      if (_colorMode) { respPre.innerHTML = highlightJson(_lastRespText); }
      else            { respPre.textContent = _lastRespText; }
      if (respMeta) respMeta.textContent = typeof data.result === 'object' && data.result && data.result.value
        ? data.result.value.length + ' items' : '';
      if (btnCopy)     btnCopy.style.display     = 'inline-block';
      if (btnColorJson) btnColorJson.style.display = 'inline-block';
      if (digestCard) { digestCard.style.display = 'flex'; }
      if (digestText) digestText.textContent = 'Summarizing…';
      window.api.digestGraphResult({ method: _lastMethod, url: _lastUrl, responseText: _lastRespText.slice(0, 3000) });
    } else {
      _lastRespText = '';
      respPre.textContent = 'Error: ' + (data.error || 'Unknown error');
      if (respMeta)     respMeta.textContent      = '';
      if (btnColorJson) btnColorJson.style.display = 'none';
      if (digestCard)   digestCard.style.display   = 'none';
    }
  });

  window.api.onGraphDigest((data) => {
    if (!digestCard || !digestText) return;
    if (data.ok && data.text) {
      digestText.textContent = data.text;
      digestCard.style.display = 'flex';
    } else {
      digestCard.style.display = 'none';
    }
  });

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (navigator.clipboard && _lastRespText) {
        navigator.clipboard.writeText(_lastRespText).then(() => showToast('Copied to clipboard', 'success'));
      }
    });
  }
})();

// ── API Archiver (Common Query Tracker) ───────────────────────────────────────
// Tracks Graph API calls made by agents. Builds a frequency map in localStorage
// so operators can learn what the agents call most often.
(function () {
  const ARCHIVE_KEY = 'jml-api-archive';

  function loadArchive() {
    try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]'); } catch { return []; }
  }

  function saveArchive(entries) {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(entries));
  }

  function normaliseUrl(url) {
    // Strip GUIDs to make URLs group better: e.g. /users/abc-123/... -> /users/{id}/...
    return (url || '').replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,35}/g, '/{id}')
                      .replace(/\?.*$/, '');
  }

  function recordCall(method, url, source) {
    const entries = loadArchive();
    const norm    = normaliseUrl(url);
    const existing = entries.find(e => e.method === method && e.normUrl === norm && e.source === source);
    if (existing) {
      existing.count++;
      existing.lastSeen = new Date().toISOString();
      existing.exampleUrls = existing.exampleUrls || [];
      if (!existing.exampleUrls.includes(url) && existing.exampleUrls.length < 3) {
        existing.exampleUrls.push(url);
      }
    } else {
      entries.push({ method, normUrl: norm, source, count: 1, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), exampleUrls: [url] });
    }
    // Keep top 200 entries by count
    entries.sort((a, b) => b.count - a.count);
    saveArchive(entries.slice(0, 200));
  }

  // Hook into Graph Query Runner results to record those calls
  window.api.onGraphQueryResult((data) => {
    // The URL was already saved to recent — read it from the input
    const url    = (document.getElementById('graph-url')    || {}).value || '';
    const method = (document.getElementById('graph-method') || {}).value || 'GET';
    if (url) recordCall(method, url, 'graph-runner');
  });

  // Expose for the API Archiver view rendering
  window._apiArchive = { loadArchive, recordCall };

  // Render the archiver section (inside Graph view, appended dynamically)
  function renderArchiver() {
    const wrap = document.getElementById('graph-archiver-wrap');
    if (!wrap) return;
    const entries = loadArchive();
    if (!entries.length) {
      wrap.innerHTML =
        '<div class="section-title" style="margin-bottom:8px">Common API Calls</div>' +
        '<div class="loading-hint">No recorded calls yet. Use the Graph Runner or run agent operations to populate this list.</div>';
      return;
    }

    // Group by source
    const sources = [...new Set(entries.map(e => e.source))];
    const srcFilter = (document.getElementById('archiver-source-filter') || {}).value || '';
    const filtered  = srcFilter ? entries.filter(e => e.source === srcFilter) : entries;

    wrap.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
        '<div class="section-title">Common API Calls</div>' +
        '<div style="display:flex;gap:8px">' +
          '<select class="form-select" id="archiver-source-filter" style="font-size:12px">' +
            '<option value="">All sources</option>' +
            sources.map(s => '<option value="' + escHtml(s) + '"' + (s === srcFilter ? ' selected' : '') + '>' + escHtml(s) + '</option>').join('') +
          '</select>' +
          '<button class="btn-danger" id="btn-clear-archive" style="font-size:12px;padding:4px 10px">Clear</button>' +
        '</div>' +
      '</div>' +
      '<table class="data-table" style="font-size:12px">' +
        '<thead><tr><th>#</th><th>Method</th><th>Endpoint</th><th>Source</th><th>Count</th><th>Last Seen</th></tr></thead>' +
        '<tbody>' +
          filtered.slice(0, 50).map((e, i) => {
            const methodColor = e.method === 'GET'    ? 'var(--success)' :
                                e.method === 'POST'   ? 'var(--accent)'  :
                                e.method === 'PATCH'  ? 'var(--warning)' :
                                e.method === 'DELETE' ? 'var(--danger)'  : 'var(--text-muted)';
            return '<tr title="' + escHtml((e.exampleUrls || []).join('\n')) + '">' +
              '<td style="color:var(--text-dim)">' + (i + 1) + '</td>' +
              '<td><span style="color:' + methodColor + ';font-weight:600;font-size:11px">' + escHtml(e.method) + '</span></td>' +
              '<td class="mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(e.normUrl) + '</td>' +
              '<td style="color:var(--text-muted)">' + escHtml(e.source || '') + '</td>' +
              '<td style="color:var(--accent);font-weight:600">' + (e.count || 0) + '</td>' +
              '<td style="color:var(--text-dim)">' + (e.lastSeen ? new Date(e.lastSeen).toLocaleDateString() : '—') + '</td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>';

    const srcSel = document.getElementById('archiver-source-filter');
    if (srcSel) srcSel.addEventListener('change', renderArchiver);

    const btnClearArchive = document.getElementById('btn-clear-archive');
    if (btnClearArchive) {
      btnClearArchive.addEventListener('click', () => {
        saveArchive([]);
        renderArchiver();
        showToast('API archive cleared', 'info');
      });
    }
  }

  // Inject archiver section into the Graph view
  const graphContent = document.querySelector('#view-graph .graph-content');
  if (graphContent) {
    const archiverSection = document.createElement('div');
    archiverSection.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;';
    archiverSection.id = 'graph-archiver-wrap';
    graphContent.appendChild(archiverSection);
    renderArchiver();
  }

  // Re-render archiver when Graph tab is opened
  const origSwitchTab = switchTab;
  // Patch the tab switch to refresh archiver
  document.querySelectorAll('.nav-item').forEach(btn => {
    if (btn.dataset.tab === 'graph') {
      btn.addEventListener('click', () => setTimeout(renderArchiver, 50));
    }
  });
})();

// ── UPN field autocomplete (all forms) ────────────────────────────────────────
setupUserAutocomplete(document.getElementById('qm-upn'));
setupUserAutocomplete(document.getElementById('ql-upn'));
setupUserAutocomplete(document.getElementById('sod-test-upn'));
setupUserAutocomplete(document.getElementById('sched-upn'));
setupUserAutocomplete(document.getElementById('log-filter-upn'));

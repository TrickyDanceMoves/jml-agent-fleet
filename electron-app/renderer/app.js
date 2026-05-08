'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab     = 'dashboard';
let isWhatif       = true;
let isWaiting      = { approver: false, auditor: false };
let currentMsgEl   = { approver: null, auditor: null };

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + tab));
  currentTab = tab;
  if (tab === 'audit-log') loadAuditLog();
  if (tab === 'dashboard') loadDashboard();
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
  el.innerHTML = `
    <div class="message-avatar">AI</div>
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
    const ind = document.createElement('div');
    ind.className    = 'tool-indicator running';
    ind.dataset.tool = toolName;
    ind.innerHTML    = `<span class="tool-spinner"></span><span class="tool-label">${formatToolName(toolName)}</span>`;
    toolEl.appendChild(ind);
  }

  if (type === 'tool_running') {
    const ind = toolEl.querySelector('[data-tool="' + toolName + '"]');
    if (ind) ind.querySelector('.tool-label').textContent = formatToolName(toolName) + '…';
  }

  if (type === 'tool_done') {
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
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No audit entries found.</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = entries.length + ' entries';
  tbody.innerHTML = entries.map(e => {
    const ts      = e.timestamp ? new Date(e.timestamp).toLocaleString() : '--';
    const outcome = e.outcome || '--';
    const mode    = e.whatif ? '<span class="badge-whatif">WhatIf</span>' : '<span class="badge-live">Live</span>';
    const cls     = outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : outcome === 'failed' ? 'failed' : '';
    const ticket  = (e.details && e.details.ticketRef) ? escHtml(e.details.ticketRef) : '<span class="dim">—</span>';
    return `<tr>
      <td class="mono">${ts}</td>
      <td>${escHtml(e.agent || '--')}</td>
      <td class="mono">${escHtml(e.subject || '--')}</td>
      <td>${ticket}</td>
      <td><span class="outcome ${cls}">${escHtml(outcome)}</span></td>
      <td>${mode}</td>
    </tr>`;
  }).join('');
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
function loadDashboard() {
  window.api.getDashboardStats();
}

window.api.onDashboardStats((data) => {
  if (data.error) {
    document.getElementById('stat-users-detail').textContent = data.error;
    document.getElementById('stat-licenses-detail').textContent = '';
    document.getElementById('stat-activity-detail').textContent = '';
    return;
  }

  if (data.users) {
    document.getElementById('stat-users-total').textContent = data.users.total || '--';
    document.getElementById('stat-users-detail').textContent =
      (data.users.enabled || 0) + ' enabled  ·  ' + (data.users.disabled || 0) + ' disabled  ·  ' + (data.users.guests || 0) + ' guests';
  }

  if (data.licenses && data.licenses.licenses) {
    const total    = data.licenses.licenses.reduce((s, l) => s + l.total, 0);
    const assigned = data.licenses.licenses.reduce((s, l) => s + l.assigned, 0);
    document.getElementById('stat-licenses-total').textContent = assigned + ' / ' + total;
    document.getElementById('stat-licenses-detail').textContent =
      data.licenses.licenses.map(l => l.sku + ': ' + l.assigned + '/' + l.total).join('  ·  ');
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

function renderMarkdown(text) {
  return escHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

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

// ── Init ──────────────────────────────────────────────────────────────────────
loadDashboard();

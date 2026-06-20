'use strict';

// Follow the console's theme choice (Settings → Appearance)
try {
  const t = localStorage.getItem('jmlTheme');
  if (t === 'glass' || t === 'preview') document.documentElement.dataset.theme = t;
} catch (_) {}

// ── State ─────────────────────────────────────────────────────────────────────
let _anchorY   = null;
let _winX      = null;
let _winW      = null;
let _agent     = 'approver';
let _streaming = false;
let _msgEl     = null;
let _resizeTimer = null;
let _mode      = 'safe';

const THREAD_OPEN_H = 200;
const MIN_H = 88;
const MAX_H = 580;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const ovApprovals = document.getElementById('ov-approvals');
const ovDivider   = document.getElementById('ov-divider');
const ovThread    = document.getElementById('ov-thread');
const ovInput     = document.getElementById('ov-input');
const ovSend      = document.getElementById('ov-send');
const ovClr       = document.getElementById('ov-clr');
const ovClose     = document.getElementById('ov-close');
const ovApToggle  = document.getElementById('ov-ap-toggle');
const ovModePill  = document.getElementById('ov-mode-pill');
const ovBadge     = document.getElementById('ov-badge');
const ovToasts    = document.getElementById('ov-toasts');

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function relativeAge(ts) {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts);
  if (ms < 60000)    return '<1m ago';
  if (ms < 3600000)  return Math.round(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
  return Math.round(ms / 86400000) + 'd ago';
}
function toolLabel(tool) {
  const t = (tool || '').toLowerCase();
  if (t.includes('hard'))     return 'Hard Leave';
  if (t.includes('soft'))     return 'Soft Leave';
  if (t.includes('joiner'))   return 'Joiner';
  if (t.includes('enroller')) return 'Enroller';
  if (t.includes('mover'))    return 'Mover';
  return 'Request';
}
function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'ov-toast ' + type;
  el.textContent = msg;
  ovToasts.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Conversation history replay ────────────────────────────────────────────────
async function loadAgentHistory(agent) {
  if (typeof window.overlayApi.getConversationHistory !== 'function') return;
  try {
    const history = await window.overlayApi.getConversationHistory(agent);
    if (!history || !history.length) return;
    history.forEach(({ role, text }) => {
      if (text) appendMsg(role === 'assistant' ? 'assistant' : 'user', text);
    });
  } catch { /* ignore */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.overlayApi.onInit((d) => {
  _anchorY = d.anchorY;
  _winX    = d.winX;
  _winW    = d.winW;
  scheduleResize();
  loadAgentHistory(_agent);
  setTimeout(() => ovInput.focus(), 80);
});

// ── Resize (anchors bottom edge at _anchorY) ──────────────────────────────────
function scheduleResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(doResize, 60);
}

function doResize() {
  const apH     = ovApprovals.offsetHeight;
  const divH    = ovDivider.classList.contains('show') ? 9 : 0;
  const threadH = ovThread.classList.contains('open') ? THREAD_OPEN_H : 0;
  const barH    = document.querySelector('.ov-bar').offsetHeight;
  const H       = Math.max(MIN_H, Math.min(MAX_H, apH + divH + threadH + barH + 2));
  if (Math.abs(H - window.outerHeight) < 2) return;
  // Anchor top when floating; anchor bottom when parked at screen bottom edge
  const nearBottom = window.screenY + window.outerHeight >= window.screen.availHeight - 32;
  const y = nearBottom ? window.screenY + window.outerHeight - H : window.screenY;
  window.overlayApi.resizeTo({ x: window.screenX, y, width: window.outerWidth, height: H });
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Don't close overlay if a modal is currently open — let the modal handle ESC
    const pinOpen     = document.getElementById('ov-pin-overlay')?.style.display !== 'none';
    const confirmOpen = document.getElementById('ov-confirm-overlay')?.style.display !== 'none';
    if (pinOpen || confirmOpen) return;
    window.overlayApi.close();
  }
});

// ── Approvals toggle ──────────────────────────────────────────────────────────
if (ovApToggle) {
  ovApToggle.addEventListener('click', () => {
    const hidden = ovApprovals.classList.toggle('chat-hidden');
    ovApToggle.classList.toggle('collapsed', hidden);
    scheduleResize();
  });
}

// ── Close / clear ─────────────────────────────────────────────────────────────
ovClose.addEventListener('click', () => window.overlayApi.close());
ovClr.addEventListener('click', () => {
  if (_streaming) return;
  clearThread();
  window.overlayApi.clearHistory(_agent);
});

// Operator changed — drop the previous user's transcript entirely and reset
// to the default agent tab. The server already cleared the stored history.
if (window.overlayApi.onConversationReset) {
  window.overlayApi.onConversationReset(() => {
    clearThread();
    document.querySelectorAll('.ov-tab').forEach(t => t.classList.toggle('active', t.dataset.agent === 'approver'));
    _agent = 'approver';
  });
}

// ── Agent tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.ov-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (_streaming) return;
    document.querySelectorAll('.ov-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _agent = tab.dataset.agent;
    clearThread();
    loadAgentHistory(_agent);
  });
});

// ── Thread helpers ────────────────────────────────────────────────────────────
function openThread() {
  if (!ovThread.classList.contains('open')) {
    ovThread.classList.add('open');
    updateDivider();
    scheduleResize();
  }
}

function clearThread() {
  ovThread.innerHTML = '';
  ovThread.classList.remove('open');
  _msgEl = null;
  updateDivider();
  // Wait for the CSS height transition (180ms) before measuring layout
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(doResize, 220);
}

function updateDivider() {
  const hasAp = ovApprovals.children.length > 0;
  const hasThread = ovThread.classList.contains('open');
  ovDivider.classList.toggle('show', hasAp && hasThread);
}

// Self-contained markdown → HTML for the overlay (separate window, no app.js).
// Covers the cases that show up in agent replies: headings, bold/italic, inline
// + fenced code, bullet lists, links, paragraphs. Escapes HTML first.
function ovMarkdown(src) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = []; let inList = false, inCode = false; const code = [];
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      if (inCode) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code.length = 0; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(raw); continue; }
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^(#{1,3})\s+(.+)/);
    if (h) { closeList(); out.push('<div class="md-h' + h[1].length + '">' + inline(h[2]) + '</div>'); continue; }
    if (/^\s*[-*]\s+/.test(line)) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue; }
    closeList();
    out.push('<div>' + inline(line) + '</div>');
  }
  if (inCode) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  closeList();
  return out.join('');
}

function appendMsg(role, text) {
  openThread();
  const el = document.createElement('div');
  el.className = 'ov-msg ' + role;
  if (role === 'assistant') el.innerHTML = ovMarkdown(text);
  else el.textContent = text;
  ovThread.appendChild(el);
  ovThread.scrollTop = ovThread.scrollHeight;
  return el;
}

// Natural-language "what the agent is doing" label, adapted to the last query.
let _lastQuery = '';
function ovThinkingLabel(query) {
  const q = String(query || '').toLowerCase();
  const has = (...w) => w.some(x => q.includes(x));
  if (has('recent join', 'new joiner', 'new hire', 'onboard')) return 'Looking up recent joiners';
  if (has('leaver', 'offboard', 'terminate', 'disable', 'remove access')) return 'Reviewing the offboarding';
  if (has('license', 'sku')) return 'Checking license utilization';
  if (has('risk', 'risky', 'compromis')) return 'Assessing identity risk';
  if (has('mfa', 'multifactor')) return 'Checking MFA coverage';
  if (has('group', 'membership')) return 'Resolving group membership';
  if (has('role', 'privileged', 'pim')) return 'Reviewing role assignments';
  if (has('guest', 'external')) return 'Reviewing guest accounts';
  if (has('stale', 'inactive', 'dormant')) return 'Finding stale accounts';
  if (has('audit', 'sign-in', 'signin', 'activity')) return 'Searching the audit trail';
  if (has('how do i', 'how to', 'what is', 'explain')) return 'Putting that together';
  if (has('how many', 'count', 'total')) return 'Counting the directory';
  return _agent === 'approver' ? 'Working through the request' : 'Searching the directory';
}

function showThinking() {
  if (document.getElementById('ov-thinking')) return;
  openThread();
  const el = document.createElement('div');
  el.className = 'ov-thinking'; el.id = 'ov-thinking';
  // The label text comes from a fixed phrase set (never the raw query), so it's
  // safe to inject directly.
  el.innerHTML = '<span></span><span></span><span></span><span class="ov-thinking-label">'
    + ovThinkingLabel(_lastQuery) + '</span>';
  ovThread.appendChild(el);
  ovThread.scrollTop = ovThread.scrollHeight;
}

function removeThinking() {
  const el = document.getElementById('ov-thinking');
  if (el) el.remove();
}

function setStreaming(on) {
  _streaming = on;
  ovInput.disabled = on;
  ovSend.disabled  = on;
  document.querySelectorAll('.ov-tab').forEach(t => { t.disabled = on; });
}

// ── Send message ──────────────────────────────────────────────────────────────
function sendMessage() {
  const text = ovInput.value.trim();
  if (!text || _streaming) return;
  ovInput.value = '';
  _lastQuery = text;  // drives the contextual "thinking" label
  appendMsg('user', text);
  showThinking();
  setStreaming(true);
  _msgEl = null;
  window.overlayApi.sendAgentMessage(_agent, text);
}

ovSend.addEventListener('click', sendMessage);
ovInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Agent streaming ───────────────────────────────────────────────────────────
window.overlayApi.onAgentChunk((d) => {
  if (d.type === 'text') {
    removeThinking();
    if (!_msgEl) {
      _msgEl = document.createElement('div');
      _msgEl.className = 'ov-msg assistant streaming';
      _msgEl._raw = '';
      ovThread.appendChild(_msgEl);
    }
    _msgEl._raw = (_msgEl._raw || '') + d.text;
    _msgEl.innerHTML = ovMarkdown(_msgEl._raw);
    ovThread.scrollTop = ovThread.scrollHeight;
  } else if (d.type === 'tool_start') {
    // No tool chips — keep the gray thinking line as the only activity cue.
    if (_msgEl) { _msgEl.classList.remove('streaming'); _msgEl = null; }
    showThinking();
    ovThread.scrollTop = ovThread.scrollHeight;
  } else if (d.type === 'tool_done') {
    showThinking();
  }
});

window.overlayApi.onAgentComplete(() => {
  removeThinking();
  if (_msgEl) { _msgEl.classList.remove('streaming'); _msgEl = null; }
  setStreaming(false);
});

window.overlayApi.onAgentError((d) => {
  removeThinking();
  if (_msgEl) { _msgEl.classList.remove('streaming'); _msgEl = null; }
  setStreaming(false);
  const el = document.createElement('div');
  el.className = 'ov-msg assistant';
  el.style.color = 'var(--coral)';
  el.textContent = 'Error: ' + (d.text || 'unknown');
  ovThread.appendChild(el);
  ovThread.scrollTop = ovThread.scrollHeight;
});

// ── Cross-window conversation mirror ──────────────────────────────────────────
if (typeof window.overlayApi.onMsgMirror === 'function') {
  window.overlayApi.onMsgMirror(({ agent, role, text }) => {
    if (!text || agent !== _agent) return;
    if (role === 'user') {
      appendMsg('user', text);
      showThinking();
    } else if (role === 'assistant') {
      removeThinking();
      appendMsg('assistant', text);
    }
  });
}

// ── Confirm modal ─────────────────────────────────────────────────────────────
function showConfirm({ title, body, okLabel = 'Confirm', primary = false }) {
  return new Promise(resolve => {
    document.getElementById('ov-confirm-title').textContent = title;
    document.getElementById('ov-confirm-body').textContent  = body;
    const ok     = document.getElementById('ov-confirm-ok');
    const cancel = document.getElementById('ov-confirm-cancel');
    const overlay = document.getElementById('ov-confirm-overlay');
    ok.textContent = okLabel;
    ok.className = primary ? 'ov-confirm-ok primary' : 'ov-confirm-ok';
    overlay.style.display = 'flex';
    cancel.focus();
    const cleanup = (r) => {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', onKey);
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(r);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// ── Mode pill toggle ──────────────────────────────────────────────────────────
ovModePill.addEventListener('click', async () => {
  if (_mode === 'safe') {
    const ok = await showConfirm({
      title: 'Switch to Live Mode',
      body: 'Live mode commits real changes to your Entra tenant. All operations execute immediately.',
      okLabel: 'Switch to Live',
      primary: true,
    });
    if (!ok) return;
    _mode = 'live';
    ovModePill.textContent = 'Live';
    ovModePill.className   = 'ov-mode-pill live';
    window.overlayApi.setMode(false);
  } else {
    _mode = 'safe';
    ovModePill.textContent = 'Safe';
    ovModePill.className   = 'ov-mode-pill safe';
    window.overlayApi.setMode(true);
  }
});

// ── Live data updates ─────────────────────────────────────────────────────────
window.overlayApi.onUpdate((data) => {
  if (data.mode) {
    _mode = data.mode;
    const live = data.mode === 'live';
    ovModePill.textContent = live ? 'Live' : 'Safe';
    ovModePill.className   = 'ov-mode-pill ' + (live ? 'live' : 'safe');
  }
  if (Array.isArray(data.pendingList)) {
    renderApprovals(data.pendingList);
  }
  if (data.approvals != null) {
    const n = data.approvals;
    ovBadge.textContent = n > 0 ? n + ' pending' : '';
    ovBadge.classList.toggle('show', n > 0);
  }
});

// ── Approval cards ────────────────────────────────────────────────────────────
function renderApprovals(list) {
  if (!list || !list.length) {
    ovApprovals.innerHTML = '';
    updateDivider();
    scheduleResize();
    return;
  }
  const MAX_SHOWN = 3;
  const visible = list.slice(0, MAX_SHOWN);
  const extra   = list.length - visible.length;
  ovApprovals.innerHTML = visible.map(item => {
    const label = toolLabel(item.tool);
    const upn   = (item.input && item.input.userPrincipalName) || '—';
    const age   = relativeAge(item.requestedAt) || '—';
    return `<div class="ov-ap-card" data-id="${escHtml(item.id)}" data-upn="${escHtml(upn)}" data-label="${escHtml(label)}">
      <div class="ov-ap-header">
        <span class="ov-ap-action">${escHtml(label)}</span>
        <span class="ov-ap-age">${age}</span>
      </div>
      <div class="ov-ap-upn" title="${escHtml(upn)}">${escHtml(upn)}</div>
      <div class="ov-ap-btns">
        <button class="ov-ap-approve" data-action="approve">✓ Approve</button>
        <button class="ov-ap-reject"  data-action="reject">✗ Reject</button>
      </div>
    </div>`;
  }).join('') + (extra > 0 ? `<div class="ov-ap-more">+${extra} more in console</div>` : '');
  updateDivider();
  scheduleResize();
}

ovApprovals.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card   = btn.closest('.ov-ap-card');
  const id     = card.dataset.id;
  const upn    = card.dataset.upn;
  const label  = card.dataset.label;
  const action = btn.dataset.action;
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });

  if (action === 'reject') {
    try {
      const res = await window.overlayApi.rejectPending(id);
      if (res.ok) {
        showToast(`${label} rejected — ${upn}`, 'info');
        card.remove();
        updateDivider();
        scheduleResize();
      } else {
        showToast('Reject failed — ' + (res.error || 'unknown'), 'error');
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    } catch {
      showToast('Reject failed', 'error');
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  } else if (action === 'approve') {
    const writeToken = await showPinModal(label, upn);
    if (!writeToken) { card.querySelectorAll('button').forEach(b => { b.disabled = false; }); return; }
    try {
      const res = await window.overlayApi.approvePending(id, writeToken);
      if (res.ok) {
        showToast(`${label} approved — ${upn}`, 'success');
        card.remove();
        updateDivider();
        scheduleResize();
      } else {
        showToast('Approve failed — ' + (res.error || 'unknown'), 'error');
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    } catch {
      showToast('Approve failed', 'error');
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }
});

// ── PIN modal ─────────────────────────────────────────────────────────────────
function showPinModal(label, upn) {
  return new Promise(resolve => {
    document.getElementById('ov-pin-label').textContent = label;
    document.getElementById('ov-pin-upn').textContent   = upn;
    const overlay   = document.getElementById('ov-pin-overlay');
    const input     = document.getElementById('ov-pin-input');
    const errorEl   = document.getElementById('ov-pin-error');
    const submitBtn = document.getElementById('ov-pin-submit');
    const cancelBtn = document.getElementById('ov-pin-cancel');
    input.value = ''; errorEl.textContent = ''; submitBtn.disabled = false;
    overlay.style.display = 'flex';
    setTimeout(() => input.focus(), 60);

    const close = (result) => {
      overlay.style.display = 'none';
      input.value = ''; errorEl.textContent = ''; submitBtn.disabled = false;
      document.removeEventListener('keydown', onKey);
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onSubmit = async () => {
      const pin = input.value;
      if (!pin) { errorEl.textContent = 'Enter your PIN'; return; }
      submitBtn.disabled = true; errorEl.textContent = '';
      try {
        const op  = await window.overlayApi.getCurrentOperator();
        const user = op && (op.name || op.username || '');
        const res  = await window.overlayApi.verifyPin(user, pin);
        if (res && res.ok) { close(res.writeToken); }
        else {
          errorEl.textContent = 'Incorrect PIN';
          input.value = ''; input.focus(); submitBtn.disabled = false;
        }
      } catch { errorEl.textContent = 'Verification failed'; submitBtn.disabled = false; }
    };
    const onCancel = () => close(null);
    const onKey = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); onSubmit(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// ── Resize handles ────────────────────────────────────────────────────────────
const MIN_OV_W = 300, MAX_OV_W = 800;
let _rzOv = null, _rzOvPending = null, _rzOvRaf = null;

document.querySelectorAll('.ov-rz').forEach(handle => {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    _rzOv = {
      dir:    handle.dataset.dir,
      startX: e.screenX, startY: e.screenY,
      startW: window.outerWidth,  startH: window.outerHeight,
      startWX: window.screenX,    startWY: window.screenY,
    };
    document.addEventListener('mousemove', _onOvRzMove);
    document.addEventListener('mouseup',   _onOvRzUp, { once: true });
  });
});

function _onOvRzMove(e) {
  if (!_rzOv) return;
  const { dir, startX, startY, startW, startH, startWX, startWY } = _rzOv;
  const dx = e.screenX - startX;
  const dy = e.screenY - startY;
  let w = startW, h = startH, x = startWX, y = startWY;
  if (dir.includes('e')) w = Math.max(MIN_OV_W, Math.min(MAX_OV_W, startW + dx));
  if (dir.includes('s')) h = Math.max(MIN_H,    Math.min(MAX_H,    startH + dy));
  if (dir.includes('w')) { w = Math.max(MIN_OV_W, Math.min(MAX_OV_W, startW - dx)); x = startWX + startW - w; }
  if (dir.includes('n')) { h = Math.max(MIN_H,    Math.min(MAX_H,    startH - dy)); y = startWY + startH - h; }
  _rzOvPending = { x, y, width: w, height: h };
  if (!_rzOvRaf) {
    _rzOvRaf = requestAnimationFrame(() => {
      _rzOvRaf = null;
      if (_rzOvPending) { const p = _rzOvPending; _rzOvPending = null; window.overlayApi.resizeTo(p); }
    });
  }
}

function _onOvRzUp() {
  _rzOv = null;
  document.removeEventListener('mousemove', _onOvRzMove);
}

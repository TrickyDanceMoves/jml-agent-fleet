'use strict';

const PREFS_KEY    = 'jml-docked-sections';
const ORDER_KEY    = 'jml-docked-order';
const COLLAPSE_KEY = 'jml-docked-collapsed';
const RECENTS_KEY  = 'jml-docked-recents';
const SECTION_IDS  = ['approvals', 'certs', 'lastEvent', 'hrQueue', 'quickAction', 'agentChat'];

// ── DOM refs ─────────────────────────────────────────────────────────────────
const approvalBadge  = document.getElementById('approval-badge');
const approvalAge    = document.getElementById('approval-age');
const approvalRow    = document.getElementById('approval-row');
const approvalList   = document.getElementById('approval-list');
const certList      = document.getElementById('cert-list');
const eventsList    = document.getElementById('events-list');
const hrBadge       = document.getElementById('hr-badge');
const hrAge         = document.getElementById('hr-age');
const hrRow         = document.getElementById('hr-row');
const qaUpn         = document.getElementById('qa-upn');
const qaSuggest     = document.getElementById('qa-suggest');
const qaRecents     = document.getElementById('qa-recents');
const settingsBtn   = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const modePill      = document.getElementById('panel-mode-pill');
const keepConsoleCb = document.getElementById('pref-keep-console');
const toastContainer= document.getElementById('toast-container');

// ── Module-level state ────────────────────────────────────────────────────────
let _currentMode   = 'safe';
let _dragFromGrip  = false;
let _dragId        = null;
let _dropDir       = null; // 'before' | 'after'
let _rz = null, _rzPending = null, _rzRaf = null;

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

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Storage ───────────────────────────────────────────────────────────────────
function loadPrefs()     { try { return JSON.parse(localStorage.getItem(PREFS_KEY)    || '{}'); } catch { return {}; } }
function savePrefs(p)    { localStorage.setItem(PREFS_KEY,    JSON.stringify(p)); }
function loadOrder()     { try { return JSON.parse(localStorage.getItem(ORDER_KEY))   || SECTION_IDS; } catch { return SECTION_IDS; } }
function saveOrder(o)    { localStorage.setItem(ORDER_KEY,    JSON.stringify(o)); }
function loadCollapsed() { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { return {}; } }
function saveCollapsed(c){ localStorage.setItem(COLLAPSE_KEY, JSON.stringify(c)); }
function loadRecents()   { try { return JSON.parse(localStorage.getItem(RECENTS_KEY)  || '[]'); } catch { return []; } }
function addRecent(upn) {
  if (!upn) return;
  const list = loadRecents().filter(u => u !== upn);
  list.unshift(upn);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 5)));
}

// ── Apply stored state ────────────────────────────────────────────────────────
function applyOrder(order) {
  const body = document.querySelector('.panel-body');
  order.forEach(id => { const el = document.getElementById('section-' + id); if (el) body.appendChild(el); });
}

function applyPrefs(prefs) {
  SECTION_IDS.forEach(id => {
    const section = document.getElementById('section-' + id);
    if (!section) return;
    const visible = prefs[id] !== false;
    section.style.display = visible ? '' : 'none';
    const cb = settingsPanel.querySelector(`[data-section="${id}"]`);
    if (cb) cb.checked = visible;
  });
  keepConsoleCb.checked = !!prefs.keepConsole;
}

function applyCollapsed(collapseMap) {
  SECTION_IDS.forEach(id => {
    const section = document.getElementById('section-' + id);
    if (section) section.classList.toggle('collapsed', !!collapseMap[id]);
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────
applyOrder(loadOrder());
const prefs = loadPrefs();
applyPrefs(prefs);
const collapseMap = loadCollapsed();
applyCollapsed(collapseMap);

// ── Settings panel ────────────────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => {
  const open = settingsPanel.classList.toggle('open');
  settingsBtn.classList.toggle('active', open);
});

settingsPanel.querySelectorAll('input[data-section]').forEach(cb => {
  cb.addEventListener('change', () => {
    prefs[cb.dataset.section] = cb.checked;
    savePrefs(prefs);
    applyPrefs(prefs);
  });
});

keepConsoleCb.addEventListener('change', () => {
  prefs.keepConsole = keepConsoleCb.checked;
  savePrefs(prefs);
  window.panelApi.setPref({ keepConsole: keepConsoleCb.checked });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsPanel.classList.contains('open')) {
    settingsPanel.classList.remove('open');
    settingsBtn.classList.remove('active');
  }
});

// ── Inline section collapse ───────────────────────────────────────────────────
document.querySelectorAll('.section-label').forEach(label => {
  label.addEventListener('click', (e) => {
    if (e.target.classList.contains('grip') || _dragFromGrip) return;
    const section = label.closest('.section');
    if (!section) return;
    const id = section.id.replace('section-', '');
    section.classList.toggle('collapsed');
    collapseMap[id] = section.classList.contains('collapsed');
    saveCollapsed(collapseMap);
  });
});

// ── Confirm modal ─────────────────────────────────────────────────────────────
function showConfirm({ title, body, okLabel = 'Confirm', danger = true }) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent  = body;
    const okBtn     = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    const overlay   = document.getElementById('confirm-overlay');
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'confirm-ok-btn' : 'confirm-ok-btn primary';
    overlay.style.display = 'flex';
    cancelBtn.focus();

    const cleanup = (result) => {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', onKeydown);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk      = () => cleanup(true);
    const onCancel  = () => cleanup(false);
    const onKeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (document.activeElement === cancelBtn) okBtn.focus(); else cancelBtn.focus();
      }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown);
  });
}

// ── Mode pill ─────────────────────────────────────────────────────────────────
modePill.addEventListener('click', async () => {
  if (_currentMode === 'safe') {
    const ok = await showConfirm({
      title: 'Switch to Live Mode',
      body: 'Live mode commits real changes to your Entra tenant. All operations will execute immediately. Continue?',
      okLabel: 'Switch to Live',
      danger: false,
    });
    if (!ok) return;
    _currentMode = 'live';
    modePill.textContent = 'Live';
    modePill.className = 'mode-pill live';
    document.body.classList.add('mode-live');
    window.panelApi.setMode(false);
  } else {
    _currentMode = 'safe';
    modePill.textContent = 'Safe';
    modePill.className = 'mode-pill safe';
    document.body.classList.remove('mode-live');
    window.panelApi.setMode(true);
  }
});

// ── 8-direction resize ────────────────────────────────────────────────────────
const MIN_W = 220, MAX_W = 640, MIN_H = 280, MAX_H = 900;

function _rzCursor(dirs) {
  if (dirs.n && dirs.w) return 'nw-resize';
  if (dirs.n && dirs.e) return 'ne-resize';
  if (dirs.s && dirs.w) return 'sw-resize';
  if (dirs.s && dirs.e) return 'se-resize';
  if (dirs.n || dirs.s) return 'ns-resize';
  return 'ew-resize';
}

document.querySelectorAll('.rz').forEach(el => {
  const d = el.dataset.dir;
  const dirs = { n: d.includes('n'), s: d.includes('s'), e: d.includes('e'), w: d.includes('w') };
  el.addEventListener('mousedown', (e) => {
    _rz = { dirs, startX: e.screenX, startY: e.screenY,
            startWinX: window.screenX, startWinY: window.screenY,
            startW: window.outerWidth, startH: window.outerHeight };
    document.body.style.cursor = _rzCursor(dirs);
    e.preventDefault();
  });
});

window.addEventListener('mousemove', (e) => {
  if (!_rz) return;
  const dx = e.screenX - _rz.startX, dy = e.screenY - _rz.startY;
  let x = _rz.startWinX, y = _rz.startWinY, w = _rz.startW, h = _rz.startH;
  if (_rz.dirs.n) h = _rz.startH - dy;
  if (_rz.dirs.s) h = _rz.startH + dy;
  if (_rz.dirs.w) w = _rz.startW - dx;
  if (_rz.dirs.e) w = _rz.startW + dx;
  w = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
  h = Math.max(MIN_H, Math.min(MAX_H, Math.round(h)));
  if (_rz.dirs.w) x = _rz.startWinX + (_rz.startW - w);
  if (_rz.dirs.n) y = _rz.startWinY + (_rz.startH - h);
  _rzPending = { x: Math.round(x), y: Math.round(y), width: w, height: h };
  if (!_rzRaf) {
    _rzRaf = requestAnimationFrame(() => {
      _rzRaf = null;
      if (_rzPending) { window.panelApi.resizeTo(_rzPending); _rzPending = null; }
    });
  }
});

window.addEventListener('mouseup', () => {
  if (_rz) {
    _rz = null;
    document.body.style.cursor = '';
    // Persist bounds so next open restores size+position
    window.panelApi.saveBounds({
      x: window.screenX, y: window.screenY,
      width: window.outerWidth, height: window.outerHeight
    });
  }
});

// ── Responsive layout ─────────────────────────────────────────────────────────
const layoutObserver = new ResizeObserver(([entry]) => {
  const w = entry.contentRect.width;
  document.body.classList.toggle('wide',  w >= 360);
  document.body.classList.toggle('xwide', w >= 500);
});
layoutObserver.observe(document.body);

// ── Actions ───────────────────────────────────────────────────────────────────
document.getElementById('close-btn').addEventListener('click', () => window.panelApi.close());
document.getElementById('open-console').addEventListener('click', () => window.panelApi.openConsole('dashboard'));
approvalRow.addEventListener('click', () => window.panelApi.openConsole('approvals'));
hrRow.addEventListener('click', () => window.panelApi.openConsole('dashboard'));
eventsList.addEventListener('click', (e) => {
  if (e.target.closest('.event-item')) window.panelApi.openConsole('audit-log');
});

document.getElementById('qa-joiner').addEventListener('click', () => {
  window.panelApi.runAction({ type: 'joiner', upn: '' });
  showToast('Opening Joiner in console…', 'info');
});

document.getElementById('qa-move').addEventListener('click', () => {
  const upn = qaUpn.value.trim();
  if (!upn) { qaUpn.focus(); return; }
  addRecent(upn);
  window.panelApi.runAction({ type: 'move', upn });
  showToast('Opening Mover in console for ' + upn, 'info');
  qaUpn.value = '';
  qaSuggest.style.display = 'none';
  qaRecents.style.display = 'none';
});

document.getElementById('qa-soft').addEventListener('click', async () => {
  const upn = qaUpn.value.trim();
  if (!upn) { qaUpn.focus(); return; }
  const whatif = _currentMode !== 'live';
  let writeToken = null;
  if (!whatif) {
    writeToken = await showPinModal('Soft Leave', upn, 'Authorize Live Operation');
    if (!writeToken) return;
  }
  addRecent(upn);
  qaUpn.value = '';
  qaSuggest.style.display = 'none';
  qaRecents.style.display = 'none';
  showToast((whatif ? '[Safe] ' : '') + 'Running Soft Leave for ' + upn + '…', 'info');
  window.panelApi.runQuickLeaver({ upn, stage: 'Soft', reason: '', whatif, writeToken });
});

document.getElementById('qa-hard').addEventListener('click', async () => {
  const upn = qaUpn.value.trim();
  if (!upn) { qaUpn.focus(); return; }
  const ok = await showConfirm({
    title: 'Confirm Hard Leave',
    body: `Hard Leave permanently removes all licenses and group memberships for ${upn} and terminates the account. This cannot be undone.`,
    okLabel: 'Hard Leave',
    danger: true,
  });
  if (!ok) return;
  const whatif = _currentMode !== 'live';
  let writeToken = null;
  if (!whatif) {
    writeToken = await showPinModal('Hard Leave', upn, 'Authorize Live Operation');
    if (!writeToken) return;
  }
  addRecent(upn);
  qaUpn.value = '';
  qaSuggest.style.display = 'none';
  qaRecents.style.display = 'none';
  showToast((whatif ? '[Safe] ' : '') + 'Running Hard Leave for ' + upn + '…', 'info');
  window.panelApi.runQuickLeaver({ upn, stage: 'Hard', reason: '', whatif, writeToken });
});

// ── Quick operation result feedback ──────────────────────────────────────────
window.panelApi.onQuickOpResult((data) => {
  if (data.approvalQueued) {
    showToast('Approval queued — admin sign-off required', 'info');
    return;
  }
  const label = data.type === 'leaver' ? ((data.data && data.data.stage) || 'Leaver') + ' Leave' : 'Mover';
  if (data.error) showToast(label + ' failed — ' + ((data.lines || [])[0] || 'see console'), 'error');
  else            showToast(label + ' complete', 'success');
});

// ── Quick Action keyboard shortcuts ──────────────────────────────────────────
qaUpn.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    qaSuggest.style.display = 'none';
    qaRecents.style.display = 'none';
  } else if (e.key === 'Enter' && qaUpn.value.trim()) {
    document.getElementById('qa-soft').click();
  }
});

// ── UPN autocomplete ──────────────────────────────────────────────────────────
let _acTimer = null;
qaUpn.addEventListener('input', () => {
  clearTimeout(_acTimer);
  qaRecents.style.display = 'none';
  const q = qaUpn.value.trim();
  if (q.length < 2) { qaSuggest.style.display = 'none'; return; }
  _acTimer = setTimeout(async () => {
    try {
      const results = await window.panelApi.searchUsers(q);
      if (!results || !results.length) { qaSuggest.style.display = 'none'; return; }
      qaSuggest.innerHTML = results.slice(0, 5).map(u =>
        `<div class="qa-ac-item" data-upn="${escHtml(u.upn)}">
          ${escHtml(u.displayName || u.upn)}
          <span class="qa-ac-upn">${escHtml(u.upn)}</span>
        </div>`
      ).join('');
      qaSuggest.style.display = 'block';
      qaSuggest.querySelectorAll('.qa-ac-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          qaUpn.value = item.dataset.upn;
          qaSuggest.style.display = 'none';
        });
      });
    } catch { qaSuggest.style.display = 'none'; }
  }, 220);
});

// ── Recent UPNs ───────────────────────────────────────────────────────────────
qaUpn.addEventListener('focus', () => {
  if (qaUpn.value.trim()) return;
  const recents = loadRecents();
  if (!recents.length) return;
  qaRecents.innerHTML = recents.map(upn =>
    `<div class="qa-rc-item" data-upn="${escHtml(upn)}">${escHtml(upn)}<span class="qa-rc-label">recent</span></div>`
  ).join('');
  qaRecents.style.display = 'block';
  qaRecents.querySelectorAll('.qa-rc-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      qaUpn.value = item.dataset.upn;
      qaRecents.style.display = 'none';
    });
  });
});

qaUpn.addEventListener('blur', () => {
  setTimeout(() => {
    qaSuggest.style.display = 'none';
    qaRecents.style.display = 'none';
  }, 200);
});

// ── Refresh on focus ──────────────────────────────────────────────────────────
window.addEventListener('focus', () => window.panelApi.requestRefresh());

// ── Approval queue management ─────────────────────────────────────────────────
function toolLabel(tool) {
  const t = (tool || '').toLowerCase();
  if (t.includes('hard'))     return 'Hard Leave';
  if (t.includes('soft'))     return 'Soft Leave';
  if (t.includes('joiner'))   return 'Joiner';
  if (t.includes('enroller')) return 'Enroller';
  if (t.includes('mover'))    return 'Mover';
  return 'Request';
}

function renderPendingList(list) {
  if (!list || !list.length) {
    approvalList.innerHTML = '';
    return;
  }
  approvalList.innerHTML = list.map(item => {
    const label   = toolLabel(item.tool);
    const sev     = item.severity || 'none';
    const upn     = (item.input && item.input.userPrincipalName) || '—';
    const by      = item.requestedBy || '?';
    const role    = item.requestedByRole ? ' (' + item.requestedByRole + ')' : '';
    const age     = relativeAge(item.requestedAt) || '—';
    return `<div class="ap-card ${sev}" data-id="${escHtml(item.id)}" data-upn="${escHtml(upn)}" data-label="${escHtml(label)}">
      <div class="ap-header">
        <span class="ap-action">${escHtml(label)}</span>
        <span class="ap-age">${age}</span>
      </div>
      <div class="ap-upn">${escHtml(upn)}</div>
      <div class="ap-meta">requested by ${escHtml(by)}${escHtml(role)}</div>
      <div class="ap-btns">
        <button class="ap-approve-btn" data-action="approve">✓ Approve</button>
        <button class="ap-reject-btn"  data-action="reject">✗ Reject</button>
      </div>
    </div>`;
  }).join('');
}

function showPinModal(label, upn, title = 'Authenticate to Approve') {
  return new Promise(resolve => {
    document.querySelector('.pin-title').textContent = title;
    document.getElementById('pin-action-label').textContent = label;
    document.getElementById('pin-upn').textContent = upn;
    const overlay  = document.getElementById('pin-overlay');
    const input    = document.getElementById('pin-input');
    const errorEl  = document.getElementById('pin-error');
    const submitBtn= document.getElementById('pin-submit');
    const cancelBtn= document.getElementById('pin-cancel');
    input.value = '';
    errorEl.textContent = '';
    submitBtn.disabled = false;
    overlay.style.display = 'flex';
    setTimeout(() => input.focus(), 60);

    const close = (result) => {
      overlay.style.display = 'none';
      input.value = '';
      errorEl.textContent = '';
      submitBtn.disabled = false;
      document.removeEventListener('keydown', onKey);
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };

    const onSubmit = async () => {
      const pin = input.value;
      if (!pin) { errorEl.textContent = 'Enter your PIN'; return; }
      submitBtn.disabled = true;
      errorEl.textContent = '';
      try {
        const operator = await window.panelApi.getCurrentOperator();
        const user = operator && (operator.name || operator.username || '');
        const res  = await window.panelApi.verifyPin(user, pin);
        if (res && res.ok) { close(res.writeToken); }
        else {
          errorEl.textContent = 'Incorrect PIN';
          input.value = '';
          input.focus();
          submitBtn.disabled = false;
        }
      } catch {
        errorEl.textContent = 'Verification failed';
        submitBtn.disabled = false;
      }
    };

    const onCancel = () => close(null);
    const onKey = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); onSubmit(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (document.activeElement === cancelBtn) submitBtn.focus(); else cancelBtn.focus();
      }
    };

    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// Event delegation for approve/reject buttons in approval cards
approvalList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card   = btn.closest('.ap-card');
  const id     = card.dataset.id;
  const upn    = card.dataset.upn;
  const label  = card.dataset.label;
  const action = btn.dataset.action;

  // Disable buttons on card while processing
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });

  if (action === 'reject') {
    const ok = await showConfirm({
      title: 'Reject Approval Request',
      body: `Reject ${label} request for ${upn}? The request will be permanently removed.`,
      okLabel: 'Reject',
      danger: true,
    });
    if (!ok) { card.querySelectorAll('button').forEach(b => { b.disabled = false; }); return; }
    try {
      const res = await window.panelApi.rejectPending(id);
      if (res.ok) {
        showToast(`${label} request rejected — ${upn}`, 'info');
        card.remove();
      } else {
        showToast('Reject failed — ' + (res.error || 'unknown error'), 'error');
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
      const res = await window.panelApi.approvePending(id, writeToken);
      if (res.ok) {
        showToast(`${label} approved — ${upn}`, 'success');
        card.remove();
      } else {
        showToast('Approve failed — ' + (res.error || 'unknown error'), 'error');
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    } catch {
      showToast('Approve failed', 'error');
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }
});

// ── Live data updates ─────────────────────────────────────────────────────────
window.panelApi.onUpdate((data) => {

  if (data.mode) {
    _currentMode = data.mode;
    const live = data.mode === 'live';
    modePill.textContent = live ? 'Live' : 'Safe';
    modePill.className = 'mode-pill ' + (live ? 'live' : 'safe');
    document.body.classList.toggle('mode-live', live);
  }

  if (typeof data.keepConsole === 'boolean') {
    keepConsoleCb.checked = data.keepConsole;
  }

  if (data.approvals != null) {
    const n = data.approvals;
    approvalBadge.textContent = n;
    approvalBadge.className = 'approval-badge' + (n > 0 ? '' : ' none');
  }

  if (Array.isArray(data.pendingList)) {
    renderPendingList(data.pendingList);
  }

  if ('oldestApproval' in data) {
    if (data.oldestApproval) {
      const ms  = Date.now() - new Date(data.oldestApproval);
      const age = relativeAge(data.oldestApproval);
      approvalAge.textContent = 'oldest ' + age;
      approvalAge.className = 'approval-age' + (ms > 3600000 ? ' urgent' : '');
      approvalAge.style.display = '';
    } else {
      approvalAge.style.display = 'none';
    }
  }

  if (Array.isArray(data.certs)) {
    certList.innerHTML = data.certs.length
      ? data.certs.map(c => {
          const dot  = c.daysLeft == null ? 'none' : c.daysLeft < 14 ? 'crit' : c.daysLeft < 45 ? 'warn' : '';
          const days = c.daysLeft != null ? c.daysLeft + 'd' : '—';
          const col  = dot === 'crit' ? 'var(--coral)' : dot === 'warn' ? 'var(--amber)' : 'var(--muted)';
          return `<div class="cert-row">
            <div class="cert-dot ${dot}"></div>
            <span class="cert-name" title="${escHtml(c.agent)}">${escHtml(c.agent)}</span>
            <span class="cert-days" style="color:${col}">${days}</span>
          </div>`;
        }).join('')
      : '<div class="cert-row"><div class="cert-dot none"></div><span class="cert-name">No agents</span></div>';
  }

  if (Array.isArray(data.recentEvents)) {
    eventsList.innerHTML = data.recentEvents.length
      ? data.recentEvents.map(e => renderEventItem(e)).join('')
      : '<div class="event-item"><div class="ev-agent">—</div><div class="ev-subject">No recent events</div><div class="ev-meta"><span>—</span></div></div>';
  } else if (data.lastEvent) {
    eventsList.innerHTML = renderEventItem(data.lastEvent);
  }

  if (data.hrQueue != null) {
    const { count, oldestMin } = data.hrQueue;
    hrBadge.textContent = count || 0;
    hrBadge.className = 'hr-badge' + (count > 0 ? '' : ' none');
    if (count > 0 && oldestMin != null) {
      const ageStr = oldestMin >= 60 ? Math.round(oldestMin / 60) + 'h' : oldestMin + 'm';
      hrAge.textContent = 'oldest ' + ageStr + ' ago';
      hrAge.className = 'hr-age' + (oldestMin > 30 ? ' urgent' : '');
      hrAge.style.display = '';
    } else {
      hrAge.style.display = 'none';
    }
  }

});

function renderEventItem(e) {
  const cls = e.outcome === 'success' ? 'success' : e.outcome === 'failed' ? 'failed' : e.outcome === 'partial' ? 'partial' : '';
  const ts  = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  return `<div class="event-item">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
      <span class="ev-agent">${escHtml(e.agent || '—')}</span>
      <span class="ev-outcome ${cls}">${escHtml(e.outcome || '—')}</span>
    </div>
    <div class="ev-subject">${escHtml(e.subject || '—')}</div>
    <div class="ev-meta"><span>${ts}</span>${e.whatif ? '<span>safe mode</span>' : ''}</div>
  </div>`;
}

// ── Agent Chat ────────────────────────────────────────────────────────────────
let _chatAgent    = 'approver';
let _chatStreaming = false;
let _chatMsgEl    = null;

const acThread = document.getElementById('ac-thread');
const acInput  = document.getElementById('ac-input');
const acSend   = document.getElementById('ac-send');
const acClear  = document.getElementById('ac-clear');

document.querySelectorAll('.ac-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (_chatStreaming) return;
    document.querySelectorAll('.ac-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _chatAgent = tab.dataset.agent;
    acThread.innerHTML = '<div class="ac-empty">Ask the agent anything…</div>';
    _chatMsgEl = null;
  });
});

function acScrollBottom() {
  acThread.scrollTop = acThread.scrollHeight;
}

function acAppendMsg(role, text) {
  const empty = acThread.querySelector('.ac-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'ac-msg ' + role;
  el.textContent = text;
  acThread.appendChild(el);
  acScrollBottom();
  return el;
}

function acShowThinking() {
  if (document.getElementById('ac-thinking')) return;
  const el = document.createElement('div');
  el.className = 'ac-thinking'; el.id = 'ac-thinking';
  el.innerHTML = '<span></span><span></span><span></span>';
  acThread.appendChild(el);
  acScrollBottom();
}

function acRemoveThinking() {
  const el = document.getElementById('ac-thinking');
  if (el) el.remove();
}

function acSetStreaming(on) {
  _chatStreaming = on;
  acInput.disabled  = on;
  acSend.disabled   = on;
  acClear.disabled  = on;
  document.querySelectorAll('.ac-tab').forEach(t => { t.disabled = on; });
}

function acSendMessage() {
  const text = acInput.value.trim();
  if (!text || _chatStreaming) return;
  acInput.value = '';
  acAppendMsg('user', text);
  acShowThinking();
  acSetStreaming(true);
  _chatMsgEl = null;
  window.panelApi.sendAgentMessage(_chatAgent, text);
}

acSend.addEventListener('click', acSendMessage);
acInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); acSendMessage(); }
  if (e.key === 'Escape') acInput.blur();
});

acClear.addEventListener('click', () => {
  if (_chatStreaming) return;
  acThread.innerHTML = '<div class="ac-empty">Ask the agent anything…</div>';
  _chatMsgEl = null;
  window.panelApi.clearAgentHistory(_chatAgent);
});

window.panelApi.onAgentChunk((d) => {
  if (d.type === 'text') {
    acRemoveThinking();
    if (!_chatMsgEl) {
      _chatMsgEl = document.createElement('div');
      _chatMsgEl.className = 'ac-msg assistant streaming';
      const empty = acThread.querySelector('.ac-empty');
      if (empty) empty.remove();
      acThread.appendChild(_chatMsgEl);
    }
    _chatMsgEl.textContent += d.text;
    acScrollBottom();
  } else if (d.type === 'tool_start') {
    acRemoveThinking();
    if (_chatMsgEl) { _chatMsgEl.classList.remove('streaming'); _chatMsgEl = null; }
    const empty = acThread.querySelector('.ac-empty');
    if (empty) empty.remove();
    const chip = document.createElement('div');
    chip.className = 'ac-tool-chip';
    chip.dataset.tool = d.toolName;
    chip.textContent = '▶ ' + d.toolName;
    acThread.appendChild(chip);
    acScrollBottom();
  } else if (d.type === 'tool_done') {
    const chips = [...acThread.querySelectorAll('.ac-tool-chip:not(.done):not(.fail)')];
    const chip = chips.reverse().find(c => c.dataset.tool === d.toolName);
    if (chip) {
      chip.className = 'ac-tool-chip ' + (d.success ? 'done' : 'fail');
      chip.textContent = (d.success ? '✓ ' : '✗ ') + d.toolName;
    }
    acShowThinking();
  }
});

window.panelApi.onAgentComplete(() => {
  acRemoveThinking();
  if (_chatMsgEl) { _chatMsgEl.classList.remove('streaming'); _chatMsgEl = null; }
  acSetStreaming(false);
});

window.panelApi.onAgentError((d) => {
  acRemoveThinking();
  if (_chatMsgEl) { _chatMsgEl.classList.remove('streaming'); _chatMsgEl = null; }
  acSetStreaming(false);
  const el = document.createElement('div');
  el.className = 'ac-msg assistant';
  el.style.color = 'var(--coral)';
  el.textContent = 'Error: ' + (d.text || 'unknown');
  const empty = acThread.querySelector('.ac-empty');
  if (empty) empty.remove();
  acThread.appendChild(el);
  acScrollBottom();
});

// ── Drag-to-reorder sections ──────────────────────────────────────────────────
function clearDragIndicators() {
  document.querySelectorAll('.section').forEach(s => {
    s.classList.remove('drag-above', 'drag-below');
  });
}

document.querySelectorAll('.grip').forEach(grip => {
  grip.addEventListener('mousedown', () => { _dragFromGrip = true; });
});
window.addEventListener('mouseup', () => { _dragFromGrip = false; }, true);

document.querySelectorAll('.section').forEach(section => {
  const id = section.id.replace('section-', '');

  section.addEventListener('dragstart', (e) => {
    if (!_dragFromGrip) { e.preventDefault(); return; }
    _dragId = id;
    section.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  section.addEventListener('dragend', () => {
    section.classList.remove('dragging');
    clearDragIndicators();
    _dragId = null;
    _dropDir = null;
  });

  section.addEventListener('dragover', (e) => {
    if (!_dragId || _dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDragIndicators();
    const rect = section.getBoundingClientRect();
    _dropDir = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    section.classList.add(_dropDir === 'before' ? 'drag-above' : 'drag-below');
  });

  section.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDragIndicators();
    if (!_dragId || _dragId === id || !_dropDir) return;
    const body = document.querySelector('.panel-body');
    const draggedEl = document.getElementById('section-' + _dragId);
    if (_dropDir === 'before') {
      body.insertBefore(draggedEl, section);
    } else {
      section.after(draggedEl);
    }
    saveOrder([...body.querySelectorAll('.section')].map(el => el.id.replace('section-', '')));
    _dropDir = null;
  });
});

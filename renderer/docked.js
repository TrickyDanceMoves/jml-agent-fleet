'use strict';

const PREFS_KEY    = 'jml-docked-sections';
const ORDER_KEY    = 'jml-docked-order';
const COLLAPSE_KEY = 'jml-docked-collapsed';
const RECENTS_KEY  = 'jml-docked-recents';
const SLIM_KEY     = 'jml-docked-slim';
const SLIM_W_KEY   = 'jml-docked-pre-slim-w';
const SLIM_X_KEY   = 'jml-docked-pre-slim-x';
const SLIM_H_KEY   = 'jml-docked-pre-slim-h';
const SLIM_EDGE_KEY = 'jml-docked-slim-edge';
const SLIM_W       = 200; // wide enough for tooltip transparent region; pill is 48px right-aligned
const SLIM_H       = 220;
const SLIM_MIN_DIM      = 52;  // absolute minimum height (vert) or width (horiz) in slim mode
const SLIM_MINIMAL_THRESH = 88; // height/width threshold below which logo-only mode activates
let _slimEdge = localStorage.getItem(SLIM_EDGE_KEY) || 'right';
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
let _slimMode      = localStorage.getItem(SLIM_KEY) === '1';
let _dragFromGrip  = false;
let _dragId        = null;
let _dropDir       = null; // 'before' | 'after'
let _rz = null, _rzPending = null, _rzRaf = null;
let _autoFitTimer = null;
let _userResized   = false; // true after user manually resizes — suppresses autoFit

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
  scheduleAutoFitPanel();
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

if (_slimMode) {
  document.body.classList.add('slim-mode');
  document.body.classList.add(`slim-${_slimEdge}`);
  setTimeout(() => {
    const isHoriz = _slimEdge === 'top' || _slimEdge === 'bottom';
    const slimW = isHoriz ? 300 : SLIM_W;
    const slimH = isHoriz ? 160 : SLIM_H;
    window.panelApi.slimResizeTo({ x: window.screenX, y: window.screenY, width: slimW, height: slimH, edge: _slimEdge });
    checkSlimMinimal();
  }, 80);
}

// ── Slim edge listener ────────────────────────────────────────────────────────
window.panelApi.onSlimEdge((edge) => {
  _slimEdge = edge;
  localStorage.setItem(SLIM_EDGE_KEY, edge);
  document.body.classList.remove('slim-right', 'slim-left', 'slim-top', 'slim-bottom');
  document.body.classList.add(`slim-${edge}`);
  checkSlimMinimal();
});

// ── Slim minimal detection ────────────────────────────────────────────────────
function _checkSlimMinimalFromSize(w, h) {
  const isHoriz = _slimEdge === 'top' || _slimEdge === 'bottom';
  const minimal = isHoriz ? w <= SLIM_MINIMAL_THRESH : h <= SLIM_MINIMAL_THRESH;
  document.body.classList.toggle('slim-minimal', minimal);
}

function checkSlimMinimal() {
  if (!_slimMode) { document.body.classList.remove('slim-minimal'); return; }
  _checkSlimMinimalFromSize(window.outerWidth, window.outerHeight);
}

window.addEventListener('resize', () => { if (_slimMode) checkSlimMinimal(); });

// ── Settings panel ────────────────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => {
  const open = settingsPanel.classList.toggle('open');
  settingsBtn.classList.toggle('active', open);
  if (open) renderSpShortcuts();
  scheduleAutoFitPanel();
});

settingsPanel.querySelectorAll('input[data-section]').forEach(cb => {
  cb.addEventListener('change', () => {
    _userResized = false; // section change: re-enable autofit
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

// ── Section → console tab mapping ────────────────────────────────────────────
const SECTION_TAB = {
  approvals:   'approvals',
  certs:       'certifications',
  lastEvent:   'audit-log',
  hrQueue:     'jml-fleet-input',
  quickAction: 'operations',
  agentChat:   'approver',
};

// ── JS tooltip (escapes overflow clipping) ────────────────────────────────────
const _tip = document.getElementById('section-tip');
let _tipTimer = null;

function showSectionTip(label) {
  if (!_tip) return;
  const text = label.dataset.tip;
  if (!text) return;
  _tip.textContent = text;
  _tip.style.display = 'block';
  _tip.style.opacity = '0';
  const rect = label.getBoundingClientRect();
  // Position: right-aligned, centred vertically on the label
  const tipW = _tip.offsetWidth;
  const tipH = _tip.offsetHeight;
  const left = Math.max(4, rect.left - tipW - 8);
  const top  = rect.top + (rect.height - tipH) / 2;
  _tip.style.left = left + 'px';
  _tip.style.top  = top  + 'px';
  _tip.style.opacity = '1';
}

function hideSectionTip() {
  if (!_tip) return;
  _tip.style.opacity = '0';
  clearTimeout(_tipTimer);
  _tipTimer = setTimeout(() => { _tip.style.display = 'none'; }, 130);
}

// ── Inline section collapse ───────────────────────────────────────────────────
document.querySelectorAll('.section-label').forEach(label => {
  label.addEventListener('mouseenter', () => {
    const section = label.closest('.section');
    if (section && section.classList.contains('collapsed')) showSectionTip(label);
  });
  label.addEventListener('mouseleave', hideSectionTip);

  label.addEventListener('click', (e) => {
    if (e.target.classList.contains('grip') || _dragFromGrip) return;
    const section = label.closest('.section');
    if (!section) return;
    const id = section.id.replace('section-', '');
    const wasCollapsed = section.classList.contains('collapsed');
    section.classList.toggle('collapsed');
    collapseMap[id] = section.classList.contains('collapsed');
    saveCollapsed(collapseMap);
    scheduleAutoFitPanel();
    hideSectionTip();
    // If expanding from collapsed: scroll section into view
    if (wasCollapsed) {
      setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    }
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
const MIN_W = 220, MAX_W = 640, MIN_H = 220, MAX_H = 900;

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
  if (_slimMode) {
    const isHoriz = _slimEdge === 'top' || _slimEdge === 'bottom';
    // In slim mode lock the non-resize axis and apply slim-specific limits
    w = isHoriz ? Math.max(SLIM_MIN_DIM, Math.min(600, Math.round(w))) : _rz.startW;
    h = isHoriz ? _rz.startH : Math.max(SLIM_MIN_DIM, Math.min(600, Math.round(h)));
  } else {
    w = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
    h = Math.max(MIN_H, Math.min(MAX_H, Math.round(h)));
  }
  if (_rz.dirs.w) x = _rz.startWinX + (_rz.startW - w);
  if (_rz.dirs.n) y = _rz.startWinY + (_rz.startH - h);
  _rzPending = { x: Math.round(x), y: Math.round(y), width: w, height: h };
  if (!_rzRaf) {
    _rzRaf = requestAnimationFrame(() => {
      _rzRaf = null;
      if (_rzPending) {
        const p = _rzPending;
        _rzPending = null;
        if (_slimMode) {
          // Route through slim-resize so main.js snaps to edge & allows small sizes
          window.panelApi.slimResizeTo({ ...p, edge: _slimEdge });
          _checkSlimMinimalFromSize(p.width, p.height);
        } else {
          window.panelApi.resizeTo(p);
        }
      }
    });
  }
});

window.addEventListener('mouseup', () => {
  if (_rz) {
    _userResized = true; // user explicitly set a height — don't autofit over it
    _rz = null;
    document.body.style.cursor = '';
    if (!_slimMode) {
      const snapThresh = 28;
      const aw = window.screen.availWidth;
      const px = window.screenX, pw = window.outerWidth;
      const py = window.screenY, ph = window.outerHeight;
      let sx = px;
      if (px <= snapThresh)           sx = 0;
      else if (px + pw >= aw - snapThresh) sx = aw - pw;
      const bounds = { x: sx, y: py, width: pw, height: ph };
      window.panelApi.saveBounds(bounds);
      if (sx !== px) window.panelApi.resizeTo(bounds);
    }
  }
});

// ── Responsive layout ─────────────────────────────────────────────────────────
const layoutObserver = new ResizeObserver(([entry]) => {
  const w = entry.contentRect.width;
  document.body.classList.toggle('wide',  w >= 360);
  document.body.classList.toggle('xwide', w >= 500);
});
layoutObserver.observe(document.body);

function scheduleAutoFitPanel() {
  clearTimeout(_autoFitTimer);
  _autoFitTimer = setTimeout(autoFitPanel, 80);
}

function setSlimMode(on) {
  _slimMode = on;
  localStorage.setItem(SLIM_KEY, on ? '1' : '0');
  document.body.classList.toggle('slim-mode', on);
  if (on) {
    localStorage.setItem(SLIM_W_KEY, String(window.outerWidth));
    localStorage.setItem(SLIM_X_KEY, String(window.screenX));
    localStorage.setItem(SLIM_H_KEY, String(window.outerHeight));
    document.body.classList.remove('slim-right', 'slim-left', 'slim-top', 'slim-bottom');
    document.body.classList.add(`slim-${_slimEdge}`);
    const isHoriz = _slimEdge === 'top' || _slimEdge === 'bottom';
    const slimW = isHoriz ? 300 : SLIM_W;
    const slimH = isHoriz ? 160 : SLIM_H;
    window.panelApi.slimResizeTo({ x: window.screenX, y: window.screenY, width: slimW, height: slimH, edge: _slimEdge });
    checkSlimMinimal();
  } else {
    const prevW = parseInt(localStorage.getItem(SLIM_W_KEY) || '280', 10);
    const prevX = parseInt(localStorage.getItem(SLIM_X_KEY) || String(window.screenX), 10);
    const prevH = parseInt(localStorage.getItem(SLIM_H_KEY) || '0', 10);
    document.body.classList.remove('slim-right', 'slim-left', 'slim-top', 'slim-bottom', 'slim-minimal');
    if (prevH > 0) {
      _userResized = true; // restore exact pre-slim size; suppress autoFit
      window.panelApi.resizeTo({ x: prevX, y: window.screenY, width: prevW, height: prevH });
    } else {
      _userResized = false; // let autoFit determine the correct height on expand
      window.panelApi.resizeTo({ x: prevX, y: window.screenY, width: prevW, height: 500 });
      scheduleAutoFitPanel();
    }
  }
}

function autoFitPanel() {
  if (_rz || _slimMode || _userResized) return;
  const measured = Math.ceil(document.body.scrollHeight + 2);
  const targetHeight = Math.max(MIN_H, Math.min(MAX_H, measured));
  if (Math.abs(targetHeight - window.outerHeight) < 8) return;

  const bounds = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: targetHeight
  };
  window.panelApi.resizeTo(bounds);
  window.panelApi.saveBounds(bounds);
}

// ── Console features registry ─────────────────────────────────────────────────
const _ico = (path, vb = '0 0 24 24', sw = '1.8') =>
  `<svg width="14" height="14" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="${sw}">${path}</svg>`;

const CONSOLE_FEATURES = [
  { id: 'dashboard',    label: 'Dashboard',    tab: 'dashboard',       icon: _ico('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>') },
  { id: 'approver',     label: 'Approver',     tab: 'approver',        icon: _ico('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><polyline points="9 11 12 14 16 9"/>') },
  { id: 'auditor',      label: 'Auditor',      tab: 'auditor',         icon: _ico('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><polyline points="8 11 11 14 15 9"/>') },
  { id: 'security',     label: 'Security',     tab: 'security',        icon: _ico('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>') },
  { id: 'exports',      label: 'Exports',      tab: 'exports',         icon: _ico('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>') },
  { id: 'approvals',    label: 'Approvals',    tab: 'approvals',       icon: _ico('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>') },
  { id: 'operations',   label: 'Operations',   tab: 'operations',      icon: _ico('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>') },
  { id: 'certifications', label: 'Certs',      tab: 'certifications',  icon: _ico('<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/>') },
  { id: 'settings',     label: 'Settings',     tab: 'settings',        icon: _ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', '0 0 24 24', '1.7') },
  { id: 'auditLog',     label: 'Audit Log',    tab: 'audit-log',       icon: _ico('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>') },
  { id: 'users',        label: 'Users',        tab: 'users',           icon: _ico('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>') },
  { id: 'graph',        label: 'MS Graph',     tab: 'graph',           icon: _ico('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>') },
  { id: 'hrQueue',      label: 'HR Queue',     tab: 'dashboard',       icon: _ico('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>') },
];

// ── Shortcut persistence ──────────────────────────────────────────────────────
const SLIM_SC_KEY   = 'jml-slim-shortcuts';
const DOCKED_SC_KEY = 'jml-docked-shortcuts';
let _slimSC   = JSON.parse(localStorage.getItem(SLIM_SC_KEY)   || '[]');
let _dockedSC = JSON.parse(localStorage.getItem(DOCKED_SC_KEY) || '[]');

function saveSlimSC()   { localStorage.setItem(SLIM_SC_KEY,   JSON.stringify(_slimSC));   }
function saveDockedSC() { localStorage.setItem(DOCKED_SC_KEY, JSON.stringify(_dockedSC)); }

// ── Slim shortcuts render ─────────────────────────────────────────────────────
function renderSlimShortcuts() {
  const container = document.getElementById('slim-shortcuts');
  const divider   = document.getElementById('slim-cust-divider');
  if (!container) return;
  if (divider) divider.style.display = _slimSC.length > 0 ? '' : 'none';
  container.innerHTML = _slimSC.map(id => {
    const f = CONSOLE_FEATURES.find(x => x.id === id);
    return f ? `<div class="slim-shortcut" data-tab="${f.tab}" data-tip="Open ${f.label}">${f.icon}</div>` : '';
  }).join('');
  container.querySelectorAll('.slim-shortcut').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      window.panelApi.openConsole(el.dataset.tab);
    });
  });
  updateSlimHeight();
}

function updateSlimHeight() {
  if (!_slimMode) return;
  if (_slimEdge === 'top' || _slimEdge === 'bottom') return;
  // base: drag+brand+divider+4stats+divider+modedot+customize+resize (approx 230px)
  // each shortcut: ~26px; divider before shortcuts: 7px if any
  const BASE = 230;
  const extra = _slimSC.length > 0 ? 7 + _slimSC.length * 26 : 0;
  const h = Math.max(SLIM_MIN_DIM, Math.min(520, BASE + extra));
  window.panelApi.slimResizeTo({ x: window.screenX, y: window.screenY, width: SLIM_W, height: h, edge: _slimEdge });
  checkSlimMinimal();
}

// ── Docked shortcuts section render ──────────────────────────────────────────
function renderDockedShortcuts() {
  const sec  = document.getElementById('section-shortcuts');
  const grid = document.getElementById('shortcut-grid');
  if (!sec || !grid) return;
  if (!_dockedSC.length) { sec.style.display = 'none'; scheduleAutoFitPanel(); return; }
  sec.style.display = '';
  // Expand it by default if newly showing
  sec.classList.remove('collapsed');
  grid.innerHTML = _dockedSC.map(id => {
    const f = CONSOLE_FEATURES.find(x => x.id === id);
    return f ? `<button class="shortcut-tile" data-tab="${f.tab}">
      <span class="st-icon">${f.icon}</span>
      <span class="st-label">${f.label}</span>
    </button>` : '';
  }).join('');
  grid.querySelectorAll('.shortcut-tile').forEach(el => {
    el.addEventListener('click', () => window.panelApi.openConsole(el.dataset.tab));
  });
  scheduleAutoFitPanel();
}

// ── Settings panel shortcut grid ──────────────────────────────────────────────
function renderSpShortcuts() {
  const grid = document.getElementById('sp-shortcut-grid');
  if (!grid) return;
  grid.innerHTML = CONSOLE_FEATURES.map(f => {
    const inS = _slimSC.includes(f.id);
    const inD = _dockedSC.includes(f.id);
    return `<div class="sp-shortcut-chip">
      <span class="sp-chip-icon">${f.icon}</span>
      <span class="sp-chip-name">${f.label}</span>
      <span class="sp-chip-pins">
        <button class="sp-pin ${inS ? 'on-slim' : ''}" data-id="${f.id}" data-target="slim"   title="Pin to sidebar">S</button>
        <button class="sp-pin ${inD ? 'on-docked' : ''}" data-id="${f.id}" data-target="docked" title="Pin to panel">P</button>
      </span>
    </div>`;
  }).join('');

  grid.querySelectorAll('.sp-pin[data-target="slim"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      _slimSC = _slimSC.includes(id) ? _slimSC.filter(x => x !== id) : [..._slimSC, id];
      saveSlimSC();
      renderSlimShortcuts();
      renderSpShortcuts();
    });
  });

  grid.querySelectorAll('.sp-pin[data-target="docked"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      _dockedSC = _dockedSC.includes(id) ? _dockedSC.filter(x => x !== id) : [..._dockedSC, id];
      saveDockedSC();
      renderDockedShortcuts();
      renderSpShortcuts();
    });
  });
}

// Initial render
renderSlimShortcuts();
renderDockedShortcuts();

// ── Actions ───────────────────────────────────────────────────────────────────
document.getElementById('close-btn').addEventListener('click', () => window.panelApi.close());
document.getElementById('slim-btn').addEventListener('click', () => setSlimMode(true));
document.getElementById('open-console').addEventListener('click', () => window.panelApi.openConsole('dashboard'));

// Slim customize button → expand panel, open settings, scroll to shortcut grid
document.getElementById('slim-customize').addEventListener('click', (e) => {
  e.stopPropagation();
  setSlimMode(false);
  setTimeout(() => {
    settingsPanel.classList.add('open');
    settingsBtn.classList.add('active');
    renderSpShortcuts();
    scheduleAutoFitPanel();
    setTimeout(() => {
      const grid = document.getElementById('sp-shortcut-grid');
      if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
  }, 200);
});

// Pin button (header) → toggle settings panel focused on shortcuts
document.getElementById('pin-btn').addEventListener('click', () => {
  const open = settingsPanel.classList.toggle('open');
  settingsBtn.classList.toggle('active', open);
  if (open) {
    renderSpShortcuts();
    scheduleAutoFitPanel();
    setTimeout(() => {
      const grid = document.getElementById('sp-shortcut-grid');
      if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  } else {
    scheduleAutoFitPanel();
  }
});

// ── Slim pill: targeted expand targets ───────────────────────────────────────
function _slimExpandTo(sectionId, delay = 180) {
  setSlimMode(false);
  setTimeout(() => {
    const sec = document.getElementById(sectionId);
    if (sec) { sec.classList.remove('collapsed'); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }, delay);
}

// JML logo → expand panel
document.getElementById('slim-brand').addEventListener('click', (e) => {
  e.stopPropagation();
  setSlimMode(false);
});

// Brand tooltip via JS tip system
document.getElementById('slim-brand').addEventListener('mouseenter', () => {
  if (!_tip) return;
  _tip.textContent = 'JML Fleet Console — expand';
  _tip.style.display = 'block'; _tip.style.opacity = '0';
  const rect = document.getElementById('slim-brand').getBoundingClientRect();
  const tipW = _tip.offsetWidth, tipH = _tip.offsetHeight;
  _tip.style.left = Math.max(4, rect.left - tipW - 10) + 'px';
  _tip.style.top  = (rect.top + (rect.height - tipH) / 2) + 'px';
  _tip.style.opacity = '1';
});
document.getElementById('slim-brand').addEventListener('mouseleave', hideSectionTip);

// Approvals stat → Pending Approvals section
document.getElementById('slim-stat-approvals').addEventListener('click', (e) => {
  e.stopPropagation(); _slimExpandTo('section-approvals');
});

// HR stat → HR Queue section
document.getElementById('slim-stat-hr').addEventListener('click', (e) => {
  e.stopPropagation(); _slimExpandTo('section-hrQueue');
});

// Certs stat → Agent Certs section
document.getElementById('slim-stat-certs').addEventListener('click', (e) => {
  e.stopPropagation(); _slimExpandTo('section-certs');
});

// Quick Action stat → expand + focus UPN input
document.getElementById('slim-stat-qa').addEventListener('click', (e) => {
  e.stopPropagation();
  setSlimMode(false);
  setTimeout(() => {
    const sec = document.getElementById('section-quickAction');
    if (sec) { sec.classList.remove('collapsed'); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    setTimeout(() => { const upn = document.getElementById('qa-upn'); if (upn) upn.focus(); }, 80);
  }, 180);
});

// Mode dot → toggle mode directly (no expand needed)
document.getElementById('slim-mode-dot').addEventListener('click', (e) => {
  e.stopPropagation();
  modePill.click();
});

// Joiner → pre-fills Agent Chat with intent, expands chat section, focuses input
document.getElementById('qa-joiner').addEventListener('click', () => {
  const sec = document.getElementById('section-agentChat');
  if (sec && sec.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    collapseMap['agentChat'] = false;
    saveCollapsed(collapseMap);
  }
  document.querySelectorAll('.ac-tab').forEach(t => t.classList.remove('active'));
  const tab = document.querySelector('.ac-tab[data-agent="approver"]');
  if (tab) { tab.classList.add('active'); _chatAgent = 'approver'; }
  acInput.value = 'Provision new joiner — ';
  scheduleAutoFitPanel();
  setTimeout(() => {
    sec && sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    acInput.focus();
    acInput.setSelectionRange(acInput.value.length, acInput.value.length);
  }, 80);
});

// Move → reveals inline mover form
document.getElementById('qa-move').addEventListener('click', () => {
  const upn = qaUpn.value.trim();
  if (!upn) { qaUpn.focus(); return; }
  const form = document.getElementById('qa-mover-form');
  document.getElementById('qa-mover-upn').textContent = upn;
  form.style.display = 'block';
  qaSuggest.style.display = 'none';
  qaRecents.style.display = 'none';
  document.getElementById('qa-move-dept').focus();
  scheduleAutoFitPanel();
});

document.getElementById('qa-move-cancel').addEventListener('click', () => {
  document.getElementById('qa-mover-form').style.display = 'none';
  document.getElementById('qa-move-dept').value = '';
  document.getElementById('qa-move-title').value = '';
  document.getElementById('qa-move-manager').value = '';
  scheduleAutoFitPanel();
});

document.getElementById('qa-move-run').addEventListener('click', async () => {
  const upn = qaUpn.value.trim();
  if (!upn) return;
  const newDepartment = document.getElementById('qa-move-dept').value.trim() || undefined;
  const newJobTitle   = document.getElementById('qa-move-title').value.trim() || undefined;
  const newManager    = document.getElementById('qa-move-manager').value.trim() || undefined;
  const whatif = _currentMode !== 'live';
  let writeToken = null;
  if (!whatif) {
    writeToken = await showPinModal('Mover', upn, 'Authorize Live Operation');
    if (!writeToken) return;
  }
  addRecent(upn);
  qaUpn.value = '';
  qaSuggest.style.display = 'none';
  qaRecents.style.display = 'none';
  document.getElementById('qa-mover-form').style.display = 'none';
  document.getElementById('qa-move-dept').value = '';
  document.getElementById('qa-move-title').value = '';
  document.getElementById('qa-move-manager').value = '';
  scheduleAutoFitPanel();
  showToast((whatif ? '[Safe] ' : '') + 'Running Move for ' + upn + '…', 'info');
  window.panelApi.runQuickMover({ upn, newDepartment, newJobTitle, newManager, whatif, writeToken });
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
  const label = data.type === 'leaver'
    ? ((data.data && data.data.stage) || 'Leaver') + ' Leave'
    : data.type === 'mover' ? 'Move' : 'Operation';
  if (data.error) showToast(label + ' failed — ' + ((data.lines || [])[0] || 'unknown error'), 'error');
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

// ── UPN autocomplete helper ───────────────────────────────────────────────────
let _acTimer = null;

function attachUpnAutocomplete(inputEl, suggestEl, onSelect) {
  let timer = null;
  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (q.length < 2) { suggestEl.style.display = 'none'; return; }
    timer = setTimeout(async () => {
      try {
        const results = await window.panelApi.searchUsers(q);
        if (!results || !results.length) { suggestEl.style.display = 'none'; return; }
        suggestEl.innerHTML = results.slice(0, 6).map(u =>
          `<div class="qa-ac-item" data-upn="${escHtml(u.upn)}">
            ${escHtml(u.displayName || u.upn)}
            <span class="qa-ac-upn">${escHtml(u.upn)}</span>
          </div>`
        ).join('');
        suggestEl.style.display = 'block';
        suggestEl.querySelectorAll('.qa-ac-item').forEach(item => {
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            inputEl.value = item.dataset.upn;
            suggestEl.style.display = 'none';
            if (onSelect) onSelect(item.dataset.upn);
          });
        });
      } catch { suggestEl.style.display = 'none'; }
    }, 220);
  });
  inputEl.addEventListener('blur', () => {
    setTimeout(() => { suggestEl.style.display = 'none'; }, 200);
  });
}

attachUpnAutocomplete(qaUpn, qaSuggest);
attachUpnAutocomplete(
  document.getElementById('qa-move-manager'),
  document.getElementById('qa-manager-suggest')
);

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
    const slimDot = document.getElementById('slim-mode-dot');
    if (slimDot) slimDot.classList.toggle('live', live);
  }

  if (typeof data.keepConsole === 'boolean') {
    keepConsoleCb.checked = data.keepConsole;
  }

  if (data.approvals != null) {
    const n = data.approvals;
    approvalBadge.textContent = n;
    approvalBadge.className = 'approval-badge' + (n > 0 ? '' : ' none');
    const slimApNum  = document.getElementById('slim-stat-approvals-num');
    const slimApIcon = document.getElementById('slim-stat-approvals-icon');
    const slimApStat = document.getElementById('slim-stat-approvals');
    if (slimApNum) {
      slimApNum.textContent = n;
      const cls = n > 0 ? 'active-coral' : '';
      slimApNum.className  = 'slim-stat-num'  + (cls ? ' ' + cls : '');
      slimApIcon.className = 'slim-stat-icon' + (cls ? ' ' + cls : '') + (n > 0 ? ' alerting' : '');
      if (slimApStat) {
        slimApStat.dataset.tip = n > 0
          ? n + ' approval' + (n === 1 ? '' : 's') + ' pending — click to review'
          : 'No pending approvals';
        slimApStat.className = 'slim-stat' + (n > 0 ? ' active-coral' : '');
      }
    }
  }

  if (Array.isArray(data.pendingList)) {
    renderPendingList(data.pendingList);
    scheduleAutoFitPanel();
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
    // Slim HUD — cert health stat
    const crit = data.certs.filter(c => c.daysLeft != null && c.daysLeft < 14).length;
    const warn = data.certs.filter(c => c.daysLeft != null && c.daysLeft >= 14 && c.daysLeft < 45).length;
    const slimCertNum  = document.getElementById('slim-stat-certs-num');
    const slimCertIcon = document.getElementById('slim-stat-certs-icon');
    const slimCertStat = document.getElementById('slim-stat-certs');
    if (slimCertNum) {
      const bad = crit + warn;
      slimCertNum.textContent = bad > 0 ? bad : '✓';
      const cls = crit > 0 ? 'active-coral' : warn > 0 ? 'active-amber' : '';
      slimCertNum.className  = 'slim-stat-num'  + (cls ? ' ' + cls : '');
      slimCertIcon.className = 'slim-stat-icon' + (cls ? ' ' + cls : '') + (crit > 0 ? ' alerting' : '');
      if (slimCertStat) {
        slimCertStat.className = 'slim-stat' + (crit > 0 ? ' active-coral' : warn > 0 ? ' active-amber' : '');
        slimCertStat.dataset.tip = crit > 0
          ? crit + ' cert' + (crit === 1 ? '' : 's') + ' expiring soon — click to review'
          : warn > 0
            ? warn + ' cert' + (warn === 1 ? '' : 's') + ' expiring in <45d'
            : 'All agent certs healthy';
      }
    }
    scheduleAutoFitPanel();
  }

  if (Array.isArray(data.recentEvents)) {
    eventsList.innerHTML = data.recentEvents.length
      ? data.recentEvents.map(e => renderEventItem(e)).join('')
      : '<div class="event-item"><div class="ev-agent">—</div><div class="ev-subject">No recent events</div><div class="ev-meta"><span>—</span></div></div>';
  } else if (data.lastEvent) {
    eventsList.innerHTML = renderEventItem(data.lastEvent);
  }
  if (Array.isArray(data.recentEvents) || data.lastEvent) scheduleAutoFitPanel();

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
    // Slim HUD — HR queue stat
    const slimHrNum  = document.getElementById('slim-stat-hr-num');
    const slimHrIcon = document.getElementById('slim-stat-hr-icon');
    const slimHrStat = document.getElementById('slim-stat-hr');
    if (slimHrNum) {
      const n = count || 0;
      const urgent = n > 0 && oldestMin != null && oldestMin > 30;
      slimHrNum.textContent = n;
      const cls = n > 0 ? 'active-amber' : '';
      slimHrNum.className  = 'slim-stat-num'  + (cls ? ' ' + cls : '');
      slimHrIcon.className = 'slim-stat-icon' + (cls ? ' ' + cls : '') + (urgent ? ' alerting' : '');
      if (slimHrStat) {
        slimHrStat.className = 'slim-stat' + (n > 0 ? ' active-amber' : '');
        const ageStr = oldestMin != null && oldestMin > 0
          ? ' · oldest ' + (oldestMin >= 60 ? Math.round(oldestMin / 60) + 'h' : oldestMin + 'm')
          : '';
        slimHrStat.dataset.tip = n > 0
          ? n + ' HR item' + (n === 1 ? '' : 's') + ageStr
          : 'HR queue empty';
      }
    }
    scheduleAutoFitPanel();
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

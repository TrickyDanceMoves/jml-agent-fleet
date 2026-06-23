'use strict';

const input   = document.getElementById('search-input');
const results = document.getElementById('results');
let _selected = null;
let _users    = [];
let _debounce = null;

const ACTIONS = [
  { action: 'approvals',  icon: '⏳', label: 'View Pending Approvals' },
  { action: 'audit-log',  icon: '🔗', label: 'Open Audit Log' },
  { action: 'dashboard',  icon: '📊', label: 'Open Dashboard' },
  { action: 'operations', icon: '⚡', label: 'Quick Operations' },
  { action: 'security',   icon: '🛡️', label: 'Security Overview' },
];

function dismiss() { window.panelApi.dismiss(); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') dismiss();
  if (e.key === 'ArrowDown') moveSelection(1);
  if (e.key === 'ArrowUp')   moveSelection(-1);
  if (e.key === 'Enter')     activateSelected();
});

input.addEventListener('input', () => {
  clearTimeout(_debounce);
  const q = input.value.trim();
  if (!q) { renderActions(); return; }
  _debounce = setTimeout(() => searchAndRender(q), 180);
});

function moveSelection(dir) {
  const items = [...results.querySelectorAll('.result-item')];
  const idx   = items.findIndex(i => i.classList.contains('active'));
  const next  = Math.max(0, Math.min(items.length - 1, idx + dir));
  items.forEach((i, j) => i.classList.toggle('active', j === next));
  _selected = items[next];
  items[next]?.scrollIntoView({ block: 'nearest' });
}

function activateSelected() {
  const active = results.querySelector('.result-item.active');
  if (active) active.click();
}

function renderActions() {
  results.innerHTML = `<div class="result-group-label">Actions</div>` +
    ACTIONS.map((a, i) => `
      <div class="result-item${i === 0 ? ' active' : ''}" data-action="${a.action}">
        <div class="result-icon">${a.icon}</div>
        <div style="flex:1"><div class="result-label">${a.label}</div></div>
      </div>`).join('');
  wireItems();
}

function renderUsers(users) {
  const html = users.length
    ? `<div class="result-group-label">Users</div>` + users.map((u, i) => `
        <div class="result-item${i === 0 ? ' active' : ''}" data-upn="${esc(u.upn)}">
          <div class="result-icon">👤</div>
          <div style="flex:1">
            <div class="result-label">${esc(u.displayName || u.upn)}</div>
            <div class="result-upn">${esc(u.upn)}</div>
          </div>
        </div>`).join('')
    : `<div class="empty-hint">No users found</div>`;
  results.innerHTML = html;
  wireItems();
}

function renderUserActions(upn, displayName) {
  results.innerHTML = `
    <div class="result-group-label">Actions for ${esc(displayName || upn)}</div>
    <div class="result-item active" data-user-action="open" data-upn="${esc(upn)}">
      <div class="result-icon">👁</div>
      <div style="flex:1"><div class="result-label">View in Users tab</div><div class="result-upn">${esc(upn)}</div></div>
    </div>
    <div class="result-item" data-user-action="move" data-upn="${esc(upn)}">
      <div class="result-icon">↗</div>
      <div style="flex:1"><div class="result-label">Move…</div></div>
    </div>
    <div class="result-item" data-user-action="soft" data-upn="${esc(upn)}">
      <div class="result-icon" style="color:var(--coral)">⚠</div>
      <div style="flex:1"><div class="result-label" style="color:var(--coral)">Soft Leave</div></div>
    </div>
    <div class="result-item" data-user-action="hard" data-upn="${esc(upn)}">
      <div class="result-icon" style="color:var(--coral)">⛔</div>
      <div style="flex:1"><div class="result-label" style="color:var(--coral);font-weight:600">Hard Leave</div></div>
    </div>`;
  wireItems();
}

function wireItems() {
  results.querySelectorAll('.result-item').forEach(item => {
    item.addEventListener('mouseenter', () => {
      results.querySelectorAll('.result-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
    });
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      const upn    = item.dataset.upn;
      const ua     = item.dataset.userAction;
      if (action)  { window.panelApi.openConsole(action); dismiss(); }
      if (upn && !ua) { renderUserActions(upn, item.querySelector('.result-label')?.textContent); }
      if (ua === 'open')  { window.panelApi.openConsole('users'); dismiss(); }
      if (ua === 'move')  { window.panelApi.runAction({ type: 'move', upn });       window.panelApi.openConsole('operations'); dismiss(); }
      if (ua === 'soft')  { window.panelApi.runAction({ type: 'soft-leave', upn }); window.panelApi.openConsole('operations'); dismiss(); }
      if (ua === 'hard') {
        if (!confirm(`Hard Leave for ${upn} - permanently removes licenses, groups, and terminates the account. Continue?`)) return;
        window.panelApi.runAction({ type: 'hard-leave', upn });
        window.panelApi.openConsole('operations');
        dismiss();
      }
    });
  });
}

async function searchAndRender(q) {
  try {
    const users = await window.panelApi.searchUsers(q);
    if (Array.isArray(users) && users.length) {
      renderUsers(users);
    } else {
      const filtered = ACTIONS.filter(a => a.label.toLowerCase().includes(q.toLowerCase()));
      if (filtered.length) {
        results.innerHTML = `<div class="result-group-label">Actions</div>` +
          filtered.map((a, i) => `
            <div class="result-item${i === 0 ? ' active' : ''}" data-action="${a.action}">
              <div class="result-icon">${a.icon}</div>
              <div style="flex:1"><div class="result-label">${a.label}</div></div>
            </div>`).join('');
        wireItems();
      } else {
        results.innerHTML = `<div class="empty-hint">No results for "${esc(q)}"</div>`;
      }
    }
  } catch {
    results.innerHTML = `<div class="empty-hint">Search unavailable</div>`;
  }
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Init
input.focus();
renderActions();

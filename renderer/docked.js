'use strict';

const approvalBadge = document.getElementById('approval-badge');
const approvalRow   = document.getElementById('approval-row');
const certList      = document.getElementById('cert-list');
const eventBox      = document.getElementById('event-box');
const qaUpn         = document.getElementById('qa-upn');

document.getElementById('close-btn').addEventListener('click', () => window.panelApi.dismiss());
document.getElementById('open-console').addEventListener('click', () => window.panelApi.openConsole('dashboard'));

approvalRow.addEventListener('click', () => window.panelApi.openConsole('approvals'));
eventBox.addEventListener('click',    () => window.panelApi.openConsole('audit-log'));

document.getElementById('qa-move').addEventListener('click', () => {
  const upn = qaUpn.value.trim();
  if (!upn) { qaUpn.focus(); return; }
  window.panelApi.runAction({ type: 'move', upn });
  window.panelApi.openConsole('operations');
  qaUpn.value = '';
});

document.getElementById('qa-soft').addEventListener('click', () => {
  const upn = qaUpn.value.trim();
  if (!upn) { qaUpn.focus(); return; }
  window.panelApi.runAction({ type: 'soft-leave', upn });
  window.panelApi.openConsole('operations');
  qaUpn.value = '';
});

document.getElementById('qa-hard').addEventListener('click', () => {
  const upn = qaUpn.value.trim();
  if (!upn) { qaUpn.focus(); return; }
  if (!confirm(`Hard Leave permanently removes licenses, group memberships, and terminates ${upn}. Continue?`)) return;
  window.panelApi.runAction({ type: 'hard-leave', upn });
  window.panelApi.openConsole('operations');
  qaUpn.value = '';
});

window.panelApi.onUpdate((data) => {
  if (data.approvals != null) {
    const n = data.approvals;
    approvalBadge.textContent = n;
    approvalBadge.className = 'approval-badge' + (n > 0 ? '' : ' none');
  }

  if (Array.isArray(data.certs)) {
    certList.innerHTML = data.certs.map(c => {
      const dot = c.daysLeft == null ? 'none' : c.daysLeft < 14 ? 'crit' : c.daysLeft < 45 ? 'warn' : '';
      const days = c.daysLeft != null ? c.daysLeft + 'd' : '—';
      return `<div class="cert-row">
        <div class="cert-dot ${dot}"></div>
        <span class="cert-name">${c.agent}</span>
        <span class="cert-days" style="color:${dot === 'crit' ? 'var(--coral)' : dot === 'warn' ? 'var(--amber)' : 'var(--muted)'}">${days}</span>
      </div>`;
    }).join('');
  }

  if (data.lastEvent) {
    const e = data.lastEvent;
    const cls = e.outcome === 'success' ? 'success' : e.outcome === 'failed' ? 'failed' : e.outcome === 'partial' ? 'partial' : '';
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    eventBox.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
        <span class="ev-agent">${e.agent || '—'}</span>
        <span class="ev-outcome ${cls}">${e.outcome || '—'}</span>
      </div>
      <div class="ev-subject">${e.subject || '—'}</div>
      <div class="ev-meta"><span>${ts}</span>${e.whatif ? '<span>safe mode</span>' : ''}</div>`;
  }
});

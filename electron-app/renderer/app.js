'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab     = 'dashboard';
let currentRole    = null;
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
// Holds the most-recent score_risk tool result so renderRiskScoreCard can
// render contextual reasons rather than generic placeholder text.
let _lastRiskResult = null;

// ── Agent avatars ─────────────────────────────────────────────────────────────
const AGENT_AVATARS = {
  approver: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`,
  auditor:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`
};
const AGENT_LABELS = { approver: 'Approver Agent', auditor: 'Audit Agent' };

const AGENT_SCOPE_META = {
  joiner:      { label: 'Joiner',      reg: 'jml-joiner-agent',      role: 'CREATE accounts on day-one',                        scopes: ['User.RW', 'Group.RW', 'LicenseAssignment.RW'],              cannot: ['PIM', 'Conditional Access', 'Directory roles'],              note: 'Day-one account creation. Invoked from Joiner tab form or HRIS webhook.' },
  mover:       { label: 'Mover',       reg: 'jml-mover-agent',       role: 'TRANSFER group + license membership',               scopes: ['User.RW', 'Group.RW'],                                       cannot: ['Account creation', 'PIM', 'Directory roles'],                note: 'Transfer group membership and license seats on role change.' },
  leaver:      { label: 'Leaver',      reg: 'jml-leaver-agent',      role: 'OFFBOARD accounts in stages',                       scopes: ['User.RW', 'Group.RW', 'Sessions.Revoke'],                    cannot: ['PIM', 'Conditional Access', 'License purchase'],             note: 'Soft & hard offboard. Soft = disable; hard = delete after 30d.' },
  enroller:    { label: 'Enroller',    reg: 'jml-enroller-agent',    role: 'MFA + device enrollment',                           scopes: ['Device.RW', 'Policy.Read'],                                  cannot: ['User mutation', 'Group mutation', 'PIM'],                    note: 'MFA registration, SSPR, device enroll, Conditional Access seed.' },
  certifier:   { label: 'Certifier',   reg: 'jml-certifier-agent',   role: 'RECERTIFY access reviews',                          scopes: ['Group.Read', 'AccessReview.RW', 'AuditLog.Read'],            cannot: ['User write', 'Group write', 'PIM'],                          note: 'Drives quarterly access-review campaigns against Entra groups.' },
  approver:    { label: 'Approver',    reg: 'jml-approver-agent',    role: 'CONVERSATIONAL submit w/ dual-approval',             scopes: ['inherits operator scope'],                                   cannot: ['anything beyond the operator'],                              note: 'Conversational front-door. Collects intent, builds plan, holds reaction window.' },
  provisioner: { label: 'Provisioner', reg: 'jml-provisioner-agent', role: 'ROTATE certs + per-agent app regs',                 scopes: ['Application.RW.OwnedBy', 'Directory.AccessAsUser.All'],     cannot: ['User / group / role mutation', 'PIM'],                       note: 'Rotates per-agent certs and manages application registrations.' },
  auditor:     { label: 'Auditor',     reg: 'jml-auditor-agent',     role: 'READ-ONLY query of logs + policy advisor',          scopes: ['AuditLog.Read', 'IdentityRiskyUser.Read'],                   cannot: ['anything that mutates state'],                               note: 'NL query layer over the hash-chained audit log. Read-only, no mutations.' },
  knowledge:   { label: 'Knowledge',   reg: 'jml-knowledge-agent',   role: 'READ-ONLY policy advisor',                          scopes: ['internal KB only'],                                          cannot: ['directory access', 'audit access'],                          note: 'Policy advisor backed by internal KB. No directory or audit access.' },
};

// ── Tab switching + auto-refresh ──────────────────────────────────────────────
let _tabRefreshTimers = {};

const TAB_TITLES = {
  dashboard: 'Dashboard',
  'glass-screen': 'Glass Screen',
  approver: 'Approver Agent',
  auditor: 'Audit Agent',
  graph: 'Graph Runner',
  approvals: 'Approvals',
  operations: 'Operations',
  certifications: 'Access Reviews',
  integrations: 'Integrations',
  security: 'Security',
  'audit-log': 'Audit Log',
  exports: 'Exports',
  users: 'Users',
  certs: 'Agent Certificates',
  settings: 'Settings'
};

// Tabs where the Safe/Live mode pill is meaningful — anywhere you can issue
// or approve a write operation. Read-only views hide the pill to reduce noise.
const PAGE_BRIEFS = {
  approver: [
    ['Intent', 'Plan before write', 'Every request resolves into scoped steps before the tenant is touched.'],
    ['Control', 'Dual approval', 'Hard leavers, PIM-adjacent changes, and sensitive licenses require a second hand.']
  ],
  auditor: [
    ['Scope', 'Read-only evidence', 'The Auditor can query logs, risk signals, and policy context without mutating state.'],
    ['Boundary', 'No directory writes', 'This surface is for explanation, precedent, and traceability only.'],
    ['Output', 'Citation-first answers', 'Responses point back to audit entries, policies, or event history.']
  ],
  approvals: [
    ['Queue', 'Expiring tokens', 'Approval tokens age out quickly so stale identity decisions do not linger.'],
    ['Risk', 'Second operator', 'High-impact requests stay blocked until a separate approver signs.'],
    ['Audit', 'Receipt required', 'Approve and reject actions both become durable evidence.']
  ],
  operations: [
    ['Run state', 'In-flight visibility', 'Operators can see active, queued, completed, and scheduled lifecycle work.'],
    ['Safety', 'Safe by default', 'Bulk and quick actions start as what-if until an operator chooses live execution.'],
    ['Recovery', 'Rollback context', 'Lifecycle runs keep enough state nearby to inspect outcomes and recover.']
  ],
  certifications: [
    ['Campaigns', 'Entitlement reviews', 'The Certifier drives recurring access attestations for groups and licenses.'],
    ['Revocation', 'Approval-routed', 'Sensitive removals flow through Approver instead of bypassing controls.'],
    ['Evidence', 'Reviewer trace', 'Campaign decisions stay tied to reviewers, scope, and timestamps.']
  ],
  integrations: [
    ['Origin', 'HRIS inbound', 'BambooHR, Workday, and ServiceNow events enter through a canonical lane.'],
    ['Queue', 'Durable handoff', 'External events land in a queue before any agent decides or writes.'],
    ['Notify', 'Teams and SIEM', 'Human alerts and downstream security records stay connected to the same event.']
  ],
  security: [
    ['Threats', 'UEBA and risk', 'After-hours behavior, risky identities, and suspicious sequences surface here first.'],
    ['Drift', 'Baseline repair', 'Policy drift is shown as a concrete diff before remediation is queued.'],
    ['Escalation', 'On-call ready', 'Critical findings are designed to page operators, not sit as passive reports.']
  ],
  'audit-log': [
    ['Integrity', 'Hash-chain verified', 'Every lifecycle operation links to the previous evidence hash.'],
    ['Replication', 'Multi-sink chain', 'Local chain, Blob, Sentinel, SIEM, and object lock should agree.'],
    ['Export', 'Attestation packs', 'Evidence can be packaged for audit without losing provenance.']
  ],
  exports: [
    ['Channels', 'SIEM and archive', 'Audit, security, and inventory exports share the same evidence backbone.'],
    ['Parity', 'Same chain everywhere', 'Downstream systems receive records tied to the same hash-chain state.'],
    ['Operations', 'Retry visible', 'Failed replication should be visible and recoverable from this page.']
  ],
  users: [
    ['Directory', 'Identity inventory', 'Managed users are shown with lifecycle, risk, and access-review context.'],
    ['Signals', 'Risk beside profile', 'UEBA, Identity Protection, and drift signals stay near the person affected.'],
    ['Action', 'Least-privilege jump', 'User-level action routes through the right agent and approval path.']
  ],
  graph: [
    ['Access', 'Scoped Graph runner', 'Ad-hoc Graph calls run under fleet RBAC, not an invisible operator shortcut.'],
    ['Logging', 'Every call recorded', 'Queries and mutations are expected to leave an audit trail.'],
    ['Control', 'Writes need approval', 'Mutating verbs require Approver context before they proceed.']
  ],
  certs: [
    ['Credentials', 'Per-agent certs', 'Each agent has its own app registration and credential lifecycle.'],
    ['Least privilege', 'Scope matrix', 'Permissions are visible by agent so over-broad access is easy to spot.'],
    ['Rotation', 'Provisioner managed', 'Expiring certs are detected early and routed through the rotation path.']
  ],
  settings: [
    ['Tenant', 'Binding and authority', 'Tenant, operators, roles, and notification rules define who can steer the fleet.'],
    ['Policy', 'Guardrails live here', 'Freeze windows, SoD, calendar policy, and routing rules are operational controls.'],
    ['Audit', 'Config is evidence', 'Settings changes are treated as lifecycle events, not private preferences.']
  ]
};

function setupPageBriefs() {
  // Function-first console: page briefs were visually useful in isolation, but
  // they delayed the actual tool on every tab. Keep the copy here for future
  // help/tooltips, but do not inject full-width info tiles.
  return;
  Object.entries(PAGE_BRIEFS).forEach(([tab, items]) => {
    const view = document.getElementById('view-' + tab);
    const head = view && view.querySelector(':scope > .head');
    if (!head || view.querySelector(':scope > .v2-view-brief')) return;
    const html = '<div class="v2-view-brief">' + items.map(([k, title, copy]) =>
      '<div class="v2-brief-tile">' +
        '<span class="k">' + k + '</span>' +
        '<span class="t">' + title + '</span>' +
        '<span class="c">' + copy + '</span>' +
      '</div>'
    ).join('') + '</div>';
    head.insertAdjacentHTML('afterend', html);
  });
}

setupPageBriefs();

const TABS_WITH_MODE = new Set(['approver', 'approvals', 'operations', 'users']);

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + tab));
  currentTab = tab;
  // Update breadcrumb in topbar
  const crumb = document.getElementById('crumb-cur');
  if (crumb) crumb.textContent = TAB_TITLES[tab] || tab;
  // Show mode pill only on tabs that can write to the directory
  const modePill = document.getElementById('topbar-mode-pill');
  if (modePill) modePill.style.display = TABS_WITH_MODE.has(tab) ? '' : 'none';
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
  if (tab === 'integrations')  loadIntegrations();
  if (tab === 'users')         loadRecentUsers();
  if (tab === 'glass-screen') window.JmlGlassScreen?.onShow();
}

// ── Integrations tab loader ────────────────────────────────────────────────────
let _intConfig = null;

function applyIntegrationsConfig(cfg) {
  _intConfig = cfg || {};
  const bb = cfg.bamboohr || {};
  const tm = cfg.teams    || {};
  const st = cfg.sentinel || {};
  const sp = cfg.splunk || {};
  const sn = cfg.servicenow || {};
  const ji = cfg.jira || {};

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  const setHealth = (id, enabled) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (enabled) { el.textContent = 'live';    el.classList.remove('int-health-offline'); }
    else         { el.textContent = 'offline'; el.classList.add('int-health-offline'); }
  };

  setHealth('int-bamboo-health',   bb.enabled);
  setHealth('int-teams-health',    tm.enabled);
  setHealth('int-sentinel-health', st.enabled);
  setHealth('int-splunk-health',   sp.enabled);
  setHealth('int-servicenow-health', sn.enabled);
  setHealth('int-jira-health',     ji.enabled);

  const secretEl = document.getElementById('int-bamboo-secret');
  if (secretEl) secretEl.textContent = bb.enabled ? '••••• configured' : 'not configured';

  setEl('int-teams-channel',    tm.channel);
  setEl('int-teams-oncall',     tm.oncallHandle);
  setEl('int-sentinel-ws',      st.workspaceName);
  setEl('int-sentinel-table',   st.tableName);
  setEl('int-splunk-hec',       sp.hecEndpoint);
  setEl('int-splunk-index',     sp.index);
  setEl('int-servicenow-url',   sn.instanceUrl);
  setEl('int-servicenow-table', sn.table || 'incident');
  setEl('int-jira-url',         ji.siteUrl);
  setEl('int-jira-project',     ji.projectKey);
  setEl('int-sentinel-rules',   '—');

  // Show edit buttons only for admins
  const isAdmin = currentOperatorRole() === 'admin';
  document.querySelectorAll('.int-admin-only').forEach(btn => { btn.style.display = isAdmin ? '' : 'none'; });

  // Sync the dashboard Integrations widget with the real config — dots and
  // count reflect what is actually enabled, never a hardcoded "connected".
  const dashSync = [['bamboo', bb], ['teams', tm], ['sentinel', st], ['splunk', sp], ['servicenow', sn], ['jira', ji]];
  let connected = 0;
  for (const [key, c] of dashSync) {
    const row = document.querySelector(`.dash-mini-row[data-conn="${key}"]`);
    if (!row) continue;
    const dot = row.querySelector('.dash-mini-dot');
    if (dot) dot.style.background = c.enabled ? 'var(--emerald)' : 'var(--border-strong)';
    const meta = row.querySelector('.dash-mini-meta');
    if (meta && !c.enabled) meta.textContent = 'not configured';
    else if (meta && key === 'teams') meta.textContent = tm.channel || 'connected';
    if (c.enabled) connected++;
  }
  const dashCnt = document.getElementById('dash-int-cnt');
  if (dashCnt) dashCnt.textContent = connected ? `· ${connected} connected` : '· not configured';
}

function loadIntegrations() {
  if (typeof window.api?.getHrQueue === 'function') {
    try { window.api.getHrQueue(); } catch (_) { /* non-fatal */ }
  }
  if (typeof window.api?.getIntegrationsConfig === 'function') {
    window.api.getIntegrationsConfig().then(r => { if (r && r.config) applyIntegrationsConfig(r.config); }).catch(() => {});
  }
}

// ── Integration edit modal ────────────────────────────────────────────────────
(function wireIntegrationEdit() {
  const overlay = document.getElementById('int-edit-overlay');
  if (!overlay) return;

  const FIELDS = {
    bamboohr: {
      title: 'Edit BambooHR',
      hint:  'Webhook secret and API key are stored in api/local.settings.json. Set the enabled flag here once the webhook is wired up.',
      fields: []
    },
    teams: {
      title: 'Edit Microsoft Teams',
      hint:  'Teams webhook URL is stored in shared/notifications.json. Update channel and on-call handle here.',
      fields: [
        { id: 'teams-channel',    label: 'Channel',       key: 'channel',      placeholder: '#identity-ops' },
        { id: 'teams-oncall',     label: 'On-crit handle',key: 'oncallHandle', placeholder: '@oncall-identity' }
      ]
    },
    sentinel: {
      title: 'Edit Sentinel Pipeline',
      hint:  'Connection details (workspace ID, key) are stored in auditor/sentinel.config.json. Set display labels and enable here.',
      fields: [
        { id: 'sentinel-ws',     label: 'Workspace name', key: 'workspaceName', placeholder: 'my-la-workspace' },
        { id: 'sentinel-table',  label: 'Table name',     key: 'tableName',     placeholder: 'JmlFleet_CL' }
      ]
    },
    splunk: {
      title: 'Edit Splunk SIEM',
      hint:  'Splunk HEC token stays outside the renderer. Store the endpoint and index label here for routing and dashboard status.',
      fields: [
        { id: 'splunk-hec',   label: 'HEC endpoint', key: 'hecEndpoint', placeholder: 'https://splunk.example/services/collector' },
        { id: 'splunk-index', label: 'Index',        key: 'index',       placeholder: 'identity' }
      ]
    },
    servicenow: {
      title: 'Edit ServiceNow',
      hint:  'ServiceNow can receive HRIS/ITSM tickets for lifecycle events. Store the instance label and target table here.',
      fields: [
        { id: 'sn-url',   label: 'Instance URL', key: 'instanceUrl', placeholder: 'https://example.service-now.com' },
        { id: 'sn-table', label: 'Table',        key: 'table',       placeholder: 'incident' }
      ]
    },
    jira: {
      title: 'Edit Jira',
      hint:  'Jira can receive identity work items and approval follow-ups. Store the site and project key here.',
      fields: [
        { id: 'jira-url',     label: 'Site URL',    key: 'siteUrl',    placeholder: 'https://example.atlassian.net' },
        { id: 'jira-project', label: 'Project key', key: 'projectKey', placeholder: 'IAM' }
      ]
    }
  };

  let _activeInt = null;

  document.querySelectorAll('.int-admin-only').forEach(btn => {
    btn.addEventListener('click', () => {
      const intKey = btn.dataset.int;
      const def = FIELDS[intKey];
      if (!def) return;
      _activeInt = intKey;
      document.getElementById('int-edit-modal-title').textContent = def.title;
      document.getElementById('int-edit-hint').textContent        = def.hint;

      const fields = document.getElementById('int-edit-modal-fields');
      const cur = (_intConfig && _intConfig[intKey]) || {};
      fields.innerHTML = def.fields.map(f => `
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-2)">
          ${escHtml(f.label)}
          <input class="int-edit-field" data-key="${escHtml(f.key)}"
            value="${escHtml(cur[f.key] || '')}"
            placeholder="${escHtml(f.placeholder)}"
            style="padding:8px 10px;font-family:var(--mono);font-size:12px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-1);color:var(--text)">
        </label>`).join('');

      document.getElementById('int-edit-enabled').checked = !!(cur.enabled);
      overlay.style.display = 'flex';
    });
  });

  const close = () => { overlay.style.display = 'none'; _activeInt = null; };
  document.getElementById('int-edit-close').addEventListener('click', close);
  document.getElementById('int-edit-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('int-edit-save').addEventListener('click', async () => {
    if (!_activeInt || currentOperatorRole() !== 'admin') return;
    const updated = Object.assign({}, (_intConfig && _intConfig[_activeInt]) || {});
    updated.enabled = document.getElementById('int-edit-enabled').checked;
    document.querySelectorAll('#int-edit-modal-fields .int-edit-field').forEach(inp => {
      updated[inp.dataset.key] = inp.value.trim();
    });
    const newCfg = Object.assign({}, _intConfig, { [_activeInt]: updated });
    const res = await window.api.saveIntegrationsConfig(newCfg);
    if (res && res.ok) {
      applyIntegrationsConfig(newCfg);
      close();
      showToast('Integration settings saved', 'success');
    } else {
      showToast((res && res.error) || 'Save failed', 'error');
    }
  });
})();

// Subscribe to HR queue events for both the Exports view AND Integrations view.
if (typeof window.api?.onHrQueue === 'function') {
  window.api.onHrQueue(hr => {
    const meta = document.getElementById('int-queue-meta');
    const rows = document.getElementById('int-queue-rows');
    // Error path — Azurite not running or queue not configured
    if (hr && hr.error) {
      if (meta) meta.innerHTML = '<span style="color:var(--coral)">offline</span>';
      if (rows) rows.innerHTML = `<div class="q-row"><span style="grid-column:1 / -1;padding:18px 14px;color:var(--muted);text-align:center;line-height:1.55">
        HR event queue is offline. <br>
        <span style="font-family:var(--mono);font-size:11px">Start the dev stack: <code style="color:var(--cyan)">agents/dev-start.ps1</code></span><br>
        <span style="font-size:11px;color:var(--dim);margin-top:6px;display:inline-block">${escHtml(hr.error)}</span>
      </span></div>`;
      return;
    }
    if (meta && hr) {
      const q = hr.queueDepth ?? hr.queued ?? 0;
      const p = hr.processing ?? 0;
      const d = hr.dlq ?? hr.deadLetter ?? 0;
      meta.innerHTML = `queued <b style="color:var(--text)">${q}</b> · processing <b style="color:var(--cyan)">${p}</b> · dlq <b style="color:var(--coral)">${d}</b>`;
    }
    // Feed dashboard Integrations widget
    if (hr && !hr.error) {
      const bb = document.getElementById('dash-int-bamboo');
      if (bb) bb.textContent = `${(hr.events && hr.events.length) || 0} events`;
      const cnt = document.getElementById('dash-int-cnt');
      if (cnt) cnt.textContent = `· ${hr.queueDepth ?? 0} queued`;
    }
    if (rows && hr && Array.isArray(hr.events) && hr.events.length) {
      rows.innerHTML = hr.events.slice(0, 10).map(e => {
        const ts = (e.queuedAt || e.timestamp || '').slice(11, 19);
        const status = (e.status || 'queued').toLowerCase();
        const klass = status === 'processing' ? 'proc' : status === 'queued' ? 'q' : 'ok';
        return `<div class="q-row">
          <span>${escHtml(ts)}</span>
          <span class="agent-tag t-${escHtml((e.agent || 'auditor').toLowerCase())}">${escHtml(e.source || 'hris')}</span>
          <span class="event">${escHtml(e.type || '—')}</span>
          <span>${escHtml(e.subject || '—')}</span>
          <span class="stat ${klass}">${escHtml(status)}</span>
        </div>`;
      }).join('');
    } else if (rows) {
      rows.innerHTML = `<div class="q-row"><span style="grid-column:1 / -1;padding:18px 14px;color:var(--muted);text-align:center">
        No queued events. New HR events from BambooHR will appear here in real time.
      </span></div>`;
    }
  });
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Window controls ───────────────────────────────────────────────────────────
document.getElementById('btn-minimize').addEventListener('click', () => window.api.windowMinimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.api.windowMaximize());
document.getElementById('btn-close').addEventListener('click',    () => window.api.windowClose());
document.getElementById('btn-power')?.addEventListener('click',   () => {
  if (confirm('Quit JML Fleet Console?')) window.api.appQuit();
});

// ── Mode toggle (Approver) ────────────────────────────────────────────────────
function updateTopbarModePill() {
  // Toggle live-mode chrome tint on the root layout element
  const layout = document.getElementById('layout') || document.querySelector('.layout');
  if (layout) layout.classList.toggle('live-mode', !isWhatif);

  const pill = document.getElementById('topbar-mode-pill');
  if (pill) {
    pill.classList.toggle('live', !isWhatif);
    pill.innerHTML = isWhatif
      ? '<span class="dot"></span> SAFE &middot; NO COMMIT'
      : '<span class="dot"></span> LIVE &middot; WRITING';
    // Respect current-tab visibility
    if (typeof TABS_WITH_MODE !== 'undefined' && typeof currentTab !== 'undefined') {
      pill.style.display = TABS_WITH_MODE.has(currentTab) ? '' : 'none';
    } else {
      pill.style.display = 'none';
    }
  }
  // Sidebar mode tag (always visible — reflects global state)
  const sideMode = document.getElementById('sidebar-mode-tag');
  if (sideMode) {
    sideMode.textContent = '· ' + (isWhatif ? 'Safe' : 'LIVE');
    sideMode.classList.toggle('live', !isWhatif);
  }
}

// Pre-load operator auth + operators map at startup so role-check + PIN gates
// work without waiting for the Settings tab to be opened.
loadOperatorAuth();
try { window.api.getOperators(); } catch (_) {}

// Global approvals poll — keeps the sidebar badge accurate from any tab.
// Tab-local poll (in switchTab) stays at 30s for the active Approvals view;
// this background poll runs at 60s so the global state never goes stale.
setInterval(() => { try { window.api.getPendingApprovals(); } catch (_) {} }, 60000);
// Kick once at startup so the badge is correct from the first paint
setTimeout(() => { try { window.api.getPendingApprovals(); } catch (_) {} }, 1500);

// ── Hard mode toggle (sticky session default) ──────────────────────────────
const HARD_MODE_KEY = 'jml-hard-mode';
let _hardMode = (function() {
  try { const v = localStorage.getItem(HARD_MODE_KEY); return v === 'live' ? 'live' : 'whatif'; }
  catch { return 'whatif'; }
})();
function setHardMode(target) {
  _hardMode = target === 'live' ? 'live' : 'whatif';
  try { localStorage.setItem(HARD_MODE_KEY, _hardMode); } catch (_) {}
  document.querySelectorAll('.hard-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.hard === _hardMode);
    b.setAttribute('aria-selected', b.dataset.hard === _hardMode ? 'true' : 'false');
  });
}
setHardMode(_hardMode);
// Initialize soft mode to match hard mode at boot
isWhatif = _hardMode === 'whatif';
window.api.setMode(isWhatif);
window.JmlModeUi.syncModeUi(document, isWhatif);

// Confirmation modal — returns true if user clicks OK, false otherwise
function confirmModal({ title, body, danger, okLabel, cancelLabel }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pin-overlay';
    overlay.innerHTML = `
      <div class="pin-modal">
        <div class="pin-header">
          <div class="pin-title">${escHtml(title || 'Confirm')}</div>
          ${body ? `<div class="pin-sub">${escHtml(body)}</div>` : ''}
        </div>
        <div class="pin-footer">
          <button class="btn ghost confirm-cancel">${escHtml(cancelLabel || 'Cancel')}</button>
          <button class="btn ${danger ? 'danger' : 'primary'} confirm-ok">${escHtml(okLabel || 'OK')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.confirm-ok').addEventListener('click', () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { done(false); document.removeEventListener('keydown', esc); } });
    setTimeout(() => overlay.querySelector('.confirm-ok').focus(), 50);
  });
}

// Returns the current operator's role. Prefer the authoritative value set by
// applyRoleUI (which comes from main.js get-current-operator IPC) — that's
// available immediately after sign-in. The _operators map is a secondary check
// keyed by operator NAME (not Windows username).
function currentOperatorRole() {
  if (currentRole) return String(currentRole).toLowerCase();
  const opName = currentOperatorName || window.api.currentUser;
  if (_operators && _operators[opName]) return String(_operators[opName]).toLowerCase();
  return 'viewer';
}
function isViewer() { return currentOperatorRole() === 'viewer'; }

// Visually hint that Live is restricted when the operator is a viewer, but
// NEVER hard-disable the button — the click handler will show a helpful
// toast/modal instead of silently swallowing the click. Disabling buttons led
// to "I can't click Live" when role data was momentarily stale at boot.
function applyViewerLock() {
  const viewer = isViewer();
  document.querySelectorAll('.hard-mode-btn[data-hard="live"], .mode-btn[data-mode="live"]').forEach(b => {
    b.disabled = false;
    b.style.opacity = viewer ? .6 : '';
    b.style.cursor = '';
    b.title = viewer ? 'Read-only role — clicking will explain why Live is restricted' : '';
  });
}

// Wire the hard toggle buttons. Switching to LIVE requires PIN; switching to
// Safe is free. Either change also auto-applies to the soft toggle so they
// stay in sync until the user explicitly deviates per-chat.
document.querySelectorAll('.hard-mode-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.hard;
    if (target === _hardMode) return;
    // Mode toggle is INTENT only — flip freely. PIN gate fires at actual write
    // time (approval submit, Live mover/leaver). The one exception is viewers,
    // who can't enter Live mode at all by policy.
    if (target === 'live' && isViewer()) {
      const switchNow = await confirmModal({
        title: 'Viewer role — Live mode is disabled',
        body: `"${currentOperatorName || window.api.currentUser}" is signed in as a read-only viewer. Switch to an admin or helpdesk operator to enable Live mode.`,
        okLabel: 'Switch operator',
        cancelLabel: 'Stay'
      });
      if (switchNow) document.getElementById('btn-switch-operator')?.click();
      return;
    }
    setHardMode(target);
    // Apply to soft state too
    isWhatif = target === 'whatif';
    window.api.setMode(isWhatif);
    window.JmlModeUi.syncModeUi(document, isWhatif);
    updateTopbarModePill();
    showToast(`Session set to ${target === 'live' ? 'LIVE' : 'Safe'} mode`, 'success');
  });
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const targetWhatif = btn.dataset.mode === 'whatif';
    const target = targetWhatif ? 'whatif' : 'live';
    // Viewer can never enter Live mode
    if (target === 'live' && isViewer()) {
      const switchNow = await confirmModal({
        title: 'Viewer role — Live mode is disabled',
        body: `"${currentOperatorName || window.api.currentUser}" is signed in as a read-only viewer. Switch operators to enable Live mode.`,
        okLabel: 'Switch operator',
        cancelLabel: 'Stay'
      });
      if (switchNow) document.getElementById('btn-switch-operator')?.click();
      return;
    }
    // Soft-mode is intent only. No PIN at toggle time — PIN gates the actual
    // approval submit / Live mover / Live leaver. If toggling away from the
    // hard session default, give a one-tap confirmation so accidental Live
    // engagement still surfaces.
    if (target !== _hardMode) {
      const ok = await confirmModal({
        title: 'Override session mode?',
        body: `Session default is ${_hardMode === 'whatif' ? 'Safe' : 'LIVE'}. Switch this chat to ${target === 'whatif' ? 'Safe' : 'LIVE'}?`,
        danger: target === 'live',
        okLabel: 'Override',
      });
      if (!ok) return;
    }
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    isWhatif = targetWhatif;
    window.api.setMode(isWhatif);
    window.JmlModeUi.syncModeUi(document, isWhatif);
    updateTopbarModePill();
  });
});
updateTopbarModePill();

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
  container.innerHTML = '';
  appendWelcome(agent);
  if (agent === 'approver') { lcSetIdle(); _lastRiskResult = null; }
  if (agent === 'auditor')  audClearState();
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

  // Lifecycle: reset to request stage when approver gets a new message
  if (agent === 'approver') lcResetToRequest();
  // Auditor: update active query card
  if (agent === 'auditor') audSetActiveQuery(text);

  window.api.sendMessage(agent, text);
}

['approver', 'auditor'].forEach(agent => {
  document.getElementById('send-' + agent).addEventListener('click', () => sendMessage(agent));
  document.getElementById('input-' + agent).addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(agent); }
  });
  const stopBtn = document.getElementById('stop-' + agent);
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      window.api.abortAgent(agent);
      setWaiting(agent, false);
      const msgEl = currentMsgEl[agent];
      if (msgEl) {
        const thinkEl = msgEl.querySelector('.thinking-indicator');
        if (thinkEl) thinkEl.style.display = 'none';
        msgEl.classList.remove('thinking');
        const textEl = msgEl.querySelector('.message-text');
        if (textEl) textEl.classList.remove('streaming');
        currentMsgEl[agent] = null;
      }
    });
  }
});

// ── V2 Approver Rail updates ───────────────────────────────────────────────
function updateSubjectCard(info) {
  // info: { name, upn, dept, manager, ticket, groups, licenses }
  const card = document.getElementById('subject-card');
  if (!card) return;
  card.style.display = 'block';
  const av = document.getElementById('subject-avatar');
  const nameEl = document.getElementById('subject-name');
  const upnEl = document.getElementById('subject-upn');
  const grid = document.getElementById('subject-grid');
  if (nameEl) nameEl.textContent = info.name || '—';
  if (upnEl) upnEl.textContent = info.upn || '—';
  if (av) {
    const initials = (info.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    av.textContent = initials;
  }
  if (grid) {
    const rows = [
      ['DEPT', info.dept],
      ['MGR', info.manager],
      ['TICKET', info.ticket],
      ['GROUPS', info.groups],
      ['LICENSES', info.licenses],
    ].filter(([, v]) => v);
    grid.innerHTML = rows.map(([k, v]) =>
      '<span class="sg-key">' + k + '</span><span>' + escHtml(String(v)) + '</span>'
    ).join('');
  }
}

function addOpLogEntry(entry) {
  // entry: { time, agent, event, msg, ok }
  const list = document.getElementById('op-log-list');
  const card = document.getElementById('op-log-card');
  if (!list || !card) return;
  card.style.display = 'block';
  const row = document.createElement('div');
  row.className = 'op-log-row';
  row.innerHTML =
    '<span class="op-log-time mono">' + escHtml(entry.time || '—') + '</span>'
    + '<span class="tag op-log-agent">' + escHtml(entry.agent || '—') + '</span>'
    + '<span class="op-log-event">' + escHtml(entry.event || '') + '<span class="op-log-msg"> · ' + escHtml(entry.msg || '') + '</span></span>'
    + '<span class="dot ' + (entry.ok ? 'ok' : 'warn') + '"></span>';
  list.insertBefore(row, list.firstChild);
}

// ── Approver lifecycle state machine ──────────────────────────────────────────
const _LC_META = {
  request:   { label: 'Request',       sub: 'intent captured' },
  risk:      { label: 'Risk Score',    sub: null },
  plan:      { label: 'Plan',          sub: null },
  soft:      { label: 'Soft Stage',    sub: 'disable · revoke sessions' },
  approval:  { label: 'Dual Approval', sub: 'second sign-off required' },
  hard:      { label: 'Hard Stage',    sub: 'remove licenses · groups' },
  provision: { label: 'Provisioning',  sub: 'create · enroll' },
  transfer:  { label: 'Transfer',      sub: 'update groups · licenses' },
  enroll:    { label: 'Enrollment',    sub: 'MFA · device registration' },
};

// Tool name → lifecycle stage key
const _TOOL_TO_LC_STAGE = {
  score_risk:           'risk',
  suggest_provisioning: 'plan',
  submit_leaver_soft:   'soft',
  submit_leaver_hard:   'hard',
  submit_joiner:        'provision',
  submit_enroller:      'enroll',
  submit_mover:         'transfer',
};

let _lcPipeline = ['request', 'risk', 'plan'];
let _lcDoneSet  = new Set();
let _lcCurrent  = null;
let _lcToolRan  = false;   // did any tool fire this turn? (request "captured" signal)
let _lcCapturing = false;  // request started but intent not yet fully captured
let _lcTerminalState = null;
let _lcTerminalError = null;
let _lcIdleTimer = null;   // relaxes a completed lifecycle back to Idle

function renderLifecycleMap() {
  const map = document.getElementById('lifecycle-map');
  if (!map) return;
  if (_lcPipeline.length === 0) {
    map.innerHTML = '<div class="lc-idle-hint">No active operation</div>';
    return;
  }
  map.innerHTML = _lcPipeline.map(key => {
    const meta    = _LC_META[key] || { label: key, sub: null };
    const isDone  = _lcDoneSet.has(key);
    const isCurr  = key === _lcCurrent;
    const isFailed = isCurr && _lcTerminalState === 'failed';
    const isPartial = isCurr && _lcTerminalState === 'partial';
    // The 'request' stage has an extra "capturing" sub-state: started but the agent
    // is still gathering required details (e.g. user only gave a name). It is neither
    // done nor a normal in-flight step — show it distinctly so operators know more
    // input is needed before the request is considered captured.
    const capturing = key === 'request' && isCurr && _lcCapturing && !isDone;
    const cls     = 'lc-state' + (isDone ? ' done' : isFailed ? ' current failed' : isPartial ? ' current partial' : capturing ? ' current capturing' : isCurr ? ' current' : '');
    const dot     = isDone ? '<span>✓</span>' : (isFailed || isPartial) ? '<span>!</span>' : capturing ? '<span>…</span>' : '';
    let sub = meta.sub;
    if (key === 'request') sub = isDone ? 'intent captured' : capturing ? 'gathering details…' : 'awaiting intent';
    if ((isFailed || isPartial) && _lcTerminalError) sub = _lcTerminalError;
    const subHtml = sub ? `<div class="lc-sub">${escHtml(sub)}</div>` : '';
    return `<div class="${cls}" data-stage="${key}">
      <div class="lc-dot">${dot}</div>
      <div class="lc-info"><div class="lc-label">${meta.label}</div>${subHtml}</div>
    </div>`;
  }).join('');
}

function lcResetToRequest() {
  clearTimeout(_lcIdleTimer);
  _lcPipeline = ['request', 'risk', 'plan'];
  _lcDoneSet  = new Set();
  _lcCurrent  = 'request';
  _lcToolRan  = false;
  _lcCapturing = true;   // a turn just started; intent not yet captured
  _lcTerminalState = null;
  _lcTerminalError = null;
  const tag = document.getElementById('lifecycle-status-tag');
  if (tag) { tag.textContent = 'Capturing'; tag.className = 'tag info'; }
  renderLifecycleMap();
}

function lcAdvanceTo(stageKey) {
  if (!_lcPipeline.includes(stageKey)) {
    // Insert after 'plan', or at the end
    const pi = _lcPipeline.indexOf('plan');
    pi >= 0 ? _lcPipeline.splice(pi + 1, 0, stageKey) : _lcPipeline.push(stageKey);
    // Also insert 'soft' before 'hard' if adding 'hard' without 'soft'
    if (stageKey === 'hard' && !_lcPipeline.includes('soft')) {
      const hi = _lcPipeline.indexOf('hard');
      _lcPipeline.splice(hi, 0, 'soft', 'approval');
    }
  }
  // A tool fired → the request is now fully captured and actionable
  _lcToolRan   = true;
  _lcCapturing = false;
  // Mark everything up to (not including) stageKey as done
  const idx = _lcPipeline.indexOf(stageKey);
  for (let i = 0; i < idx; i++) _lcDoneSet.add(_lcPipeline[i]);
  _lcCurrent = stageKey;
  _lcTerminalState = null;
  _lcTerminalError = null;
  const tag = document.getElementById('lifecycle-status-tag');
  if (tag) { tag.textContent = 'In Progress'; tag.className = 'tag info'; }
  renderLifecycleMap();
}

function lcMarkComplete() {
  // If the turn ended without any tool firing and we're still at 'request', the
  // agent only asked a follow-up — the request is NOT captured/complete yet.
  if (!_lcToolRan && _lcCurrent === 'request') {
    _lcCapturing = true;
    const tag = document.getElementById('lifecycle-status-tag');
    if (tag) { tag.textContent = 'Awaiting details'; tag.className = 'tag warn'; }
    renderLifecycleMap();
    return;
  }
  // Chat completion only ends the conversational turn. An operation-status
  // event is the authority for success, partial completion, or failure.
}

// One-line, human-readable failure summary for the lifecycle rail. The raw
// infrastructure error stays on the operation record — Glass Screen's details
// drawer and the audit trail carry the full text; the rail never does.
function lcSummarizeError(error) {
  if (!error) return null;
  const text = String(error);
  if (/certificate|ClientCertificateCredential/i.test(text)) return 'Graph certificate authentication failed';
  if (/auth|token|credential|401|403/i.test(text)) return 'Graph authentication failed';
  const line = text.split('\n').map(l => l.trim())
    .find(l => l && !/^Command failed:/i.test(l) && !/^At /.test(l) && !/^\+/.test(l))
    || text.split('\n')[0].trim();
  return line.length > 140 ? line.slice(0, 137) + '…' : line;
}

function lcApplyOperation(operation) {
  if (!operation || !operation.stage) return;
  lcAdvanceTo(operation.stage);
  const tag = document.getElementById('lifecycle-status-tag');
  if (operation.status === 'running') return;
  _lcCapturing = false;
  _lcTerminalState = operation.status;
  _lcTerminalError = lcSummarizeError(operation.error);
  if (operation.status === 'succeeded') {
    _lcDoneSet.add(operation.stage);
    _lcCurrent = null;
    if (tag) { tag.textContent = 'Succeeded'; tag.className = 'tag ok'; }
    // Don't let the rail sit at "Succeeded" forever — relax back to Idle so the
    // next visit shows a clean lifecycle, not a stale completed one.
    clearTimeout(_lcIdleTimer);
    _lcIdleTimer = setTimeout(lcSetIdle, 9000);
  } else if (operation.status === 'awaiting_approval') {
    if (tag) { tag.textContent = 'Awaiting approval'; tag.className = 'tag warn'; }
  } else if (operation.status === 'partial') {
    if (tag) { tag.textContent = 'Partial'; tag.className = 'tag warn'; }
  } else if (operation.status === 'failed') {
    if (tag) { tag.textContent = 'Failed'; tag.className = 'tag danger'; }
  }
  renderLifecycleMap();
}

function lcSetIdle() {
  clearTimeout(_lcIdleTimer);
  _lcPipeline = ['request', 'risk', 'plan'];
  _lcDoneSet  = new Set();
  _lcCurrent  = null;
  _lcToolRan  = false;
  _lcCapturing = false;
  _lcTerminalState = null;
  _lcTerminalError = null;
  const tag = document.getElementById('lifecycle-status-tag');
  if (tag) { tag.textContent = 'Idle'; tag.className = 'tag'; }
  renderLifecycleMap();
}

window.__jmlSetApproverInputLifecycle = lcSetIdle;

// Legacy shim — kept so any future callers don't break
function updateLifecycleState(stepLabel, state) {
  // Replaced by the new state machine above; no-op for legacy calls
}

window.__jmlSetApproverDemoLifecycle = function () {
  _lcPipeline  = ['request', 'risk', 'plan', 'soft', 'approval', 'hard'];
  _lcDoneSet   = new Set(['request', 'risk', 'plan', 'soft']);
  _lcCurrent   = 'approval';
  _lcToolRan   = true;
  _lcCapturing = false;
  const tag = document.getElementById('lifecycle-status-tag');
  if (tag) { tag.textContent = 'Awaiting dual approval'; tag.className = 'tag warn'; }
  renderLifecycleMap();
};

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
  el.className = 'message assistant thinking';
  el.dataset.agent = agent;
  const avatarSvg = AGENT_AVATARS[agent] || 'AI';
  const timeStr   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="message-avatar avatar-${agent}">${avatarSvg}</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="meta-agent">${AGENT_LABELS[agent] || agent}</span>
        <span class="meta-sep">·</span>
        <span class="meta-time">${timeStr}</span>
      </div>
      <div class="thinking-indicator">
        <span class="thinking-dots"><span></span><span></span><span></span></span>
        <span class="thinking-label">Thinking</span>
      </div>
      <div class="message-text"></div>
      <div class="tool-indicators"></div>
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
window.api.onChunk(({ agent: chunkAgent, type, text, toolName, success, result }) => {
  // Route by the agent tag on the chunk itself — a response streaming in for a
  // background agent must not land in whichever chat tab is currently open.
  const agent = chunkAgent || (currentTab === 'auditor' ? 'auditor' : 'approver');
  const msgEl = getOrCreateCurrentMsg(agent);
  const textEl = msgEl.querySelector('.message-text');
  const toolEl = msgEl.querySelector('.tool-indicators');
  const msgs   = msgEl.closest('.messages');

  if (type === 'text') {
    const thinkEl = msgEl.querySelector('.thinking-indicator');
    if (thinkEl) thinkEl.style.display = 'none';
    msgEl.classList.remove('thinking');
    textEl.dataset.raw = (textEl.dataset.raw || '') + text;
    // Throttle markdown re-renders via RAF to avoid layout thrash on every streamed token
    if (!textEl._renderPending) {
      textEl._renderPending = true;
      requestAnimationFrame(() => {
        textEl._renderPending = false;
        textEl.innerHTML = renderMarkdown(textEl.dataset.raw || '');
        textEl.classList.add('streaming');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      });
    }
  }

  if (type === 'tool_start') {
    // Advance lifecycle for approver; track tools for auditor query card
    if (agent === 'approver' && _TOOL_TO_LC_STAGE[toolName]) {
      lcAdvanceTo(_TOOL_TO_LC_STAGE[toolName]);
    }
    if (agent === 'auditor') audTrackTool(toolName, 'running');

    // Once a tool starts, its own spinner represents activity — hide the
    // generic thinking dots so only one "loading" animation runs at a time.
    const thinkEl = msgEl.querySelector('.thinking-indicator');
    if (thinkEl) thinkEl.style.display = 'none';
    msgEl.classList.remove('thinking');
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
    // Capture structured results for contextual card rendering
    if (toolName === 'score_risk' && success && result && !result.error) _lastRiskResult = result;
    if (agent === 'auditor') audTrackTool(toolName, 'done');
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
        // Attach expandable result drawer for successful non-error results
        if (success && result && !result.error) {
          const wrap = document.createElement('div');
          wrap.className = 'tool-indicator-wrap';
          ind.parentNode.insertBefore(wrap, ind);
          wrap.appendChild(ind);
          const drawer = document.createElement('div');
          drawer.className = 'tool-result-drawer';
          try {
            const pretty = JSON.stringify(typeof result === 'string' ? JSON.parse(result) : result, null, 2);
            drawer.innerHTML = '<pre>' + highlightJson(pretty) + '</pre>';
          } catch { drawer.textContent = String(result); }
          wrap.appendChild(drawer);
          const chev = document.createElement('span');
          chev.className = 'tool-expand-chev';
          chev.textContent = ' ›';
          ind.appendChild(chev);
          ind.classList.add('has-result');
          ind.addEventListener('click', () => {
            drawer.classList.toggle('open');
            chev.classList.toggle('rotated');
          });
        }
      }
    }
  }

  if (msgs) msgs.scrollTop = msgs.scrollHeight;
});

window.api.onComplete(({ agent }) => {
  setWaiting(agent, false);
  // Advance lifecycle / query state on completion
  if (agent === 'approver') lcMarkComplete();
  if (agent === 'auditor')  audQueryComplete(currentMsgEl[agent]);

  // Real-time security refresh: if remediation actions were routed from Security,
  // re-scan once per completed operation (counter survives rapid double-dispatch).
  if (agent === 'approver' && window._secRefreshAfterOp > 0) {
    window._secRefreshAfterOp--;
    setTimeout(() => window.api.getSecurityReports(), 4000);
  }
  const msgEl = currentMsgEl[agent];
  if (msgEl) {
    const thinkEl = msgEl.querySelector('.thinking-indicator');
    if (thinkEl) thinkEl.style.display = 'none';
    msgEl.classList.remove('thinking');
    const textEl2 = msgEl.querySelector('.message-text');
    if (textEl2) { textEl2.classList.remove('streaming'); textEl2._renderPending = false; }
    // Collapse tool steps: if 2+ indicators ran, fold them into a summary bar
    const toolEl2 = msgEl.querySelector('.tool-indicators');
    if (toolEl2 && toolEl2.children.length >= 2) {
      const allChildren = Array.from(toolEl2.children);
      const failCount = toolEl2.querySelectorAll('.tool-indicator.failed').length;
      const labels = Array.from(toolEl2.querySelectorAll('.tool-label'))
        .map(l => l.textContent.trim()).filter(Boolean);
      const nameStr = labels.length <= 3 ? labels.join(' · ')
        : labels.slice(0, 2).join(' · ') + ' · +' + (labels.length - 2) + ' more';
      const countWord = allChildren.length === 1 ? '1 step' : allChildren.length + ' steps';
      const summary = document.createElement('div');
      summary.className = 'tool-steps-summary';
      summary.innerHTML = (failCount > 0
        ? '<span class="ts-icon ts-fail">!</span>'
        : '<span class="ts-icon ts-ok">✓</span>')
        + `<span class="ts-count">${escHtml(countWord)}</span>`
        + `<span class="ts-names"> · ${escHtml(nameStr)}</span>`
        + '<span class="ts-chev"> ›</span>';
      const detail = document.createElement('div');
      detail.className = 'tool-steps-detail';
      allChildren.forEach(c => detail.appendChild(c));
      toolEl2.appendChild(summary);
      toolEl2.appendChild(detail);
      summary.addEventListener('click', () => {
        detail.classList.toggle('open');
        summary.classList.toggle('expanded');
      });
    }
    // Auditor: if the response contains findings, surface quick-nav action chips
    if (agent === 'auditor') {
      const textEl = msgEl.querySelector('.message-text');
      const txt = textEl ? (textEl.textContent || '') : '';
      const findingKeywords = ['risk', 'finding', 'violation', 'anomaly', 'flag', 'alert', 'concern', 'critical', 'warning', 'suspicious', 'unusual', 'gap', 'exposure'];
      const hasFinding = findingKeywords.some(kw => txt.toLowerCase().includes(kw));
      if (hasFinding && textEl) {
        const chips = [
          { label: '→ Security', tab: 'security' },
          { label: '→ Operations', tab: 'operations' },
          { label: '→ Audit Log', tab: 'audit-log' },
        ];
        const wrap = document.createElement('div');
        wrap.className = 'auditor-finding-actions';
        chips.forEach(({ label, tab }) => {
          const btn = document.createElement('button');
          btn.className = 'auditor-action-chip';
          btn.textContent = label;
          btn.addEventListener('click', () => switchTab(tab));
          wrap.appendChild(btn);
        });
        textEl.appendChild(wrap);
      }
    }
    // Approver: inline confirm buttons + copyable token chips
    if (agent === 'approver') {
      const textEl = msgEl.querySelector('.message-text');
      if (textEl) {
        const raw = (textEl.dataset.raw || textEl.textContent || '');

        // Fix 3: detect confirmation prompts and inject Proceed/Cancel buttons
        if (/confirm to continue\??|shall i proceed\??|want me to proceed\??|go ahead\?/i.test(raw)
            && !textEl.querySelector('.inline-confirm')) {
          const div = document.createElement('div');
          div.className = 'inline-confirm';
          const proceed = document.createElement('button');
          proceed.className = 'btn primary sm';
          proceed.textContent = 'Proceed';
          const cancel = document.createElement('button');
          cancel.className = 'btn ghost sm';
          cancel.textContent = 'Cancel';
          proceed.addEventListener('click', () => {
            div.remove();
            window.api.sendMessage('approver', 'Confirmed. Go ahead.');
          });
          cancel.addEventListener('click', () => {
            div.remove();
            window.api.sendMessage('approver', 'Cancel — do not proceed.');
          });
          div.appendChild(proceed);
          div.appendChild(cancel);
          textEl.appendChild(div);
        }

        // Fix 4: make dual-approval tokens copyable.
        // Guard: the text node immediately before the <strong> must contain "Token"
        // so we don't accidentally mark bold role names (**READ**, **ADMIN**, etc.)
        // in paragraphs that happen to mention "token" elsewhere.
        textEl.querySelectorAll('strong').forEach(strong => {
          const val     = strong.textContent.trim();
          if (!/^[A-Z0-9]{4,8}$/.test(val)) return;
          const prev    = strong.previousSibling;
          const prevTxt = prev && prev.nodeType === Node.TEXT_NODE ? prev.textContent : '';
          if (!/\btoken\b\s*$/i.test(prevTxt)) return;
          strong.classList.add('token-chip');
          strong.title = 'Click to copy token';
          strong.addEventListener('click', () => {
            navigator.clipboard.writeText(val).then(() => {
              const orig = strong.textContent;
              strong.textContent = 'Copied!';
              setTimeout(() => { strong.textContent = orig; }, 1200);
            });
          });
        });
      }
    }

    currentMsgEl[agent] = null;
  }
});

window.api.onError(({ agent: errAgent, text }) => {
  (errAgent ? [errAgent] : ['approver', 'auditor']).forEach(agent => {
    if (isWaiting[agent]) {
      setWaiting(agent, false);
      const msgEl = currentMsgEl[agent];
      if (msgEl) {
        const thinkElE = msgEl.querySelector('.thinking-indicator');
        if (thinkElE) thinkElE.style.display = 'none';
        msgEl.classList.remove('thinking');
        const textEl = msgEl.querySelector('.message-text');
        textEl.classList.remove('streaming');
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
  const stopBtn = document.getElementById('stop-' + agent);
  if (stopBtn) stopBtn.classList.toggle('hidden', !waiting);
}

// ── Cross-window conversation mirror ─────────────────────────────────────────
// When the overlay or docked panel sends a message, mirror it into the main
// console's conversation so both views stay in sync.
if (typeof window.api.onMsgMirror === 'function') {
  window.api.onMsgMirror(({ agent, role, text }) => {
    if (!text) return;
    const validAgent = agent === 'auditor' ? 'auditor' : 'approver';
    if (role === 'user') {
      appendUserMessage(validAgent, text);
      appendAssistantPlaceholder(validAgent); // show thinking indicator
    } else if (role === 'assistant') {
      // Find the most recent thinking placeholder and fill it
      const msgs = document.getElementById('messages-' + validAgent);
      if (!msgs) return;
      let placeholder = msgs.querySelector('.message.assistant.thinking:last-of-type');
      if (!placeholder) { placeholder = appendAssistantPlaceholder(validAgent); }
      placeholder.classList.remove('thinking');
      const thinkEl = placeholder.querySelector('.thinking-indicator');
      if (thinkEl) thinkEl.style.display = 'none';
      const textEl = placeholder.querySelector('.message-text');
      if (textEl) { textEl.innerHTML = renderMarkdown(text); textEl.classList.remove('streaming'); }
      msgs.scrollTop = msgs.scrollHeight;
    }
  });
}

// ── Security dashboard ────────────────────────────────────────────────────────
// Visual cue while a security re-scan is in flight — every scan tile pulses
// until onSecurityReports fires; the Re-scan button shows "Scanning…".
function setSecurityScanning(on) {
  ['sec-ueba', 'sec-drift', 'sec-risky'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('scanning', on);
  });
  const btn = document.getElementById('refresh-security');
  if (btn) { btn.disabled = on; btn.textContent = on ? 'Scanning…' : 'Re-scan'; }
}
document.getElementById('refresh-security').addEventListener('click', () => {
  setSecurityScanning(true);
  loadSecurity();
  // Safety: clear scanning state after 30s even if no response
  setTimeout(() => setSecurityScanning(false), 30000);
});

// Drift remediation card actions
(function () {
  const card    = document.getElementById('drift-rem-card');
  const btnIgn  = document.getElementById('btn-drift-ignore');
  const btnRest = document.getElementById('btn-drift-restore');
  if (btnIgn)  btnIgn.addEventListener('click',  () => { if (card) card.style.display = 'none'; });
  if (btnRest) btnRest.addEventListener('click', () => {
    addNotification('🔒', 'Restore baseline queued — awaiting dual approval from a second operator');
  });
})();

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

// ── V2 Security Inbox ──────────────────────────────────────────────────────
let _secFindings = []; // flat array of all findings
let _secFocused = null; // currently focused finding index
let _secAckedKeys     = new Set();  // stable keys (rule|title) of acknowledged findings — survives rescans
let _secAckedFindings = [];         // ordered list of acked finding objects for the acked section
let _secDeletedKeys   = new Set();  // stable keys of admin-deleted findings — permanently hidden from inbox
let _secCheckedSet    = new Set();  // original indices of checkbox-selected findings
let _secFilter = { sev: '', source: '', assign: 'unassigned', maxAge: 0 }; // active inbox filter state

/** Stable identity key for a finding — survives index changes across rescans */
function _secKey(f) { return (f.rule || '') + '|' + (f.title || ''); }

/** Extract the primary subject UPN/name from a finding for cross-tab navigation */
function _secFindingSubject(f) {
  if (!f) return null;
  for (const key of ['subjects', 'user', 'affected']) {
    const row = (f.signals || []).find(([k]) => k === key);
    if (row && row[1] && row[1] !== '—') return row[1].split(',')[0].trim();
  }
  if (f.driftItems && f.driftItems.length > 0)
    return f.driftItems[0].userPrincipalName || f.driftItems[0].displayName || null;
  return null;
}

/** Show a compact floating dropdown anchored to a button element */
function _showSecDropdown(anchorBtn, options, onSelect) {
  document.getElementById('_sec-dd')?.remove();
  const r = anchorBtn.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.id = '_sec-dd';
  Object.assign(panel.style, {
    position: 'fixed', top: (r.bottom + 4) + 'px', left: r.left + 'px',
    background: 'var(--surface-2,#181818)', border: '1px solid var(--border,#333)',
    borderRadius: '6px', padding: '4px', zIndex: '9999',
    minWidth: Math.max(r.width, 150) + 'px',
    boxShadow: '0 8px 24px rgba(0,0,0,.55)',
  });
  options.forEach(({ label, value, active }) => {
    const item = document.createElement('button');
    Object.assign(item.style, {
      display: 'block', width: '100%', textAlign: 'left',
      padding: '6px 10px', background: active ? 'var(--surface-3,#242424)' : 'none',
      border: 'none', color: 'var(--text-1)', fontSize: '12px',
      cursor: 'pointer', borderRadius: '4px', transition: 'background .1s',
    });
    item.textContent = label;
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface-3,#242424)'; });
    item.addEventListener('mouseleave', () => { item.style.background = active ? 'var(--surface-3,#242424)' : 'none'; });
    item.addEventListener('click', e => { e.stopPropagation(); panel.remove(); onSelect(value, label); });
    panel.appendChild(item);
  });
  document.body.appendChild(panel);
  setTimeout(() => document.addEventListener('click', function _c() {
    panel.remove(); document.removeEventListener('click', _c);
  }), 0);
}

/** Sync the bulk-action bar (count badge + button visibility) */
function _updateBulkBar() {
  const n = _secCheckedSet.size;
  const show = n > 0;
  const countEl = document.getElementById('sec-selection-count');
  if (countEl) { countEl.textContent = n + ' selected'; countEl.style.display = show ? '' : 'none'; }
  ['sec-btn-assign', 'sec-btn-ack', 'sec-btn-page'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  });
}

/** Render inbox rows respecting the current filter + acked state */
function _renderSecRows() {
  const inbox = document.getElementById('sec-inbox');
  const empty = document.getElementById('sec-inbox-empty');
  if (!inbox) return;

  const visible = [];
  _secFindings.forEach((f, origIdx) => {
    if (_secAckedKeys.has(_secKey(f)) || _secDeletedKeys.has(_secKey(f))) return; // hide acked / deleted findings
    if (_secFilter.sev && f.sev !== _secFilter.sev) return;
    if (_secFilter.source) {
      if (!f.rule.toLowerCase().startsWith(_secFilter.source.toLowerCase())) return;
    }
    if (_secFilter.assign === 'unassigned' && f.assignee !== '—') return;
    if (_secFilter.assign === 'assigned'   && f.assignee === '—') return;
    if (_secFilter.maxAge > 0 && f.age !== '—') {
      const ageDays = parseInt(f.age) || 0;
      if (ageDays > _secFilter.maxAge) return;
    }
    visible.push({ f, origIdx });
  });

  inbox.innerHTML = '';
  if (empty) inbox.appendChild(empty);

  if (visible.length === 0) {
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  _secCheckedSet.clear();
  _updateBulkBar();

  visible.forEach(({ f, origIdx }, rowPos) => {
    const row = document.createElement('div');
    row.className = 'sec-finding-row' + (rowPos === 0 ? (f.sev === 'crit' ? ' focused' : ' focused-warn') : '');
    row.dataset.idx = origIdx;
    row.innerHTML =
        '<input type="checkbox" style="accent-color:var(--violet)">'
      + '<div class="sec-finding-sev-bar ' + f.sev + '"></div>'
      + '<div class="sec-finding-content">'
        + '<div class="sec-finding-rule-row">'
          + '<span class="tag ' + f.sev + '">' + f.sev.toUpperCase() + '</span>'
          + '<span class="mono" style="font-size:10.5px;color:var(--text-3);letter-spacing:.05em">' + escHtml(f.rule) + '</span>'
        + '</div>'
        + '<div class="sec-finding-title">' + escHtml(f.title) + '</div>'
        + '<div class="sec-finding-sub">' + escHtml(f.sub) + '</div>'
      + '</div>'
      + '<div class="sec-finding-assignee">' + (f.assignee === '—' ? 'unassigned' : escHtml(f.assignee)) + '</div>'
      + '<div class="sec-finding-age">' + f.age + '</div>'
      + (rowPos === 0 ? '<span style="color:var(--text-3)">›</span>' : '<span></span>');

    const cb = row.querySelector('input[type=checkbox]');
    cb.addEventListener('change', () => {
      if (cb.checked) _secCheckedSet.add(origIdx); else _secCheckedSet.delete(origIdx);
      _updateBulkBar();
    });

    row.addEventListener('click', e => {
      if (e.target === cb) return;
      document.querySelectorAll('.sec-finding-row').forEach(r => r.classList.remove('focused', 'focused-warn'));
      row.classList.add(f.sev === 'crit' ? 'focused' : 'focused-warn');
      inbox.querySelectorAll('.sec-finding-row > span:last-child').forEach(s => { s.textContent = ''; });
      row.querySelector('span:last-child').textContent = '›';
      focusFinding(origIdx);
    });

    inbox.appendChild(row);
  });

  focusFinding(visible[0].origIdx);
}

/** Render (or update) the Acknowledged section below the active inbox */
function _renderAckedSection() {
  const inbox = document.getElementById('sec-inbox');
  if (!inbox) return;

  // Remove any existing section before re-rendering
  let section = document.getElementById('sec-acked-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'sec-acked-section';
    inbox.appendChild(section);
  }

  if (_secAckedFindings.length === 0) {
    section.innerHTML = '';
    return;
  }

  const isAdmin = currentOperatorRole() === 'admin';
  const timeFmt = d => d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  section.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px 6px;border-top:1px solid var(--border);margin-top:4px">'
    + '<span style="font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase">Acknowledged</span>'
    + '<span style="font-size:11px;font-family:var(--mono);color:var(--text-4)">' + _secAckedFindings.length + '</span>'
    + '<span style="flex:1"></span>'
    + (isAdmin
        ? '<button class="btn sm danger" id="sec-acked-wipe" style="font-size:11px">Delete all</button>'
        : '<span style="font-size:10.5px;color:var(--text-4);font-style:italic">Admin required to delete</span>')
    + '</div>'
    + _secAckedFindings.map((f, i) =>
        '<div class="sec-finding-row" style="opacity:.45;pointer-events:none" data-acked-idx="' + i + '">'
        + '<div class="sec-finding-sev-bar ' + f.sev + '" style="opacity:.5"></div>'
        + '<div class="sec-finding-content">'
          + '<div class="sec-finding-rule-row">'
            + '<span class="tag ' + f.sev + '" style="opacity:.6">' + f.sev.toUpperCase() + '</span>'
            + '<span class="mono" style="font-size:10.5px;color:var(--text-4)">' + escHtml(f.rule) + '</span>'
          + '</div>'
          + '<div class="sec-finding-title" style="color:var(--text-3)">' + escHtml(f.title) + '</div>'
          + '<div class="sec-finding-sub">' + escHtml(f.sub) + '</div>'
        + '</div>'
        + '<div class="sec-finding-age" style="color:var(--text-4)">'
            + (f.ackedAt ? timeFmt(f.ackedAt) : '') + '</div>'
        + (isAdmin
            ? '<button class="btn sm danger sec-acked-delete" data-acked-idx="' + i + '" style="pointer-events:all;font-size:11px">Delete</button>'
            : '<span></span>')
        + '</div>'
      ).join('');

  // Wire admin delete buttons
  if (isAdmin) {
    section.querySelector('#sec-acked-wipe')?.addEventListener('click', () => {
      confirmModal({
        title: 'Delete all acknowledged findings',
        body: 'Permanently wipe ' + _secAckedFindings.length + ' acknowledged finding' + (_secAckedFindings.length > 1 ? 's' : '') + ' from this session? This cannot be undone.',
        danger: true,
        okLabel: 'Delete all',
      }).then(ok => {
        if (!ok) return;
        _secAckedFindings.forEach(f => _secDeletedKeys.add(_secKey(f)));
        _secAckedKeys.clear();
        _secAckedFindings = [];
        const ackedEl = document.getElementById('sec-count-acked');
        if (ackedEl) ackedEl.textContent = '0';
        _renderAckedSection();
        _renderSecRows();
        showToast('All acknowledged findings deleted');
      }).catch(() => {});
    });

    section.querySelectorAll('.sec-acked-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.ackedIdx);
        const f = _secAckedFindings[idx];
        if (!f) return;
        _secDeletedKeys.add(_secKey(f));
        _secAckedKeys.delete(_secKey(f));
        _secAckedFindings.splice(idx, 1);
        const ackedEl = document.getElementById('sec-count-acked');
        if (ackedEl) ackedEl.textContent = String(_secAckedFindings.length);
        _renderAckedSection();
        _renderSecRows();
        showToast('Finding deleted from acknowledged list');
      });
    });
  }
}

function renderSecurityInbox(data) {
  const inbox = document.getElementById('sec-inbox');
  const empty = document.getElementById('sec-inbox-empty');
  if (!inbox) return;

  // Flatten all findings from UEBA, drift, risky users
  _secFindings = [];

  if (data.ueba && data.ueba.findings) {
    data.ueba.findings.forEach(f => {
      const subjects = (f.events || []).map(e => e.subject || e.user || '').filter(Boolean);
      const latest = (f.events || []).map(e => e.timestamp).filter(Boolean).sort().pop();
      _secFindings.push({
        sev: f.severity === 'critical' ? 'crit' : f.severity === 'warning' ? 'warn' : 'info',
        rule: 'UEBA · ' + (f.ruleId || ''),
        title: f.title,
        sub: subjects.slice(0, 2).join(', ') + (latest ? ' · ' + new Date(latest).toLocaleDateString() : ''),
        assignee: '—',
        age: latest ? Math.max(0, Math.floor((Date.now() - new Date(latest)) / 86400000)) + 'd' : '—',
        rawSev: f.severity,
        signals: [
          ['rule', f.ruleId || '—'],
          ['events', (f.events || []).length],
          ['subjects', subjects.join(', ') || '—'],
        ],
      });
    });
  }

  if (data.drift && data.drift.findings) {
    data.drift.findings.forEach(f => {
      const items = (f.items || []);
      const names = items.map(i => i.displayName || i.userPrincipalName || i.agent || '').filter(Boolean);
      _secFindings.push({
        sev: f.severity === 'critical' ? 'crit' : f.severity === 'warning' ? 'warn' : 'info',
        rule: 'Drift · ' + (f.checkId || ''),
        title: f.title,
        sub: names.slice(0, 2).join(', '),
        assignee: '—',
        age: '—',
        rawSev: f.severity,
        isDrift: true,
        driftItems: items,
        signals: [
          ['check', f.checkId || '—'],
          ['items', items.length],
          ['affected', names.join(', ') || '—'],
        ],
      });
    });
  }

  if (data.riskyUsers && data.riskyUsers.users) {
    data.riskyUsers.users.forEach(u => {
      _secFindings.push({
        sev: u.riskLevel === 'high' ? 'crit' : u.riskLevel === 'medium' ? 'warn' : 'info',
        rule: 'Identity Protection',
        title: 'Risky sign-in: ' + (u.riskDetail || 'see details'),
        sub: (u.userPrincipalName || u.displayName || '—'),
        assignee: '—',
        age: u.riskLastUpdatedDateTime ? Math.max(0, Math.floor((Date.now() - new Date(u.riskLastUpdatedDateTime)) / 86400000)) + 'd' : '—',
        rawSev: u.riskLevel || 'medium',
        signals: [
          ['user', u.userPrincipalName || '—'],
          ['level', u.riskLevel || '—'],
          ['detail', u.riskDetail || '—'],
          ['state', u.riskState || '—'],
        ],
      });
    });
  }

  // Sort: crit first, then warn, then info
  const sevOrder = { crit: 0, warn: 1, info: 2 };
  _secFindings.sort((a, b) => (sevOrder[a.sev] ?? 3) - (sevOrder[b.sev] ?? 3));

  // Update ribbon counts
  const critEl = document.getElementById('sec-count-crit');
  const warnEl = document.getElementById('sec-count-warn');
  const infoEl = document.getElementById('sec-count-info');
  const ackedEl = document.getElementById('sec-count-acked');
  if (critEl) critEl.textContent = _secFindings.filter(f => f.sev === 'crit').length;
  if (warnEl) warnEl.textContent = _secFindings.filter(f => f.sev === 'warn').length;
  if (infoEl) infoEl.textContent = _secFindings.filter(f => f.sev === 'info').length;
  if (ackedEl) ackedEl.textContent = String(_secAckedFindings.length);

  // Reset active-inbox filter state (but NOT acked state — it persists across rescans)
  _secFilter = { sev: '', source: '', assign: 'unassigned', maxAge: 0 };
  const sevBtn    = document.getElementById('sec-filter-sev');
  const srcBtn    = document.getElementById('sec-filter-source');
  const assignBtn = document.getElementById('sec-filter-assign');
  const timeBtn   = document.getElementById('sec-filter-time');
  if (sevBtn)    { sevBtn.textContent = 'All severities ▾'; sevBtn.classList.remove('active'); }
  if (srcBtn)    { srcBtn.textContent = 'All sources ▾';    srcBtn.classList.remove('active'); }
  if (assignBtn) { assignBtn.textContent = 'Unassigned ▾';  assignBtn.classList.remove('active'); }
  if (timeBtn)   { timeBtn.textContent = 'All time ▾';      timeBtn.classList.remove('active'); }

  if (_secFindings.length === 0) {
    if (empty) empty.style.display = 'flex';
    _renderAckedSection();
    return;
  }
  if (empty) empty.style.display = 'none';

  _renderSecRows();
  _renderAckedSection();
}

function focusFinding(idx) {
  _secFocused = idx;
  const f = _secFindings[idx];
  if (!f) return;
  const fc = document.getElementById('sec-focused-card');
  if (!fc) return;
  fc.style.display = 'block';

  const tagEl = document.getElementById('sec-focused-tag');
  const titleEl = document.getElementById('sec-focused-title');
  const ruleEl = document.getElementById('sec-focused-rule');
  const descEl = document.getElementById('sec-focused-desc');
  const signalsEl = document.getElementById('sec-signals');

  if (tagEl) { tagEl.className = 'tag ' + f.sev; tagEl.textContent = 'FOCUSED · ' + f.sev.toUpperCase(); }
  if (titleEl) titleEl.textContent = f.title;
  if (ruleEl) ruleEl.textContent = f.rule;
  if (descEl) descEl.textContent = '';

  // Update pivot button hash label — show a compact rule/check identifier
  const pivotHashEl = document.getElementById('sec-pivot-audit-hash');
  if (pivotHashEl) {
    const parts = (f.rule || '').split(' · ');
    pivotHashEl.textContent = parts.length > 1 ? parts.slice(1).join('·').slice(0, 14) : (parts[0] || '—').slice(0, 14);
  }

  if (signalsEl) {
    signalsEl.innerHTML = (f.signals || []).map(([k, v]) =>
      '<div class="sec-signal-row"><span class="sec-signal-key">' + escHtml(String(k)) + '</span><span class="sec-signal-val">' + escHtml(String(v)) + '</span></div>'
    ).join('');
  }

  _updateRemButtonAccess();
  // Inline remediation — show per-finding-type quick actions that route to Approver
  const remLabel   = document.getElementById('sec-rem-label');
  const remBtns    = document.getElementById('sec-rem-btns');
  const remDisable = document.getElementById('sec-rem-disable');
  const remRevoke  = document.getElementById('sec-rem-revoke');
  const remMfa     = document.getElementById('sec-rem-mfa');
  const remGroups  = document.getElementById('sec-rem-groups');

  if (remBtns) {
    const ruleStr  = (f.rule || '').toLowerCase();
    const titleStr = (f.title || '').toLowerCase();
    const combo    = ruleStr + ' ' + titleStr;
    // Extract subject UPN from signals for pre-filling the Approver prompt
    const subSig   = (f.signals || []).find(([k]) => /subject|user|upn/i.test(k));
    remBtns.dataset.subject = subSig ? String(subSig[1]) : (f.subject || '');

    const showDisable = /after.hours|risky|suspicious|compromised|anomaly|pattern/i.test(combo);
    const showRevoke  = /after.hours|risky|compromised|session/i.test(combo);
    const showMfa     = /risky|compromised|identity.protect/i.test(combo);
    const showGroups  = /group.*still|still.*group|disabled.*group|stale.*group|active.*license/i.test(combo);
    const any = showDisable || showRevoke || showMfa || showGroups;

    if (remLabel) remLabel.style.display = any ? '' : 'none';
    remBtns.style.display = any ? 'flex' : 'none';
    if (remDisable) remDisable.style.display = showDisable ? '' : 'none';
    if (remRevoke)  remRevoke.style.display  = showRevoke  ? '' : 'none';
    if (remMfa)     remMfa.style.display     = showMfa     ? '' : 'none';
    if (remGroups)  remGroups.style.display  = showGroups  ? '' : 'none';
  }

  // Show drift remediation card if this is a drift finding
  const driftCard = document.getElementById('sec-drift-rem-v2');
  if (driftCard) {
    if (f.isDrift && f.driftItems && f.driftItems.length > 0) {
      driftCard.style.display = 'block';
      const sub = document.getElementById('sec-drift-rem-subject');
      const desc = document.getElementById('sec-drift-rem-desc');
      const diff = document.getElementById('sec-drift-rem-diff');
      if (sub) sub.textContent = f.driftItems[0].displayName || f.driftItems[0].agent || '—';
      if (desc && f.driftItems[0].note) desc.textContent = f.driftItems[0].note;
      if (diff) {
        const item = f.driftItems[0];
        diff.innerHTML = item.expected
          ? '<div class="diff-row keep"><span class="sym"> </span><span>' + escHtml(item.expected) + ' (expected)</span></div>'
            + '<div class="diff-row rem"><span class="sym">−</span><span>' + escHtml(item.actual || '?') + ' (actual)</span></div>'
          : '<div class="diff-row rem"><span class="sym">−</span><span>' + escHtml(f.title) + '</span></div>';
      }
    } else {
      driftCard.style.display = 'none';
    }
  }
}

window.api.onSecurityReports((data) => {
  // Re-scan visual cue: data arrived → clear the pulsing state
  setSecurityScanning(false);

  // Reflect real security counts in dashboard triage card
  const critCard = document.querySelector('.v2-triage-card.crit');
  if (critCard) {
    let critCount = 0, warnCount = 0;
    if (data.ueba && data.ueba.findings) {
      critCount += data.ueba.findings.filter(f => f.severity === 'critical').length;
      warnCount += data.ueba.findings.filter(f => f.severity === 'warning').length;
    }
    if (data.drift && data.drift.findings) {
      critCount += data.drift.findings.filter(f => f.severity === 'critical').length;
      warnCount += data.drift.findings.filter(f => f.severity === 'warning').length;
    }
    if (data.riskyUsers && data.riskyUsers.users) {
      critCount += data.riskyUsers.users.filter(r => r.riskLevel === 'high').length;
    }
    const labelEl = critCard.querySelector('.label');
    const titleEl = critCard.querySelector('.title');
    const metaEl  = critCard.querySelector('.meta');
    if (labelEl) labelEl.textContent = critCount > 0
      ? `Security · ${critCount} critical`
      : warnCount > 0 ? `Security · ${warnCount} warning` : 'Security · all clear';
    // Keep title and label consistent — never leave a stale "findings" title when
    // counts are zero, nor a "no findings" title when there are real findings.
    if (titleEl) titleEl.textContent =
      critCount > 0 ? `${critCount} critical finding${critCount !== 1 ? 's' : ''} need review`
      : warnCount > 0 ? `${warnCount} warning${warnCount !== 1 ? 's' : ''} to review`
      : 'No security findings yet';
    if (metaEl) metaEl.textContent = '';
  }

  // Sections stay collapsed by default — user clicks a scan card to open one
  // Update summary strip tiles (scan-trio)
  function updateTile(id, report) {
    const countsEl = document.getElementById('sec-' + id + '-counts');
    const metaEl   = document.getElementById('sec-' + id + '-meta');
    const runEl    = document.getElementById('sec-' + id + '-run');
    const badgeEl  = document.getElementById('sec-' + id + '-badge');
    const s = (report && report.summary) || {};
    const cr = s.critical || 0;
    const wn = s.warning || 0;
    const inf = s.info || 0;
    // If the counts element is the new scan-trio .nums layout, fill the three slots;
    // otherwise fall back to badge chips.
    if (countsEl) {
      if (countsEl.classList.contains('nums')) {
        countsEl.innerHTML = `
          <div class="n cr"><b>${cr}</b><span>critical</span></div>
          <div class="n wn"><b>${wn}</b><span>warning</span></div>
          <div class="n in"><b>${inf}</b><span>info</span></div>`;
      } else if (!report) {
        countsEl.innerHTML = '<span class="scanner-no-report">No report</span>';
      } else {
        countsEl.innerHTML = buildCountBadges(cr, wn, inf);
      }
    }
    const ts = report && report.timestamp ? new Date(report.timestamp).toLocaleString() : '';
    if (metaEl) metaEl.textContent = ts ? 'Last run: ' + ts : 'No report';
    if (runEl)  runEl.textContent  = ts ? 'last run ' + ts : '';
    const total = cr + wn + inf;
    if (badgeEl) {
      badgeEl.textContent = total ? total + ' finding' + (total !== 1 ? 's' : '') : 'All clear';
      badgeEl.className = 'sec-section-badge ' + (cr ? 'badge-critical' : wn ? 'badge-warning' : 'badge-clear');
    }
  }
  // Sidebar security badge — sum of all critical findings
  const totalCrit = ((data.ueba?.summary?.critical) || 0) +
                    ((data.drift?.summary?.critical) || 0) +
                    ((data.riskyUsers?.summary?.critical) || 0);
  const totalWarn = ((data.ueba?.summary?.warning) || 0) +
                    ((data.drift?.summary?.warning) || 0);
  _dashState.secCrit = totalCrit;
  _dashState.secWarn = totalWarn;
  buildDashSummary();
  const secNav = document.getElementById('nav-security-count');
  if (secNav) {
    secNav.textContent = totalCrit;
    secNav.classList.toggle('empty', totalCrit === 0);
    secNav.classList.toggle('warn', totalCrit > 0);
  }

  updateTile('ueba',  data.ueba);
  updateTile('drift', data.drift);
  updateTile('risky', data.riskyUsers);

  // Update collapse <summary> preview chips
  function updateSummaryPreview(key, report) {
    const el = document.getElementById('sec-' + key + '-summary-preview');
    if (!el) return;
    if (!report) { el.textContent = ''; el.className = 'collapse-summary-preview'; return; }
    const s = report.summary || {};
    const cr = s.critical || 0, wn = s.warning || 0, inf = s.info || 0;
    const total = cr + wn + inf;
    if (!total) { el.textContent = 'All clear'; el.className = 'collapse-summary-preview all-clear'; return; }
    const parts = [];
    if (cr) parts.push(cr + ' critical');
    if (wn) parts.push(wn + ' warning');
    if (inf) parts.push(inf + ' info');
    el.textContent = parts.join(' · ');
    el.className = 'collapse-summary-preview ' + (cr ? 'has-crit' : wn ? 'has-warn' : '');
  }
  updateSummaryPreview('ueba',  data.ueba);
  updateSummaryPreview('drift', data.drift);
  updateSummaryPreview('risky', data.riskyUsers);

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
            + (agents.length ? '<span class="sec-agent-tag">via ' + agents.map(a => agentScopeTip(a, a)).join(', ') + '</span>' : '')
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

  // V2 inbox render
  renderSecurityInbox(data);
});

// ── V2 security inbox action buttons ─────────────────────────────────────────
document.getElementById('sec-action-ack')?.addEventListener('click', () => {
  if (_secFocused === null || !_secFindings[_secFocused]) return;
  const f = _secFindings[_secFocused];
  const key = _secKey(f);
  if (!_secAckedKeys.has(key)) {
    _secAckedKeys.add(key);
    _secAckedFindings.push({ ...f, ackedAt: new Date() });
  }
  const ackedEl = document.getElementById('sec-count-acked');
  if (ackedEl) ackedEl.textContent = String(_secAckedFindings.length);
  showToast('Finding acknowledged');
  _renderSecRows();
  _renderAckedSection();
});

document.getElementById('sec-action-page')?.addEventListener('click', () => {
  showToast('On-call paged via Teams (#identity-ops)');
});

document.getElementById('sec-drift-restore-v2')?.addEventListener('click', () => {
  if (typeof window.api?.runDriftRemediation === 'function') {
    window.api.runDriftRemediation();
  } else {
    showToast('Restore baseline: submitting for dual approval…');
  }
});

// ── Security inline remediation buttons ──────────────────────────────────────
// Only admin/helpdesk can take remediation actions; viewers see buttons disabled.
function _updateRemButtonAccess() {
  const canWrite = ['admin','helpdesk'].includes(currentOperatorRole());
  ['sec-rem-disable','sec-rem-revoke','sec-rem-mfa','sec-rem-groups'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !canWrite;
    btn.title    = canWrite ? '' : 'Requires admin or helpdesk role';
    btn.style.opacity = canWrite ? '' : '0.45';
  });
}

function _secRemRoute(promptTemplate) {
  if (!['admin','helpdesk'].includes(currentOperatorRole())) {
    showToast('Remediation requires admin or helpdesk role', 'error');
    return;
  }
  const subject = document.getElementById('sec-rem-btns')?.dataset.subject || '';
  const msg     = subject
    ? promptTemplate.replace('{subject}', subject)
    : promptTemplate.replace(' {subject}', '').replace('{subject}', 'this user');
  switchTab('approver');
  // Schedule a security re-scan after the approver finishes — finding should resolve
  window._secRefreshAfterOp = (window._secRefreshAfterOp || 0) + 1;
  setTimeout(() => {
    const inp = document.getElementById('chat-input-approver');
    if (inp) { inp.value = msg; inp.focus(); }
  }, 350);
}
document.getElementById('sec-rem-disable')?.addEventListener('click', () =>
  _secRemRoute('Disable account for {subject} immediately — security finding requires urgent action'));
document.getElementById('sec-rem-revoke')?.addEventListener('click', () =>
  _secRemRoute('Revoke all active sessions for {subject} — security finding'));
document.getElementById('sec-rem-mfa')?.addEventListener('click', () =>
  _secRemRoute('Force MFA re-registration for {subject} — identity protection alert'));
document.getElementById('sec-rem-groups')?.addEventListener('click', () =>
  _secRemRoute('Remove {subject} from all active group memberships — account is disabled and should not retain access'));

// ── Security pivot buttons ────────────────────────────────────────────────────
// "Open audit entry" → jump to Audit Log and pre-filter by subject
document.getElementById('sec-pivot-audit')?.addEventListener('click', () => {
  const f = _secFindings[_secFocused];
  if (!f) return;
  switchTab('audit-log');
  const subject = _secFindingSubject(f);
  if (subject) {
    setTimeout(() => {
      const sel = document.getElementById('log-filter-agent');
      // Audit log filters by agent name — try to set the UPN as a text search
      const searchInput = document.getElementById('log-search-input') || document.getElementById('log-filter-upn');
      if (searchInput) { searchInput.value = subject; }
      // Trigger filter apply
      const applyBtn = document.getElementById('btn-log-filter-apply') || document.getElementById('btn-log-apply');
      if (applyBtn) applyBtn.click(); else if (typeof applyAuditFilters === 'function') applyAuditFilters();
    }, 150);
  }
});

// "Subject in Users" → jump to Users tab and search for the subject
document.getElementById('sec-pivot-users')?.addEventListener('click', () => {
  const f = _secFindings[_secFocused];
  if (!f) return;
  const subject = _secFindingSubject(f);
  switchTab('users');
  if (subject) {
    setTimeout(() => {
      const inp = document.getElementById('user-search-input');
      if (inp) { inp.value = subject; }
      const searchBtn = document.getElementById('btn-user-search');
      if (searchBtn) searchBtn.click();
    }, 150);
  }
});

// "Ask Audit Agent" → jump to Auditor and pre-fill a contextual query
document.getElementById('sec-pivot-audit-agent')?.addEventListener('click', () => {
  const f = _secFindings[_secFocused];
  if (!f) return;
  switchTab('auditor');
  setTimeout(() => {
    const inp = document.getElementById('input-auditor');
    if (inp) {
      const subject = _secFindingSubject(f);
      inp.value = subject
        ? `Investigate security finding "${f.title}" (${f.rule}) for user ${subject}. Show related audit entries and context.`
        : `Investigate security finding: "${f.title}" (${f.rule}). Show related audit log entries.`;
      inp.focus();
    }
  }, 150);
});

// ── Security filter dropdowns ─────────────────────────────────────────────────
document.getElementById('sec-filter-sev')?.addEventListener('click', function () {
  _showSecDropdown(this, [
    { label: 'All severities', value: '', active: _secFilter.sev === '' },
    { label: 'Critical only',  value: 'crit', active: _secFilter.sev === 'crit' },
    { label: 'Warning+',       value: 'warn', active: _secFilter.sev === 'warn' },
    { label: 'Info only',      value: 'info', active: _secFilter.sev === 'info' },
  ], (value, label) => {
    _secFilter.sev = value;
    this.textContent = (value ? label : 'All severities') + ' ▾';
    this.classList.toggle('active', !!value);
    _renderSecRows();
  });
});

document.getElementById('sec-filter-source')?.addEventListener('click', function () {
  _showSecDropdown(this, [
    { label: 'All sources',         value: '',        active: _secFilter.source === '' },
    { label: 'UEBA',                value: 'ueba',    active: _secFilter.source === 'ueba' },
    { label: 'Drift',               value: 'drift',   active: _secFilter.source === 'drift' },
    { label: 'Identity Protection', value: 'identity',active: _secFilter.source === 'identity' },
  ], (value, label) => {
    _secFilter.source = value;
    this.textContent = (value ? label : 'All sources') + ' ▾';
    this.classList.toggle('active', !!value);
    _renderSecRows();
  });
});

document.getElementById('sec-filter-assign')?.addEventListener('click', function () {
  _showSecDropdown(this, [
    { label: 'Unassigned',  value: 'unassigned', active: _secFilter.assign === 'unassigned' },
    { label: 'Assigned',    value: 'assigned',   active: _secFilter.assign === 'assigned' },
    { label: 'All findings',value: '',           active: _secFilter.assign === '' },
  ], (value, label) => {
    _secFilter.assign = value;
    this.textContent = (value === 'unassigned' ? 'Unassigned' : value === 'assigned' ? 'Assigned' : 'All') + ' ▾';
    this.classList.toggle('active', value === 'assigned');
    _renderSecRows();
  });
});

document.getElementById('sec-filter-time')?.addEventListener('click', function () {
  _showSecDropdown(this, [
    { label: 'All time', value: 0,  active: _secFilter.maxAge === 0 },
    { label: 'Last 24h', value: 1,  active: _secFilter.maxAge === 1 },
    { label: 'Last 7d',  value: 7,  active: _secFilter.maxAge === 7 },
    { label: 'Last 30d', value: 30, active: _secFilter.maxAge === 30 },
  ], (value, label) => {
    _secFilter.maxAge = value;
    this.textContent = label + ' ▾';
    this.classList.toggle('active', value > 0);
    _renderSecRows();
  });
});

// ── Security bulk action buttons ──────────────────────────────────────────────
document.getElementById('sec-btn-ack')?.addEventListener('click', () => {
  if (_secCheckedSet.size === 0) return;
  _secCheckedSet.forEach(idx => {
    const f = _secFindings[idx];
    if (!f) return;
    const key = _secKey(f);
    if (!_secAckedKeys.has(key)) {
      _secAckedKeys.add(key);
      _secAckedFindings.push({ ...f, ackedAt: new Date() });
    }
  });
  const ackedEl = document.getElementById('sec-count-acked');
  if (ackedEl) ackedEl.textContent = String(_secAckedFindings.length);
  const n = _secCheckedSet.size;
  showToast(n + ' finding' + (n > 1 ? 's' : '') + ' acknowledged');
  _renderSecRows();
  _renderAckedSection();
});

document.getElementById('sec-btn-page')?.addEventListener('click', () => {
  const n = _secCheckedSet.size;
  if (n === 0) return;
  showToast('On-call paged for ' + n + ' finding' + (n > 1 ? 's' : '') + ' via Teams (#identity-ops)');
});

/**
 * Show an operator-picker modal.
 * onPick(operatorName) is called when the user selects someone.
 * Lists "Assign to me" first, then all other known operators.
 */
function _showAssignPicker(onPick) {
  const me = currentOperatorName || window.api.currentUser || 'me';
  const others = Object.keys(_operators).filter(n => n !== me);

  const overlay = document.createElement('div');
  overlay.className = 'pin-overlay';

  const rows = [{ name: me, label: me + ' (me)', role: _operators[me] || currentOperatorRole() }]
    .concat(others.map(n => ({ name: n, label: n, role: _operators[n] || '' })));

  const roleChip = role => {
    if (!role) return '';
    const cls = role === 'admin' ? 'crit' : role === 'helpdesk' ? 'warn' : 'info';
    return '<span class="tag ' + cls + '" style="margin-left:6px;font-size:10px">' + escHtml(role) + '</span>';
  };

  overlay.innerHTML =
    '<div class="pin-modal" style="width:360px;max-width:94vw">'
    + '<div class="pin-header"><div class="pin-title">Assign to operator</div>'
    + '<button class="pin-close" id="assign-picker-close">×</button></div>'
    + '<div class="pin-body" style="padding:8px 0">'
    + rows.map(r =>
        '<button class="assign-picker-row" data-name="' + escHtml(r.name) + '" style="display:flex;align-items:center;width:100%;padding:10px 20px;background:none;border:none;cursor:pointer;text-align:left;gap:8px;font-size:13px;color:var(--text-1);border-bottom:1px solid var(--border)">'
        + '<span style="flex:1">' + escHtml(r.label) + roleChip(r.role) + '</span>'
        + '</button>'
      ).join('')
    + '</div></div>';

  document.body.appendChild(overlay);

  overlay.querySelector('#assign-picker-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.assign-picker-row').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--surface-2)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
    btn.addEventListener('click', () => {
      overlay.remove();
      onPick(btn.dataset.name);
    });
  });
}

document.getElementById('sec-btn-assign')?.addEventListener('click', function () {
  if (_secCheckedSet.size === 0) return;
  const n = _secCheckedSet.size;
  _showAssignPicker(name => {
    _secCheckedSet.forEach(idx => { if (_secFindings[idx]) _secFindings[idx].assignee = name; });
    showToast(n + ' finding' + (n > 1 ? 's' : '') + ' assigned to ' + name);
    _renderSecRows();
  });
});

// ── Individual finding action: Assign ─────────────────────────────────────────
document.getElementById('sec-action-assign')?.addEventListener('click', () => {
  if (_secFocused === null || !_secFindings[_secFocused]) return;
  _showAssignPicker(name => {
    _secFindings[_secFocused].assignee = name;
    showToast('Finding assigned to ' + name);
    _renderSecRows();
    focusFinding(_secFocused); // refresh right-rail assignee display
  });
});

// ── Drift "Show full diff" ────────────────────────────────────────────────────
document.getElementById('sec-drift-full')?.addEventListener('click', () => {
  const f = _secFindings[_secFocused];
  if (!f || !f.isDrift || !f.driftItems) return;
  const rowsHtml = f.driftItems.map(item => {
    const name = escHtml(item.displayName || item.userPrincipalName || item.agent || '?');
    const exp = item.expected ? escHtml(item.expected) : null;
    const act = item.actual  ? escHtml(item.actual)   : null;
    return '<div style="margin-bottom:8px">'
      + '<div style="font-weight:600;margin-bottom:4px">' + name + '</div>'
      + (exp
        ? '<div class="diff-row keep"><span class="sym"> </span><span style="color:var(--ok)">Expected: ' + exp + '</span></div>'
          + '<div class="diff-row rem"><span class="sym">−</span><span style="color:var(--crit)">Actual: ' + (act || '?') + '</span></div>'
        : '<div class="diff-row rem"><span class="sym">−</span><span>' + escHtml(item.note || f.title) + '</span></div>')
      + '</div>';
  }).join('<hr style="border-color:var(--border);margin:8px 0">');

  // Build modal directly so we can render HTML (showDetailPopover escapes raw)
  const overlay = document.createElement('div');
  overlay.className = 'pin-overlay';
  overlay.innerHTML =
    '<div class="pin-modal" style="width:540px;max-width:94vw">'
    + '<div class="pin-header"><div class="pin-title">' + escHtml('Full drift diff — ' + f.title) + '</div></div>'
    + '<div class="pin-body" style="max-height:60vh;overflow-y:auto;padding:16px">'
    + '<div style="font-family:var(--mono,monospace);font-size:12px;line-height:1.7">'
    + rowsHtml
    + '</div></div>'
    + '<div class="pin-footer"><button class="btn ghost dd-close">Close</button></div>'
    + '</div>';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.dd-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
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
    // No status file yet = the export/ingest has never run (fresh tenant).
    chip.textContent = 'Not run yet';
    chip.className   = 'export-status-chip chip-unconfigured';
    if (lastRun) lastRun.textContent = 'Use the Run / Ingest button';
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

  updateExportReceiptHop('blob', b, b && b.entriesExported != null ? b.entriesExported + ' entries' : null);

  const s = data.sentinel;
  applyExportStatus('sentinel', s);
  if (s) {
    document.getElementById('sentinel-workspace').textContent = s.workspaceId ? s.workspaceId.slice(0, 8) + '…' : '—';
    document.getElementById('sentinel-events').textContent    = s.eventsIngested != null ? s.eventsIngested + ' events' : '—';
    if (!s.error) document.getElementById('sentinel-error').textContent = '';
  }

  updateExportReceiptHop('sentinel', s, s && s.eventsIngested != null ? s.eventsIngested + ' events' : null);

  // Feed dashboard Exports widget
  const blobOk = b && !b.error;
  const sentOk = s && !s.error;
  const blobDot = document.getElementById('dash-exp-blob-dot');
  const sentDot = document.getElementById('dash-exp-sentinel-dot');
  if (blobDot) blobDot.style.background = b ? (blobOk ? 'var(--emerald)' : 'var(--coral)') : 'var(--muted)';
  if (sentDot) sentDot.style.background = s ? (sentOk ? 'var(--emerald)' : 'var(--coral)') : 'var(--muted)';
  const blobMeta = document.getElementById('dash-exp-blob');
  if (blobMeta) blobMeta.textContent = b ? (b.entriesExported != null ? b.entriesExported + ' entries' : (b.error ? 'error' : 'ready')) : 'unconfigured';
  const sentMeta = document.getElementById('dash-exp-sentinel');
  if (sentMeta) sentMeta.textContent = s ? (s.eventsIngested != null ? s.eventsIngested + ' events' : (s.error ? 'error' : 'ready')) : 'unconfigured';

  // Audit-log page replication chain: light each storage/SIEM sink by REAL
  // status instead of the hardcoded all-green dots.
  const setRep = (key, active, error) => {
    const dot = document.getElementById('rep-dot-' + key);
    const lat = document.getElementById('rep-lat-' + key);
    if (dot) dot.className = 'dot' + (error ? ' crit' : active ? ' ok' : '');
    if (lat) lat.textContent = error ? 'error' : active ? 'active' : 'inactive';
  };
  setRep('blob',     !!(b && !b.error && (b.lastRun || b.entriesExported != null)), !!(b && b.error));
  setRep('sentinel', !!(s && !s.error && (s.lastRun || s.eventsIngested != null)), !!(s && s.error));
  const _ic = (typeof _intConfig === 'object' && _intConfig) ? _intConfig : null;
  setRep('splunk', !!(_ic && _ic.splunk && _ic.splunk.enabled), false);
});

function updateExportReceiptHop(id, status, countText) {
  const hop = document.getElementById('export-hop-' + id);
  const meta = document.getElementById('export-hop-' + id + '-meta');
  if (!hop || !meta) return;
  hop.classList.remove('ok', 'err', 'soon');
  if (!status) {
    hop.classList.add('soon');
    meta.textContent = 'unconfigured';
    return;
  }
  if (status.error) {
    hop.classList.add('err');
    meta.textContent = 'needs attention';
    return;
  }
  if (status.configured === false) {
    hop.classList.add('soon');
    meta.textContent = 'not configured';
    return;
  }
  hop.classList.add('ok');
  meta.textContent = countText || (status.lastRun ? 'last run recorded' : 'ready');
}

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
    const label = result.type === 'blob' ? 'Blob export' : 'Sentinel ingest';
    if (result.status && result.status.configured === false) {
      showToast(label + ' skipped — configure in Integrations settings', 'warning');
    } else {
      showToast(label + ' complete', 'success');
    }
  } else {
    const errEl = document.getElementById(result.type === 'blob' ? 'blob-error' : 'sentinel-error');
    if (errEl) errEl.textContent = result.error || 'Unknown error';
    showToast((result.type === 'blob' ? 'Blob export' : 'Sentinel ingest') + ' failed: ' + (result.error || 'unknown error'), 'error');
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────
document.getElementById('refresh-log').addEventListener('click', loadAuditLog);

function loadAuditLog() {
  document.getElementById('log-tbody').innerHTML = '<tr class="empty-row"><td colspan="7">Loading…</td></tr>';
  window.api.getAuditLog();
}

const LOG_PAGE_SIZE = 50;
let _logPage = 0;
let _logEntries = [];

function renderAuditPage() {
  const tbody   = document.getElementById('log-tbody');
  const paginEl = document.getElementById('log-pagination');
  const entries = _logEntries;
  const total   = entries.length;
  const start   = _logPage * LOG_PAGE_SIZE;
  const end     = Math.min(start + LOG_PAGE_SIZE, total);
  const page    = entries.slice(start, end);

  tbody.innerHTML = page.map((e, i) => {
    const idx      = start + i;
    const ts       = e.timestamp ? new Date(e.timestamp).toLocaleString() : '--';
    const outcome  = e.outcome || '--';
    const mode     = e.whatif ? '<span class="badge-whatif">Safe</span>' : '<span class="badge-live">Live</span>';
    const cls      = outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : outcome === 'failed' ? 'failed' : '';
    const ticket   = (e.details && e.details.ticketRef) ? escHtml(e.details.ticketRef) : '<span class="dim">—</span>';
    const operator = e.operator ? escHtml(e.operator) : '<span class="dim">—</span>';
    return `<tr data-audit-idx="${idx}" style="cursor:pointer">
      <td class="mono">${ts}</td>
      <td>${escHtml(e.agent || '--')}</td>
      <td class="mono" title="${escHtml(e.subject || '')}">${escHtml(e.subject || '--')}</td>
      <td title="${escHtml(e.operator || '')}">${operator}</td>
      <td>${ticket}</td>
      <td><span class="outcome ${cls}">${escHtml(outcome)}</span></td>
      <td>${mode}</td>
    </tr>`;
  }).join('');

  // Click handler for detail popover
  tbody.querySelectorAll('tr[data-audit-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const e = entries[parseInt(row.dataset.auditIdx, 10)];
      if (!e) return;
      const kv = [
        ['Timestamp',  e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'],
        ['Agent',      e.agent || '—'],
        ['Action',     e.action || '—'],
        ['Subject',    e.subject || '—'],
        ['Outcome',    e.outcome || '—'],
        ['Operator',   e.operator || '—'],
        ['Mode',       e.whatif ? 'Safe' : 'Live'],
        ['Ticket',     e.details?.ticketRef || '—'],
        ['Hash',       e.hash ? String(e.hash).slice(0, 24) + '…' : '—'],
        ['Prev hash',  e.prevHash ? String(e.prevHash).slice(0, 24) + '…' : '—'],
      ];
      const _actions = [
        { id: 'copyhash', label: 'Copy full hash', onClick: () => {
          try { navigator.clipboard.writeText(e.hash || ''); showToast('Hash copied', 'success'); } catch (_) {}
        }}
      ];
      // Lifecycle operations (JoinerProcess/MoverProcess/LeaverProcess/…) can be
      // replayed on the Glass Screen; other audit events (sign-in, config) can't.
      if (e.agent && e.subject && /Process$/i.test(e.action || '') && window.JmlGlassScreen?.replayAudit) {
        _actions.unshift({ id: 'replay', label: '▶ Replay in Glass Screen', onClick: () => {
          if (typeof switchTab === 'function') { try { switchTab('glass-screen'); } catch (_) {} }
          setTimeout(() => { try { window.JmlGlassScreen.replayAudit(e); } catch (_) {} }, 150);
        }});
      }
      showDetailPopover({
        title: `${e.agent || 'event'} · ${e.subject || ''}`,
        kv, raw: e.details && Object.keys(e.details).length ? e.details : null,
        actions: _actions
      });
    });
  });

  // Pagination controls
  if (paginEl) {
    const totalPages = Math.ceil(total / LOG_PAGE_SIZE);
    if (total <= LOG_PAGE_SIZE) {
      paginEl.innerHTML = '';
    } else {
      paginEl.innerHTML = `
        <span class="lp-range">Showing ${start + 1}–${end} of ${total}</span>
        <div class="lp-btns">
          <button class="lp-btn" id="lp-prev"${_logPage === 0 ? ' disabled' : ''}>← Prev</button>
          <button class="lp-btn" id="lp-next"${_logPage >= totalPages - 1 ? ' disabled' : ''}>Next →</button>
        </div>`;
      const prevBtn = paginEl.querySelector('#lp-prev');
      const nextBtn = paginEl.querySelector('#lp-next');
      if (prevBtn) prevBtn.addEventListener('click', () => { _logPage--; renderAuditPage(); });
      if (nextBtn) nextBtn.addEventListener('click', () => { _logPage++; renderAuditPage(); });
    }
  }
}

window.api.onAuditLogData((entries) => {
  // Feed Operations kanban Completed-today column from audit log
  _opsAuditEntries = entries || [];
  renderOpsCompleted(mergedCompletedOperations());

  // Feed dashboard Audit widget
  if (Array.isArray(entries)) {
    const total = entries.length;
    const totalEl = document.getElementById('dash-audit-total');
    if (totalEl) totalEl.textContent = total;
    const cnt = document.getElementById('dash-audit-cnt');
    if (cnt) cnt.textContent = `· ${total} entries`;
    const last = entries[0];
    const sealEl = document.getElementById('dash-audit-seal');
    if (sealEl && last) sealEl.textContent = last.timestamp ? new Date(last.timestamp).toLocaleString() : '—';
    const headEl = document.getElementById('dash-audit-head');
    if (headEl && last && last.hash) headEl.textContent = String(last.hash).slice(0, 12) + '…';
  }

  const countEl = document.getElementById('log-count');
  if (!entries.length) {
    document.getElementById('log-tbody').innerHTML = '<tr><td colspan="7" class="empty-row">No audit entries found.</td></tr>';
    if (countEl) countEl.textContent = '';
    const paginEl = document.getElementById('log-pagination');
    if (paginEl) paginEl.innerHTML = '';
    return;
  }
  if (countEl) countEl.textContent = entries.length + ' entries';
  window._lastAuditEntries = entries;
  _logEntries = entries;
  _logPage = 0;
  renderAuditPage();
  window.JmlGlassScreen?.onAuditEntries(entries);
});

// ── Dashboard AI summary ──────────────────────────────────────────────────────
const _dashState = {
  users:     null,   // { total, enabled, disabled, guests }
  activity:  null,   // { totalEntries }
  approvals: null,   // number
  secCrit:   null,   // number
  secWarn:   null,   // number
  agents:    null,   // array from agent health
  certAlert: null,   // name of first expiring cert
};

function buildDashSummary() {
  const el = document.getElementById('dash-page-sub');
  if (!el) return;

  const urgent = [];
  const notes  = [];

  // Security pressure
  const sc = _dashState.secCrit ?? 0;
  const sw = _dashState.secWarn ?? 0;
  if (sc > 0)       urgent.push(`${sc} critical security finding${sc > 1 ? 's' : ''}`);
  else if (sw > 0)  urgent.push(`${sw} security warning${sw > 1 ? 's' : ''}`);

  // Approval pressure
  const ap = _dashState.approvals ?? 0;
  if (ap > 0) urgent.push(`${ap} pending approval${ap > 1 ? 's' : ''}`);

  // Agent health
  if (_dashState.agents && _dashState.agents.length) {
    const sick = _dashState.agents.filter(a => a.status === 'critical' || a.status === 'expiring').length;
    if (sick > 0) notes.push(`${sick} agent${sick > 1 ? 's' : ''} need${sick === 1 ? 's' : ''} attention`);
    else          notes.push(`all ${_dashState.agents.length} agents healthy`);
  }

  // Cert alert
  if (_dashState.certAlert) notes.push(`${_dashState.certAlert} cert expiring soon`);

  // User baseline
  if (_dashState.users) {
    const u = _dashState.users;
    notes.push(`${(u.total || 0).toLocaleString()} identities${u.guests > 0 ? ` · ${u.guests} guests` : ''}`);
  }

  // Activity
  if (_dashState.activity && _dashState.activity.totalEntries) {
    notes.push(`${_dashState.activity.totalEntries} operations logged`);
  }

  // Compose prose
  if (urgent.length === 0 && notes.length === 0) {
    el.textContent = 'Fleet operating normally — no pending actions, all agents ready.';
    return;
  }
  let text = '';
  if (urgent.length > 0) {
    text = urgent.join(' · ');
    if (notes.length > 0) text += ' — ' + notes.join(', ') + '.';
    else text += '.';
  } else {
    text = notes.join(' · ') + '.';
    // Capitalise first letter
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  el.textContent = text;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
let _dashConnected = false;
function loadDashboard() {
  _dashConnected = false;
  window.api.getDashboardStats();
  window.api.getPendingApprovals();
  window.api.getSecurityReports();
  window.api.getAgentHealth();
  // Fallback: if live data doesn't arrive within 8s, show a graceful disconnected state
  clearTimeout(window._dashTimeout);
  window._dashTimeout = setTimeout(() => {
    if (_dashConnected) return;
    document.querySelectorAll('#view-dashboard .loading').forEach(el => el.classList.remove('loading'));
    const sub = document.getElementById('dash-page-sub');
    if (sub) sub.textContent = 'Fleet offline — no Entra connection. Configure tenant binding in Settings → Tenant Binding to enable live data.';
    const statEls = ['stat-users-total','stat-licenses-total','stat-activity-total'];
    statEls.forEach(id => { const el = document.getElementById(id); if (el && el.textContent === '') el.textContent = '—'; });
  }, 8000);
}

window.api.onDashboardStats((data) => {
  _dashConnected = true;
  clearTimeout(window._dashTimeout);
  ['stat-users-total','stat-users-detail','stat-licenses-total','stat-activity-total','stat-activity-detail']
    .forEach(id => document.getElementById(id).classList.remove('loading'));
  if (data.error) {
    document.getElementById('stat-users-detail').textContent = data.error;
    document.getElementById('stat-activity-detail').textContent = '';
    // Don't leave the heading stuck on "loading…" when the tenant isn't
    // connected yet — state it plainly.
    const sub = document.getElementById('dash-headline-sub');
    if (sub && sub.textContent.includes('loading')) sub.textContent = 'tenant not connected';
    const pageSub = document.getElementById('dash-page-sub');
    if (pageSub && pageSub.textContent.includes('loading')) {
      pageSub.textContent = 'Connect a tenant in Settings → Tenant to bring the fleet online.';
    }
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

  if (data.users)    { _dashState.users    = data.users; }
  if (data.activity) { _dashState.activity = { totalEntries: data.activity.totalEntries || 0 }; }
  buildDashSummary();

  if (data.activity) {
    document.getElementById('stat-activity-total').textContent = data.activity.totalEntries || 0;
    const recent = (data.activity.recentEntries || []).slice(0, 5);
    const list   = document.getElementById('recent-activity-list');
    if (recent.length === 0) {
      list.innerHTML = '<div class="loading-hint">No activity recorded yet.</div>';
    } else {
      document.getElementById('stat-activity-detail').textContent = 'total operations';
      list.innerHTML = recent.map(e => buildActivityItem(e)).join('');
      // Click an activity row to see the full entry details + jump-to-Audit option
      list.querySelectorAll('.activity-item').forEach((el, i) => {
        el.addEventListener('click', () => {
          const entry = recent[i];
          if (!entry) return;
          const kv = [
            ['Timestamp',  entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—'],
            ['Agent',      entry.agent || '—'],
            ['Action',     entry.action || '—'],
            ['Subject',    entry.subject || '—'],
            ['Outcome',    entry.outcome || '—'],
            ['Operator',   entry.operator || '—'],
            ['Mode',       entry.whatif ? 'Safe' : 'Live'],
            ['Ticket',     entry.details?.ticketRef || '—'],
          ];
          showDetailPopover({
            title: `${entry.agent || 'event'} · ${entry.subject || entry.action || ''}`,
            kv, raw: entry.details && Object.keys(entry.details).length ? entry.details : null,
            actions: [{
              id: 'jump', label: 'Open in Audit Log', primary: true,
              onClick: () => {
                switchTab('audit-log');
                const f = document.getElementById('log-filter-upn');
                if (f && entry.subject) { f.value = entry.subject; document.getElementById('btn-log-filter-apply')?.click(); }
              }
            }]
          });
        });
      });
    }
  }

  // Update dashboard V2 heading meta with real user count
  if (data.users && data.users.total) {
    const sub = document.getElementById('dash-headline-sub');
    if (sub) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      sub.textContent = data.users.total + ' identities · last sync ' + timeStr;
    }
  }
});

// Generic detail-popover used by clickable rows that should reveal more data.
// Pass an object with title + key/value pairs; renders a centered modal.
function showDetailPopover({ title, kv, raw, actions }) {
  const overlay = document.createElement('div');
  overlay.className = 'pin-overlay';
  const kvHtml = (kv || []).map(([k, v]) => `<div class="ap-row"><span class="k">${escHtml(k)}</span><span class="v">${escHtml(v)}</span></div>`).join('');
  const rawHtml = raw ? `<pre style="margin:12px 0 0;padding:12px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:11.5px;color:var(--text-2);white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto">${escHtml(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))}</pre>` : '';
  const actionsHtml = (actions || []).map(a => `<button class="btn ${a.danger ? 'danger' : a.primary ? 'primary' : 'ghost'}" data-act="${escHtml(a.id)}">${escHtml(a.label)}</button>`).join('');
  overlay.innerHTML = `
    <div class="pin-modal" style="width:520px;max-width:94vw">
      <div class="pin-header">
        <div class="pin-title">${escHtml(title || 'Details')}</div>
      </div>
      <div class="pin-body" style="max-height:60vh;overflow-y:auto">
        <div style="display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-size:12px">${kvHtml}</div>
        ${rawHtml}
      </div>
      <div class="pin-footer">
        ${actionsHtml}
        <button class="btn ghost dp-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.dp-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const handler = (actions || []).find(a => a.id === btn.dataset.act);
      if (handler && handler.onClick) handler.onClick();
      overlay.remove();
    });
  });
}

// ── Activity item builder (revamp .evt row) ──────────────────────────────────
function buildActivityItem(e) {
  const ts = e.timestamp ? new Date(e.timestamp) : null;
  // Compact ts: "MM/DD HH:MM" if older than today, else "HH:MM"
  let tsLabel = '—';
  if (ts) {
    const now = new Date();
    const sameDay = ts.toDateString() === now.toDateString();
    const hh = String(ts.getHours()).padStart(2, '0');
    const mm = String(ts.getMinutes()).padStart(2, '0');
    tsLabel = sameDay ? `${hh}:${mm}` : `${ts.getMonth()+1}/${ts.getDate()} ${hh}:${mm}`;
  }
  const agent = (e.agent || 'unknown').toLowerCase();
  // Normalize subject: handle UPN (user@domain), bare names ("tenant", group names),
  // file paths ("audit.jsonl"), or empty values gracefully.
  const subjFull = e.subject || '';
  let subjMain = '—', subjEm = '';
  if (subjFull) {
    const at = subjFull.indexOf('@');
    if (at > 0) {
      // UPN — split user from domain
      subjMain = subjFull.slice(0, at);
      subjEm = subjFull.slice(at);
    } else if (subjFull.includes('.') && /\.(jsonl?|csv|ps1)$/i.test(subjFull)) {
      // File path — show as-is, italic
      subjMain = subjFull;
      subjEm = ' · file';
    } else {
      // Group name, tenant, scan id, etc. — show as-is, optional context tag
      subjMain = subjFull;
      const detail = (e.details && (e.details.stage || e.details.ticketRef || e.details.action)) || '';
      if (detail) subjEm = ' · ' + detail;
    }
  } else if (e.action) {
    subjMain = e.action;
  }
  const outcomeClass = (e.outcome || '').toLowerCase();
  return `<div class="evt activity-item" data-agent="${escHtml(agent)}" title="${escHtml(subjFull || e.action || '')}">
    <span class="ts">${escHtml(tsLabel)}</span>
    <span class="agent-tag t-${escHtml(agent)}">${agentScopeTip(agent, agent)}</span>
    <span class="subj">${escHtml(subjMain)}${subjEm ? `<em>${escHtml(subjEm)}</em>` : ''}</span>
    <span class="outcome ${outcomeClass}">${escHtml(e.outcome || '—')}</span>
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatToolName(n) {
  return n.replace(/^(submit|query)_/, '').replace(/_/g, ' ');
}

function _relativeTime(d) {
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString();
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
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  // Helpers
  const isBullet   = l => /^\s*[-*•]\s/.test(l);
  const isNumList  = l => /^\s*\d+\.\s/.test(l);
  const isTaskItem = l => /^\s*[-*]\s+\[[ xX]\]\s/.test(l);
  const isBlockq   = l => /^\s*>\s?/.test(l);

  while (i < lines.length) {
    const raw  = lines[i];
    const line = raw.trimEnd();

    // Blank line — skip
    if (!line.trim()) { i++; continue; }

    // Heading
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      out.push('<div class="md-h' + hm[1].length + '">' + inlineMarkdown(hm[2]) + '</div>');
      i++; continue;
    }

    // Horizontal rule
    if (/^[-*]{3,}$/.test(line.trim())) { out.push('<div class="md-hr"></div>'); i++; continue; }

    // Blockquote — collect only lines that start with `>`; stop at anything else
    if (isBlockq(line)) {
      const bqLines = [];
      while (i < lines.length && isBlockq(lines[i])) {
        bqLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<div class="md-blockquote">' + inlineMarkdown(bqLines.join(' ')) + '</div>');
      continue;
    }

    // Pipe table
    if (line.trim().startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { tableLines.push(lines[i]); i++; }
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

    // Task list (must come before bullet so `- [x]` isn't consumed as a plain bullet)
    if (isTaskItem(line)) {
      out.push('<ul class="md-list">');
      while (i < lines.length && isTaskItem(lines[i])) {
        const done = /^\s*[-*]\s+\[[xX]\]/.test(lines[i]);
        const body = lines[i].replace(/^\s*[-*]\s+\[[ xX]\]\s*/, '');
        out.push('<li><span class="md-task-check">' + (done ? '☑' : '☐') + '</span>'
          + '<span class="' + (done ? 'md-task-done' : '') + '">' + inlineMarkdown(body) + '</span></li>');
        i++;
      }
      out.push('</ul>');
      continue;
    }

    // Bullet list — `-`, `*`, or `•` prefixes all treated as list items
    if (isBullet(line)) {
      out.push('<ul class="md-list">');
      while (i < lines.length && isBullet(lines[i])) {
        out.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*[-*•]\s+/, '')) + '</li>');
        i++;
      }
      out.push('</ul>');
      continue;
    }

    // Numbered list
    if (isNumList(line)) {
      out.push('<ol class="md-list">');
      while (i < lines.length && isNumList(lines[i])) {
        out.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
        i++;
      }
      out.push('</ol>');
      continue;
    }

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++; // consume closing ```
      out.push('<pre' + (lang ? ' data-lang="' + escHtml(lang) + '"' : '') + '><code>'
        + escHtml(codeLines.join('\n')) + '</code></pre>');
      continue;
    }

    // Paragraph
    out.push('<p class="md-p">' + inlineMarkdown(line) + '</p>');
    i++;
  }

  // Agent-mention tooltip decoration removed from chat replies: the injected
  // scope-tooltip markup (role/can/permission rows) rendered as garbled inline
  // text inside agent prose. agentScopeTip stays in use for the activity feed.
  return out.join('');
}

function inlineMarkdown(text) {
  return escHtml(text)
    // Bold+italic together first
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>')
    // Strikethrough
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // Inline code (do before links so backticks aren't processed inside links)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links [text](url) — only http/https to avoid XSS
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>')
    // Emoji status markers
    .replace(/✅/g, '<span class="md-check">✅</span>')
    .replace(/❌/g, '<span class="md-cross">❌</span>')
    .replace(/⚠️/g, '<span class="md-warn">⚠️</span>')
    .replace(/&#x2705;/g, '<span class="md-check">✅</span>')
    .replace(/&#x274C;/g, '<span class="md-cross">❌</span>');
}

// ── Approvals tab ─────────────────────────────────────────────────────────────
function agentScopeTip(agent, label, className) {
  const key = String(agent || '').toLowerCase().replace(/[^a-z-]/g, '').replace(/-agent$/, '');
  const meta = AGENT_SCOPE_META[key];
  const safeLabel = escHtml(label || key || 'agent');
  const cls = className ? ' ' + className : '';
  if (!meta) return '<span class="agent-scope-label' + cls + '">' + safeLabel + '</span>';
  // Compact tooltip: role + key permissions only (no reg, cannot, or note)
  return '<span class="tip-host agent-scope-label' + cls + '" tabindex="0">' + safeLabel +
    '<span class="tip">' +
      '<div class="tip-title">' + escHtml(meta.label || key) + '</div>' +
      '<div class="tip-row"><span class="k">role</span><span class="v">' + escHtml(meta.role) + '</span></div>' +
      '<div class="tip-row"><span class="k">can</span><span class="v ok">' + escHtml(meta.scopes.join(', ')) + '</span></div>' +
    '</span>' +
  '</span>';
}

function renderV2ChatEnhancements(text) {
  // Synthetic chat-enhancement cards (a fabricated "plan preview" execution trace
  // and a text-pattern-matched risk gauge with a fallback fake score) were appended
  // to every agent reply. They showed made-up tool calls, timings, and data, which
  // is misleading — disabled. Real risk data is stated in the agent's own text and
  // surfaced via the actual score_risk tool result; the deterministic Policy
  // Simulation tool (Operations tab) covers genuine policy previews.
  return '';
}

// renderRiskScoreCard(data)
// data — either a plain number (legacy fallback) or the full score_risk tool result:
//   { score, riskLevel, operation, subject, blocked, dualApproval, reasons: string[] }
// Reasons from Invoke-RiskScore.ps1 use "PREFIX: message" format, e.g.:
//   "FREEZE: Change-freeze is active on Sundays"
//   "SENSITIVE_LICENSE: 'AAD_PREMIUM_P2' is flagged for additional review"
//   "SENSITIVE_GROUP: 'Global Admins' is a privileged group requiring approval"
//   "SOD_BLOCK [R-001]: Conflicting roles assigned simultaneously"
//   "DUAL_APPROVAL_REQUIRED: This operation requires a second operator to approve"
function renderRiskScoreCard(data) {
  const d      = typeof data === 'number' ? { score: data } : (data || { score: 68 });
  const clamped = Math.max(0, Math.min(100, d.score || 0));
  // Derive tone from riskLevel field if present (more accurate than threshold buckets)
  const tone    = d.riskLevel || (clamped >= 80 ? 'critical' : clamped >= 60 ? 'high' : clamped >= 35 ? 'medium' : 'low');
  const toneVar = tone === 'critical' ? 'var(--crit)' : tone === 'high' ? 'var(--warn)' : tone === 'medium' ? 'var(--info)' : 'var(--ok)';
  // SVG circular gauge — r=22 → circumference ≈ 138.2
  const r = 22, circ = 2 * Math.PI * r;
  const dash = (clamped / 100) * circ;
  const gap  = circ - dash;

  // ── Reason rows ─────────────────────────────────────────────────────────────
  // Map reason prefixes → severity class and human-readable label
  const _reasonClass = (prefix) => {
    if (/^(SOD_BLOCK|FREEZE|BLOCKED)/.test(prefix))    return 'bad';
    if (/^(SENSITIVE|SOD_WARN|DUAL_APPROVAL)/.test(prefix)) return 'warn';
    return 'ok';
  };
  const _reasonLabel = (prefix) => {
    const map = {
      FREEZE:               '❄ Freeze window',
      SENSITIVE_LICENSE:    '⚑ Sensitive license',
      SENSITIVE_GROUP:      '⚑ Privileged group',
      SOD_BLOCK:            '⊘ SoD conflict (blocked)',
      SOD_WARN:             '△ SoD conflict (warn)',
      DUAL_APPROVAL_REQUIRED: '⊛ Dual approval required',
      SOD_CHECK_SKIPPED:    '— SoD check skipped',
    };
    // Match any key that the prefix starts with
    return Object.entries(map).find(([k]) => prefix.startsWith(k))?.[1] || prefix;
  };

  const reasons = Array.isArray(d.reasons) ? d.reasons : [];
  let reasonsHtml;

  if (reasons.length) {
    reasonsHtml = reasons.map(raw => {
      const colon = raw.indexOf(':');
      const prefix = colon >= 0 ? raw.slice(0, colon).trim() : raw.trim();
      const detail = colon >= 0 ? raw.slice(colon + 1).trim() : '';
      const cls    = _reasonClass(prefix);
      const label  = _reasonLabel(prefix);
      return '<div class="it ' + cls + '">' +
        '<span class="risk-reason-lbl">' + escHtml(label) + '</span>' +
        (detail ? '<span class="risk-reason-detail">' + escHtml(detail) + '</span>' : '') +
        '</div>';
    }).join('');
  } else {
    // No reasons from the script — render score-relative baseline copy
    const op = d.operation || '';
    const opNames = { joiner: 'Joiner', enroller: 'Enroller', mover: 'Mover', leaver_soft: 'Soft leaver', leaver_hard: 'Hard leaver' };
    const opLabel = opNames[op] || 'Lifecycle';
    const impact  = clamped < 30 ? 'low-impact' : clamped < 60 ? 'moderate-impact' : 'high-impact';
    reasonsHtml = '<div class="it ' + (clamped >= 60 ? 'bad' : 'warn') + '">' +
      escHtml(opLabel + ' baseline — ' + impact + ' on account state.') + '</div>';
    if (d.dualApproval) reasonsHtml += '<div class="it warn">Dual approval required before execution.</div>';
    reasonsHtml += '<div class="it ok">Audit chain and rollback window active.</div>';
  }

  // Blocked banner appended to reasons
  if (d.blocked) {
    reasonsHtml += '<div class="it bad risk-blocked-banner">⊘ Operation is blocked by policy — cannot proceed without override.</div>';
  }

  // ── Badge strip (riskLevel + optional dual-approval + blocked flags) ─────────
  const badges = '<span class="badge ' + tone + '">' + escHtml(tone) + '</span>' +
    (d.dualApproval ? ' <span class="badge warn">dual-approval</span>' : '') +
    (d.blocked      ? ' <span class="badge critical">blocked</span>' : '');

  // ── Score breakdown tooltip text ─────────────────────────────────────────────
  const opBase = { joiner: 10, enroller: 15, mover: 25, leaver_soft: 40, leaver_hard: 60 };
  const base   = opBase[d.operation] != null ? opBase[d.operation] : '—';
  const subEl  = d.operation
    ? '<div class="risk-score-meta">baseline ' + base + ' + ' + (reasons.length) + ' modifier' + (reasons.length !== 1 ? 's' : '') + '</div>'
    : '';

  // ── Foundry IQ grounding: cited policy block ─────────────────────────────────
  // The Microsoft IQ layer makes the decision auditable — every risk call can
  // show which policy documents grounded it, or that it failed closed.
  let groundingHtml = '';
  const g = d.grounding;
  if (g) {
    if (g.unavailable) {
      groundingHtml =
        '<div class="risk-grounding unavailable">' +
          '<div class="risk-grounding-head">⚠ Foundry IQ — policy grounding unavailable (failed closed)</div>' +
          '<div class="risk-grounding-note">' + escHtml(g.error || 'Grounding service unreachable') + '</div>' +
        '</div>';
    } else {
      const cites = (g.citations || []).slice(0, 4).map(c =>
        '<li><span class="cite-title">' + escHtml(c.title || 'policy') + '</span>' +
        (c.snippet ? '<span class="cite-snippet">' + escHtml(c.snippet.slice(0, 160)) + '</span>' : '') +
        '</li>').join('');
      groundingHtml =
        '<div class="risk-grounding">' +
          '<div class="risk-grounding-head">◆ Grounded by Foundry IQ' +
            (g.summary ? '<span class="risk-grounding-sum">' + escHtml(g.summary.slice(0, 180)) + '</span>' : '') +
          '</div>' +
          (cites ? '<ul class="risk-cites">' + cites + '</ul>'
                 : '<div class="risk-grounding-note">No matching policy documents.</div>') +
        '</div>';
    }
  }

  return '<div class="v2-chat-card v2-risk-card">' +
    '<div class="v2-risk-top">' +
    '<div class="v2-risk-gauge-wrap">' +
      '<svg class="v2-risk-gauge" width="56" height="56" viewBox="0 0 56 56">' +
        '<circle cx="28" cy="28" r="' + r + '" fill="none" stroke="var(--surface-2)" stroke-width="5"/>' +
        '<circle cx="28" cy="28" r="' + r + '" fill="none" stroke="' + toneVar + '" stroke-width="5"' +
          ' stroke-dasharray="' + dash.toFixed(1) + ' ' + gap.toFixed(1) + '"' +
          ' stroke-linecap="round" transform="rotate(-90 28 28)"/>' +
        '<text x="28" y="32" text-anchor="middle" font-size="13" font-weight="600" fill="' + toneVar + '" font-family="var(--mono)">' + clamped + '</text>' +
      '</svg>' +
      '<div class="v2-risk-gauge-label">/ 100' + subEl + '</div>' +
    '</div>' +
    '<div class="v2-risk-body">' +
      '<div class="v2-risk-heading">Risk assessment ' + badges + '</div>' +
      '<div class="risk-list">' + reasonsHtml + '</div>' +
    '</div>' +
    '</div>' +
    groundingHtml +
  '</div>';
}



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
  _dashState.approvals = items.length;
  buildDashSummary();
  if (countEl) countEl.textContent = items.length;

  // Sidebar approvals badge
  const navBadge = document.getElementById('nav-approvals-count');
  if (navBadge) {
    navBadge.textContent = items.length;
    navBadge.classList.toggle('empty', items.length === 0);
    navBadge.classList.toggle('warn', items.length > 0);
  }

  // Update dashboard approvals stat card
  const dashCnt = document.getElementById('stat-approvals-count');
  const dashDet = document.getElementById('stat-approvals-detail');
  if (dashCnt) { dashCnt.classList.remove('loading'); dashCnt.textContent = items.length || '0'; }
  if (dashDet) dashDet.textContent = items.length
    ? (items.length === 1 ? '1 action awaiting decision' : items.length + ' actions awaiting decision')
    : 'No pending approvals';

  // Update V2 triage card for approvals
  const apprLabel = document.getElementById('triage-appr-label');
  const apprTitle = document.getElementById('triage-appr-title');
  const apprMeta  = document.getElementById('triage-appr-meta');
  const apprCard  = document.getElementById('triage-approvals');
  if (apprLabel) apprLabel.textContent = items.length > 0
    ? 'Approvals · ' + items.length + ' pending'
    : 'Approvals';
  if (apprCard) {
    apprCard.className = 'v2-triage-card ' + (items.length > 2 ? 'crit' : items.length > 0 ? 'warn' : 'info');
  }
  const apprSub = document.getElementById('triage-appr-sub');
  if (items.length > 0 && apprTitle) {
    const first = items[0];
    const tool = (first.tool || '').toLowerCase();
    apprTitle.textContent = tool
      ? tool.charAt(0).toUpperCase() + tool.slice(1).replace(/_/g, ' ') + ' awaiting approval'
      : 'Operation awaiting approval';
    if (apprMeta) {
      const subject = (first.input || first).userPrincipalName || '';
      const token = first.token || first.id || '';
      apprMeta.textContent = subject ? subject.split('@')[0]
        : token ? 'token ' + token.slice(0, 6) + '…' : 'pending review';
    }
    if (apprSub) apprSub.textContent = items.length > 1
      ? 'Plus ' + (items.length - 1) + ' more pending'
      : '';
  } else if (apprTitle) {
    apprTitle.textContent = 'No pending approvals';
    if (apprMeta) apprMeta.textContent = 'queue is clear';
    if (apprSub) apprSub.textContent = '';
  }
  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      </div>
      <div class="empty-state-title">All clear</div>
      <div class="empty-state-body">No pending approvals. Operations requiring sign-off will appear here with a TTL countdown.</div>
    </div>`;
    return;
  }
  listEl.innerHTML = items.map(op => {
    const inp       = op.input || op;
    const token     = op.token || op.id || '';
    const tool      = (op.tool || '').toLowerCase();
    const now       = new Date();
    const expired   = op.expiresAt && new Date(op.expiresAt) < now;

    // TTL countdown text (mm:ss)
    let ttlText = '';
    if (op.expiresAt && !expired) {
      const ms = new Date(op.expiresAt) - now;
      const min = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      ttlText = `EXPIRES IN ${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    } else if (expired) {
      ttlText = 'EXPIRED';
    }
    const ttlIsWarn = op.expiresAt && !expired && (new Date(op.expiresAt) - now) < 5 * 60 * 1000;

    // Derive operation type, badge, severity
    let opLabel, badgeClass, severity;
    if (tool.includes('joiner'))      { opLabel = 'JOINER';      badgeClass = 'joiner'; severity = 'info'; }
    else if (tool.includes('hard'))   { opLabel = 'HARD LEAVER'; badgeClass = 'hard';   severity = 'crit'; }
    else if (tool.includes('soft'))   { opLabel = 'SOFT LEAVER'; badgeClass = 'soft';   severity = 'info'; }
    else if (tool.includes('mover'))  { opLabel = 'MOVER';       badgeClass = 'mover';  severity = 'info'; }
    else                              { opLabel = 'PENDING';     badgeClass = 'soft';   severity = 'info'; }

    // KV details
    const groups   = Array.isArray(inp.groups)   ? inp.groups   : [];
    const licenses = Array.isArray(inp.licenses) ? inp.licenses : [];
    const kvRows = [];
    if (inp.ticketRef)   kvRows.push(['Ticket',       escHtml(inp.ticketRef)]);
    if (op.requestedBy)  kvRows.push(['Requested by', escHtml(op.requestedBy)]);
    if (op.created)      kvRows.push(['Submitted',    escHtml(new Date(op.created).toLocaleString())]);
    if (inp.givenName || inp.surname) kvRows.push(['Name', escHtml(((inp.givenName || '') + ' ' + (inp.surname || '')).trim())]);
    if (inp.department)  kvRows.push(['Department',   escHtml(inp.department) + (inp.jobTitle ? ' · ' + escHtml(inp.jobTitle) : '')]);
    if (inp.stage)       kvRows.push(['Stage',        `<span class="chip">${escHtml(inp.stage)}</span>`]);
    if (licenses.length) kvRows.push(['Licenses',     licenses.map(l => `<span class="chip">${escHtml(l)}</span>`).join('')]);
    if (groups.length)   kvRows.push(['Groups',       groups.map(g => `<span class="chip">${escHtml(g)}</span>`).join('')]);
    if (inp.manager)     kvRows.push(['Manager',      escHtml(inp.manager)]);

    const kvHtml = kvRows.length
      ? '<div class="kv">' + kvRows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('') + '</div>'
      : '';

    // Risk note based on operation type
    let noteHtml = '';
    if (severity === 'crit') {
      noteHtml = `<div class="note crit"><div class="ttl">Risk Note</div><div class="reason">Hard-stage leaver — license + group removal requires dual approval. UEBA may flag this as a high-impact change.</div></div>`;
    } else if (badgeClass === 'joiner') {
      noteHtml = `<div class="note info"><div class="ttl">Provisioner Note</div><div class="reason">New hire provisioning. Groups and licenses pre-assigned. SoD precheck completed.</div></div>`;
    } else if (badgeClass === 'mover') {
      noteHtml = `<div class="note info"><div class="ttl">Mover Note</div><div class="reason">Department or role change. Will adjust group membership and license assignment per policy.</div></div>`;
    } else {
      noteHtml = `<div class="note"><div class="ttl">Notes</div><div class="reason">Standard operation. Review the details and approve, hold, or reject.</div></div>`;
    }

    // Role gate: can the current operator approve this?
    const reqApproverRole  = op.requiredApproverRole || (severity === 'crit' ? 'admin' : 'helpdesk');
    const actorRole        = currentOperatorRole();
    const canApproveThis   = actorRole === 'admin' || (reqApproverRole !== 'admin' && actorRole === 'helpdesk');
    const needsAdminBadge  = reqApproverRole === 'admin';
    const submittedByHelpdesk = (op.requestedByRole || '').toLowerCase() === 'helpdesk';

    // Dual approver row
    const isDual = severity === 'crit';
    const approverRow = isDual
      ? `<span class="approver-line">Approvers
           <span class="av"><span class="a" title="you"></span><span class="a pending" title="awaiting peer"></span></span>
           <span style="margin-left:8px">1 of 2 required</span>
         </span>`
      : `<span class="approver-line">Approvers
           <span class="av"><span class="a" title="you"></span></span>
           <span style="margin-left:8px">1 of 1 required</span>
         </span>`;

    // Role badge and disabled-approve messaging
    const roleBadgeHtml = needsAdminBadge
      ? `<span class="tag crit" style="font-size:10px;padding:2px 7px">Admin required</span>`
      : `<span class="tag info" style="font-size:10px;padding:2px 7px;opacity:.7">Any approver</span>`;
    const submitterHtml = submittedByHelpdesk && op.requestedBy
      ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:6px;font-family:var(--mono)">Escalated by helpdesk · ${escHtml(op.requestedBy)}</div>`
      : '';
    const approveBtn = !expired
      ? canApproveThis
        ? `<button class="btn primary btn-approve" data-id="${escHtml(token)}">Approve${isDual ? ' (1 of 2)' : ''}</button>`
        : `<button class="btn primary btn-approve" data-id="${escHtml(token)}" disabled
              title="Requires admin role — contact an admin operator to approve this action"
              style="opacity:.45;cursor:not-allowed">Admin sign-off needed</button>`
      : '';

    return `<div class="approval-card card ${severity === 'crit' ? 'crit' : 'info'}${expired ? ' expired' : ''}" data-id="${escHtml(token)}">
      <div class="card-h approval-header">
        <span class="tag approval-badge ${badgeClass}">${opLabel}</span>
        <span class="who-em approval-upn">${escHtml(inp.userPrincipalName || '—')}</span>
        <div class="spacer"></div>
        ${roleBadgeHtml}
        ${token ? `<span class="token approval-token">TOKEN <b>${escHtml(token.slice(0, 8).toUpperCase())}</b></span>` : ''}
        ${ttlText ? `<span class="ttl-cnt${ttlIsWarn ? ' warn' : ''}"><span class="x"></span>${escHtml(ttlText)}</span>` : ''}
      </div>
      <div class="card-b">
        ${kvHtml}
        ${submitterHtml}
        ${noteHtml}
      </div>
      <div class="card-f approval-actions">
        ${approverRow}
        <div class="spacer"></div>
        ${!expired ? `<button class="btn danger btn-reject" data-id="${escHtml(token)}">Reject</button>` : ''}
        ${!expired ? `<button class="btn btn-hold" data-id="${escHtml(token)}" disabled title="Hold not yet supported">Hold</button>` : ''}
        ${approveBtn}
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.btn-approve').forEach(btn => {
    btn.addEventListener('click', async () => {
      // If current effective mode deviates from hard session default, confirm
      const effective = isWhatif ? 'whatif' : 'live';
      if (effective !== _hardMode) {
        const ok = await confirmModal({
          title: 'Mode mismatch',
          body: `Session default is ${_hardMode.toUpperCase()}, but approval will execute in ${effective.toUpperCase()}. Continue?`,
          danger: effective === 'live',
          okLabel: 'Continue',
        });
        if (!ok) return;
      }
      const tokenOrTrue = await requirePinIfNeeded('Confirm approval');
      if (!tokenOrTrue) return;
      const writeToken = typeof tokenOrTrue === 'string' ? tokenOrTrue : null;
      btn.disabled = true; btn.textContent = 'Running…';
      window.api.approvePending(btn.dataset.id, writeToken);
    });
  });
  listEl.querySelectorAll('.btn-reject').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true; btn.textContent = 'Rejecting…';
      window.api.rejectPending(btn.dataset.id);
    });
  });
});

window.api.onApproveResult((data) => {
  loadApprovals();
  // Approval granted — refresh security findings after brief delay so any newly
  // cleared findings (e.g. leaver-then-group-add) can resolve
  setTimeout(() => window.api.getSecurityReports(), 3500);
});
window.api.onRejectResult((data) => { loadApprovals(); });

// Live TTL countdown on approval cards (1-second tick)
setInterval(() => {
  document.querySelectorAll('#approvals-list .ttl-cnt').forEach(el => {
    const m = el.textContent.match(/(\d+):(\d+)/);
    if (!m) return;
    let s = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) - 1;
    if (s < 0) s = 0;
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    el.innerHTML = el.innerHTML.replace(/\d+:\d+/, mm + ':' + ss);
    if (s < 5 * 60 && !el.classList.contains('warn')) el.classList.add('warn');
  });
}, 1000);

// ── Operations tab ────────────────────────────────────────────────────────────
function loadOperations() {
  window.api.getScheduledOps();
  window.api.getOperationStatuses();
  // Also fetch audit log entries for the completed-today column
  if (typeof window.api.getAuditLog === 'function') {
    try { window.api.getAuditLog(); } catch (_) {}
  }
}

// Render Operations kanban — derives Queued from scheduled-ops, Completed from audit log,
// In Flight from the dynamic _inflightOps registry below.
const _inflightOps = new Map();
const _operationRecords = new Map();
let _opsAuditEntries = [];
function renderOpsInflight() {
  const body = document.getElementById('ops-inflight-body');
  const count = document.getElementById('ops-inflight-count');
  if (!body || !count) return;
  const arr = [...(_inflightOps.values())];
  count.textContent = arr.length;
  if (!arr.length) {
    body.innerHTML = `<div class="empty-state sm">
      <div class="empty-state-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
      </div>
      <div class="empty-state-title">No active runs</div>
      <div class="empty-state-body">Live operations will stream here as they execute.</div>
    </div>`;
    return;
  }
  body.innerHTML = arr.map(op => {
    const elapsed = op.startedAt ? Math.floor((Date.now() - new Date(op.startedAt).getTime()) / 1000) : 0;
    return `<div class="op-card run">
      <div class="op-top">
        <span class="ag t-${escHtml(op.agent || 'auditor')}">${escHtml(op.agent || '—')}</span>
        <span class="id">${escHtml(op.id || '')}</span>
        <span class="meta">${elapsed < 60 ? elapsed + 's' : Math.floor(elapsed/60) + 'm'}</span>
      </div>
      <div style="font-size:12.5px;color:var(--text)">${escHtml(op.subject || '—')}</div>
      <div class="op-progress"><i style="width:${op.progress || 50}%"></i></div>
      <div class="op-foot"><span>${escHtml(op.step || 'running')}</span><span>${escHtml(op.operator || '—')}</span></div>
    </div>`;
  }).join('');
}
function renderOpsQueued(items) {
  const body = document.getElementById('ops-queued-body');
  const count = document.getElementById('ops-queued-count');
  const next = document.getElementById('ops-queued-next');
  if (!body || !count) return;
  count.textContent = items.length;
  if (!items.length) {
    body.innerHTML = `<div class="empty-state sm">
      <div class="empty-state-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </div>
      <div class="empty-state-title">Queue is empty</div>
      <div class="empty-state-body">Scheduled operations will appear here before dispatch.</div>
    </div>`;
    if (next) next.textContent = ''; return;
  }
  if (next && items[0].when) {
    const t = new Date(items[0].when);
    next.textContent = 'next ' + t.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  }
  body.innerHTML = items.map(item => {
    const ag = (item.op || '').toLowerCase().split('-')[0] || 'mover';
    const when = item.when ? new Date(item.when) : null;
    const tMeta = when ? when.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '—';
    return `<div class="op-card">
      <div class="op-top">
        <span class="ag t-${escHtml(ag)}">${escHtml(item.op || '—')}</span>
        <span class="id">${escHtml((item.id || '').toString().slice(0, 8))}</span>
        <span class="meta">${escHtml(tMeta)}</span>
      </div>
      <div style="font-size:12.5px;color:var(--text)">${escHtml(item.upn || '—')}</div>
      <div class="op-foot"><span>${item.whatif ? 'Safe' : 'Live'} · scheduled</span><span>${escHtml(item.status || 'pending')}</span></div>
    </div>`;
  }).join('');
}
function renderOpsCompleted(entries) {
  const body = document.getElementById('ops-completed-body');
  const count = document.getElementById('ops-completed-count');
  const summary = document.getElementById('ops-completed-summary');
  if (!body || !count) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const todays = entries.filter(e => e.timestamp && new Date(e.timestamp) >= today).slice(0, 6);
  count.textContent = todays.length;
  if (summary) {
    const ok = todays.filter(e => e.outcome === 'success').length;
    const partial = todays.filter(e => e.outcome === 'partial').length;
    summary.textContent = todays.length ? `${ok} ok · ${partial} partial` : '';
  }
  if (!todays.length) { body.innerHTML = '<div class="loading-hint">No completions today yet.</div>'; return; }
  body.innerHTML = todays.map((e, i) => {
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '—';
    const oc = (e.outcome || '').toLowerCase();
    return `<div class="op-card" data-op-idx="${i}" style="cursor:pointer">
      <div class="op-top">
        <span class="ag t-${escHtml((e.agent || '').toLowerCase())}">${escHtml(e.agent || '—')}</span>
        <span class="id">${escHtml((e.details?.ticketRef || e.id || '').toString().slice(0, 12))}</span>
        <span class="meta">${escHtml(ts)}</span>
      </div>
      <div style="font-size:12.5px;color:var(--text)">${escHtml((e.subject || '').split('@')[0] || '—')}</div>
      <div class="op-foot">
        <span style="color:${oc === 'success' ? 'var(--emerald)' : oc === 'partial' ? 'var(--amber)' : oc === 'failed' ? 'var(--coral)' : 'var(--muted)'}">● ${escHtml(oc || 'unknown')}</span>
        <span>${escHtml(e.operator || '—')}</span>
      </div>
    </div>`;
  }).join('');
  // Click a completed op card → show its full audit entry
  body.querySelectorAll('[data-op-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const e = todays[parseInt(card.dataset.opIdx, 10)];
      if (!e) return;
      showDetailPopover({
        title: `${e.agent || 'op'} · ${e.subject || ''}`,
        kv: [
          ['Time',       e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'],
          ['Outcome',    e.outcome || '—'],
          ['Operator',   e.operator || '—'],
          ['Mode',       e.whatif ? 'Safe' : 'Live'],
          ['Ticket',     e.details?.ticketRef || '—'],
        ],
        raw: e.details && Object.keys(e.details).length ? e.details : null,
        actions: [{ id: 'jump', label: 'Open in Audit Log', primary: true, onClick: () => switchTab('audit-log') }]
      });
    });
  });
}

function mergedCompletedOperations() {
  const terminal = [..._operationRecords.values()].filter(op => op.status !== 'running')
    .map(op => ({
      ...op,
      timestamp: op.completedAt || op.updatedAt,
      details: { error: op.error },
    }));
  const seen = new Set(terminal.map(op => op.id).filter(Boolean));
  return [...terminal, ..._opsAuditEntries.filter(entry => !entry.id || !seen.has(entry.id))]
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

function updateDashboardOperationStatus() {
  const operations = [..._operationRecords.values()]
    .sort((a, b) => new Date(b.updatedAt || b.startedAt || 0) - new Date(a.updatedAt || a.startedAt || 0));
  const current = operations.find(op => op.status === 'running')
    || operations.find(op => op.status === 'failed' || op.status === 'partial');
  if (!current) return;
  const sub = document.getElementById('dash-page-sub');
  if (!sub) return;
  const label = current.status === 'running' ? 'In flight'
    : current.status === 'failed' ? 'Failed' : 'Partial';
  sub.textContent = `${label}: ${current.agent || 'agent'} · ${current.subject || 'operation'}${current.error ? ' · ' + current.error : ''}`;
  sub.classList.toggle('operation-failed', current.status === 'failed');
}

function applyOperationStatus(operation) {
  if (!operation || !operation.id) return;
  _operationRecords.set(operation.id, operation);
  if (operation.status === 'running') {
    _inflightOps.set(operation.id, { ...operation, progress: 55, step: operation.stage || 'running' });
  } else {
    _inflightOps.delete(operation.id);
  }
  renderOpsInflight();
  renderOpsCompleted(mergedCompletedOperations());
  updateDashboardOperationStatus();
  lcApplyOperation(operation);
  window.JmlGlassScreen?.onOperationStatus(operation);
}

// Dashboard 7-day telemetry: bucket real operations by day so the bars reflect
// actual throughput, and expose each day's count on hover (data-label → CSS
// tooltip). Replaces the static placeholder bars.
function renderTelemetryChart(operations) {
  const chart = document.getElementById('v2-bar-chart');
  if (!chart) return;
  const bars = chart.querySelectorAll('.bar');
  if (!bars.length) return;
  const DAY = 86400000;
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const WK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = [];
  for (let i = 6; i >= 0; i--) {
    const start = today0 - i * DAY;
    buckets.push({ start, end: start + DAY, count: 0, date: new Date(start) });
  }
  let total = 0;
  (operations || []).forEach(op => {
    const t = Date.parse(op.completedAt || op.startedAt || op.updatedAt || '');
    if (!t) return;
    const b = buckets.find(x => t >= x.start && t < x.end);
    if (b) { b.count++; total++; }
  });
  const max = Math.max(1, ...buckets.map(b => b.count));
  buckets.forEach((b, i) => {
    const bar = bars[i];
    if (!bar) return;
    bar.style.height = (b.count ? Math.max(8, Math.round((b.count / max) * 100)) : 3) + '%';
    const dayLabel = WK[b.date.getDay()] + ' ' + b.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    bar.dataset.label = `${dayLabel} · ${b.count} op${b.count === 1 ? '' : 's'}`;
    bar.classList.toggle('empty', !b.count);
  });
  const daySpans = document.querySelectorAll('.v2-bar-days span');
  buckets.forEach((b, i) => { if (daySpans[i]) daySpans[i].textContent = WK[b.date.getDay()][0]; });
  const totalEl = document.getElementById('v2-telemetry-ops-total');
  if (totalEl) totalEl.textContent = `${total} ops · 7d`;
  const rangeEl = document.getElementById('v2-telemetry-range');
  if (rangeEl) rangeEl.textContent = buckets[0].date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' – ' + buckets[6].date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

window.api.onOperationStatus(applyOperationStatus);
window.api.onOperationStatuses(operations => {
  _operationRecords.clear();
  _inflightOps.clear();
  (operations || []).slice().reverse().forEach(applyOperationStatus);
  window.JmlGlassScreen?.onOperationStatuses(operations || []);
  renderTelemetryChart(operations || []);
});

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
  if (!op || !upn || !when) {
    showToast(!upn ? 'Enter a UPN before scheduling' : 'Choose a date and time', 'warn');
    return;
  }
  window.api.saveScheduledOp({
    operation: op,
    payload:   { userPrincipalName: upn, whatif },
    scheduledFor: new Date(when).toISOString(),
    createdBy: window.api.currentUser,
    whatif
  });
  document.getElementById('sched-upn').value  = '';
  document.getElementById('sched-when').value = '';
});

window.api.onScheduledOps((ops) => {
  // Also feed the Operations kanban Queued column
  const queuedItems = Array.isArray(ops)
    ? ops.filter(o => o.status === 'pending' || !o.status).map(o => ({
        id: o.id, op: o.operation, upn: (o.payload || {}).userPrincipalName,
        when: o.scheduledFor, whatif: o.whatif !== false && (o.payload || {}).whatif !== false, status: o.status || 'pending'
      }))
    : [];
  renderOpsQueued(queuedItems);
  renderOpsInflight();

  const el = document.getElementById('sched-list');
  if (!Array.isArray(ops) || !ops.length) {
    el.innerHTML = '<div class="loading-hint">No scheduled operations.</div>';
    return;
  }
  el.innerHTML = ops.map(op => {
    const when    = op.scheduledFor ? new Date(op.scheduledFor).toLocaleString() : '—';
    const errHtml = (op.status === 'failed' && op.error)
      ? `<div class="sched-error-detail">${escHtml(op.error)}</div>`
      : '';
    return `<div class="sched-item" data-id="${escHtml(op.id)}">
      <span class="sched-op">${escHtml(op.operation || '')}</span>
      <span class="sched-upn">${escHtml((op.payload && op.payload.userPrincipalName) || '')}</span>
      <span class="sched-when">${escHtml(when)}</span>
      <span class="sched-status ${escHtml(op.status || 'pending')}">${escHtml(op.status || 'pending')}</span>
      ${op.status === 'pending' ? '<button class="btn-danger btn-cancel-sched" data-id="' + escHtml(op.id) + '">Cancel</button>' : ''}
      ${errHtml}
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
    // Stacked decision bar: approved (emerald) / revoked (coral) / pending (amber)
    const total = c.totalCount || 0;
    const approved = c.approvedCount || 0;
    const revoked  = c.revokedCount  || 0;
    const pending  = total - approved - revoked;
    const pct = (n) => total ? Math.max(0, Math.min(100, (n / total) * 100)) : 0;
    const barHtml = total
      ? `<div class="bar" style="margin-top:14px;height:6px;background:oklch(0.24 0.018 252);border-radius:99px;overflow:hidden;display:flex">
          <i class="approved" style="height:100%;display:block;width:${pct(approved)}%"></i>
          <i class="revoked"  style="height:100%;display:block;width:${pct(revoked)}%"></i>
          <i class="pending"  style="height:100%;display:block;width:${pct(pending)}%"></i>
        </div>
        <div style="display:flex;gap:14px;margin-top:8px;font-family:var(--mono);font-size:11px;color:var(--text-2)">
          <span><span style="color:var(--emerald)">●</span> approved ${approved}</span>
          <span><span style="color:var(--coral)">●</span> revoked ${revoked}</span>
          <span><span style="color:var(--amber)">●</span> pending ${pending}</span>
        </div>`
      : '';
    return '<div class="cert-campaign-card camp">'
      + '<div class="c-info">'
        + '<div class="cert-campaign-header ttl">'
          + '<div class="cert-campaign-type-icon">' + typeIcon + '</div>'
          + '<div class="cert-campaign-name">' + escHtml(c.displayName || c.id || 'Unnamed Campaign') + '</div>'
          + '<span class="cert-status-badge ' + sm.cls + '">' + sm.label + '</span>'
        + '</div>'
        + '<div class="cert-campaign-meta">'
          + '<span class="cert-meta-item"><span class="dim-label">Type</span> ' + escHtml(c.type || '—') + '</span>'
          + '<span class="cert-meta-item"><span class="dim-label">Created</span> ' + created + '</span>'
          + (decisions ? '<span class="cert-meta-item"><span class="dim-label">Progress</span> ' + escHtml(decisions) + '</span>' : '')
        + '</div>'
        + barHtml
      + '</div>'
    + '</div>';
  }).join('');
});

window.api.onCertHistory((entries) => {
  const el = document.getElementById('cert-history-body');
  if (!entries || !entries.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
      </div>
      <div class="empty-state-title">No campaign history</div>
      <div class="empty-state-body">Run a campaign above to start building an attestation record.</div>
    </div>`;
    return;
  }

  // Group by campaign subject name
  const grouped = {};
  entries.forEach(e => {
    const key = e.subject || 'Unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  });

  el.innerHTML = Object.entries(grouped).map(([name, runs]) => {
    const total  = runs.length;
    const passed = runs.filter(r => r.outcome === 'success').length;
    const failed = runs.filter(r => r.outcome === 'failed').length;
    const pct    = total ? Math.round((passed / total) * 100) : 0;
    const last   = runs[0]; // most recent first
    const lastTs = last && last.timestamp ? new Date(last.timestamp).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : '—';
    const lastMode = last && !last.whatif ? '<span class="badge-live">Live</span>' : '<span class="badge-whatif">Safe</span>';
    const passColor = pct >= 80 ? 'var(--emerald)' : pct >= 50 ? 'var(--amber)' : 'var(--coral)';

    const runRows = runs.slice(0, 8).map(r => {
      const ts  = r.timestamp ? new Date(r.timestamp).toLocaleString() : '—';
      const ok  = r.outcome === 'success';
      const fail= r.outcome === 'failed';
      const icon = ok ? '<span style="color:var(--emerald)">✓</span>' : fail ? '<span style="color:var(--coral)">✗</span>' : '<span style="color:var(--amber)">○</span>';
      const mode = r.whatif ? '<span class="badge-whatif">Safe</span>' : '<span class="badge-live">Live</span>';
      return `<div class="cert-hist-entry">
        <div class="cert-hist-icon">${icon}</div>
        <div class="cert-hist-body">
          <div class="cert-hist-top"><span style="font-family:var(--mono);font-size:11px;color:var(--text-2)">${escHtml(ts)}</span>${mode}</div>
        </div>
      </div>`;
    }).join('');

    const isPerfect = pct === 100;
    return `<details class="cert-campaign-group${isPerfect ? ' ccg-perfect' : ''}"${isPerfect ? '' : ''}>
      <summary>
        <div class="ccg-left">
          <span class="ccg-name">${escHtml(name)}</span>
          <span class="ccg-meta">${total} run${total !== 1 ? 's' : ''} · last ${escHtml(lastTs)}</span>
        </div>
        <div class="ccg-right">
          <span class="ccg-pass-rate" style="color:${passColor}">${pct}% pass</span>
          ${lastMode}
          ${isPerfect ? '<span class="ccg-checkmark">✓</span>' : '<span class="ccg-chevron">›</span>'}
        </div>
      </summary>
      <div class="ccg-runs">${runRows}</div>
    </details>`;
  }).join('');
});

// ── Settings tab ──────────────────────────────────────────────────────────────
let _policies = {};
let _sod      = {};
let _operators = {};
let _operatorAuth = {};  // { user: { mode: 'pin'|'windows'|'none', set: bool } }

async function loadOperatorAuth() {
  try { _operatorAuth = await window.api.getOperatorAuth() || {}; }
  catch { _operatorAuth = {}; }
  if (typeof renderOperators === 'function') renderOperators();
}
function saveOperatorAuth() { /* writes happen server-side via setOperatorAuthPin/Windows */ }

async function promptSetPin(user) {
  const result = await showPinModal({
    title: `Set PIN for ${user}`,
    body: 'Choose a 4–8 digit PIN. This PIN will be required before Live writes and approvals.',
    confirm: true
  });
  if (!result || !result.pin) return;
  const resp = await window.api.setOperatorAuthPin(user, result.pin);
  if (resp && resp.ok) {
    showToast('PIN set for ' + user, 'success');
    await loadOperatorAuth();
  } else {
    showToast('Failed to set PIN: ' + (resp && resp.error || 'unknown'), 'error');
  }
}

// Returns { pin } on confirm, null on cancel
function showPinModal(opts) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pin-overlay';
    overlay.innerHTML = `
      <div class="pin-modal">
        <div class="pin-header">
          <div class="pin-title">${escHtml(opts.title || 'Enter PIN')}</div>
          <div class="pin-sub">${escHtml(opts.body || '')}</div>
        </div>
        <div class="pin-body">
          <input type="password" class="pin-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" autofocus maxlength="12" placeholder="PIN" />
          ${opts.confirm ? '<input type="password" class="pin-confirm" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="12" placeholder="Confirm PIN" />' : ''}
          <div class="pin-error" style="display:none;color:var(--coral);font-size:11.5px;font-family:var(--mono)"></div>
        </div>
        <div class="pin-footer">
          <button class="btn ghost pin-cancel">Cancel</button>
          <button class="btn primary pin-ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const pinInput = overlay.querySelector('.pin-input');
    const confirmInput = overlay.querySelector('.pin-confirm');
    const errorEl = overlay.querySelector('.pin-error');
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.pin-cancel').addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(null); });
    const submit = () => {
      const pin = (pinInput.value || '').trim();
      if (pin.length < 4) { errorEl.textContent = 'PIN must be at least 4 characters'; errorEl.style.display = ''; return; }
      if (confirmInput && pin !== confirmInput.value) { errorEl.textContent = 'PINs do not match'; errorEl.style.display = ''; return; }
      cleanup({ pin });
    };
    overlay.querySelector('.pin-ok').addEventListener('click', submit);
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') (confirmInput ? confirmInput.focus() : submit()); else if (e.key === 'Escape') cleanup(null); });
    if (confirmInput) confirmInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') cleanup(null); });
    setTimeout(() => pinInput.focus(), 50);
  });
}

// Gate: if operator has write access + PIN/Windows mode, prompt for verification.
// Returns a short-TTL write token on success, null on denial/cancellation. The
// token must be attached to the next write-IPC call; main.js enforces this.
// Viewer/guest skip the gate and return `true` (no token needed since they
// can't reach Live mode anyway).
async function requirePinIfNeeded(reason) {
  // operator-auth.json is keyed by OPERATOR NAME (chosen at sign-in), not the
  // Windows username. Use currentOperatorName which was set by setSidebarOperator
  // — falls back to Windows username only if no operator is selected.
  const opName = currentOperatorName || window.api.currentUser;
  const role = currentOperatorRole();
  const writeAccess = role === 'admin' || role === 'helpdesk';
  if (!writeAccess) return true;
  await loadOperatorAuth();
  let a = _operatorAuth[opName];
  if (!a || a.mode === 'none' || !a.set) {
    // No PIN configured — offer to set one up RIGHT NOW so the user isn't dead-ended.
    const want = await confirmModal({
      title: `Set up authentication for "${opName}"`,
      body: 'Your operator account has write access but no PIN is configured. Set a PIN now to continue.',
      okLabel: 'Set PIN',
      cancelLabel: 'Not now',
    });
    if (!want) return null;
    const setup = await showPinModal({
      title: `Choose a PIN for ${opName}`,
      body: '4–8 digits. Required for Live writes and approvals.',
      confirm: true,
    });
    if (!setup) return null;
    const resp = await window.api.setOperatorAuthPin(opName, setup.pin);
    if (!(resp && resp.ok)) {
      showToast('Failed to set PIN: ' + (resp && resp.error || 'unknown'), 'error');
      return null;
    }
    showToast('PIN set — verify to continue', 'success');
    await loadOperatorAuth();
    a = _operatorAuth[opName];
    if (!a) return null;
  }
  const result = await showPinModal({
    title: reason || 'Confirm with PIN',
    body: a.mode === 'windows' ? 'Windows-authenticated session — confirm with your PIN to proceed.' : `Enter PIN for ${opName} to proceed.`
  });
  if (!result) return null;
  const resp = await window.api.verifyOperatorPin(opName, result.pin);
  if (!(resp && resp.ok)) {
    showToast('PIN incorrect', 'error');
    return null;
  }
  // Return the short-TTL write token; renderer attaches it to mutating IPC.
  return resp.writeToken || true;
}
let _roles     = {};

function loadSettings() {
  window.api.getPolicy();
  window.api.getOperators();
  loadOperatorAuth();
  loadOperatorActivity();
  loadTenantConfig();
}

// ── AI Provider settings ──────────────────────────────────────────────────────
(function () {
  const SECTIONS = ['claude', 'openai', 'azure-foundry', 'azure-openai', 'ollama', 'lmstudio', 'qwen'];

  function showSection(provider) {
    SECTIONS.forEach(p => {
      const el = document.getElementById('ai-prov-' + p);
      if (el) el.style.display = p === provider ? '' : 'none';
    });
  }

  const sel = document.getElementById('ai-provider-select');
  if (sel) sel.addEventListener('change', () => showSection(sel.value));

  async function loadAiProvider() {
    if (typeof window.api?.getAiProviderConfig !== 'function') return;
    const cfg = await window.api.getAiProviderConfig();
    if (!cfg) return;

    if (sel) sel.value = cfg.provider || 'claude';
    showSection(cfg.provider || 'claude');

    // Claude
    const c = cfg.claude || {};
    setVal('ai-claude-key',        c.apiKey     || '');
    setVal('ai-claude-agent-model',c.agentModel || 'claude-opus-4-7');
    setVal('ai-claude-fast-model', c.fastModel  || 'claude-haiku-4-5-20251001');

    // OpenAI
    const o = cfg.openai || {};
    setVal('ai-openai-key',        o.apiKey     || '');
    setVal('ai-openai-agent-model',o.agentModel || 'gpt-4o');
    setVal('ai-openai-fast-model', o.fastModel  || 'gpt-4o-mini');

    // Azure AI Foundry
    const af = cfg['azure-foundry'] || {};
    setVal('ai-foundry-key',        af.apiKey     || '');
    setVal('ai-foundry-endpoint',   af.endpoint   || 'https://models.inference.ai.azure.com');
    setVal('ai-foundry-agent-model',af.agentModel || 'gpt-4o');
    setVal('ai-foundry-fast-model', af.fastModel  || 'gpt-4o-mini');

    // Azure OpenAI
    const az = cfg['azure-openai'] || {};
    setVal('ai-azure-key',         az.apiKey          || '');
    setVal('ai-azure-endpoint',    az.endpoint         || '');
    setVal('ai-azure-agent-deploy',az.agentDeployment  || 'gpt-4o');
    setVal('ai-azure-fast-deploy', az.fastDeployment   || 'gpt-4o-mini');
    setVal('ai-azure-api-version', az.apiVersion       || '2025-01-01-preview');

    // Ollama
    const ol = cfg.ollama || {};
    setVal('ai-ollama-url',        ol.baseUrl    || 'http://localhost:11434');
    setVal('ai-ollama-agent-model',ol.agentModel || 'llama3.1');
    setVal('ai-ollama-fast-model', ol.fastModel  || 'llama3.1');

    // Qwen (local)
    const lm = cfg.lmstudio || {};
    setVal('ai-lmstudio-url',        lm.baseUrl    || 'http://localhost:1234');
    setVal('ai-lmstudio-agent-model',lm.agentModel || 'qwen2.5-7b-instruct');
    setVal('ai-lmstudio-fast-model', lm.fastModel  || 'qwen2.5-7b-instruct');
    const qw = cfg.qwen || {};
    setVal('ai-qwen-url',        qw.baseUrl    || 'http://localhost:11434');
    setVal('ai-qwen-agent-model',qw.agentModel || 'qwen3:14b');
    setVal('ai-qwen-fast-model', qw.fastModel  || 'qwen3:4b');

    updateStatusPip(cfg.provider);
  }

  function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
  function getVal(id)    { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

  function updateStatusPip(provider) {
    const pip = document.getElementById('ai-provider-status-pip');
    if (!pip) return;
    const labels = { claude: 'Claude', openai: 'OpenAI', 'azure-foundry': 'Azure AI Foundry', 'azure-openai': 'Azure OpenAI', ollama: 'Ollama', lmstudio: 'LM Studio', qwen: 'Qwen' };
    pip.innerHTML = `<span class="d" style="background:var(--green)"></span>${labels[provider] || provider || 'None'}`;
  }

  function feedback(msg, isErr) {
    const el = document.getElementById('ai-provider-feedback');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? 'var(--coral)' : 'var(--green)';
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
  }

  function buildConfig() {
    return {
      provider: sel ? sel.value : 'claude',
      claude: {
        apiKey:     getVal('ai-claude-key'),
        agentModel: getVal('ai-claude-agent-model') || 'claude-opus-4-7',
        fastModel:  getVal('ai-claude-fast-model')  || 'claude-haiku-4-5-20251001'
      },
      openai: {
        apiKey:     getVal('ai-openai-key'),
        agentModel: getVal('ai-openai-agent-model') || 'gpt-4o',
        fastModel:  getVal('ai-openai-fast-model')  || 'gpt-4o-mini'
      },
      'azure-foundry': {
        apiKey:     getVal('ai-foundry-key'),
        endpoint:   getVal('ai-foundry-endpoint')    || 'https://models.inference.ai.azure.com',
        agentModel: getVal('ai-foundry-agent-model') || 'gpt-4o',
        fastModel:  getVal('ai-foundry-fast-model')  || 'gpt-4o-mini'
      },
      'azure-openai': {
        apiKey:          getVal('ai-azure-key'),
        endpoint:        getVal('ai-azure-endpoint'),
        agentDeployment: getVal('ai-azure-agent-deploy') || 'gpt-4o',
        fastDeployment:  getVal('ai-azure-fast-deploy')  || 'gpt-4o-mini',
        apiVersion:      getVal('ai-azure-api-version')  || '2025-01-01-preview'
      },
      ollama: {
        baseUrl:    getVal('ai-ollama-url')         || 'http://localhost:11434',
        agentModel: getVal('ai-ollama-agent-model') || 'llama3.1',
        fastModel:  getVal('ai-ollama-fast-model')  || 'llama3.1'
      },
      lmstudio: {
        baseUrl:    getVal('ai-lmstudio-url')         || 'http://localhost:1234',
        agentModel: getVal('ai-lmstudio-agent-model') || 'qwen2.5-7b-instruct',
        fastModel:  getVal('ai-lmstudio-fast-model')  || 'qwen2.5-7b-instruct'
      },
      qwen: {
        baseUrl:    getVal('ai-qwen-url')         || 'http://localhost:11434',
        agentModel: getVal('ai-qwen-agent-model') || 'qwen3:14b',
        fastModel:  getVal('ai-qwen-fast-model')  || 'qwen3:4b'
      }
    };
  }

  const saveBtn = document.getElementById('ai-provider-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (typeof window.api?.saveAiProviderConfig !== 'function') return;
      saveBtn.disabled = true;
      const resp = await window.api.saveAiProviderConfig(buildConfig());
      saveBtn.disabled = false;
      if (resp && resp.ok) {
        feedback('Saved');
        updateStatusPip(sel ? sel.value : '');
      } else {
        feedback(resp?.error || 'Save failed', true);
      }
    });
  }

  const testBtn = document.getElementById('ai-provider-test-btn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      if (typeof window.api?.testAiProvider !== 'function') return;
      testBtn.disabled = true;
      feedback('Testing…');
      const resp = await window.api.testAiProvider();
      testBtn.disabled = false;
      if (resp && resp.ok) {
        feedback(`Connected · ${resp.provider} · "${resp.text}"`);
      } else {
        feedback(resp?.error || 'Connection failed', true);
      }
    });
  }

  // ── AI observability / run telemetry ──────────────────────────────────────
  async function loadAiTraces() {
    if (typeof window.api?.getAiTraces !== 'function') return;
    const data = await window.api.getAiTraces(50);
    const s = (data && data.summary) || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ai-tr-count', s.count ?? 0);
    set('ai-tr-in',  (s.totalInputTokens  ?? 0).toLocaleString());
    set('ai-tr-out', (s.totalOutputTokens ?? 0).toLocaleString());
    set('ai-tr-lat', (s.avgLatencyMs ?? 0) + ' ms');
    const list = document.getElementById('ai-traces-list');
    if (!list) return;
    const traces = (data && data.traces) || [];
    if (!traces.length) { list.innerHTML = '<div style="color:var(--text-4)">No model runs recorded yet. Chat with an agent to populate telemetry.</div>'; return; }
    list.innerHTML = traces.map(t => {
      const ts = t.ts ? new Date(t.ts).toLocaleTimeString() : '—';
      const tok = (t.inputTokens != null || t.outputTokens != null) ? `${t.inputTokens ?? '?'}→${t.outputTokens ?? '?'} tok` : 'tokens n/a';
      return `<div style="display:flex;gap:10px;padding:3px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--text-4);min-width:64px">${ts}</span>
        <span style="min-width:62px">${escHtml(t.agent || '')}</span>
        <span style="flex:1;color:var(--text-2)">${escHtml(t.provider || '')} · ${escHtml(t.model || '')}</span>
        <span style="color:var(--cyan)">${tok}</span>
        <span style="min-width:60px;text-align:right">${t.latencyMs ?? '?'} ms</span>
      </div>`;
    }).join('');
  }
  document.getElementById('ai-traces-refresh')?.addEventListener('click', loadAiTraces);

  // Expose for sub-tab navigation hook
  window._loadAiProvider = () => { loadAiProvider(); loadAiTraces(); };
})();

async function loadOperatorActivity() {
  const body = document.getElementById('op-activity-body');
  if (!body || typeof window.api?.getOperatorActivity !== 'function') return;
  try {
    const resp = await window.api.getOperatorActivity(50);
    const entries = (resp && resp.entries) || [];
    if (!entries.length) { body.innerHTML = '<div class="loading-hint" style="padding:14px">No activity recorded yet.</div>'; return; }
    body.innerHTML = entries.map(e => {
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      const tsLabel = ts ? `${ts.getMonth()+1}/${ts.getDate()} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}` : '—';
      const evt = e.event || '';
      const evtColor = evt.includes('fail') ? 'var(--coral)' : evt.includes('verify.ok') ? 'var(--emerald)' : evt.startsWith('tenant') ? 'var(--amber)' : 'var(--cyan)';
      const target = e.details && (e.details.target || e.details.tenantId);
      const opName = e.operator || '—';
      const opRole = e.role || '';
      return `<div style="display:grid;grid-template-columns:80px minmax(0,1fr) minmax(120px,210px);gap:10px;padding:6px 0;border-top:1px solid var(--border);align-items:baseline">
        <span style="color:var(--muted)">${escHtml(tsLabel)}</span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="color:${evtColor}">${escHtml(evt)}</span>${target ? ` · ${escHtml(target)}` : ''}</span>
        <span title="${escHtml(opName + (opRole ? ' · ' + opRole : ''))}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--text-2)">${escHtml(opName)} · <span style="color:var(--muted)">${escHtml(opRole)}</span></span>
      </div>`;
    }).join('');
  } catch (e) {
    body.innerHTML = '<div class="loading-hint" style="padding:14px;color:var(--coral)">Error: ' + escHtml(e.message) + '</div>';
  }
}
document.getElementById('btn-refresh-op-activity')?.addEventListener('click', loadOperatorActivity);

// ── Notification routing rules ──────────────────────────────────────────────
let _notifRules = [];
async function loadNotificationRules() {
  if (typeof window.api?.getNotificationRules !== 'function') return;
  try {
    const resp = await window.api.getNotificationRules();
    _notifRules = (resp && resp.rules) || [];
    renderNotificationRules();
  } catch (_) { /* non-fatal */ }
}
function renderNotificationRules() {
  const tbody = document.getElementById('notif-rules-tbody');
  if (!tbody) return;
  if (!_notifRules.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:18px;text-align:center;color:var(--muted);font-size:12px">No rules configured. Add one below.</td></tr>';
    return;
  }
  const sevColor = { info: 'var(--cyan)', warning: 'var(--amber)', critical: 'var(--coral)' };
  tbody.innerHTML = _notifRules.map((r, idx) => `
    <tr style="display:grid;grid-template-columns:1fr 110px 1fr auto;gap:12px;padding:10px 18px;border-top:1px solid var(--border);align-items:center;font-family:var(--mono);font-size:12px">
      <td style="color:var(--text)">${escHtml(r.event)}</td>
      <td><span class="role-badge" style="color:${sevColor[r.severity] || 'var(--muted)'};border-color:${sevColor[r.severity] || 'var(--border)'};background:transparent">${escHtml(r.severity)}</span></td>
      <td style="display:flex;flex-wrap:wrap;gap:4px">${(r.channels || []).map(c => `<span class="policy-tag" style="padding:2px 8px;font-size:10.5px">${escHtml(c)}</span>`).join('')}</td>
      <td><button class="btn-del-sod" data-notif-idx="${idx}">Remove</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-notif-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      _notifRules.splice(parseInt(btn.dataset.notifIdx, 10), 1);
      renderNotificationRules();
    });
  });
}
document.getElementById('btn-notif-add')?.addEventListener('click', () => {
  const evt = document.getElementById('notif-add-event').value;
  const severity = document.getElementById('notif-add-severity').value;
  const channels = [...document.querySelectorAll('.notif-add-ch:checked')].map(c => c.value);
  if (!channels.length) { showToast('Pick at least one channel', 'warning'); return; }
  // Replace existing rule for same event, or add new
  const existing = _notifRules.findIndex(r => r.event === evt);
  const rule = { id: 'rule-' + Date.now().toString(36), event: evt, severity, channels };
  if (existing >= 0) _notifRules[existing] = rule;
  else _notifRules.push(rule);
  renderNotificationRules();
});
// ── Tenant onboarding wizard ────────────────────────────────────────────────
(function() {
  const overlay = document.getElementById('wizard-overlay');
  const stepLabel = document.getElementById('wizard-step-label');
  if (!overlay || !document.getElementById('btn-tenant-wizard')) return;

  let _wizState = { step: 1, tenantId: '', account: '', createdApps: [] };
  let _signinPoll = null;

  function showStep(n) {
    _wizState.step = n;
    document.querySelectorAll('.wiz-step').forEach(s => s.style.display = (+s.dataset.step === n) ? '' : 'none');
    const labels = ['', 'Sign in', 'Create app registrations', 'Consent & save', 'Deploy certificates'];
    if (stepLabel) stepLabel.textContent = `Step ${n} of 4 · ${labels[n] || ''}`;
    document.getElementById('wizard-next').style.display =
      ((n === 1 && _wizState.tenantId) || (n === 2 && _wizState.createdApps.length)) ? '' : 'none';
    document.getElementById('wizard-finish').style.display   = n === 3 ? '' : 'none';
    document.getElementById('wizard-deploy-certs').style.display = n === 4 ? '' : 'none';
    document.getElementById('wizard-skip-certs').style.display   = n === 4 ? '' : 'none';
  }
  function openWizard() {
    _wizState = { step: 1, tenantId: '', account: '', createdApps: [] };
    overlay.style.display = 'flex';
    document.getElementById('wizard-signin-pending').style.display = 'none';
    document.getElementById('wizard-signin-success').style.display = 'none';
    document.getElementById('wizard-signin-error').style.display = 'none';
    showStep(1);
  }
  function closeWizard() {
    if (_signinPoll) { clearInterval(_signinPoll); _signinPoll = null; }
    overlay.style.display = 'none';
  }

  document.getElementById('btn-tenant-wizard').addEventListener('click', openWizard);
  document.getElementById('wizard-cancel').addEventListener('click', closeWizard);

  // Step 1 — start device-code sign-in
  document.getElementById('wizard-start-signin').addEventListener('click', async () => {
    const errEl = document.getElementById('wizard-signin-error');
    errEl.style.display = 'none';
    const resp = await window.api.startDeviceCodeSignin();
    if (!resp || !resp.ok) {
      errEl.textContent = (resp && resp.error) || 'Failed to start sign-in';
      errEl.style.display = '';
      return;
    }
    document.getElementById('wizard-signin-pending').style.display = '';
    if (_signinPoll) clearInterval(_signinPoll);
    let _urlOpened = false;
    _signinPoll = setInterval(async () => {
      const s = await window.api.checkDeviceCodeStatus();
      if (s.deviceCode) document.getElementById('wizard-device-code').textContent = s.deviceCode;
      if (s.verificationUrl) {
        document.getElementById('wizard-verify-url').textContent = s.verificationUrl;
        // Auto-open verification URL in browser the first time it arrives
        if (!_urlOpened) {
          _urlOpened = true;
          if (typeof window.api?.openExternal === 'function') window.api.openExternal(s.verificationUrl);
        }
      }
      if (s.status === 'success') {
        clearInterval(_signinPoll); _signinPoll = null;
        _wizState.tenantId = s.tenantId; _wizState.account = s.account;
        document.getElementById('wizard-signin-pending').style.display = 'none';
        document.getElementById('wizard-tenant-id').textContent = s.tenantId;
        document.getElementById('wizard-account').textContent = s.account;
        document.getElementById('wizard-signin-success').style.display = '';
        document.getElementById('wizard-next').style.display = '';
      } else if (s.status === 'error') {
        clearInterval(_signinPoll); _signinPoll = null;
        errEl.textContent = s.error || 'Sign-in failed';
        errEl.style.display = '';
        document.getElementById('wizard-signin-pending').style.display = 'none';
      }
    }, 2000);
  });

  // Wizard step 1 — Copy code button
  document.getElementById('wizard-copy-code')?.addEventListener('click', () => {
    const code = document.getElementById('wizard-device-code').textContent.trim();
    if (code && code !== '—') {
      navigator.clipboard.writeText(code).then(() => showToast('Device code copied')).catch(() => showToast('Copy failed', 'warn'));
    }
  });

  // Wizard step 1 — Open URL button
  document.getElementById('wizard-open-url')?.addEventListener('click', () => {
    const url = document.getElementById('wizard-verify-url').textContent.trim();
    if (url && url !== '—' && typeof window.api?.openExternal === 'function') {
      window.api.openExternal(url);
    }
  });

  // Step 2 — create app regs
  document.getElementById('wizard-create-appregs').addEventListener('click', async () => {
    const list = document.getElementById('wizard-appreg-list');
    const agents = ['joiner', 'mover', 'leaver', 'enroller', 'certifier', 'approver', 'provisioner', 'auditor'];
    list.innerHTML = agents.map(a => `<div data-app="${a}" style="display:grid;grid-template-columns:120px 1fr;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text)">${a}</span><span class="status" style="color:var(--muted)">waiting…</span></div>`).join('');
    const resp = await window.api.createAgentAppRegistrations(agents);
    if (!resp || !resp.ok) { showToast(resp?.error || 'create failed', 'error'); return; }
    _wizState.createdApps = resp.created || [];
    // Update statuses
    agents.forEach(a => {
      const row = list.querySelector(`[data-app="${a}"] .status`);
      const created = (resp.created || []).find(c => c.agent === a);
      const err = (resp.errors || []).find(e => e.agent === a);
      if (created) { row.style.color = 'var(--emerald)'; row.innerHTML = `✓ <span style="font-size:11px">${created.appId.slice(0, 8)}…</span>`; }
      else if (err) { row.style.color = 'var(--coral)'; row.textContent = '✗ ' + err.error.slice(0, 40); }
      else { row.style.color = 'var(--muted)'; row.textContent = 'skipped'; }
    });
    document.getElementById('wizard-next').style.display = '';
  });

  // Step navigation
  document.getElementById('wizard-next').addEventListener('click', () => {
    if (_wizState.step === 1) showStep(2);
    else if (_wizState.step === 2) {
      // Populate consent links
      const list = document.getElementById('wizard-consent-list');
      list.innerHTML = _wizState.createdApps.map(c => {
        const url = `https://login.microsoftonline.com/${_wizState.tenantId}/adminconsent?client_id=${c.appId}`;
        return `<div style="display:grid;grid-template-columns:120px 1fr auto;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);align-items:center">
          <span style="color:var(--text)">${escHtml(c.agent)}</span>
          <span style="color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(c.appId)}</span>
          <a href="${url}" target="_blank" rel="noopener" class="btn-text-link" style="font-family:var(--mono);font-size:11px">Grant consent →</a>
        </div>`;
      }).join('');
      showStep(3);
    }
  });

  // Finish — push tenant id + client ids into the existing tenant config form, save
  // Step 3 finish — save tenant config then proceed to cert deployment
  document.getElementById('wizard-finish').addEventListener('click', async () => {
    document.getElementById('set-tenant-id-input').value = _wizState.tenantId;
    _wizState.createdApps.forEach(c => {
      const input = document.querySelector(`.set-clientid[data-agent="${c.agent}"]`);
      if (input) input.value = c.appId;
    });
    // Save silently (no diff modal) so we can proceed to cert step
    if (typeof window.api?.saveTenantConfig === 'function') {
      const clientIds = {};
      _wizState.createdApps.forEach(c => { clientIds[c.agent] = c.appId; });
      await window.api.saveTenantConfig({ tenantId: _wizState.tenantId, clientIds });
    }
    // Populate cert list for step 4
    const certList = document.getElementById('wizard-cert-list');
    certList.innerHTML = _wizState.createdApps.map(c =>
      `<div data-agent="${escHtml(c.agent)}" style="display:grid;grid-template-columns:120px 1fr;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--text)">${escHtml(c.agent)}</span>
        <span class="wiz-cert-status" style="color:var(--muted)">ready to deploy</span>
      </div>`
    ).join('');
    showStep(4);
  });

  // Step 4 — deploy certs
  document.getElementById('wizard-deploy-certs').addEventListener('click', async () => {
    const btn = document.getElementById('wizard-deploy-certs');
    btn.disabled = true; btn.textContent = 'Deploying…';
    const statusEl = document.getElementById('wizard-cert-status');
    statusEl.style.display = 'none';

    // Mark all as pending
    document.querySelectorAll('#wizard-cert-list [data-agent]').forEach(row => {
      row.querySelector('.wiz-cert-status').style.color = 'var(--muted)';
      row.querySelector('.wiz-cert-status').textContent = 'deploying…';
    });

    const agents = _wizState.createdApps.map(c => ({ agent: c.agent, clientId: c.appId }));
    const resp = await window.api.deployAgentCertificates(agents);

    if (!resp || !resp.ok) {
      statusEl.style.cssText = 'display:block;color:var(--coral);background:oklch(0.30 0.10 24 / .15);border:1px solid oklch(0.45 0.16 24 / .35);border-radius:8px;padding:10px';
      statusEl.textContent = resp?.error || 'Certificate deployment failed';
      btn.disabled = false; btn.textContent = 'Retry';
      return;
    }

    (resp.results || []).forEach(r => {
      const row = document.querySelector(`#wizard-cert-list [data-agent="${r.agent}"]`);
      if (!row) return;
      const st = row.querySelector('.wiz-cert-status');
      if (r.ok) {
        st.style.color = 'var(--emerald)';
        st.textContent = `✓ ${r.thumbprint ? r.thumbprint.slice(0, 10) + '…' : 'deployed'}`;
      } else {
        st.style.color = 'var(--coral)';
        st.textContent = '✗ ' + (r.error || 'failed').slice(0, 60);
      }
    });

    const ok = (resp.results || []).filter(r => r.ok).length;
    const total = (resp.results || []).length;
    statusEl.style.cssText = `display:block;padding:10px;border-radius:8px;${ok === total
      ? 'color:var(--emerald);background:oklch(0.30 0.06 155 / .15);border:1px solid oklch(0.50 0.13 155 / .35)'
      : 'color:var(--amber);background:oklch(0.30 0.10 60 / .15);border:1px solid oklch(0.55 0.14 60 / .35)'}`;
    statusEl.textContent = ok === total
      ? `✓ All ${total} certificates deployed. Agents are ready to authenticate.`
      : `${ok} of ${total} succeeded. Fix errors above, then retry.`;
    btn.disabled = false;
    btn.textContent = ok === total ? '✓ Done' : 'Retry failed';
    if (ok === total) {
      document.getElementById('wizard-skip-certs').textContent = 'Close';
      showToast('Agent certificates deployed — fleet ready on this PC', 'success');
    }
  });

  // Step 4 — skip / close
  document.getElementById('wizard-skip-certs').addEventListener('click', () => {
    closeWizard();
    loadTenantConfig();
    showToast('You can deploy certificates later from Settings → Agent Certificates', 'info');
  });
})();

// ── "Deploy on this PC" button in Settings > Agent Certificates ──────────────
(function () {
  const btn = document.getElementById('btn-deploy-certs-here');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const statusEl = document.getElementById('deploy-certs-status');
    // If wizard sign-in is already complete, skip straight to deploy.
    // Otherwise we need a fresh device-code sign-in.
    const state = await window.api.checkDeviceCodeStatus();
    if (state.status !== 'success') {
      statusEl.style.cssText = 'display:block;color:var(--text-2)';
      statusEl.textContent = 'Starting device-code sign-in — a browser window will open…';
      const r = await window.api.startDeviceCodeSignin();
      if (!r?.ok) {
        statusEl.style.color = 'var(--coral)';
        statusEl.textContent = '✗ ' + (r?.error || 'Could not start sign-in. Use the Setup Wizard for a guided flow.');
        return;
      }
      // Poll until signed in
      btn.disabled = true; btn.textContent = 'Waiting for sign-in…';
      await new Promise(resolve => {
        const poll = setInterval(async () => {
          const s = await window.api.checkDeviceCodeStatus();
          if (s.deviceCode) statusEl.textContent = `Sign in at ${s.verificationUrl || 'https://microsoft.com/devicelogin'} with code: ${s.deviceCode}`;
          if (s.verificationUrl && typeof window.api?.openExternal === 'function') {
            window.api.openExternal(s.verificationUrl);
          }
          if (s.status === 'success' || s.status === 'error') { clearInterval(poll); resolve(s); }
        }, 2000);
      });
      const s2 = await window.api.checkDeviceCodeStatus();
      if (s2.status !== 'success') {
        statusEl.style.color = 'var(--coral)';
        statusEl.textContent = '✗ Sign-in failed: ' + (s2.error || 'unknown error');
        btn.disabled = false; btn.textContent = '⬇ Deploy on this PC';
        return;
      }
    }
    btn.disabled = true; btn.textContent = 'Deploying certificates…';
    statusEl.style.cssText = 'display:block;color:var(--text-2)';
    statusEl.textContent = 'Creating and uploading certificates for all agents…';
    const resp = await window.api.deployAgentCertificates(null);
    const ok = (resp?.results || []).filter(r => r.ok).length;
    const total = (resp?.results || []).length;
    const lines = (resp?.results || []).map(r => `${r.agent}: ${r.ok ? '✓ ' + (r.thumbprint || '').slice(0,10) : '✗ ' + (r.error || 'failed').slice(0,60)}`).join('\n');
    statusEl.style.cssText = `display:block;white-space:pre;padding:10px;border-radius:8px;${ok === total
      ? 'color:var(--emerald);background:oklch(0.30 0.06 155 / .15);border:1px solid oklch(0.50 0.13 155 / .35)'
      : 'color:var(--amber);background:oklch(0.30 0.10 60 / .15);border:1px solid oklch(0.55 0.14 60 / .35)'}`;
    statusEl.textContent = `${ok}/${total} succeeded:\n${lines}`;
    btn.disabled = false;
    btn.textContent = ok === total ? '✓ Done — deployed' : '⬇ Retry';
    if (ok === total) showToast('All agent certificates deployed on this PC', 'success');
    loadTenantConfig();
  });
})();

document.getElementById('btn-save-notifications')?.addEventListener('click', async () => {
  const status = document.getElementById('notif-rules-status');
  if (status) status.textContent = 'Saving…';
  const resp = await window.api.saveNotificationRules(_notifRules);
  if (resp && resp.ok) {
    if (status) status.textContent = `Saved ${_notifRules.length} rule(s)`;
    showToast('Notification rules saved', 'success');
  } else {
    if (status) status.textContent = 'Error: ' + (resp && resp.error || 'unknown');
    showToast('Save failed', 'error');
  }
});

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
  const auth = _operatorAuth || {};
  tbody.innerHTML = Object.entries(_operators).map(([user, role]) => {
    const writeRole = role === 'admin' || role === 'helpdesk';
    const a = auth[user] || (writeRole ? { mode: 'pin', set: false } : { mode: 'none' });
    let authBadge;
    if (!writeRole) authBadge = '<span class="role-badge role-viewer">N/A · viewer</span>';
    else if (a.mode === 'windows') authBadge = '<span class="role-badge role-helpdesk">Windows</span>';
    else if (a.mode === 'pin' && a.set) authBadge = '<span class="role-badge role-admin">PIN set</span>';
    else authBadge = '<span class="role-badge" style="color:var(--coral);border-color:oklch(0.45 0.16 24 / .45);background:oklch(0.45 0.16 24 / .08)">PIN required</span>';
    const actions = writeRole
      ? `<button class="btn btn-set-pin" data-user="${escHtml(user)}" style="padding:3px 9px;font-size:11px">${a.set ? 'Change PIN' : 'Set PIN'}</button>
         <button class="btn btn-set-windows" data-user="${escHtml(user)}" style="padding:3px 9px;font-size:11px" title="Use Windows authentication">Use Windows</button>
         <button class="btn-del-op" data-user="${escHtml(user)}">Remove</button>`
      : `<button class="btn-del-op" data-user="${escHtml(user)}">Remove</button>`;
    return `<tr>
      <td class="mono">${escHtml(user)}</td>
      <td><span class="role-badge role-${escHtml(role)}">${escHtml(role)}</span></td>
      <td>${authBadge}</td>
      <td style="display:flex;gap:6px;justify-content:flex-end">${actions}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty-row">No operators configured.</td></tr>';
  tbody.querySelectorAll('.btn-del-op').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetRole = (_operators[btn.dataset.user] || '').toLowerCase();
      if (targetRole === 'admin' && currentOperatorRole() !== 'admin') {
        showToast('Only admin operators can remove admin accounts', 'error');
        return;
      }
      delete _operators[btn.dataset.user];
      renderOperators();
    });
  });
  tbody.querySelectorAll('.btn-set-pin').forEach(btn => {
    btn.addEventListener('click', () => promptSetPin(btn.dataset.user));
  });
  tbody.querySelectorAll('.btn-set-windows').forEach(btn => {
    btn.addEventListener('click', () => {
      _operatorAuth = _operatorAuth || {};
      _operatorAuth[btn.dataset.user] = { mode: 'windows', set: true };
      saveOperatorAuth();
      renderOperators();
    });
  });
}

document.getElementById('btn-add-operator').addEventListener('click', () => {
  const user = document.getElementById('input-add-op-user').value.trim();
  const role = document.getElementById('input-add-op-role').value;
  if (!user) return;
  if (role === 'admin' && currentOperatorRole() !== 'admin') {
    showToast('Only admin operators can add admin accounts', 'error');
    return;
  }
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
  // Dashboard agent fleet panel: update each .agent tile in place
  const dashAgents = data.agents || [];
  dashAgents.forEach(a => {
    const key = (a.name || '').toLowerCase().replace(/^claudeagent/, '').replace(/agent$/, '').trim();
    const tile = document.querySelector(`.agent[data-agent="${key}"]`);
    if (!tile) return;
    // Map agent health status → meter state
    let st = 'idle';
    if (a.status === 'critical') st = 'degraded';
    else if (a.status === 'warn') st = 'waiting';
    else if (a.lastOutcome === 'partial' || a.lastOutcome === 'failed') st = 'degraded';
    else if (key === 'auditor') st = 'active';
    else if (key === 'approver') st = 'waiting';
    else if (key === 'provisioner') st = 'standby';
    tile.dataset.st = st;
    // Legacy .status-text support (pre-revamp cards)
    const stext = tile.querySelector('.status-text');
    if (stext) {
      const last = a.lastActivity ? ' · ' + new Date(a.lastActivity).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
      stext.textContent = st + last;
    }
    const certLine = tile.querySelector('.cert-line');
    if (certLine && a.daysUntilExpiry != null) {
      certLine.textContent = a.daysUntilExpiry < 0 ? 'expired' : 'cert ' + a.daysUntilExpiry + 'd';
    }
    // Update last-run meta in the new card layout
    const lrEl = document.getElementById('fleet-lr-' + key);
    if (lrEl) {
      lrEl.textContent = a.lastActivity
        ? new Date(a.lastActivity).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
        : 'never run';
    }
    // Update status pill text
    const pillEl = tile.querySelector('.agent-st-pill');
    if (pillEl) pillEl.textContent = st;
  });
  // Dashboard fleet count
  const fleetCount = document.getElementById('dash-fleet-count');
  if (fleetCount && dashAgents.length) {
    const healthy = dashAgents.filter(a => a.status === 'ok' || a.status === 'healthy').length;
    fleetCount.textContent = `· ${healthy}/${dashAgents.length} healthy`;
  }
  // Inject details popover into each agent tile (hover + click reveal)
  dashAgents.forEach(a => {
    const key = (a.name || '').toLowerCase().replace(/^claudeagent/, '').replace(/agent$/, '').trim();
    const tile = document.querySelector(`.agent[data-agent="${key}"]`);
    if (!tile) return;
    const status = a.status || 'ok';
    const lastAct = a.lastActivity ? new Date(a.lastActivity).toLocaleString() : '—';
    const expiry = a.expiry ? new Date(a.expiry).toLocaleDateString() : '—';
    const daysLeft = a.daysUntilExpiry != null
      ? (a.daysUntilExpiry < 0 ? `${Math.abs(a.daysUntilExpiry)}d expired` : `${a.daysUntilExpiry}d remaining`)
      : '—';
    const cred = a.credentialType === 'certificate' ? 'Certificate' : a.credentialType === 'secret' ? 'Secret' : 'Unknown';
    const outcome = a.lastOutcome ? a.lastOutcome.toUpperCase() : '—';
    const purpose = AGENT_PURPOSE[key] || '';
    const popHtml = `<div class="agent-pop">
      <div class="ap-h">${escHtml(a.name || key)} <span class="ap-status ${status === 'critical' ? 'critical' : status === 'warn' ? 'warn' : 'ok'}">${escHtml(status)}</span></div>
      ${purpose ? `<div class="ap-desc">${escHtml(purpose)}</div>` : ''}
      <div class="ap-row">
        <span class="k">Last run</span><span class="v">${escHtml(lastAct)}</span>
        <span class="k">Outcome</span><span class="v">${escHtml(outcome)}</span>
        <span class="k">Credential</span><span class="v">${escHtml(cred)}</span>
        <span class="k">Cert expires</span><span class="v">${escHtml(expiry)} (${escHtml(daysLeft)})</span>
        ${a.lastError ? `<span class="k">Last error</span><span class="v" style="color:var(--coral)">${escHtml(a.lastError)}</span>` : ''}
      </div>
    </div>`;
    // Remove old pop, inject new
    const oldPop = tile.querySelector('.agent-pop');
    if (oldPop) oldPop.remove();
    tile.insertAdjacentHTML('beforeend', popHtml);
  });
  // Static fallback: ensure every tile has at least a description popover
  // (in case the health IPC fails or has no data for some agents yet).
  document.querySelectorAll('.agent[data-agent]').forEach(tile => {
    if (tile.querySelector('.agent-pop')) return;
    const key = tile.dataset.agent;
    const purpose = AGENT_PURPOSE[key];
    if (!purpose) return;
    tile.insertAdjacentHTML('beforeend',
      `<div class="agent-pop">
        <div class="ap-h">${escHtml(key)} <span class="ap-status ok">ready</span></div>
        <div class="ap-desc">${escHtml(purpose)}</div>
        <div class="ap-row"><span class="k">Status</span><span class="v">awaiting health data</span></div>
      </div>`);
  });
  // Wire click toggle (in addition to hover)
  document.querySelectorAll('.agent').forEach(tile => {
    if (tile.dataset.popWired) return;
    tile.dataset.popWired = '1';
    tile.addEventListener('click', () => {
      document.querySelectorAll('.agent.popped').forEach(t => { if (t !== tile) t.classList.remove('popped'); });
      tile.classList.toggle('popped');
    });
  });
  // Dashboard headline subtitle
  const sub = document.getElementById('dash-headline-sub');
  if (sub && dashAgents.length) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    sub.textContent = `${dashAgents.length} agents · ${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()} ${hh}:${mm}`;
  }

  // Update dashboard AI summary state
  _dashState.agents = dashAgents.map(a => ({ name: a.name, status: a.status || 'ok' }));
  const expiring = dashAgents.find(a => a.daysUntilExpiry != null && a.daysUntilExpiry >= 0 && a.daysUntilExpiry <= 30);
  _dashState.certAlert = expiring ? (expiring.name + ' (' + expiring.daysUntilExpiry + 'd)') : null;
  buildDashSummary();

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

  // Update V2 fleet strip tiles
  if (data.agents) {
    data.agents.forEach(ag => {
      const name = ag.name; // e.g. 'joiner', 'leaver', etc.
      const lrEl = document.getElementById('v2fl-lr-' + name);
      const certEl = document.getElementById('v2fl-cert-' + name);
      const tileEl = document.querySelector('.v2-fleet-tile[data-agent="' + name + '"]');
      if (lrEl) {
        const la = ag.lastActivity ? new Date(ag.lastActivity).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
        lrEl.textContent = la;
      }
      if (certEl) {
        const days = ag.daysUntilExpiry;
        certEl.textContent = days === null ? '—' : days < 0 ? 'expired' : days + 'd';
        if (certEl && days !== null) {
          certEl.style.color = days < 0 ? 'var(--crit)' : days < 14 ? 'var(--warn)' : 'var(--ok)';
        }
      }
      if (tileEl) {
        // Update the status dot and state text
        const dotEl = tileEl.querySelector('.ft-dot');
        const stateEl = tileEl.querySelector('.ft-state');
        if (dotEl && stateEl) {
          if (ag.status === 'unconfigured') {
            dotEl.className = 'ft-dot muted';
            stateEl.textContent = 'unconfigured';
          } else if (ag.status === 'critical') {
            dotEl.className = 'ft-dot crit';
            stateEl.textContent = 'credential expired';
          } else if (ag.status === 'expiring') {
            dotEl.className = 'ft-dot warn';
            stateEl.textContent = 'expiring soon';
          } else if (ag.lastOutcome === 'error') {
            dotEl.className = 'ft-dot warn';
            stateEl.textContent = 'last run errored';
          } else {
            dotEl.className = 'ft-dot ok';
            stateEl.textContent = ag.lastActivity ? 'idle' : 'ready';
          }
        }
      }
    });
  }
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
  currentRole = r;
  // Force Safe if a viewer signed in while LIVE was active
  if (r === 'viewer' && !isWhatif) {
    isWhatif = true;
    window.api.setMode(true);
    setHardMode('whatif');
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'whatif'));
    document.getElementById('mode-banner-whatif')?.classList.toggle('hidden', false);
    document.getElementById('mode-banner-live')?.classList.toggle('hidden', true);
    updateTopbarModePill();
  }
  if (typeof applyViewerLock === 'function') applyViewerLock();

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
      if (bannerText) bannerText.textContent = 'Helpdesk role — integrations config and admin account management are restricted. Leavers on privileged users require admin approval.';
    } else {
      banner.classList.add('hidden');
    }
  }
}

// Authoritative current operator name (selected at sign-in, may differ from Windows username)
let currentOperatorName = null;

function updateDashGreeting(name) {
  const el = document.getElementById('dash-greeting');
  if (!el) return;
  const h = new Date().getHours();
  const period = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const parts = (name || '').split(/[.\s_@-]+/).filter(Boolean);
  const firstName = parts[0] || '';
  const display = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : '';
  el.textContent = display
    ? `Good ${period}, ${display}`
    : 'Fleet Overview';
}

// Sidebar operator name + avatar (initials or uploaded image)
function setSidebarOperator(name) {
  currentOperatorName = name || null;
  const nameEl = document.getElementById('sidebar-operator-name');
  if (nameEl) {
    // Entra UPNs: show the readable local part; the full identity lives in
    // the tooltip (and is what the audit chain records).
    const display = name && name.includes('@') ? name.split('@')[0] : (name || '—');
    nameEl.textContent = display;
    nameEl.title = name || '';
  }
  const av = document.getElementById('sidebar-operator-avatar');
  if (av) {
    const base = name || '?';
    const initials = base.split(/[.\s_@-]+/).filter(Boolean).map(s => s[0]).join('').slice(0, 2).toUpperCase() || base.slice(0, 2).toUpperCase();
    av.textContent = initials;
    av.title = base + ' — click to change avatar';
    av.dataset.user = base;
    // Render saved image if any
    const saved = (function() {
      try { return localStorage.getItem('jml-avatar-' + base); } catch { return null; }
    })();
    const existingImg = av.querySelector('img.av-photo');
    if (existingImg) existingImg.remove();
    if (saved) {
      const photo = document.createElement('img');
      photo.className = 'av-photo';
      photo.src = saved;
      photo.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:7px;pointer-events:none;';
      av.appendChild(photo);
      av.style.color = 'transparent';
      av.classList.add('has-image');
    } else {
      av.style.removeProperty('color');
      av.style.removeProperty('background-image');
      av.classList.remove('has-image');
    }
  }
  updateDashGreeting(name);
  // Re-evaluate security remediation button access when operator changes
  _updateRemButtonAccess();
}

// Click avatar → Electron native dialog → crop+resize done in main process → store data URL
(function wireAvatarPicker() {
  const av = document.getElementById('sidebar-operator-avatar');
  if (!av) return;
  av.addEventListener('click', async () => {
    if (typeof window.api?.pickImageFile !== 'function') return;
    let dataUrl;
    try { dataUrl = await window.api.pickImageFile(); } catch { return; }
    if (!dataUrl) return;
    const user = av.dataset.user;
    if (!user) { showToast('No operator signed in', 'warning'); return; }
    try { localStorage.setItem('jml-avatar-' + user, dataUrl); }
    catch { showToast('Image too large to store — try a smaller file', 'error'); return; }
    setSidebarOperator(user);
    showToast('Avatar updated', 'success');
  });
})();

// ── Init ──────────────────────────────────────────────────────────────────────
// Bootstrap UI state
lcSetIdle();   // Render empty lifecycle map in idle state
window.api.getOperationStatuses();

window.api.getCurrentOperator().then(d => {
  setSidebarOperator(d.name || window.api.currentUser);
  applyRoleUI(d.role);
}).catch(() => {
  setSidebarOperator(window.api.currentUser);
  applyRoleUI('viewer');
});

// Populate sidebar + topbar tenant domain from configured agent configs
if (typeof window.api?.getTenantConfig === 'function') {
  window.api.getTenantConfig().then(cfg => {
    const domain = cfg ? (cfg.primaryDomain || cfg.tenantId || '—') : '—';
    const el = document.getElementById('sidebar-tenant-domain');
    if (el) el.textContent = domain;
    const tb = document.getElementById('topbar-tenant-domain');
    if (tb) tb.textContent = domain;
  }).catch(() => {});
}

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
          list.innerHTML = entries.map(([name, role]) => {
            const r = (role || 'viewer').toLowerCase();
            const initials = name.split(/[.\s_-]+/).map(s => s[0]).join('').slice(0, 2).toUpperCase() || name.slice(0, 2).toUpperCase();
            return `<button class="op-switch-btn${name === current ? ' active' : ''}" data-name="${escHtml(name)}" data-role="${escHtml(role || '')}">
              <span class="av">${escHtml(initials)}</span>
              <span class="nm-block">
                <span class="nm">${escHtml(name)}</span>
                <span class="up">${escHtml(role || 'user')}</span>
              </span>
              <span class="role-badge role-${escHtml(r)}">${escHtml((role || 'user').toUpperCase())}</span>
            </button>`;
          }).join('');
          list.querySelectorAll('.op-switch-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const name = btn.dataset.name;
              const role = (btn.dataset.role || 'viewer').toLowerCase();
              const writeAccess = role === 'admin' || role === 'helpdesk';
              if (writeAccess) {
                // Always require PIN/Windows verification mid-session
                const auth = await window.api.getOperatorAuth();
                const entry = auth && auth[name];
                if (!entry || !entry.set) {
                  // Force setup first
                  const choice = await confirmModal({
                    title: 'Set up authentication first',
                    body: `${name} is a write-access operator and has no PIN configured. Use PIN setup or Windows auth?`,
                    danger: true,
                    okLabel: 'Open Settings',
                    cancelLabel: 'Cancel switch'
                  });
                  if (choice) switchTab('settings');
                  return;
                }
                const result = await showPinModal({
                  title: entry.mode === 'windows' ? `Confirm Windows session for ${name}` : `PIN for ${name}`,
                  body: 'Verifying before switching operator.'
                });
                if (!result) return;
                const verify = await window.api.verifyOperatorPin(name, result.pin);
                if (!(verify && verify.ok)) { showToast('PIN incorrect', 'error'); return; }
              }
              window.api.switchOperator(name, role);
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
  document.getElementById('op-switch-signout').addEventListener('click', () => {
    overlay.style.display = 'none';
    window.api.signOut();
  });

  window.api.onOperatorSwitched(d => {
    setSidebarOperator(d.name);
    applyRoleUI(d.role);
    switchTab('dashboard');
  });
})();

const _viewAllBtn = document.getElementById('btn-view-all-activity');
if (_viewAllBtn) _viewAllBtn.addEventListener('click', () => switchTab('audit-log'));
const _viewFleetBtn = document.getElementById('dash-open-fleet');
if (_viewFleetBtn) _viewFleetBtn.addEventListener('click', () => switchTab('certs'));

// Universal "OPEN →" links on dashboard widgets — any [data-jump-tab] navigates
document.querySelectorAll('[data-jump-tab]').forEach(el => {
  el.addEventListener('click', () => switchTab(el.dataset.jumpTab));
  el.style.cursor = 'pointer';
});

// Lightweight populators for dashboard mini-widgets. Hook into existing IPC
// streams + fetched data so the widgets stay alive when shown.
function refreshDashWidgets() {
  // Integrations — pull HR queue stats
  if (typeof window.api?.getHrQueue === 'function') { try { window.api.getHrQueue(); } catch (_) {} }
  // Audit Log — use existing audit data
  if (typeof window.api?.getAuditLog === 'function') { try { window.api.getAuditLog(); } catch (_) {} }
  // Exports — exports status
  if (typeof window.api?.getExportsStatus === 'function') { try { window.api.getExportsStatus(); } catch (_) {} }
  // Agent Certs — cert expiry dashboard widget
  if (typeof window.api?.getCertExpiry === 'function') { try { window.api.getCertExpiry(); } catch (_) {} }
  // Graph runner — recent queries from localStorage
  try {
    const recent = JSON.parse(localStorage.getItem('jml-graph-recent') || '[]');
    const el = document.getElementById('dash-graph-recent');
    if (el) el.textContent = recent.length ? `${recent.length} saved` : 'none';
  } catch (_) {}
}
// Run once at boot and then every 2 minutes
setTimeout(refreshDashWidgets, 2000);
setInterval(refreshDashWidgets, 120000);

// KPI cards on dashboard navigate to relevant tabs
const KPI_NAV = {
  'stat-users':     'users',
  'stat-licenses':  'exports',
  'stat-activity':  'audit-log',
  'stat-approvals': 'approvals',
};
Object.entries(KPI_NAV).forEach(([id, tab]) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.cursor = 'pointer';
  el.title = 'Open ' + (TAB_TITLES[tab] || tab);
  el.addEventListener('click', () => switchTab(tab));
});

// ── Agent quarantine (kill switch) ───────────────────────────────────────────
(function wireQuarantine() {
  const sel      = document.getElementById('quarantine-agent-select');
  const reasonEl = document.getElementById('quarantine-reason');
  const revokeEl = document.getElementById('quarantine-revoke');
  const previewBtn = document.getElementById('quarantine-preview-btn');
  const execBtn    = document.getElementById('quarantine-execute-btn');
  const fb         = document.getElementById('quarantine-feedback');
  if (!sel || !execBtn || typeof window.api?.quarantineAgent !== 'function') return;

  function show(msg, kind) {
    fb.style.display = 'block';
    fb.textContent = msg;
    fb.style.color = kind === 'error' ? 'var(--coral)' : kind === 'ok' ? 'var(--emerald)' : 'var(--text-2)';
  }

  previewBtn?.addEventListener('click', async () => {
    previewBtn.disabled = true;
    show('Running WhatIf preview…');
    const r = await window.api.quarantineAgent({
      agent: sel.value, reason: reasonEl.value || undefined, whatif: true, revoke: revokeEl.checked
    });
    previewBtn.disabled = false;
    if (r && r.ok) show(`WhatIf: would disable ${r.agent} (appId ${r.appId})${r.revoke ? ' + revoke creds' : ''}. No changes made.`, 'ok');
    else show('Preview failed: ' + (r?.error || 'unknown'), 'error');
  });

  execBtn?.addEventListener('click', async () => {
    if (currentOperatorRole() !== 'admin') { show('Quarantine requires an admin operator.', 'error'); return; }
    const agent = sel.value;
    const ok = await confirmModal({
      title: `Quarantine ${agent}?`,
      body: `This disables the ${agent} agent's service principal immediately, blocking all token issuance${revokeEl.checked ? ' and revokes its credentials' : ''}. A high-severity audit entry is written. Continue?`,
      okLabel: 'Quarantine', danger: true,
    });
    if (!ok) return;
    const token = await requirePinIfNeeded('Confirm agent quarantine');
    if (!token) return;
    execBtn.disabled = true;
    show('Quarantining…');
    const r = await window.api.quarantineAgent({
      agent, reason: reasonEl.value || undefined, whatif: false, revoke: revokeEl.checked,
      writeToken: typeof token === 'string' ? token : null
    });
    execBtn.disabled = false;
    if (r && r.ok) {
      show(`✓ ${agent} quarantined — SP ${r.spObjectId} disabled${r.revoked ? ', credentials revoked' : ''}. Audit entry written.`, 'ok');
      showToast(`${agent} agent quarantined`, 'success');
      if (typeof window.api?.getAgentHealth === 'function') window.api.getAgentHealth();
    } else {
      show('Quarantine failed: ' + (r?.error || 'unknown'), 'error');
      showToast('Quarantine failed', 'error');
    }
  });
})();

// ── Certs tiles → detail popover with thumbprint, agent name, status ──────
(function wireCertTileClicks() {
  document.querySelectorAll('#view-certs .cert-tile').forEach(tile => {
    tile.style.cursor = 'pointer';
    tile.addEventListener('click', () => {
      const name = tile.querySelector('.name')?.firstChild?.textContent?.trim() || tile.querySelector('.name')?.textContent?.trim() || 'Agent';
      const sub = tile.querySelector('.sub')?.textContent?.trim() || '';
      const status = tile.querySelector('.status')?.textContent?.trim() || '—';
      const expiry = tile.querySelector('.exp b')?.textContent?.trim() || '—';
      const thumb = tile.querySelector('.thumb b')?.textContent?.trim() || '—';
      showDetailPopover({
        title: `${name} certificate`,
        kv: [
          ['App registration', sub],
          ['Status',           status],
          ['Expires in',       expiry],
          ['SHA-1 thumbprint', thumb],
        ],
        actions: [{
          id: 'docs', label: 'Provisioning script reference', onClick: () => {
            showToast('See ~/.claude/agents/provisioner/New-AgentCertificates.ps1', 'success');
          }
        }]
      });
    });
  });
})();

// ── Integrations queue rows → event payload popover ───────────────────────
function wireIntegrationsQueueClicks() {
  document.querySelectorAll('#int-queue-rows .q-row').forEach((row, i) => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      const ts = row.children[0]?.textContent?.trim() || '—';
      const source = row.children[1]?.textContent?.trim() || '—';
      const event = row.children[2]?.textContent?.trim() || '—';
      const subject = row.children[3]?.textContent?.trim() || '—';
      const status = row.children[4]?.textContent?.trim() || '—';
      showDetailPopover({
        title: `Event · ${event}`,
        kv: [
          ['Queued at', ts],
          ['Source',    source],
          ['Subject',   subject],
          ['Status',    status],
        ],
        actions: []
      });
    });
  });
}

// ── Access Reviews campaign cards → click to view campaign meta ─────────────
function wireAccessReviewClicks() {
  document.querySelectorAll('#cert-result-table-wrap .cert-campaign-card, #cert-result-table-wrap .camp').forEach((card, i) => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      const name = card.querySelector('.cert-campaign-name, .ttl')?.textContent?.trim() || 'Campaign';
      const meta = [...card.querySelectorAll('.cert-meta-item')].map(m => m.textContent.trim());
      showDetailPopover({
        title: name,
        kv: meta.map(m => {
          const idx = m.indexOf(' ');
          return idx > 0 ? [m.slice(0, idx), m.slice(idx + 1)] : ['Meta', m];
        }),
        actions: [{ id: 'jump', label: 'Open Access Reviews', primary: true, onClick: () => switchTab('certifications') }]
      });
    });
  });
}

// Re-wire queue + review handlers whenever their content rerenders
const _origLoadInt = typeof loadIntegrations === 'function' ? loadIntegrations : null;
setTimeout(() => {
  // Initial wire after first render
  wireIntegrationsQueueClicks();
  wireAccessReviewClicks();
}, 2000);
// Also re-wire when integrations tab is shown
if (typeof window.api?.onHrQueue === 'function') {
  // Run once after onHrQueue fires to attach to fresh rows
  let _wired = false;
  const obs = new MutationObserver(() => { wireIntegrationsQueueClicks(); });
  setTimeout(() => {
    const target = document.getElementById('int-queue-rows');
    if (target && !_wired) { obs.observe(target, { childList: true }); _wired = true; }
  }, 3000);
}

// ── Collapsible sidebar ────────────────────────────────────────────────────
(function() {
  const layout = document.querySelector('.layout');
  const btn = document.getElementById('btn-sidebar-collapse');
  if (!layout || !btn) return;
  const KEY = 'jml-sidebar-collapsed';
  const restore = (() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })();
  if (restore) layout.classList.add('sidebar-collapsed');
  // Seed data-label on every nav-item so the collapsed-state tooltip works
  document.querySelectorAll('.nav-item').forEach(item => {
    const lbl = item.querySelector('span:not(.count)');
    if (lbl && !item.dataset.label) item.dataset.label = lbl.textContent.trim();
  });
  btn.addEventListener('click', () => {
    layout.classList.toggle('sidebar-collapsed');
    try { localStorage.setItem(KEY, layout.classList.contains('sidebar-collapsed') ? '1' : '0'); } catch (_) {}
  });
})();

// ── Settings left-rail sub-tab navigation ───────────────────────────────────
(function() {
  const items = document.querySelectorAll('#view-settings .s-item[data-sub]');
  if (!items.length) return;
  items.forEach(item => {
    item.addEventListener('click', () => {
      const sub = item.dataset.sub;
      items.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('#view-settings .set-sub').forEach(card => {
        card.style.display = card.dataset.sub === sub ? '' : 'none';
      });
      if (sub === 'tenant') loadTenantConfig();
      if (sub === 'notifications') loadNotificationRules();
      if (sub === 'ai-provider' && typeof window._loadAiProvider === 'function') window._loadAiProvider();
    });
  });
  document.querySelectorAll('[data-settings-sub]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.settingsSub;
      const target = document.querySelector('#view-settings .s-item[data-sub="' + sub + '"]');
      if (target) target.click();
    });
  });
  // Initial preload of notification rules
  loadNotificationRules();
})();

// ── Theme switcher (warm oklch / preview purple-blue / glass frosted) ───────
(function() {
  const THEME_KEY = 'jmlTheme';
  const VALID = new Set(['warm', 'preview', 'glass']);
  function applyTheme(name) {
    if (!VALID.has(name)) name = 'warm';
    if (name === 'warm') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = name;
  }
  let saved = 'warm';
  try { const s = localStorage.getItem(THEME_KEY); if (VALID.has(s)) saved = s; } catch (_) {}
  applyTheme(saved);

  const radios = document.querySelectorAll('input[name="theme-pick"]');
  if (!radios.length) return;
  radios.forEach(r => { r.checked = (r.value === saved); });
  radios.forEach(r => r.addEventListener('change', () => {
    if (!r.checked) return;
    applyTheme(r.value);
    try { localStorage.setItem(THEME_KEY, r.value); } catch (_) {}
  }));
})();

// ── Tenant onboarding: read/write Tenant ID + Client IDs across all agents ──
async function loadTenantConfig() {
  if (typeof window.api?.getTenantConfig !== 'function') return;
  try {
    const cfg = await window.api.getTenantConfig();
    document.getElementById('set-tenant-id-input').value = cfg.tenantId || '';
    document.getElementById('set-primary-domain-input').value = cfg.primaryDomain || '';
    document.getElementById('set-region-input').value = cfg.region || '';
    const wrap = document.getElementById('set-clientids-wrap');
    if (wrap) {
      const agents = cfg.agents || [];
      wrap.innerHTML = agents.map(a => {
        const cid = (cfg.clientIds || {})[a.agent] || '';
        const cred = a.hasCert ? '<span style="color:var(--emerald);font-size:10px">CERT</span>' : a.hasSecret ? '<span style="color:var(--amber);font-size:10px">SECRET</span>' : '<span style="color:var(--coral);font-size:10px">NO AUTH</span>';
        const exists = a.exists ? cred : '<span style="color:var(--muted);font-size:10px">MISSING</span>';
        return `<div style="display:grid;grid-template-columns:110px 1fr 80px;gap:10px;align-items:center">
          <span class="dim-label">${escHtml(a.agent)}</span>
          <input class="set-clientid" data-agent="${escHtml(a.agent)}" type="text" placeholder="Client ID (Application ID)" value="${escHtml(cid)}" style="font-family:var(--mono);font-size:11.5px">
          <span style="text-align:right">${exists}</span>
        </div>`;
      }).join('');
    }
    const pip = document.getElementById('tenant-health-pip');
    if (pip) {
      const ready = cfg.tenantId && (cfg.agents || []).some(a => a.exists && (a.hasCert || a.hasSecret));
      pip.innerHTML = ready ? '<span class="d"></span>HEALTHY' : '<span class="d" style="background:var(--amber)"></span>SETUP NEEDED';
      pip.classList.toggle('warn', !ready);
    }
    // Keep sidebar + topbar domain in sync
    const domain2 = cfg.primaryDomain || cfg.tenantId || '—';
    const sdt = document.getElementById('sidebar-tenant-domain');
    if (sdt) sdt.textContent = domain2;
    const tbd = document.getElementById('topbar-tenant-domain');
    if (tbd) tbd.textContent = domain2;
  } catch (e) {
    showToast('Failed to load tenant config: ' + e.message, 'error');
  }
}

document.getElementById('btn-tenant-reload')?.addEventListener('click', loadTenantConfig);
document.getElementById('btn-tenant-save')?.addEventListener('click', async () => {
  const tenantId = document.getElementById('set-tenant-id-input').value.trim();
  const primaryDomain = document.getElementById('set-primary-domain-input').value.trim();
  const region = document.getElementById('set-region-input').value;
  const clientIds = {};
  document.querySelectorAll('.set-clientid').forEach(i => {
    const v = i.value.trim();
    if (v) clientIds[i.dataset.agent] = v;
  });
  const status = document.getElementById('tenant-save-status');
  if (!tenantId) { if (status) status.textContent = 'Tenant ID required'; return; }

  // Dry-run: ask main to compute the diff, render it, then ask for confirmation.
  const preview = await window.api.previewTenantConfig({ tenantId, primaryDomain, region, clientIds });
  const changes = (preview && preview.changes) || [];
  const hasChanges = changes.some(c => c.diff && Object.keys(c.diff).length > 0);
  if (!hasChanges) {
    showToast('No changes to apply', 'success');
    if (status) status.textContent = 'No changes.';
    return;
  }

  // Build a readable diff in a modal. Each agent shows which fields change with from/to.
  const diffHtml = changes.map(c => {
    if (!c.exists) return `<div class="diff-row"><span class="diff-agent">${escHtml(c.agent)}</span><span class="diff-skip">config missing — skipped</span></div>`;
    if (c.error)  return `<div class="diff-row"><span class="diff-agent">${escHtml(c.agent)}</span><span class="diff-err">error: ${escHtml(c.error)}</span></div>`;
    const keys = Object.keys(c.diff || {});
    if (!keys.length) return `<div class="diff-row diff-nochg"><span class="diff-agent">${escHtml(c.agent)}</span><span class="diff-skip">no change</span></div>`;
    return `<div class="diff-row"><span class="diff-agent">${escHtml(c.agent)}</span><div class="diff-fields">${keys.map(k => {
      const v = c.diff[k];
      const from = v.from ? escHtml(String(v.from).slice(0, 32)) : '<span class="diff-empty">(unset)</span>';
      return `<div class="diff-field"><span class="diff-key">${escHtml(k)}</span><span class="diff-arrow">→</span><span class="diff-to">${escHtml(String(v.to).slice(0, 32))}</span><span class="diff-from">was ${from}</span></div>`;
    }).join('')}</div></div>`;
  }).join('');

  const ok = await richConfirmModal({
    title: 'Review tenant changes',
    body: `${changes.filter(c => c.diff && Object.keys(c.diff).length).length} of ${changes.length} agent configs will be rewritten.`,
    html: `<div class="diff-list">${diffHtml}</div>`,
    danger: true,
    okLabel: 'Apply changes',
  });
  if (!ok) return;
  if (status) status.textContent = 'Saving…';
  const resp = await window.api.saveTenantConfig({ tenantId, primaryDomain, region, clientIds });
  if (resp && resp.ok) {
    if (status) status.textContent = `Updated ${resp.updated.length} agents${resp.skipped.length ? ` · skipped ${resp.skipped.length}` : ''}${resp.errors.length ? ` · ${resp.errors.length} errors` : ''}`;
    showToast('Tenant config saved', 'success');
    loadTenantConfig();
  } else {
    if (status) status.textContent = 'Error: ' + (resp && resp.error || 'unknown');
    showToast('Save failed', 'error');
  }
});

// Richer confirm modal that can show arbitrary HTML body (used for tenant diff).
function richConfirmModal({ title, body, html, danger, okLabel, cancelLabel }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pin-overlay';
    overlay.innerHTML = `
      <div class="pin-modal" style="width:560px;max-width:92vw">
        <div class="pin-header">
          <div class="pin-title">${escHtml(title || 'Confirm')}</div>
          ${body ? `<div class="pin-sub">${escHtml(body)}</div>` : ''}
        </div>
        <div class="pin-body" style="max-height:60vh;overflow-y:auto">
          ${html || ''}
        </div>
        <div class="pin-footer">
          <button class="btn ghost rcm-cancel">${escHtml(cancelLabel || 'Cancel')}</button>
          <button class="btn ${danger ? 'danger' : 'primary'} rcm-ok">${escHtml(okLabel || 'OK')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = v => { overlay.remove(); resolve(v); };
    overlay.querySelector('.rcm-cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.rcm-ok').addEventListener('click', () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
  });
}

// One-line purpose for each fleet agent — shown in the hover popover (module scope so static seed + health update both use it).
const AGENT_PURPOSE = {
  joiner:      'Creates new identities · assigns initial groups + licenses',
  mover:       'Applies dept/title/manager changes · reconciles group membership',
  leaver:      'Soft: disable + revoke sessions · Hard: remove licenses + groups',
  enroller:    'Registers devices into Intune · manages MFA enrollment',
  certifier:   'Drives access review campaigns + PIM eligibility reviews',
  approver:    'Issues approval tokens · runs risk scoring · gates dual approval',
  provisioner: 'Creates app registrations + grants Graph permissions',
  auditor:     'Hash-chained logging · UEBA · drift detection · risky users',
};

// Seed static descriptions immediately so hover shows purpose even before health IPC fires
(function seedAgentDescriptions() {
  document.querySelectorAll('.agent[data-agent]').forEach(tile => {
    const key = tile.dataset.agent;
    const purpose = AGENT_PURPOSE[key];
    if (!purpose) return;
    if (tile.querySelector('.agent-pop')) return;
    tile.insertAdjacentHTML('beforeend',
      `<div class="agent-pop">
        <div class="ap-h">${key} <span class="ap-status ok">ready</span></div>
        <div class="ap-desc">${purpose}</div>
        <div class="ap-row"><span class="k">Status</span><span class="v">awaiting data</span></div>
      </div>`);
  });
  // Click toggle wiring (hover already shown via CSS, click for sticky)
  document.querySelectorAll('.agent').forEach(tile => {
    if (tile.dataset.popWired) return;
    tile.dataset.popWired = '1';
    tile.addEventListener('click', () => {
      document.querySelectorAll('.agent.popped').forEach(t => { if (t !== tile) t.classList.remove('popped'); });
      tile.classList.toggle('popped');
    });
  });
})();

// ── Dashboard customize popover ─────────────────────────────────────────────
(function() {
  const btn = document.getElementById('btn-customize-dashboard');
  const pop = document.getElementById('dash-customize');
  const closeBtn = document.getElementById('dash-customize-close');
  if (!btn || !pop) return;

  const VIS_KEY = 'jml-dash-section-visible';
  const loadVis = () => { try { return JSON.parse(localStorage.getItem(VIS_KEY) || '{}'); } catch { return {}; } };
  const saveVis = (v) => { try { localStorage.setItem(VIS_KEY, JSON.stringify(v)); } catch (_) {} };

  // Restore saved visibility on boot
  const initial = loadVis();
  Object.entries(initial).forEach(([key, on]) => {
    const sec = document.querySelector(`.dash-section[data-section="${key}"]`);
    if (sec) sec.classList.toggle('dash-hidden', on === false);
    const cb = pop.querySelector(`[data-toggle-section="${key}"]`);
    if (cb) cb.checked = on !== false;
  });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    pop.style.display = pop.style.display === 'none' ? '' : 'none';
  });
  closeBtn?.addEventListener('click', () => { pop.style.display = 'none'; });
  // Click outside to close
  document.addEventListener('click', e => {
    if (pop.style.display === 'none') return;
    if (pop.contains(e.target) || btn.contains(e.target)) return;
    pop.style.display = 'none';
  });

  // Section toggles
  pop.querySelectorAll('[data-toggle-section]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.toggleSection;
      const sec = document.querySelector(`.dash-section[data-section="${key}"]`);
      if (sec) sec.classList.toggle('dash-hidden', !cb.checked);
      const vis = loadVis();
      vis[key] = cb.checked;
      saveVis(vis);
    });
  });

  // Click on a collapsed stub restores the section and persists the preference
  document.querySelectorAll('.dash-section[data-section]').forEach(sec => {
    sec.addEventListener('click', e => {
      if (!sec.classList.contains('dash-hidden')) return;
      e.stopPropagation();
      const key = sec.dataset.section;
      sec.classList.remove('dash-hidden');
      const cb = pop.querySelector(`[data-toggle-section="${key}"]`);
      if (cb) cb.checked = true;
      const vis = loadVis();
      vis[key] = true;
      saveVis(vis);
    });
  });

  // Reset to default order + show all + default spans
  document.getElementById('dash-reset-layout')?.addEventListener('click', () => {
    try {
      localStorage.removeItem('jml-dash-section-order');
      localStorage.removeItem(VIS_KEY);
      localStorage.removeItem('jml-dash-section-spans');
    } catch (_) {}
    location.reload();
  });
})();

// ── Dashboard section stretch toggle (span-1 ⇄ span-2) ─────────────────────
// Each section gets a small right-edge handle. Click toggles between half-width
// and full-width in the 2-col grid. Persisted to localStorage. Grid uses
// grid-auto-flow:dense, so the surviving siblings reflow to fill gaps.
(function() {
  const container = document.getElementById('dash-sections');
  if (!container) return;
  const WIDTH_KEY = 'jml-dash-section-spans';
  const loadSpans = () => { try { return JSON.parse(localStorage.getItem(WIDTH_KEY) || '{}'); } catch { return {}; } };
  const saveSpans = (m) => { try { localStorage.setItem(WIDTH_KEY, JSON.stringify(m)); } catch (_) {} };

  // Restore saved span widths
  const saved = loadSpans();
  Object.entries(saved).forEach(([key, span]) => {
    const sec = container.querySelector(`.dash-section[data-section="${key}"]`);
    if (!sec || (span !== 1 && span !== 2)) return;
    sec.classList.remove('span-1', 'span-2');
    sec.classList.add('span-' + span);
  });

  // Inject toggle handles
  container.querySelectorAll(':scope > .dash-section[data-section]').forEach(sec => {
    if (sec.querySelector('.span-toggle')) return;
    const handle = document.createElement('button');
    handle.className = 'span-toggle';
    handle.title = 'Toggle width';
    handle.addEventListener('click', e => {
      e.stopPropagation();
      const next = sec.classList.contains('span-2') ? 1 : 2;
      sec.classList.remove('span-1', 'span-2');
      sec.classList.add('span-' + next);
      const spans = loadSpans();
      spans[sec.dataset.section] = next;
      saveSpans(spans);
    });
    sec.appendChild(handle);
  });
})();

// ── Dashboard section drag-reorder ──────────────────────────────────────────
(function() {
  const container = document.getElementById('dash-sections');
  if (!container) return;
  const STORAGE_KEY = 'jml-dash-section-order';

  // Restore saved order
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved) && saved.length) {
      const byKey = new Map();
      container.querySelectorAll(':scope > .dash-section[data-section]').forEach(el => {
        byKey.set(el.dataset.section, el);
      });
      saved.forEach(key => {
        const el = byKey.get(key);
        if (el) container.appendChild(el);
      });
      // Append any sections not in saved order
      byKey.forEach((el, key) => {
        if (!saved.includes(key)) container.appendChild(el);
      });
    }
  } catch (_) { /* ignore corrupt state */ }

  let dragged = null;
  container.querySelectorAll(':scope > .dash-section[data-section]').forEach(sec => {
    sec.setAttribute('draggable', 'true');
    sec.addEventListener('dragstart', e => {
      dragged = sec;
      sec.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', sec.dataset.section); } catch (_) {}
    });
    sec.addEventListener('dragend', () => {
      sec.classList.remove('dragging');
      container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      dragged = null;
      // Persist order
      const order = [...container.querySelectorAll(':scope > .dash-section[data-section]')].map(el => el.dataset.section);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch (_) {}
    });
    sec.addEventListener('dragover', e => {
      if (!dragged || dragged === sec) return;
      e.preventDefault();
      sec.classList.add('drag-over');
    });
    sec.addEventListener('dragleave', () => sec.classList.remove('drag-over'));
    sec.addEventListener('drop', e => {
      e.preventDefault();
      sec.classList.remove('drag-over');
      if (!dragged || dragged === sec) return;
      const rect = sec.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      if (after) sec.after(dragged);
      else sec.before(dragged);
    });
  });
})();

// ── JML Fleet assist bar + slash commands ─────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/joiner',      label: 'New Joiner',    desc: 'Onboard a new hire to the tenant',                          prompt: 'Onboard a new hire' },
  { cmd: '/mover',       label: 'Move User',     desc: 'Transfer a user to a new department or role',               prompt: 'Move a user to a new department' },
  { cmd: '/soft-leaver', label: 'Soft Offboard', desc: 'Disable account and revoke active sessions',                prompt: 'Soft offboard a user — disable their account and revoke sessions' },
  { cmd: '/hard-leaver', label: 'Hard Offboard', desc: 'Remove all licenses, groups, and delete the account',       prompt: 'Hard offboard a user — remove all access, licenses, and memberships' },
  { cmd: '/enroll',      label: 'Enroll MFA',    desc: 'Register a user for multi-factor authentication',           prompt: 'Enroll a user in MFA' },
  { cmd: '/check',       label: 'Check User',    desc: 'Retrieve current status and attributes for a user',         prompt: 'What is the current status of user ' },
  { cmd: '/whatif',      label: 'Safe',        desc: 'Simulate an operation without committing any changes',      prompt: 'Safe — what would happen if I ' },
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

// Assist bar chips — approver
document.querySelectorAll('#approver-assist-bar .assist-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (!_approverIn) return;
    _approverIn.value = chip.dataset.prompt;
    _approverIn.focus();
  });
});

// Assist bar chips — auditor (pre-fill input, let user send)
document.querySelectorAll('#auditor-assist-bar .assist-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const inp = document.getElementById('input-auditor');
    if (!inp) return;
    inp.value = chip.dataset.prompt;
    inp.focus();
  });
});

// ── V2 Auditor Rail ────────────────────────────────────────────────────────────
let _audTools = [];  // list of { name, state } seen in current query

function audSetActiveQuery(text) {
  _audTools = [];
  const statusEl = document.getElementById('aud-query-status');
  const bodyEl   = document.getElementById('aud-query-body');
  if (statusEl) { statusEl.textContent = 'running'; statusEl.style.color = 'var(--cyan)'; }
  if (bodyEl) {
    // Don't echo the query text here — it's already the operator's chat message
    // and a suggestion chip on the tab. Show just the tool activity rows.
    bodyEl.innerHTML = `<div id="aud-tool-rows"></div>`;
  }
}

function audTrackTool(toolName, state) {
  const toolRows = document.getElementById('aud-tool-rows');
  if (!toolRows) return;
  const existing = toolRows.querySelector(`[data-tool="${CSS.escape(toolName)}"]`);
  if (existing) {
    existing.className = 'aud-tool-row ' + state;
    existing.querySelector('.aud-tool-icon').textContent = state === 'done' ? '✓' : '▶';
  } else {
    const row = document.createElement('div');
    row.className = 'aud-tool-row ' + state;
    row.dataset.tool = toolName;
    row.innerHTML = `<span class="aud-tool-icon">${state === 'done' ? '✓' : '▶'}</span><span>${escHtml(formatToolName(toolName))}</span>`;
    toolRows.appendChild(row);
  }
  _audTools.push({ name: toolName, state });
}

function audQueryComplete(msgEl) {
  const statusEl = document.getElementById('aud-query-status');
  if (statusEl) { statusEl.textContent = 'done'; statusEl.style.color = 'var(--ok)'; }

  // Extract key findings from the response text
  if (!msgEl) return;
  const textEl = msgEl.querySelector('.message-text');
  const raw = textEl ? (textEl.dataset.raw || textEl.textContent || '') : '';
  if (!raw) return;

  const findings = [];

  // Extract numeric facts: "X users", "Y licenses", "N roles", "N failed" etc.
  const numFacts = [...raw.matchAll(/\b(\d[\d,]*)\s+(user[s]?|identit[yi][es]*|license[s]?|admin[s]?|role[s]?|group[s]?|event[s]?|operation[s]?|finding[s]?|failed|enabled|disabled|guest[s]?)/gi)];
  numFacts.slice(0, 4).forEach(m => {
    findings.push({ tone: 'default', text: m[0] });
  });

  // Risk keywords
  const riskMatch = raw.match(/(\d+)\s+(critical|high.risk|risky)\s+(user[s]?|finding[s]?)/i);
  if (riskMatch) findings.unshift({ tone: 'crit', text: riskMatch[0] });
  const warnMatch = raw.match(/(\d+)\s+(warn(?:ing)?|anomal[yous]+|flag[ged]*)\s/i);
  if (warnMatch) findings.unshift({ tone: 'warn', text: warnMatch[0].trim() });

  if (!findings.length) return;

  const card = document.getElementById('aud-findings-card');
  const list = document.getElementById('aud-findings-list');
  if (!card || !list) return;
  card.style.display = '';
  // Deduplicate by text
  const seen = new Set();
  const unique = findings.filter(f => { if (seen.has(f.text)) return false; seen.add(f.text); return true; });
  list.innerHTML = unique.slice(0, 5).map(f =>
    `<div class="aud-finding-item">
      <div class="aud-finding-dot ${f.tone === 'crit' ? 'crit' : f.tone === 'warn' ? 'warn' : ''}"></div>
      <div class="aud-finding-text">${escHtml(f.text)}</div>
    </div>`
  ).join('');
}

function audClearState() {
  _audTools = [];
  const statusEl = document.getElementById('aud-query-status');
  const bodyEl   = document.getElementById('aud-query-body');
  const card     = document.getElementById('aud-findings-card');
  if (statusEl) { statusEl.textContent = 'idle'; statusEl.style.color = ''; }
  if (bodyEl)   { bodyEl.className = 'aud-idle-hint'; bodyEl.innerHTML = 'Send a query to begin…'; }
  if (card)     card.style.display = 'none';
}

window.__jmlSetAuditorDemoRail = function (query, responseText) {
  audSetActiveQuery(query || 'Show failed and suspicious operations');
  audTrackTool('query_audit_log', 'done');
  audTrackTool('scan_ueba_findings', 'done');
  const msgEl = document.createElement('div');
  const txt = document.createElement('div');
  txt.className = 'message-text';
  txt.textContent = responseText || '';
  msgEl.appendChild(txt);
  audQueryComplete(msgEl);
};

// Auditor jump-to buttons
document.getElementById('aud-jump-log')?.addEventListener('click', () => switchTab('audit-log'));
document.getElementById('aud-jump-security')?.addEventListener('click', () => switchTab('security'));
document.getElementById('aud-jump-users')?.addEventListener('click', () => switchTab('users'));

// Auditor findings clear
document.getElementById('aud-findings-clr')?.addEventListener('click', () => {
  const card = document.getElementById('aud-findings-card');
  const list = document.getElementById('aud-findings-list');
  if (list) list.innerHTML = '';
  if (card) card.style.display = 'none';
});

// ── Scroll-to-bottom buttons (Fix 7) ─────────────────────────────────────────
['approver', 'auditor'].forEach(agent => {
  const msgs = document.getElementById('messages-' + agent);
  const btn  = document.getElementById('scroll-bottom-' + agent);
  if (!msgs || !btn) return;
  msgs.addEventListener('scroll', () => {
    const distFromBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
    btn.style.display = distFromBottom > 120 ? '' : 'none';
  }, { passive: true });
  btn.addEventListener('click', () => { msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' }); });
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
document.getElementById('dash-open-ops')?.addEventListener('click', () => switchTab('operations'));

// Shared helper: open a <details> then smooth-scroll to it within its .view container
function openSecSection(key) {
  const d = document.getElementById('sec-section-' + key);
  if (!d) return;
  d.open = true;
  // Two-frame wait: first frame commits the open, second frame lets the
  // browser reflow the expanded content so scrollIntoView lands correctly
  requestAnimationFrame(() => requestAnimationFrame(() => {
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// Security page — top stat cards open+scroll their section
[['sec-ueba', 'ueba'], ['sec-drift', 'drift'], ['sec-risky', 'risky']].forEach(([cardId, key]) => {
  const card = document.getElementById(cardId);
  if (card) { card.style.cursor = 'pointer'; card.addEventListener('click', () => openSecSection(key)); }
});

// Dashboard security tiles → Security tab, open + scroll to that section
const _SEC_TILE_MAP = { 'dash-tile-ueba': 'ueba', 'dash-tile-drift': 'drift', 'dash-tile-risky': 'risky' };
Object.entries(_SEC_TILE_MAP).forEach(([btnId, key]) => {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    switchTab('security');
    // After tab switch, wait for the view to be visible before opening+scrolling
    setTimeout(() => openSecSection(key), 120);
  });
});

loadDashboard();

// ── Notification Centre ───────────────────────────────────────────────────────
let _notifications = [];

function addNotification(icon, title, action) {
  const n = { id: Date.now() + Math.random(), icon: icon, title: title, action: action || null, time: new Date() };
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
    '<div class="notif-item" data-id="' + n.id + '" data-action="' + (n.action ? '1' : '') + '">' +
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
  list.querySelectorAll('.notif-item[data-action="1"]').forEach(item => {
    item.addEventListener('click', () => {
      const n = _notifications.find(x => String(x.id) === String(item.dataset.id));
      if (!n || !n.action) return;
      if (n.action.tab) switchTab(n.action.tab);
      if (typeof n.action.run === 'function') n.action.run();
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

  window._filteredAuditEntries = filtered; // consumed by the evidence-packet export

  if (_timelineActive) {
    renderTimeline(filtered);
  } else {
    renderAuditTable(filtered);
  }
}

// ── Evidence packet export ────────────────────────────────────────────────────
async function runEvidenceExport() {
  if (typeof window.api?.exportEvidencePacket !== 'function') return;
  const btn = document.getElementById('btn-export-evidence');
  const filtered = window._filteredAuditEntries || window._allAuditEntries || [];
  const hashes = filtered.map(e => e.hash).filter(Boolean);
  if (!hashes.length) { showToast('No audit entries to export', 'warning'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
  const r = await window.api.exportEvidencePacket({ hashes });
  if (btn) { btn.disabled = false; btn.textContent = orig; }
  if (r && r.ok) {
    showToast(`Evidence packet exported (${r.count} entries) — integrity: ${/PASS/i.test(r.integrity) ? 'verified' : 'see packet'}`, 'success');
  } else if (r && r.canceled) {
    /* user cancelled save dialog */
  } else {
    showToast('Export failed: ' + (r?.error || 'unknown'), 'error');
  }
}

document.getElementById('btn-export-evidence')?.addEventListener('click', runEvidenceExport);

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
    const mode     = e.whatif ? '<span class="badge-whatif">Safe</span>' : '<span class="badge-live">Live</span>';
    const cls      = outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : outcome === 'failed' ? 'failed' : '';
    const ticket   = (e.details && e.details.ticketRef) ? escHtml(e.details.ticketRef) : '<span class="dim">—</span>';
    const operator = e.operator ? escHtml(e.operator) : '<span class="dim">—</span>';
    return '<tr>' +
      '<td class="mono">' + ts + '</td>' +
          '<td>' + agentScopeTip(e.agent || '', e.agent || '--') + '</td>' +
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
            '<span class="timeline-agent">' + agentScopeTip(e.agent || '', e.agent || '') + '</span>' +
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
  const btnAttestation = document.getElementById('btn-build-attestation');

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

  document.querySelectorAll('.v2-filter-chip[data-log-agent], .v2-filter-chip[data-log-outcome]').forEach(chip => {
    chip.addEventListener('click', () => {
      const isAgent = Object.prototype.hasOwnProperty.call(chip.dataset, 'logAgent');
      const selectId = isAgent ? 'log-filter-agent' : 'log-filter-outcome';
      const value = isAgent ? chip.dataset.logAgent : chip.dataset.logOutcome;
      const sel = document.getElementById(selectId);
      if (sel) {
        if (value && !Array.from(sel.options).some(opt => opt.value === value)) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = value;
          sel.appendChild(opt);
        }
        sel.value = value;
      }
      const selector = isAgent ? '[data-log-agent]' : '[data-log-outcome]';
      document.querySelectorAll('.v2-filter-chip' + selector).forEach(btn => btn.classList.remove('active'));
      chip.classList.add('active');
      applyAuditFilters();
    });
  });

  if (btnAttestation) {
    btnAttestation.addEventListener('click', () => {
      // Remove any existing dialog
      const existing = document.getElementById('attest-dialog-backdrop');
      if (existing) existing.remove();

      const backdrop = document.createElement('div');
      backdrop.id = 'attest-dialog-backdrop';
      backdrop.className = 'attest-dialog-backdrop';
      backdrop.innerHTML =
        '<div class="attest-dialog" role="dialog" aria-modal="true" aria-labelledby="attest-dialog-title">' +
          '<div class="dialog-head">' +
            '<div class="dialog-head-title">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>' +
              '<span id="attest-dialog-title">Build Attestation Pack</span>' +
            '</div>' +
            '<button class="btn ghost sm" id="attest-dialog-close" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="dialog-body">' +
            '<p class="attest-desc">Select evidence layers to include in the signed PDF + JSON pack. All selected items are hash-anchored to the audit chain before export.</p>' +
            '<div class="attest-option-grid">' +
              '<label class="attest-cb-row"><input type="checkbox" checked> <span class="attest-cb-label">Audit log entries <span class="attest-cb-sub">All filtered entries · hash-chained</span></span></label>' +
              '<label class="attest-cb-row"><input type="checkbox" checked> <span class="attest-cb-label">Agent execution trace <span class="attest-cb-sub">Tool calls, plan steps, outcomes</span></span></label>' +
              '<label class="attest-cb-row"><input type="checkbox" checked> <span class="attest-cb-label">Dual-approval receipts <span class="attest-cb-sub">Operator + approver signatures</span></span></label>' +
              '<label class="attest-cb-row"><input type="checkbox"> <span class="attest-cb-label">HRIS inbound events <span class="attest-cb-sub">Raw webhook payloads from BambooHR / Workday</span></span></label>' +
              '<label class="attest-cb-row"><input type="checkbox"> <span class="attest-cb-label">Replication receipts <span class="attest-cb-sub">Azure Blob · Sentinel · Splunk · S3 ACKs</span></span></label>' +
              '<label class="attest-cb-row"><input type="checkbox"> <span class="attest-cb-label">Certificate chain <span class="attest-cb-sub">Per-agent app-reg certs at time of operation</span></span></label>' +
            '</div>' +
            '<div class="attest-callout">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
              'Pack will be signed with the Provisioner agent&rsquo;s current cert and anchored as a new hash-chain entry.' +
            '</div>' +
          '</div>' +
          '<div class="dialog-foot">' +
            '<button class="btn ghost" id="attest-dialog-cancel">Cancel</button>' +
            '<button class="btn primary" id="attest-dialog-build">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Export Pack' +
            '</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(backdrop);

      // Close handlers
      const close = () => backdrop.remove();
      backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
      document.getElementById('attest-dialog-close').addEventListener('click', close);
      document.getElementById('attest-dialog-cancel').addEventListener('click', close);
      document.getElementById('attest-dialog-build').addEventListener('click', () => {
        close();
        addNotification('✓', 'Attestation pack queued for export — download will begin shortly', { tab: 'audit-log' });
        runEvidenceExport();
      });
    });
  }
})();

// ── User Lookup ───────────────────────────────────────────────────────────────

// Show recently-searched users or a friendly prompt when the tab loads cold.
function loadRecentUsers() {
  const listEl  = document.getElementById('user-results-list');
  const countEl = document.getElementById('user-search-count');
  if (!listEl) return;
  // Never auto-search with empty string — Graph API returns 400 for empty $search
  const searchInput = document.getElementById('user-search-input');
  if (searchInput && searchInput.value.trim()) return;
  const cached = typeof _userCache !== 'undefined' ? _userCache.slice(0, 10) : [];
  if (countEl) countEl.textContent = cached.length ? 'Recent · ' + cached.length : '0 identities';
  // If we already have results visible from a prior search, leave them alone
  const hasResults = listEl.querySelector('.utable-r');
  if (hasResults && cached.length) return;
  // Show friendly hint
  listEl.innerHTML = `<div class="users-hint">
    <div class="users-hint-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    </div>
    <div class="users-hint-title">Search the directory</div>
    <div class="users-hint-body">Type a name, UPN, or department above to find identities across your Entra tenant.</div>
  </div>`;
}

(function () {
  let _selectedUser = null;

  const searchInput = document.getElementById('user-search-input');
  const searchBtn   = document.getElementById('btn-user-search');

  function doSearch() {
    const q = (searchInput && searchInput.value.trim()) || '';
    if (!q) {
      // Empty search → show recent users hint
      loadRecentUsers();
      return;
    }
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
    const isBlankSearch = !searchInput || !searchInput.value.trim();
    if (data.error) {
      // Suppress errors for empty/blank searches (Graph rejects $search with empty value)
      if (isBlankSearch) return;
      listEl.innerHTML = '<div class="loading-hint">Error: ' + escHtml(data.error) + '</div>';
      if (countEl) countEl.textContent = '';
      return;
    }
    const users = data.users || [];
    if (isBlankSearch) {
      if (countEl) countEl.textContent = users.length ? 'Recent · ' + users.length : '0 identities';
    } else {
      if (countEl) countEl.textContent = users.length + ' result' + (users.length !== 1 ? 's' : '');
    }
    if (!users.length) {
      if (isBlankSearch) {
        listEl.innerHTML = `<div class="users-hint">
          <div class="users-hint-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="users-hint-title">Search the directory</div>
          <div class="users-hint-body">Type a name, UPN, or department above to find identities across your Entra tenant.</div>
        </div>`;
      } else {
        listEl.innerHTML = '<div class="loading-hint">No users found.</div>';
      }
      return;
    }
    // Render revamp's .utable-r rows (avatar + name + dept + status + licenses + risk meter)
    const initials = (name, upn) => {
      const base = name || upn || '?';
      return base.split(/[.\s_@-]+/).filter(Boolean).map(s => s[0]).join('').slice(0, 2).toUpperCase() || base.slice(0, 2).toUpperCase();
    };
    const avBg = (seedIdx) => {
      const hues = [195, 280, 35, 130, 60, 320, 250, 100, 24, 155];
      const h = hues[seedIdx % hues.length];
      return `background: linear-gradient(135deg, oklch(0.55 0.14 ${h}), oklch(0.40 0.12 ${(h+45)%360}))`;
    };
    listEl.innerHTML = users.map((u, i) => {
      const lic = (u.assignedLicenses || []).slice(0, 3).map(l =>
        `<span class="pip">${escHtml((l.skuPartNumber || l.skuId || '').toString().split('_')[0].slice(0, 6) || 'LIC')}</span>`
      ).join('');
      const statClass = u.accountEnabled ? 'enabled' : 'disabled';
      const statLabel = u.accountEnabled ? 'enabled' : 'disabled';
      const lastSign = u.signInActivity?.lastSignInDateTime ? new Date(u.signInActivity.lastSignInDateTime) : null;
      const lastSignText = lastSign ? _relativeTime(lastSign) : '—';
      // Real risk only comes from Identity Protection (riskScore/riskLevel).
      // When absent, show "—" rather than a fabricated default that made every
      // user read the same number.
      const risk = typeof u.riskScore === 'number' ? u.riskScore
        : (u.riskLevel === 'high' ? 80 : u.riskLevel === 'medium' ? 50 : u.riskLevel === 'low' ? 20 : null);
      const riskCell = risk == null
        ? '<span class="rmeter rmeter-na"><span class="bar"></span><span class="rmeter-na-val">—</span></span>'
        : `<span class="rmeter"><span class="bar"><i style="width:${risk}%"></i></span>${risk}</span>`;
      return `<div class="utable-r user-result-item" data-id="${escHtml(u.id)}" data-upn="${escHtml(u.userPrincipalName || '')}">
        <span class="chk"></span>
        <span class="person">
          <span class="av" style="${avBg(i)}">${escHtml(initials(u.displayName, u.userPrincipalName))}</span>
          <span class="nm">
            <span class="n user-result-name">${escHtml(u.displayName || u.userPrincipalName || '—')}</span>
            <span class="u user-result-upn">${escHtml(u.userPrincipalName || '')}</span>
          </span>
        </span>
        <span class="dept">${escHtml(u.department || '—')}</span>
        <span class="stat user-result-badge ${statClass}">${statLabel}</span>
        <span class="lic">${lic || '—'}</span>
        <span class="ago">${escHtml(lastSignText)}</span>
        ${riskCell}
        <span class="more">⋯</span>
      </div>`;
    }).join('');
    // Add a header row matching the data row grid
    const tableEl = listEl.parentElement;
    let header = tableEl.querySelector('.utable-h-full');
    if (!header) {
      header = document.createElement('div');
      header.className = 'utable-h-full utable-h';
      header.innerHTML = '<span></span><span>USER</span><span>DEPARTMENT</span><span>STATUS</span><span>LICENSES</span><span>LAST SIGN-IN</span><span>RISK</span><span></span>';
      // Replace the placeholder header if any
      const oldHdr = tableEl.querySelector('.utable-h:not(.utable-h-full)');
      if (oldHdr) oldHdr.replaceWith(header);
      else tableEl.insertBefore(header, listEl);
    }

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

    const riskScore = typeof u.riskScore === 'number'
      ? u.riskScore
      : (u.riskLevel === 'high' ? 82 : u.riskLevel === 'medium' ? 54 : u.riskLevel === 'low' ? 22 : null);
    const riskScoreEl = document.getElementById('udp-risk-score');
    const riskBarEl = document.getElementById('udp-risk-bar');
    const writeRouteEl = document.getElementById('udp-write-route');
    const auditPostureEl = document.getElementById('udp-audit-posture');
    if (riskScoreEl) riskScoreEl.textContent = riskScore == null ? '— · no Identity Protection data' : riskScore + ' / 100';
    if (riskBarEl) riskBarEl.style.width = riskScore == null ? '0%' : Math.max(2, Math.min(100, riskScore)) + '%';
    if (writeRouteEl) writeRouteEl.textContent = (riskScore != null && riskScore >= 70) || !u.accountEnabled ? 'Dual approval required' : 'Safe preview first';
    if (auditPostureEl) auditPostureEl.textContent = u.accountEnabled ? 'Chain ready' : 'Disabled account';
    const avatarEl = document.getElementById('udp-avatar');
    const roleExposureEl = document.getElementById('udp-role-exposure');
    const licenseExposureEl = document.getElementById('udp-license-exposure');
    const groupExposureEl = document.getElementById('udp-group-exposure');
    const nextActionEl = document.getElementById('udp-next-action');
    const routeEl = document.getElementById('udp-dossier-route');
    const initials = (u.displayName || u.userPrincipalName || '--')
      .split(/[.\s@_-]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '--';
    if (avatarEl) avatarEl.textContent = initials;

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
    if (licenseExposureEl) licenseExposureEl.textContent = lics.length ? lics.length + ' assigned' : 'none assigned';

    const groupsEl = document.getElementById('udp-groups');
    const grps = data.groups || [];
    groupsEl.innerHTML = grps.length
      ? grps.map(g => '<span class="user-tag">' + escHtml(g) + '</span>').join('')
      : '<span class="loading-hint">None</span>';
    const privileged = grps.some(g => /admin|privileged|pim|global|security/i.test(String(g)));
    if (roleExposureEl) roleExposureEl.textContent = privileged ? 'privileged group member' : 'standard user';
    if (groupExposureEl) groupExposureEl.textContent = grps.length ? grps.length + ' groups' : 'no groups';
    if (nextActionEl) nextActionEl.textContent = !u.accountEnabled ? 'audit disabled account' : (riskScore >= 70 || privileged ? 'review before write' : 'safe preview first');
    if (routeEl) routeEl.textContent = riskScore >= 70 || privileged ? 'approval-routed profile' : 'standard lifecycle profile';

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
  if (btnLeaverHard) btnLeaverHard.addEventListener('click', async () => {
    if (!_selectedUser) return;
    const confirmed = await confirmModal({
      title: 'Confirm Hard Leave',
      body: `Hard Leave permanently removes all licenses and group memberships for ${_selectedUser.displayName || _selectedUser.upn} and terminates the account. This cannot be undone.`,
      danger: true,
      okLabel: 'Hard Leave',
    });
    if (!confirmed) return;
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

  // ── Policy simulation (read-only dry-run) ────────────────────────────────
  const btnSim = document.getElementById('btn-policy-sim');
  if (btnSim && typeof window.api?.simulatePolicy === 'function') {
    btnSim.addEventListener('click', async () => {
      const upn = (document.getElementById('ps-upn') || {}).value || '';
      if (!upn.trim()) { showToast('UPN is required', 'warning'); return; }
      const resultEl = document.getElementById('ps-result');
      btnSim.disabled = true; resultEl.innerHTML = '<span class="dim">Evaluating policy…</span>';
      const r = await window.api.simulatePolicy({
        operation:         (document.getElementById('ps-operation') || {}).value,
        userPrincipalName: upn.trim(),
        licenses:          (document.getElementById('ps-licenses') || {}).value || '',
        groups:            (document.getElementById('ps-groups')   || {}).value || '',
        newDepartment:     (document.getElementById('ps-dept')     || {}).value || ''
      });
      btnSim.disabled = false;
      if (!r || r.error) { resultEl.innerHTML = '<span class="qop-error">Error: ' + escHtml(r?.error || 'unknown') + '</span>'; return; }
      const decision = (r.decision || 'allow');
      const lvl = (r.riskLevel || r.level || '—');
      const colors = { allow: 'var(--emerald)', warn: 'var(--amber)', requires_approval: 'var(--amber)', blocked: 'var(--coral)' };
      const reasons = Array.isArray(r.reasons) ? r.reasons : [];
      resultEl.innerHTML =
        '<div style="font-family:var(--mono);font-size:12px;line-height:1.7">' +
        '<div><b style="color:' + (colors[decision] || 'var(--text)') + '">DECISION: ' + escHtml(decision.toUpperCase().replace('_', ' ')) + '</b></div>' +
        '<div>risk score: <b>' + escHtml(String(r.score ?? '—')) + '</b> · level: <b>' + escHtml(String(lvl)) + '</b>' +
        (r.dualApproval ? ' · <span style="color:var(--amber)">dual approval required</span>' : '') + '</div>' +
        (reasons.length ? '<div style="margin-top:6px;color:var(--text-2)">matched policies:</div><ul style="margin:2px 0 0 16px">' +
          reasons.map(x => '<li>' + escHtml(String(x)) + '</li>').join('') + '</ul>' : '<div style="color:var(--text-3);margin-top:4px">No policy flags — clean.</div>') +
        '</div>';
    });
  }

  // ── Before/after access diff (read-only impact preview) ──────────────────
  function _diffList(before, after) {
    const b = new Set(before || []), a = new Set(after || []);
    const removed = [...b].filter(x => !a.has(x));
    const added   = [...a].filter(x => !b.has(x));
    const kept    = [...b].filter(x => a.has(x));
    return { removed, added, kept };
  }
  function _renderAccessDiff(snap, after, headline) {
    const chip = (t, kind) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;border-radius:99px;font-size:11px;` +
      (kind === 'rem' ? 'background:color-mix(in oklab,var(--coral),transparent 80%);color:var(--coral);text-decoration:line-through' :
       kind === 'add' ? 'background:color-mix(in oklab,var(--emerald),transparent 80%);color:var(--emerald)' :
       'background:var(--bg-2);color:var(--text-3)') + `">${escHtml(t)}</span>`;
    const gd = _diffList(snap.groups, after.groups);
    const ld = _diffList(snap.licenses, after.licenses);
    const section = (label, d) => {
      const parts = [];
      d.removed.forEach(x => parts.push(chip(x, 'rem')));
      d.added.forEach(x => parts.push(chip(x, 'add')));
      d.kept.forEach(x => parts.push(chip(x, 'keep')));
      return `<div style="margin-top:6px"><span style="color:var(--muted);font-size:11px">${label}:</span> ${parts.length ? parts.join('') : '<span class="dim">none</span>'}</div>`;
    };
    const enabledLine = (after.accountEnabled === false && snap.accountEnabled !== false)
      ? '<div style="margin-top:4px;color:var(--coral);font-size:12px">Account will be DISABLED + sessions revoked</div>' : '';
    return `<div style="font-family:var(--mono);font-size:12px;line-height:1.6">
      <div><b>${escHtml(headline)}</b> — ${escHtml(snap.displayName || '')}</div>
      ${enabledLine}
      ${section('Groups', gd)}
      ${section('Licenses', ld)}
      <div style="margin-top:6px;color:var(--text-4);font-size:10.5px">red = removed · green = added · grey = retained · read-only preview, no changes made</div>
    </div>`;
  }

  const btnPrevLeaver = document.getElementById('btn-preview-leaver');
  if (btnPrevLeaver && typeof window.api?.getAccessSnapshot === 'function') {
    btnPrevLeaver.addEventListener('click', async () => {
      const upn = (document.getElementById('ql-upn') || {}).value || '';
      if (!upn.trim()) { showToast('UPN is required', 'warning'); return; }
      const stage = (document.querySelector('input[name="ql-stage"]:checked') || {}).value || 'Soft';
      const resultEl = document.getElementById('ql-result');
      btnPrevLeaver.disabled = true; resultEl.innerHTML = '<span class="dim">Reading current access…</span>';
      const r = await window.api.getAccessSnapshot(upn.trim());
      btnPrevLeaver.disabled = false;
      if (!r || !r.ok) { resultEl.innerHTML = '<span class="qop-error">Error: ' + escHtml(r?.error || 'unknown') + '</span>'; return; }
      const snap = r.snapshot;
      // Soft: nothing removed yet (disable + revoke). Hard: removes all groups + licenses.
      const after = stage === 'Hard'
        ? { groups: [], licenses: [], accountEnabled: false }
        : { groups: snap.groups, licenses: snap.licenses, accountEnabled: false };
      resultEl.innerHTML = _renderAccessDiff(snap, after, stage === 'Hard' ? 'Hard leaver impact' : 'Soft leaver impact');
    });
  }

  const btnPrevMover = document.getElementById('btn-preview-mover');
  if (btnPrevMover && typeof window.api?.getAccessSnapshot === 'function') {
    btnPrevMover.addEventListener('click', async () => {
      const upn = (document.getElementById('qm-upn') || {}).value || '';
      if (!upn.trim()) { showToast('UPN is required', 'warning'); return; }
      const resultEl = document.getElementById('qm-result');
      btnPrevMover.disabled = true; resultEl.innerHTML = '<span class="dim">Reading current attributes…</span>';
      const r = await window.api.getAccessSnapshot(upn.trim());
      btnPrevMover.disabled = false;
      if (!r || !r.ok) { resultEl.innerHTML = '<span class="qop-error">Error: ' + escHtml(r?.error || 'unknown') + '</span>'; return; }
      const snap = r.snapshot;
      const newDept = (document.getElementById('qm-dept') || {}).value || '';
      const newTitle = (document.getElementById('qm-title') || {}).value || '';
      const newMgr = (document.getElementById('qm-manager') || {}).value || '';
      const row = (label, before, after) => {
        const changed = after && after !== before;
        return `<div>${escHtml(label)}: <span style="color:var(--text-3)">${escHtml(before || '—')}</span>` +
          (changed ? ` <span style="color:var(--text-4)">→</span> <span style="color:var(--emerald)">${escHtml(after)}</span>` : ' <span class="dim">(unchanged)</span>') + '</div>';
      };
      resultEl.innerHTML = `<div style="font-family:var(--mono);font-size:12px;line-height:1.7">
        <div><b>Mover impact</b> — ${escHtml(snap.displayName || '')}</div>
        ${row('Department', snap.department, newDept)}
        ${row('Job title', snap.jobTitle, newTitle)}
        ${row('Manager', '(current)', newMgr)}
        <div style="margin-top:6px;color:var(--text-4);font-size:10.5px">Groups/licenses unchanged by attribute move · read-only preview</div>
      </div>`;
    });
  }

  if (btnMover) {
    btnMover.addEventListener('click', async () => {
      const upn     = (document.getElementById('qm-upn')     || {}).value || '';
      const dept    = (document.getElementById('qm-dept')    || {}).value || '';
      const title   = (document.getElementById('qm-title')   || {}).value || '';
      const manager = (document.getElementById('qm-manager') || {}).value || '';
      const whatif  = (document.getElementById('qm-whatif')  || {}).checked !== false;
      if (!upn.trim()) { showToast('UPN is required', 'warning'); return; }
      // Live run requires a fresh write token; Safe is free
      let writeToken = null;
      if (!whatif) {
        const t = await requirePinIfNeeded('Confirm Live mover');
        if (!t) return;
        writeToken = typeof t === 'string' ? t : null;
      }
      const resultEl = document.getElementById('qm-result');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<span style="color:var(--text-dim)">Running…</span>'; }
      btnMover.disabled = true; btnMover.textContent = 'Running…';
      window.api.runQuickMover({ upn, newDepartment: dept, newJobTitle: title, newManager: manager, whatif, writeToken });
    });
  }

  if (btnLeaver) {
    btnLeaver.addEventListener('click', async () => {
      const upn    = (document.getElementById('ql-upn')    || {}).value || '';
      const stage  = (document.querySelector('input[name="ql-stage"]:checked') || {}).value || 'Soft';
      const reason = (document.getElementById('ql-reason') || {}).value || '';
      const whatif = (document.getElementById('ql-whatif') || {}).checked !== false;
      if (!upn.trim()) { showToast('UPN is required', 'warning'); return; }
      let writeToken = null;
      if (!whatif) {
        const t = await requirePinIfNeeded(`Confirm Live ${stage.toLowerCase()} leaver`);
        if (!t) return;
        writeToken = typeof t === 'string' ? t : null;
      }
      const resultEl = document.getElementById('ql-result');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<span style="color:var(--text-dim)">Running…</span>'; }
      btnLeaver.disabled = true; btnLeaver.textContent = 'Running…';
      window.api.runQuickLeaver({ upn, stage, reason, whatif, writeToken });
    });
  }

  window.api.onQuickOpResult((data) => {
    const isLeaver = data.type === 'leaver';
    const btnEl    = document.getElementById(isLeaver ? 'btn-run-quick-leaver' : 'btn-run-quick-mover');
    const resultEl = document.getElementById(isLeaver ? 'ql-result' : 'qm-result');

    if (btnEl) { btnEl.disabled = false; btnEl.textContent = isLeaver ? 'Run Leaver' : 'Run Mover'; }

    if (!resultEl) return;
    resultEl.style.display = 'block';

    if (data.approvalQueued) {
      resultEl.innerHTML = '<div class="qop-warn" style="color:var(--amber)">[APPROVAL QUEUED] Approval request submitted — go to the <strong>Approvals</strong> tab for admin sign-off. Token: ' + escHtml(String(data.token || '').toUpperCase()) + '</div>';
      showToast('Approval request queued — admin sign-off required in Approvals tab', 'warning');
      return;
    }

    const lines = data.lines || [];
    if (!lines.length) {
      resultEl.innerHTML = data.error
        ? '<span class="qop-error">Error: ' + escHtml(String(lines[0] || 'Unknown error')) + '</span>'
        : '<span style="color:var(--text-dim)">No output.</span>';
      return;
    }

    resultEl.innerHTML = lines.map(line => {
      if (/\[ACTION\]/.test(line))   return '<div class="qop-action">' + escHtml(line) + '</div>';
      if (/\[APPROVAL\]/.test(line)) return '<div class="qop-warn" style="color:var(--amber)">' + escHtml(line) + '</div>';
      if (/\[WARN\]/.test(line))     return '<div class="qop-warn">'   + escHtml(line) + '</div>';
      if (/\[ERROR\]/.test(line))    return '<div class="qop-error">'  + escHtml(line) + '</div>';
      if (/\[WHATIF\]/.test(line))   return '<div class="qop-whatif">' + escHtml(line) + '</div>';
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
      // Reset the triage card to a neutral state so it doesn't sit on the
      // "Checking…" placeholder when no agent certs exist yet.
      const _t = id => document.getElementById(id);
      if (_t('triage-certs-label')) _t('triage-certs-label').textContent = 'Rotations';
      if (_t('triage-certs-title')) _t('triage-certs-title').textContent = 'No certificates configured';
      if (_t('triage-certs-meta'))  _t('triage-certs-meta').textContent  = '';
      if (_t('triage-certs-sub'))   _t('triage-certs-sub').textContent   = '';
      return;
    }

    // Settings → Agent Certificates: replace the hardcoded rows/summary with
    // live per-agent data so they're accurate.
    const setRows = document.getElementById('set-cert-rows');
    if (setRows) {
      setRows.innerHTML = certs.map(c => {
        const d = c.daysRemaining;
        const crit = d != null && d < 0, warn = d != null && d >= 0 && d < 30;
        const days = d == null ? 'no expiry data' : (d < 0 ? Math.abs(d) + 'd expired' : 'expires in ' + d + 'd');
        const pip = crit ? 'cert-pip crit' : warn ? 'cert-pip warn' : 'cert-pip';
        const label = (c.agent || '').charAt(0).toUpperCase() + (c.agent || '').slice(1);
        const kind = c.credentialType === 'secret' ? 'Client secret' : 'Signing certificate';
        return '<div class="set-row"><div><div class="lbl">' + escHtml(label) + '</div><div class="desc">' + escHtml(kind) + '</div></div>'
          + '<div class="val right-ctrl"><span class="strong">' + escHtml(days) + '</span><span class="' + pip + '"><span class="d"></span>'
          + (crit ? 'EXPIRED' : warn ? 'ROTATE SOON' : 'OK') + '</span></div></div>';
      }).join('') || '<div class="set-row"><div class="desc">No certificate data.</div></div>';
    }
    const setSummary = document.getElementById('set-cert-summary');
    if (setSummary) {
      const healthy = certs.filter(c => c.daysRemaining == null || c.daysRemaining >= 30).length;
      setSummary.innerHTML = '<span class="d"></span>' + healthy + ' / ' + certs.length + ' HEALTHY';
    }

    // Fire notifications for certs expiring < 30 days
    certs.forEach(c => {
      if (c.daysRemaining !== null && c.daysRemaining < 30) {
        addNotification('⚠️', 'Cert expiring soon: ' + c.agent + ' (' + c.daysRemaining + 'd)');
      }
    });

    // Populate dashboard Agent Certs widget
    const _cOk   = certs.filter(c => c.daysRemaining === null || c.daysRemaining > 90).length;
    const _cWarn = certs.filter(c => c.daysRemaining !== null && c.daysRemaining > 0 && c.daysRemaining <= 90).length;
    const _cCrit = certs.filter(c => c.daysRemaining !== null && c.daysRemaining <= 0).length;

    // Update V2 triage card for cert rotations
    const expiring = certs.filter(c => c.daysRemaining !== null && c.daysRemaining > 0 && c.daysRemaining <= 30);
    const expired  = certs.filter(c => c.daysRemaining !== null && c.daysRemaining <= 0);
    const certsLabel = document.getElementById('triage-certs-label');
    const certsTitle = document.getElementById('triage-certs-title');
    const certsMeta  = document.getElementById('triage-certs-meta');
    const certsSub   = document.getElementById('triage-certs-sub');
    const certsCard  = document.getElementById('triage-certs');
    if (certsCard) certsCard.className = 'v2-triage-card ' + (expired.length > 0 ? 'crit' : expiring.length > 0 ? 'warn' : 'info');
    if (certsLabel) certsLabel.textContent = expired.length > 0
      ? 'Rotations · ' + expired.length + ' expired'
      : expiring.length > 0 ? 'Rotations · ' + expiring.length + ' soon' : 'Rotations · all healthy';
    if (certsTitle && expiring.length > 0) {
      const first = expiring.sort((a, b) => a.daysRemaining - b.daysRemaining)[0];
      certsTitle.textContent = first.agent + ' cert expires in ' + first.daysRemaining + ' days';
      if (certsMeta) certsMeta.textContent = first.agent + ' · ' + (first.thumbprint ? first.thumbprint.slice(0, 8) + '…' : '—');
    } else if (certsTitle && expired.length > 0) {
      const first = expired[0];
      certsTitle.textContent = first.agent + ' cert has expired';
      if (certsMeta) certsMeta.textContent = first.agent + ' · rotate immediately';
    } else if (certsTitle) {
      certsTitle.textContent = 'All agent certs healthy';
      if (certsMeta) certsMeta.textContent = 'Next rotation: > 90 days';
    }
    if (certsSub && expiring.length > 1) certsSub.textContent = 'Plus ' + (expiring.length - 1) + ' more expiring within 30 days';
    const _setDashCert = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    _setDashCert('dash-certs-ok',   _cOk);
    _setDashCert('dash-certs-warn', _cWarn || '—');
    _setDashCert('dash-certs-crit', _cCrit || '—');
    const _cCnt = document.getElementById('dash-certs-cnt');
    if (_cCnt) _cCnt.textContent = '· ' + certs.length + ' agent' + (certs.length !== 1 ? 's' : '');

    bodyEl.innerHTML =
      '<table class="cert-expiry-table">' +
        '<thead><tr><th>Agent</th><th>Thumbprint</th><th>Expiry</th><th>Days Remaining</th><th>Rotate by</th></tr></thead>' +
        '<tbody>' +
          certs.map(c => {
            const d     = c.daysRemaining;
            const dCls  = d === null ? '' : d < 30 ? 'days-critical' : d < 90 ? 'days-warning' : 'days-ok';
            const dText = d === null ? '—' : String(d) + 'd';
            const thumb = c.thumbprint ? (c.thumbprint.slice(0, 12) + '…') : '—';
            const exp   = c.expiry ? new Date(c.expiry).toLocaleDateString() : '—';
            // Rotate ~14 days before expiry (the Provisioner's auto-rotate window).
            const rotateBy = c.expiry
              ? new Date(new Date(c.expiry).getTime() - 14 * 86400000).toLocaleDateString() : '—';
            return '<tr>' +
              '<td style="text-transform:capitalize">' + escHtml(c.agent) + '</td>' +
              '<td class="mono">' + escHtml(thumb) + '</td>' +
              '<td>' + escHtml(exp) + '</td>' +
              '<td><span class="' + dCls + '">' + escHtml(dText) + '</span></td>' +
              '<td>' + escHtml(rotateBy) + '</td>' +
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
  const guardCard   = document.getElementById('graph-write-guard-card');
  const guardText   = document.getElementById('graph-write-guard');
  const guardSub    = document.getElementById('graph-write-guard-sub');
  const prevMethod  = document.getElementById('graph-preview-method');
  const prevTarget  = document.getElementById('graph-preview-target');
  const prevApprove = document.getElementById('graph-preview-approval');
  const dryrunMode  = document.getElementById('graph-dryrun-mode');

  // Quick-pick chips
  document.querySelectorAll('.graph-cq-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (methodSel) methodSel.value = chip.dataset.method || 'GET';
      if (urlInput)  urlInput.value  = chip.dataset.url   || '';
      updateGraphGuard();
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
    updateGraphGuard();
    showToast('Suggestion applied', 'success');
  });

  const RECENT_KEY   = 'jml-graph-recent';
  const btnColorJson = document.getElementById('btn-color-json');
  const digestCard   = document.getElementById('graph-digest-card');
  const digestText   = document.getElementById('graph-digest-text');
  let _colorMode = true, _lastRespText = '', _lastMethod = 'GET', _lastUrl = '';
  if (btnColorJson) { btnColorJson.textContent = 'Color: ON'; btnColorJson.classList.add('active'); }

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
        updateGraphGuard();
      });
    });
  }

  function isGraphMutation(method) {
    return /^(POST|PATCH|DELETE)$/i.test(method || '');
  }

  function updateGraphGuard() {
    const method = methodSel ? methodSel.value : 'GET';
    const url = urlInput ? urlInput.value.trim() || '/me' : '/me';
    const mutating = isGraphMutation(method);
    if (bodyArea) bodyArea.style.display = (method === 'POST' || method === 'PATCH') ? '' : 'none';
    if (guardCard) guardCard.classList.toggle('warn', mutating);
    if (guardText) guardText.textContent = mutating ? 'PIN + approval guarded' : 'Read-only request';
    if (guardSub) guardSub.textContent = mutating
      ? 'POST, PATCH, and DELETE require a fresh write token before the request is sent.'
      : 'GET calls are recorded but do not require approval.';
    if (prevMethod) prevMethod.textContent = method;
    if (prevTarget) prevTarget.textContent = url;
    if (prevApprove) prevApprove.textContent = mutating ? 'write token required' : 'not required';
    if (dryrunMode) dryrunMode.textContent = mutating ? 'guarded write' : 'safe read';
  }

  if (methodSel) methodSel.addEventListener('change', updateGraphGuard);
  if (urlInput) urlInput.addEventListener('input', updateGraphGuard);
  updateGraphGuard();
  renderRecent();

  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      const method = methodSel ? methodSel.value : 'GET';
      const url    = urlInput  ? urlInput.value.trim() : '';
      const body   = bodyArea  ? bodyArea.value.trim() : '';
      if (!url) { showToast('URL is required', 'warning'); return; }
      updateGraphGuard();
      let writeToken = null;
      if (isGraphMutation(method)) {
        const ok = await confirmModal({
          title: 'Guarded Graph write',
          body: method + ' ' + url + ' will mutate the tenant and requires a fresh operator write token.',
          danger: method === 'DELETE',
          okLabel: 'Continue',
        });
        if (!ok) return;
        const t = await requirePinIfNeeded('Confirm Graph ' + method);
        if (!t) return;
        writeToken = typeof t === 'string' ? t : null;
      }

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
      window.api.runGraphQuery({ method, url, body: parsedBody, writeToken });

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
      btnColorJson.textContent = _colorMode ? 'Color: ON' : 'Color: OFF';
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

// ── Command Palette (Ctrl+K) ──────────────────────────────────────────────────
(function () {
  const palette   = document.getElementById('cmd-palette');
  const input     = document.getElementById('cmd-input');
  const results   = document.getElementById('cmd-results');
  const backdrop  = palette && palette.querySelector('.cmd-backdrop');
  if (!palette || !input || !results) return;

  let _activeIdx = -1;
  let _items = [];

  // Tab navigation entries
  const TAB_CMDS = [
    { label: 'Dashboard',      meta: 'Overview',           tab: 'dashboard',      icon: '⊞' },
    { label: 'Approver Agent', meta: 'AI · conversational', tab: 'approver',      icon: '◇' },
    { label: 'Audit Agent',    meta: 'AI · read-only',     tab: 'auditor',        icon: '◌' },
    { label: 'Graph Runner',   meta: 'Ad-hoc Graph API',   tab: 'graph',          icon: '⟩⟨' },
    { label: 'Approvals',      meta: 'Pending sign-offs',  tab: 'approvals',      icon: '✓' },
    { label: 'Operations',     meta: 'Live · Queued',      tab: 'operations',     icon: '⚙' },
    { label: 'Access Reviews', meta: 'Certifier campaigns',tab: 'certifications', icon: '◈' },
    { label: 'Integrations',   meta: 'HRIS · Teams · SIEM',tab: 'integrations',   icon: '⇆' },
    { label: 'Security',       meta: 'UEBA · Drift',       tab: 'security',       icon: '◥' },
    { label: 'Audit Log',      meta: 'Hash-chained events',tab: 'audit-log',      icon: '≡' },
    { label: 'Exports',        meta: 'Sentinel · Blob',    tab: 'exports',        icon: '↑' },
    { label: 'Users',          meta: 'Directory search',   tab: 'users',          icon: '◎' },
    { label: 'Agent Certs',    meta: 'Certificates · expiry',tab: 'certs',        icon: '⬟' },
    { label: 'Settings',       meta: 'Tenant · operators', tab: 'settings',       icon: '◎' },
  ];

  // Action entries
  const ACTION_CMDS = [
    { label: 'New Joiner',    meta: 'Open Approver Agent', action: () => { closePalette(); switchTab('approver'); const i = document.getElementById('input-approver'); if (i) { i.value = 'New joiner: '; i.focus(); } } },
    { label: 'Offboard User', meta: 'Quick Leaver',        action: () => { closePalette(); switchTab('operations'); setTimeout(() => document.getElementById('ops-quick-leaver')?.setAttribute('open',''), 100); } },
    { label: 'Move User',     meta: 'Quick Mover',         action: () => { closePalette(); switchTab('operations'); setTimeout(() => document.getElementById('ops-quick-mover')?.setAttribute('open',''), 100); } },
    { label: 'Run Security Scan', meta: 'Re-scan UEBA + Drift', action: () => { closePalette(); switchTab('security'); setTimeout(() => document.getElementById('refresh-security')?.click(), 200); } },
    { label: 'Open Audit Log', meta: 'Browse hash-chain', action: () => { closePalette(); switchTab('audit-log'); } },
  ];

  function openPalette() {
    palette.style.display = 'flex';
    input.value = '';
    _activeIdx = -1;
    renderResults('');
    setTimeout(() => input.focus(), 30);
  }

  function closePalette() {
    palette.style.display = 'none';
    input.value = '';
    _activeIdx = -1;
  }

  function renderResults(q) {
    const ql = q.toLowerCase().trim();
    _items = [];
    let html = '';

    // Score and filter tab commands
    const tabMatches = TAB_CMDS.filter(c =>
      !ql || c.label.toLowerCase().includes(ql) || c.meta.toLowerCase().includes(ql)
    );
    if (tabMatches.length) {
      html += '<div class="cmd-group-label">Navigate</div>';
      tabMatches.forEach(c => {
        const idx = _items.length;
        _items.push({ type: 'tab', tab: c.tab });
        html += `<div class="cmd-item" data-idx="${idx}" role="option">
          <div class="cmd-item-icon">${escHtml(c.icon)}</div>
          <div class="cmd-item-label">${escHtml(c.label)}</div>
          <div class="cmd-item-meta">${escHtml(c.meta)}</div>
        </div>`;
      });
    }

    // User cache matches
    const userMatches = (typeof _userCache !== 'undefined' ? _userCache : [])
      .filter(u => !ql || (u.displayName || '').toLowerCase().includes(ql) || (u.userPrincipalName || '').toLowerCase().includes(ql))
      .slice(0, 5);
    if (userMatches.length) {
      html += '<div class="cmd-group-label">Users</div>';
      userMatches.forEach(u => {
        const idx = _items.length;
        const initials = (u.displayName || u.userPrincipalName || '?').split(/[\s._@-]+/).filter(Boolean).map(s => s[0]).join('').slice(0,2).toUpperCase();
        _items.push({ type: 'user', upn: u.userPrincipalName });
        html += `<div class="cmd-item" data-idx="${idx}" role="option">
          <div class="cmd-item-icon" style="font-family:var(--mono);font-size:10px">${escHtml(initials)}</div>
          <div style="flex:1;min-width:0">
            <div class="cmd-item-label">${escHtml(u.displayName || u.userPrincipalName)}</div>
            <div class="cmd-item-upn">${escHtml(u.userPrincipalName || '')}</div>
          </div>
          <div class="cmd-item-meta">${escHtml(u.department || u.jobTitle || '')}</div>
        </div>`;
      });
    }

    // Action commands
    const actionMatches = ACTION_CMDS.filter(c =>
      !ql || c.label.toLowerCase().includes(ql) || c.meta.toLowerCase().includes(ql)
    );
    if (actionMatches.length) {
      html += '<div class="cmd-group-label">Actions</div>';
      actionMatches.forEach(c => {
        const idx = _items.length;
        _items.push({ type: 'action', fn: c.action });
        html += `<div class="cmd-item" data-idx="${idx}" role="option">
          <div class="cmd-item-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="cmd-item-label">${escHtml(c.label)}</div>
          <div class="cmd-item-meta">${escHtml(c.meta)}</div>
        </div>`;
      });
    }

    if (!html) {
      html = `<div class="cmd-empty">No results for "${escHtml(q)}"</div>`;
    }

    results.innerHTML = html;
    _activeIdx = -1;

    results.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('mouseenter', () => setActive(parseInt(el.dataset.idx, 10)));
      el.addEventListener('click', () => selectItem(parseInt(el.dataset.idx, 10)));
    });
  }

  function setActive(idx) {
    _activeIdx = idx;
    results.querySelectorAll('.cmd-item').forEach((el, i) => el.classList.toggle('active', i === idx || parseInt(el.dataset.idx, 10) === idx));
  }

  function selectItem(idx) {
    const item = _items[idx];
    if (!item) return;
    if (item.type === 'tab') {
      closePalette();
      switchTab(item.tab);
    } else if (item.type === 'user') {
      closePalette();
      switchTab('users');
      const si = document.getElementById('user-search-input');
      if (si) { si.value = item.upn; document.getElementById('btn-user-search')?.click(); }
    } else if (item.type === 'action') {
      item.fn();
    }
  }

  // Keyboard navigation
  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', e => {
    const visibleItems = results.querySelectorAll('.cmd-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(_activeIdx + 1, visibleItems.length - 1);
      const nextIdx = parseInt(visibleItems[next]?.dataset.idx ?? next, 10);
      setActive(nextIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(_activeIdx - 1, 0);
      const prevIdx = parseInt(visibleItems[prev]?.dataset.idx ?? prev, 10);
      setActive(prevIdx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Find item by active index from dataset
      const activeEl = results.querySelector('.cmd-item.active');
      if (activeEl) selectItem(parseInt(activeEl.dataset.idx, 10));
      else if (_items.length) selectItem(parseInt(visibleItems[0]?.dataset.idx ?? '0', 10));
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  // Open/close triggers
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      palette.style.display === 'none' ? openPalette() : closePalette();
    }
    if (e.key === 'Escape' && palette.style.display !== 'none') closePalette();
  });

  if (backdrop) backdrop.addEventListener('click', closePalette);
})();

// Docked panel toggle buttons (topbar #btn-toggle-docked + sidebar .nav-docked-toggle)
(function () {
  const btns = document.querySelectorAll('#btn-toggle-docked, .nav-docked-toggle');
  if (!btns.length) return;
  btns.forEach(btn => btn.addEventListener('click', () => { window.api.toggleDockedPanel(); }));
  window.api.onDockedPanelState(visible => { btns.forEach(btn => btn.classList.toggle('active', !!visible)); });
})();

// Agent Overlay toggle buttons (topbar #btn-toggle-overlay + sidebar .nav-overlay-toggle)
(function () {
  const btns = document.querySelectorAll('#btn-toggle-overlay, .nav-overlay-toggle');
  if (!btns.length) return;
  btns.forEach(btn => btn.addEventListener('click', () => { window.api.toggleOverlay(); }));
  window.api.onOverlayState(visible => { btns.forEach(btn => btn.classList.toggle('active', !!visible)); });
})();

// Maximize/restore — toggle rounded corners
window.api.onMaximized(isMax => { document.body.classList.toggle('maximized', isMax); });

// Azure Portal button
(function () {
  const btn = document.getElementById('btn-azure');
  if (!btn) return;
  btn.addEventListener('click', () => { window.api.openExternal('https://portal.azure.com'); });
})();

// Populate tenant badge from live agent config (replaces hardcoded placeholder)
(function () {
  window.api.getTenantConfig().then(cfg => {
    if (cfg && cfg.primaryDomain) {
      document.querySelectorAll('.tenant-badge').forEach(el => { el.textContent = cfg.primaryDomain; });
    }
  }).catch(() => {});
})();

// Sync session mode when toggled from the docked panel
window.api.onModeChanged(({ whatif }) => {
  isWhatif = whatif;
  setHardMode(whatif ? 'whatif' : 'live');
  window.api.setMode(whatif);
  window.JmlModeUi.syncModeUi(document, whatif);
  updateTopbarModePill();
});

// ── Glass Screen — live Command Center ──────────────────────────────────────
// All state, rendering, and motion live in glass-screen.js (window.JmlGlassScreen),
// backed by the pure view-model in glass-screen-model.js. app.js only forwards
// operation-status IPC events, audit entries, and tab activation to it.

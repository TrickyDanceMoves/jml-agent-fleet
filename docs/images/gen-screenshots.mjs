import puppeteer from '/opt/node22/lib/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Shared design tokens (inlined — no font file deps for screenshot) ──────
const TOKENS = `
  :root {
    --bg: oklch(0.16 0.012 252);
    --bg-2: oklch(0.18 0.014 252);
    --surface: oklch(0.205 0.016 252);
    --elev: oklch(0.235 0.018 252);
    --elev-2: oklch(0.27 0.020 252);
    --border: oklch(0.31 0.022 252);
    --border-strong: oklch(0.40 0.030 252);
    --text: oklch(0.97 0.005 252);
    --text-2: oklch(0.78 0.010 252);
    --muted: oklch(0.58 0.014 252);
    --dim: oklch(0.42 0.014 252);
    --cyan: oklch(0.74 0.07 220);
    --cyan-dim: oklch(0.48 0.06 220);
    --coral: oklch(0.70 0.20 24);
    --emerald: oklch(0.78 0.16 155);
    --amber: oklch(0.82 0.16 75);
    --violet: oklch(0.74 0.14 280);
    --r-1: 6px; --r-2: 10px; --r-3: 14px;
    --mono: 'JetBrains Mono', 'Cascadia Code', 'Consolas', ui-monospace, monospace;
    --sans: 'Geist', 'Inter', ui-sans-serif, system-ui, sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased; }
`;

// ── Reusable shell (sidebar + topbar) ─────────────────────────────────────
function shell(activeTab, content) {
  const navItems = [
    { tab: 'dashboard',      label: 'Dashboard',      section: 'Overview',  icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { tab: 'approver',       label: 'Approver Agent', section: 'Dispatch',  icon: '<path d="M12 2L3 7v10l9 5 9-5V7L12 2z"/><path d="M9 12l2 2 4-4"/>' },
    { tab: 'auditor',        label: 'Audit Agent',    section: null,        icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>' },
    { tab: 'graph',          label: 'Graph Runner',   section: null,        icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>' },
    { tab: 'approvals',      label: 'Approvals',      section: 'Operate',   icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>' },
    { tab: 'operations',     label: 'Operations',     section: null,        icon: '<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>' },
    { tab: 'certifications', label: 'Access Reviews', section: null,        icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>' },
    { tab: 'integrations',   label: 'Integrations',   section: null,        icon: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>' },
    { tab: 'security',       label: 'Security',       section: 'Govern',    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
    { tab: 'audit-log',      label: 'Audit Log',      section: null,        icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
    { tab: 'exports',        label: 'Exports',        section: null,        icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>' },
    { tab: 'users',          label: 'Users',          section: 'Data',      icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    { tab: 'certs',          label: 'Certs',          section: null,        icon: '<circle cx="12" cy="8" r="6"/><path d="M9 14l-2 8 5-3 5 3-2-8"/>' },
    { tab: 'settings',       label: 'Settings',       section: null,        icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
  ];

  let navHtml = '';
  let lastSection = null;
  for (const item of navItems) {
    if (item.section && item.section !== lastSection) {
      navHtml += `<div class="nav-section">${item.section}</div>`;
      lastSection = item.section;
    }
    const isActive = item.tab === activeTab;
    navHtml += `
      <button class="nav-item${isActive ? ' active' : ''}" data-tab="${item.tab}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">${item.icon}</svg>
        <span>${item.label}</span>
      </button>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${TOKENS}
    body { background:
      radial-gradient(1100px 600px at 8% -10%, oklch(0.24 0.05 230 / .35), transparent 60%),
      radial-gradient(900px 500px at 105% 100%, oklch(0.22 0.06 280 / .25), transparent 55%),
      var(--bg);
    }
    .layout { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
    .sidebar {
      background: var(--bg-2);
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      padding-bottom: 16px;
    }
    .brand {
      display: flex; align-items: center; gap: 10px;
      padding: 16px 14px 12px;
      border-bottom: 1px solid var(--border);
    }
    .brand-mark {
      width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
      background: conic-gradient(from 220deg at 50% 50%, var(--cyan), var(--violet), var(--coral), var(--cyan));
      position: relative;
    }
    .brand-mark::after { content: ""; position: absolute; inset: 4px; border-radius: 5px; background: var(--bg-2); }
    .brand-mark::before {
      content: ""; position: absolute; inset: 8px; border-radius: 3px;
      background: linear-gradient(135deg, var(--cyan), var(--violet));
    }
    .brand-text { display: flex; flex-direction: column; gap: 1px; }
    .brand-text .t1 { font-size: 13px; font-weight: 600; line-height: 1.2; }
    .brand-text .t2 { font-size: 10px; color: var(--muted); font-family: var(--mono); letter-spacing: .04em; }
    .side-tag {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 14px;
      font-family: var(--mono); font-size: 10px; color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    .tenant-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); flex-shrink: 0; box-shadow: 0 0 0 3px color-mix(in oklch, var(--emerald) 12%, transparent); }
    .nav-items { padding: 8px; flex: 1; overflow-y: auto; }
    .nav-section { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); padding: 10px 8px 4px; }
    .nav-item {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 10px; border-radius: var(--r-1);
      font-size: 12.5px; color: var(--text-2); cursor: pointer;
      background: transparent; border: none; width: 100%; text-align: left;
      position: relative;
    }
    .nav-item:hover { background: color-mix(in oklch, var(--surface) 60%, transparent); color: var(--text); }
    .nav-item.active {
      background: linear-gradient(90deg, color-mix(in oklch, var(--cyan-dim) 35%, transparent), transparent);
      color: var(--text);
    }
    .nav-item.active svg { color: var(--cyan); }
    .nav-item.active::before {
      content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
      width: 3px; height: 60%; border-radius: 99px; background: var(--cyan);
    }
    .nav-item svg { color: var(--muted); flex-shrink: 0; }
    .hard-mode { padding: 10px 10px 4px; border-top: 1px solid var(--border); margin-top: auto; }
    .hard-mode-lbl { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: var(--dim); margin-bottom: 6px; }
    .hard-mode-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    .hard-mode-btn {
      padding: 5px; border-radius: var(--r-1); border: 1px solid var(--border);
      font-family: var(--mono); font-size: 11px; color: var(--muted);
      background: transparent; cursor: pointer;
    }
    .hard-mode-btn.active { border-color: var(--cyan-dim); color: var(--cyan); background: color-mix(in oklch, var(--cyan) 8%, transparent); }
    .who { display: flex; align-items: center; gap: 8px; padding: 10px; border-top: 1px solid var(--border); }
    .who-avatar {
      width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
      background: linear-gradient(135deg, var(--cyan-dim), var(--violet));
      display: grid; place-items: center; font-size: 11px; font-weight: 600;
    }
    .who-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .who-name { font-size: 12px; font-weight: 500; }
    .who-role { font-family: var(--mono); font-size: 9px; color: var(--cyan); }
    /* Main */
    .main { display: flex; flex-direction: column; min-height: 100vh; overflow: hidden; }
    .topbar {
      display: flex; align-items: center; gap: 10px;
      padding: 0 20px; height: 44px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in oklch, var(--bg-2) 80%, transparent);
      backdrop-filter: blur(8px);
      flex-shrink: 0;
    }
    .topbar-title { font-size: 12.5px; font-weight: 600; flex: 1; }
    .topbar-mode-pill {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: 99px;
      font-family: var(--mono); font-size: 10px;
      border: 1px solid color-mix(in oklch, var(--amber) 30%, transparent);
      color: var(--amber); background: color-mix(in oklch, var(--amber) 6%, transparent);
    }
    .topbar-mode-pill .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--amber); }
    .content-area { flex: 1; overflow-y: auto; padding: 20px 24px; }
    /* View head */
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    .h1 { font-size: 20px; font-weight: 700; letter-spacing: -.02em; }
    .h1 .sub { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 8px; }
    .desc { font-size: 12.5px; color: var(--text-2); line-height: 1.55; margin-top: 4px; max-width: 640px; }
    .row-flex { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn {
      padding: 7px 14px; border-radius: var(--r-1); font-size: 12.5px; cursor: pointer;
      font-family: inherit; border: 1px solid var(--border); color: var(--text-2);
      background: var(--surface); transition: border-color .15s, color .15s;
    }
    .btn:hover { border-color: var(--border-strong); color: var(--text); }
    .btn.ghost { background: transparent; }
    /* Panel */
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; margin-bottom: 14px; }
    .panel-h { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
    .ttl { font-size: 13px; font-weight: 600; }
    .loading-hint { font-size: 12px; color: var(--muted); padding: 18px 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"></div>
        <div class="brand-text">
          <span class="t1">JML Fleet</span>
          <span class="t2">Identity Console</span>
        </div>
      </div>
      <div class="side-tag">
        <span class="tenant-dot"></span>
        <span>contoso.onmicrosoft.com</span>
      </div>
      <nav class="nav-items">${navHtml}</nav>
      <div class="hard-mode">
        <div class="hard-mode-lbl">Session Mode</div>
        <div class="hard-mode-toggle">
          <button class="hard-mode-btn active">Safe</button>
          <button class="hard-mode-btn">Live</button>
        </div>
      </div>
      <div class="who">
        <div class="who-avatar">AW</div>
        <div class="who-meta">
          <div class="who-name">a.whitfield</div>
          <div class="who-role">admin</div>
        </div>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div class="topbar-title">JML Fleet · Identity Console</div>
        <div class="topbar-mode-pill"><span class="dot"></span> Safe · Safe</div>
      </div>
      <div class="content-area">${content}</div>
    </div>
  </div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1.  ACCESS REVIEWS page
// ═══════════════════════════════════════════════════════════════════════════
const accessReviewsContent = `
<style>
  .cert-campaign-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2);
    padding: 16px; margin-bottom: 10px;
  }
  .cert-campaign-header { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cert-campaign-type-icon {
    width: 26px; height: 26px; border-radius: var(--r-1); background: var(--elev);
    display: grid; place-items: center; color: var(--cyan); flex-shrink: 0;
  }
  .cert-campaign-name { flex: 1; }
  .cert-status-badge {
    font-family: var(--mono); font-size: 10px; padding: 3px 8px;
    border-radius: 4px; border: 1px solid; letter-spacing: .06em; text-transform: uppercase;
  }
  .cert-status-active    { color: var(--cyan);    border-color: color-mix(in oklch, var(--cyan) 35%, transparent);    background: color-mix(in oklch, var(--cyan) 8%, transparent); }
  .cert-status-completed { color: var(--emerald); border-color: color-mix(in oklch, var(--emerald) 35%, transparent); background: color-mix(in oklch, var(--emerald) 8%, transparent); }
  .cert-status-pending   { color: var(--amber);   border-color: color-mix(in oklch, var(--amber) 35%, transparent);   background: color-mix(in oklch, var(--amber) 8%, transparent); }
  .cert-campaign-meta { margin-top: 8px; font-family: var(--mono); font-size: 11px; color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap; }
  .cert-meta-item .dim-label { color: var(--dim); margin-right: 4px; }
  .bar { margin-top: 14px; height: 6px; background: oklch(0.24 0.018 252); border-radius: 99px; overflow: hidden; display: flex; }
  .bar i.approved { background: var(--emerald); }
  .bar i.revoked  { background: var(--coral); }
  .bar i.pending  { background: var(--amber); }
  .bar-legend { display: flex; gap: 14px; margin-top: 8px; font-family: var(--mono); font-size: 11px; color: var(--text-2); }
  .cert-history-row {
    display: grid; grid-template-columns: 1fr 140px 80px 80px;
    gap: 10px; padding: 9px 16px; border-bottom: 1px solid var(--border);
    font-family: var(--mono); font-size: 11.5px; align-items: center;
  }
  .cert-history-row.head { color: var(--dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; background: var(--elev); }
  .ok-icon { color: var(--emerald); }
  .fail-icon { color: var(--coral); }
  .pending-icon { color: var(--amber); }
  .run-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 14px 16px; }
  .check-label { font-size: 12.5px; display: flex; align-items: center; gap: 6px; color: var(--text-2); }
  .check-label input[type=checkbox] { accent-color: var(--cyan); }
</style>

<div class="head">
  <div>
    <h1 class="h1">Access Reviews <span class="sub">recurring entitlement attestations</span></h1>
    <p class="desc">Driven by the Certifier agent. Reviewers attest in-product; revocations route through Approver for dual-control on sensitive groups.</p>
  </div>
  <div class="row-flex">
    <button class="btn ghost">Refresh</button>
  </div>
</div>

<div class="panel" style="margin-bottom:14px">
  <div class="panel-h"><div class="ttl">Run a Campaign</div></div>
  <div class="run-controls">
    <label class="check-label"><input type="checkbox" checked> Safe</label>
    <button class="btn">All Entitlements</button>
    <button class="btn">User · Groups</button>
    <button class="btn">Agent PIM Roles</button>
  </div>
  <!-- Inline result after last run -->
  <div style="padding:0 16px 14px">
    <div style="font-family:var(--mono);font-size:11.5px;color:var(--text-2);margin-bottom:10px">
      <span style="color:var(--emerald)">✓ Campaign scan complete</span>
      <span style="color:var(--muted)"> · 3 campaigns found</span>
    </div>
    <!-- Campaign card 1 -->
    <div class="cert-campaign-card">
      <div class="cert-campaign-header">
        <div class="cert-campaign-type-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <div class="cert-campaign-name">Q1 2025 · All Users Group Membership</div>
        <span class="cert-status-badge cert-status-active">Active</span>
      </div>
      <div class="cert-campaign-meta">
        <span class="cert-meta-item"><span class="dim-label">Type</span> user-groups</span>
        <span class="cert-meta-item"><span class="dim-label">Created</span> Apr 1, 2025</span>
        <span class="cert-meta-item"><span class="dim-label">Progress</span> 38 / 54 reviewed</span>
      </div>
      <div class="bar">
        <i class="approved" style="height:100%;display:block;width:60%"></i>
        <i class="revoked"  style="height:100%;display:block;width:10%"></i>
        <i class="pending"  style="height:100%;display:block;width:30%"></i>
      </div>
      <div class="bar-legend">
        <span><span style="color:var(--emerald)">●</span> approved 32</span>
        <span><span style="color:var(--coral)">●</span> revoked 6</span>
        <span><span style="color:var(--amber)">●</span> pending 16</span>
      </div>
    </div>
    <!-- Campaign card 2 -->
    <div class="cert-campaign-card">
      <div class="cert-campaign-header">
        <div class="cert-campaign-type-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div class="cert-campaign-name">Agent PIM Eligibility Attestation — May</div>
        <span class="cert-status-badge cert-status-active">Active</span>
      </div>
      <div class="cert-campaign-meta">
        <span class="cert-meta-item"><span class="dim-label">Type</span> agent-pim</span>
        <span class="cert-meta-item"><span class="dim-label">Created</span> May 1, 2025</span>
        <span class="cert-meta-item"><span class="dim-label">Progress</span> 5 / 8 reviewed</span>
      </div>
      <div class="bar">
        <i class="approved" style="height:100%;display:block;width:62%"></i>
        <i class="revoked"  style="height:100%;display:block;width:0%"></i>
        <i class="pending"  style="height:100%;display:block;width:38%"></i>
      </div>
      <div class="bar-legend">
        <span><span style="color:var(--emerald)">●</span> approved 5</span>
        <span><span style="color:var(--coral)">●</span> revoked 0</span>
        <span><span style="color:var(--amber)">●</span> pending 3</span>
      </div>
    </div>
    <!-- Campaign card 3 -->
    <div class="cert-campaign-card">
      <div class="cert-campaign-header">
        <div class="cert-campaign-type-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div class="cert-campaign-name">Q4 2024 · Privileged Role Holders</div>
        <span class="cert-status-badge cert-status-completed">Completed</span>
      </div>
      <div class="cert-campaign-meta">
        <span class="cert-meta-item"><span class="dim-label">Type</span> user-groups</span>
        <span class="cert-meta-item"><span class="dim-label">Created</span> Oct 15, 2024</span>
        <span class="cert-meta-item"><span class="dim-label">Progress</span> 71 / 71 reviewed</span>
      </div>
      <div class="bar">
        <i class="approved" style="height:100%;display:block;width:85%"></i>
        <i class="revoked"  style="height:100%;display:block;width:15%"></i>
        <i class="pending"  style="height:100%;display:block;width:0%"></i>
      </div>
      <div class="bar-legend">
        <span><span style="color:var(--emerald)">●</span> approved 60</span>
        <span><span style="color:var(--coral)">●</span> revoked 11</span>
        <span><span style="color:var(--amber)">●</span> pending 0</span>
      </div>
    </div>
  </div>
</div>

<div class="panel">
  <div class="panel-h"><div class="ttl">Campaign History</div></div>
  <div class="cert-history-row head"><span>Campaign</span><span>Run</span><span>Type</span><span>Outcome</span></div>
  <div class="cert-history-row">
    <span style="color:var(--text)">Agent PIM Eligibility Attestation — May</span>
    <span style="color:var(--muted)">May 1, 2025 09:14</span>
    <span style="color:var(--text-2)">agent-pim</span>
    <span class="ok-icon">✓ success</span>
  </div>
  <div class="cert-history-row">
    <span style="color:var(--text)">Q1 2025 · All Users Group Membership</span>
    <span style="color:var(--muted)">Apr 1, 2025 08:00</span>
    <span style="color:var(--text-2)">user-groups</span>
    <span class="ok-icon">✓ success</span>
  </div>
  <div class="cert-history-row">
    <span style="color:var(--text)">Privileged Role Holders (ad-hoc)</span>
    <span style="color:var(--muted)">Feb 14, 2025 14:32</span>
    <span style="color:var(--text-2)">user-groups</span>
    <span class="ok-icon">✓ success</span>
  </div>
  <div class="cert-history-row">
    <span style="color:var(--text)">Q4 2024 · Privileged Role Holders</span>
    <span style="color:var(--muted)">Oct 15, 2024 08:00</span>
    <span style="color:var(--text-2)">user-groups</span>
    <span class="ok-icon">✓ success</span>
  </div>
  <div class="cert-history-row">
    <span style="color:var(--text)">Q3 2024 · All Entitlements</span>
    <span style="color:var(--muted)">Jul 1, 2024 08:00</span>
    <span style="color:var(--text-2)">all</span>
    <span class="fail-icon">✗ partial</span>
  </div>
</div>
`;

// ═══════════════════════════════════════════════════════════════════════════
// 2.  INTEGRATIONS page
// ═══════════════════════════════════════════════════════════════════════════
const integrationsContent = `
<style>
  .int-trio { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 14px; margin-bottom: 18px; }
  .int {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2);
    padding: 16px; display: flex; flex-direction: column; gap: 14px;
  }
  .int .top { display: flex; align-items: center; gap: 10px; }
  .int .top .logo {
    width: 36px; height: 36px; border-radius: var(--r-1); flex-shrink: 0;
    display: grid; place-items: center; font-weight: 700; font-size: 12px;
    background: linear-gradient(135deg, var(--elev), var(--elev-2));
    border: 1px solid var(--border-strong); color: var(--text-2);
    font-family: var(--mono);
  }
  .int .top .nm { display: flex; flex-direction: column; line-height: 1.2; flex: 1; }
  .int .top .nm .n { font-size: 14px; font-weight: 600; }
  .int .top .nm .s { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 2px; }
  .int .top .health {
    display: flex; align-items: center; gap: 5px; margin-left: auto; flex-shrink: 0;
    font-family: var(--mono); font-size: 10px; color: var(--emerald);
    text-transform: uppercase; letter-spacing: .08em;
  }
  .int .top .health::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); box-shadow: 0 0 0 3px color-mix(in oklch, var(--emerald) 12%, transparent); }
  .int .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 14px; font-family: var(--mono); font-size: 11.5px; }
  .int .grid .k { color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; align-self: center; }
  .int .grid .v { color: var(--text); align-self: center; }
  .queue { border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface); overflow: hidden; margin-bottom: 18px; }
  .queue-h { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-bottom: 1px solid var(--border); }
  .queue-h .ttl { font-size: 13px; font-weight: 600; }
  .queue-h .meta { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .q-row {
    display: grid; grid-template-columns: 80px 90px 1fr 1fr 80px;
    padding: 9px 18px; border-bottom: 1px solid var(--border);
    font-family: var(--mono); font-size: 11.5px; align-items: center; gap: 10px;
  }
  .q-row.head { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); background: var(--elev); }
  .agent-tag { font-size: 10px; padding: 2px 7px; border-radius: 4px; border: 1px solid; width: fit-content; }
  .t-bamboohr, .t-hris { color: var(--emerald); border-color: color-mix(in oklch, var(--emerald) 35%, transparent); background: color-mix(in oklch, var(--emerald) 8%, transparent); }
  .stat { font-size: 10px; }
  .stat.ok { color: var(--emerald); }
  .stat.q  { color: var(--amber); }
  .stat.proc { color: var(--cyan); }
  .schema { border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface); overflow: hidden; }
  .schema-h { padding: 14px 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .schema-h .ttl { font-size: 13px; font-weight: 600; }
  .schema pre { margin: 0; padding: 18px; font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--text-2); }
  .schema pre .k { color: var(--cyan); }
  .schema pre .s { color: var(--emerald); }
  .schema pre .c { color: var(--dim); }
</style>

<div class="head">
  <div>
    <h1 class="h1">Integrations <span class="sub">HRIS · notifications · SIEM</span></h1>
    <p class="desc">External systems of record that emit lifecycle events into the fleet. Events flow through the canonical schema and a durable queue before any agent acts.</p>
  </div>
  <div class="row-flex">
    <button class="btn ghost">Replay Queue</button>
  </div>
</div>

<div class="int-trio">
  <div class="int bamboo">
    <div class="top">
      <div class="logo">BB</div>
      <div class="nm"><span class="n">BambooHR</span><span class="s">HRIS · webhook</span></div>
      <span class="health">live</span>
    </div>
    <div class="grid">
      <span class="k">Endpoint</span><span class="v">/api/webhooks/bamboohr</span>
      <span class="k">Secret</span><span class="v">••••• rotate</span>
      <span class="k">Events / 24h</span><span class="v">47</span>
      <span class="k">Last event</span><span class="v">14:22:08</span>
      <span class="k">Mapped</span><span class="v">14 / 14</span>
      <span class="k">Failure</span><span class="v" style="color:var(--emerald)">0.00 %</span>
    </div>
  </div>
  <div class="int teams">
    <div class="top">
      <div class="logo">MT</div>
      <div class="nm"><span class="n">Microsoft Teams</span><span class="s">notifications · webhook</span></div>
      <span class="health">live</span>
    </div>
    <div class="grid">
      <span class="k">Channel</span><span class="v">#identity-ops</span>
      <span class="k">Card</span><span class="v">Adaptive 1.5</span>
      <span class="k">Sent / 24h</span><span class="v">12</span>
      <span class="k">Failure</span><span class="v" style="color:var(--emerald)">0.00 %</span>
      <span class="k">Triggers</span><span class="v">approval · fail · drift</span>
      <span class="k">On crit</span><span class="v">@oncall-identity</span>
    </div>
  </div>
  <div class="int sentinel">
    <div class="top">
      <div class="logo">MS</div>
      <div class="nm"><span class="n">Sentinel Pipeline</span><span class="s">DCR · Log Analytics</span></div>
      <span class="health">live</span>
    </div>
    <div class="grid">
      <span class="k">Workspace</span><span class="v">jml-fleet-ws</span>
      <span class="k">Table</span><span class="v">JmlFleet_CL</span>
      <span class="k">Records / 24h</span><span class="v">312</span>
      <span class="k">Lag</span><span class="v">~1.2 s</span>
      <span class="k">Rules</span><span class="v">7 active</span>
      <span class="k">Incidents</span><span class="v" style="color:var(--emerald)">0 open</span>
    </div>
  </div>
</div>

<div class="queue">
  <div class="queue-h">
    <div class="ttl">Event Queue <span style="font-family:var(--mono);font-size:11px;color:var(--muted);font-weight:400;margin-left:6px">· durable · at-least-once</span></div>
    <div class="meta">queued <b style="color:var(--text)">3</b> · processing <b style="color:var(--cyan)">1</b> · dlq <b style="color:var(--coral)">0</b></div>
  </div>
  <div class="q-row head"><span>QUEUED</span><span>SOURCE</span><span>EVENT</span><span>SUBJECT</span><span>STATUS</span></div>
  <div class="q-row">
    <span>14:22:08</span>
    <span class="agent-tag t-hris">bamboohr</span>
    <span>employee.hire</span>
    <span>taylor.chen</span>
    <span class="stat proc">processing</span>
  </div>
  <div class="q-row">
    <span>14:19:45</span>
    <span class="agent-tag t-hris">bamboohr</span>
    <span>employee.transfer</span>
    <span>m.okafor</span>
    <span class="stat q">queued</span>
  </div>
  <div class="q-row">
    <span>14:11:02</span>
    <span class="agent-tag t-hris">bamboohr</span>
    <span>employee.terminate</span>
    <span>r.santos</span>
    <span class="stat q">queued</span>
  </div>
  <div class="q-row">
    <span>13:58:33</span>
    <span class="agent-tag t-hris">bamboohr</span>
    <span>employee.hire</span>
    <span>p.dubois</span>
    <span class="stat ok">done</span>
  </div>
  <div class="q-row">
    <span>13:44:17</span>
    <span class="agent-tag t-hris">bamboohr</span>
    <span>employee.hire</span>
    <span>j.nakamura</span>
    <span class="stat ok">done</span>
  </div>
</div>

<div class="schema">
  <div class="schema-h">
    <div class="ttl">Canonical Event Schema <span style="font-family:var(--mono);font-size:11px;color:var(--muted);font-weight:400;margin-left:6px">· v1.2 · every integration normalizes to this</span></div>
    <button class="btn ghost" style="padding:5px 10px;font-size:11.5px">Copy</button>
  </div>
  <pre>{
  <span class="k">"event_id"</span>: <span class="s">"bb-evt-9f2a-…"</span>,                <span class="c">// idempotency key</span>
  <span class="k">"source"</span>:   <span class="s">"bamboohr"</span>,
  <span class="k">"type"</span>:     <span class="s">"employee.hire"</span>,                   <span class="c">// canonical verb</span>
  <span class="k">"subject"</span>:  <span class="s">"taylor.chen@contoso.com"</span>,
  <span class="k">"payload"</span>:  { <span class="k">"department"</span>: <span class="s">"Engineering"</span>, <span class="k">"start"</span>: <span class="s">"2025-05-20"</span> },
  <span class="k">"queued_at"</span>: <span class="s">"2025-05-18T14:22:08Z"</span>
}</pre>
</div>
`;

// ═══════════════════════════════════════════════════════════════════════════
// 3.  AUTH SELECT screen (PIN vs Windows — modal on operator-select)
// ═══════════════════════════════════════════════════════════════════════════
const authSelectHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    ${TOKENS}
    body {
      font-family: var(--sans);
      background:
        radial-gradient(800px 500px at 8% -10%, oklch(0.24 0.05 230 / .4), transparent 60%),
        radial-gradient(700px 400px at 105% 100%, oklch(0.22 0.06 280 / .3), transparent 55%),
        var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px 30px;
      width: 380px;
      display: flex; flex-direction: column; gap: 18px;
      box-shadow: 0 30px 80px oklch(0 0 0 / .55);
      opacity: 0.35;
      filter: blur(1px);
    }
    .brand-row { display: flex; align-items: center; gap: 12px; }
    .seal {
      width: 38px; height: 38px; border-radius: 10px;
      background: conic-gradient(from 220deg at 50% 50%, var(--cyan), var(--violet), var(--coral), var(--cyan));
      position: relative; box-shadow: 0 0 0 1px oklch(0.4 0.02 252 / .8); flex-shrink: 0;
    }
    .seal::after { content: ""; position: absolute; inset: 4px; border-radius: 7px; background: var(--bg-2); }
    .seal::before { content: ""; position: absolute; inset: 10px; border-radius: 4px; background: linear-gradient(135deg, var(--cyan), var(--violet)); }
    .brand-title { font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
    .brand-sub { font-size: 11px; color: var(--muted); font-family: var(--mono); letter-spacing: .04em; text-transform: uppercase; margin-top: 2px; }
    .divider { height: 1px; background: var(--border); }
    .op-btn {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px;
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
      color: inherit; font-family: inherit; font-size: 13px; width: 100%; text-align: left;
    }
    .op-btn.selected { border-color: var(--cyan); }
    .op-av {
      width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center;
      font-weight: 600; font-size: 11px; border: 1px solid var(--border-strong);
      background: linear-gradient(135deg, oklch(0.55 0.12 195), oklch(0.40 0.12 280)); color: #fff; flex-shrink: 0;
    }
    .op-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .op-name { font-weight: 500; color: var(--text); }
    .op-role {
      font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 4px;
      letter-spacing: .08em; text-transform: uppercase; border: 1px solid; width: fit-content; margin-left: auto;
    }
    .role-admin { color: var(--cyan); border-color: oklch(0.55 0.12 195 / .45); background: oklch(0.55 0.12 195 / .08); }
    .role-helpdesk { color: var(--emerald); border-color: oklch(0.50 0.13 155 / .45); background: oklch(0.50 0.13 155 / .08); }
    /* Overlay */
    .overlay {
      position: fixed; inset: 0; background: oklch(0 0 0 / .7); backdrop-filter: blur(4px);
      z-index: 100; display: flex; align-items: center; justify-content: center;
    }
    .pin-gate {
      width: 360px; max-width: 92vw; background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 22px; display: flex; flex-direction: column; gap: 14px;
      box-shadow: 0 40px 100px oklch(0 0 0 / .6);
    }
    .pin-gate h3 { font-size: 14px; font-weight: 600; }
    .pin-gate .sub { font-size: 12px; color: var(--muted); line-height: 1.55; }
    .pin-gate-choice { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .pin-gate-choice button {
      padding: 14px 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
      color: var(--text); cursor: pointer; font-family: inherit; font-size: 13px;
      display: flex; flex-direction: column; gap: 5px; align-items: center;
      transition: border-color .15s;
    }
    .pin-gate-choice button:hover { border-color: var(--cyan-dim); }
    .pin-gate-choice button .choice-icon { font-size: 22px; margin-bottom: 2px; }
    .pin-gate-choice button .label { font-weight: 600; font-size: 13px; }
    .pin-gate-choice button .desc { font-size: 11px; color: var(--muted); }
    .pin-gate-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .btn-cancel {
      padding: 7px 14px; border-radius: 7px; font-size: 12.5px; cursor: pointer;
      background: transparent; color: var(--text-2); border: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <!-- Blurred background: operator select card -->
  <div class="card">
    <div class="brand-row">
      <div class="seal"></div>
      <div>
        <div class="brand-title">JML Fleet Console</div>
        <div class="brand-sub">Identity Lifecycle Management</div>
      </div>
    </div>
    <div class="divider"></div>
    <div style="font-size:12.5px;color:var(--text-2)">Who is operating this session? All actions will be signed with this identity's certificate and recorded to the audit chain.</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <button class="op-btn selected">
        <span class="op-av">AW</span>
        <span class="op-meta"><span class="op-name">a.whitfield</span></span>
        <span class="op-role role-admin">admin</span>
      </button>
      <button class="op-btn">
        <span class="op-av">JK</span>
        <span class="op-meta"><span class="op-name">j.kim</span></span>
        <span class="op-role role-helpdesk">helpdesk</span>
      </button>
    </div>
  </div>

  <!-- Auth choice modal -->
  <div class="overlay">
    <div class="pin-gate">
      <h3>Set up authentication</h3>
      <div class="sub">a.whitfield is a write-access operator. Choose how to authenticate this and future sign-ins.</div>
      <div class="pin-gate-choice">
        <button>
          <span class="choice-icon">🔢</span>
          <span class="label">Use PIN</span>
          <span class="desc">4–8 digit code</span>
        </button>
        <button>
          <span class="choice-icon">🪟</span>
          <span class="label">Use Windows</span>
          <span class="desc">Trust the OS session</span>
        </button>
      </div>
      <div class="pin-gate-actions">
        <button class="btn-cancel">Cancel sign-in</button>
      </div>
    </div>
  </div>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════════════
// Screenshot runner
// ═══════════════════════════════════════════════════════════════════════════
const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  headless: true,
});

async function snap(name, html, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));
  const out = join(__dirname, `${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  console.log(`  ✓  ${name}.png`);
  return out;
}

console.log('Generating screenshots…');
await snap('access-reviews', shell('certifications', accessReviewsContent));
await snap('integrations',   shell('integrations',   integrationsContent));
await snap('auth-select',    authSelectHtml, { width: 1280, height: 800 });

await browser.close();
console.log('Done.');

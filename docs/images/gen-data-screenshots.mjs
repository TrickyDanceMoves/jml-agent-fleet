import puppeteer from '/opt/node22/lib/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
<html lang="en"><head><meta charset="UTF-8"><style>
  ${TOKENS}
  body { background:
    radial-gradient(1100px 600px at 8% -10%, oklch(0.24 0.05 230 / .35), transparent 60%),
    radial-gradient(900px 500px at 105% 100%, oklch(0.22 0.06 280 / .25), transparent 55%),
    var(--bg); }
  .layout { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
  .sidebar { background: var(--bg-2); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding-bottom: 16px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 16px 14px 12px; border-bottom: 1px solid var(--border); }
  .brand-mark { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; background: conic-gradient(from 220deg at 50% 50%, var(--cyan), var(--violet), var(--coral), var(--cyan)); position: relative; }
  .brand-mark::after { content: ""; position: absolute; inset: 4px; border-radius: 5px; background: var(--bg-2); }
  .brand-mark::before { content: ""; position: absolute; inset: 8px; border-radius: 3px; background: linear-gradient(135deg, var(--cyan), var(--violet)); }
  .brand-text .t1 { font-size: 13px; font-weight: 600; line-height: 1.2; }
  .brand-text .t2 { font-size: 10px; color: var(--muted); font-family: var(--mono); letter-spacing: .04em; }
  .side-tag { display: flex; align-items: center; gap: 6px; padding: 8px 14px; font-family: var(--mono); font-size: 10px; color: var(--muted); border-bottom: 1px solid var(--border); }
  .tenant-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); flex-shrink: 0; box-shadow: 0 0 0 3px color-mix(in oklch, var(--emerald) 12%, transparent); }
  .nav-items { padding: 8px; flex: 1; overflow-y: auto; }
  .nav-section { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); padding: 10px 8px 4px; }
  .nav-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: var(--r-1); font-size: 12.5px; color: var(--text-2); cursor: pointer; background: transparent; border: none; width: 100%; text-align: left; position: relative; }
  .nav-item.active { background: linear-gradient(90deg, color-mix(in oklch, var(--cyan-dim) 35%, transparent), transparent); color: var(--text); }
  .nav-item.active svg { color: var(--cyan); }
  .nav-item.active::before { content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: 3px; height: 60%; border-radius: 99px; background: var(--cyan); }
  .nav-item svg { color: var(--muted); flex-shrink: 0; }
  .hard-mode { padding: 10px 10px 4px; border-top: 1px solid var(--border); margin-top: auto; }
  .hard-mode-lbl { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: var(--dim); margin-bottom: 6px; }
  .hard-mode-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .hard-mode-btn { padding: 5px; border-radius: var(--r-1); border: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); background: transparent; }
  .hard-mode-btn.active { border-color: var(--cyan-dim); color: var(--cyan); background: color-mix(in oklch, var(--cyan) 8%, transparent); }
  .who { display: flex; align-items: center; gap: 8px; padding: 10px; border-top: 1px solid var(--border); }
  .who-avatar { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; background: linear-gradient(135deg, var(--cyan-dim), var(--violet)); display: grid; place-items: center; font-size: 11px; font-weight: 600; }
  .who-meta { display: flex; flex-direction: column; gap: 1px; }
  .who-name { font-size: 12px; font-weight: 500; }
  .who-role { font-family: var(--mono); font-size: 9px; color: var(--cyan); }
  .main { display: flex; flex-direction: column; min-height: 100vh; overflow: hidden; }
  .topbar { display: flex; align-items: center; gap: 10px; padding: 0 20px; height: 44px; border-bottom: 1px solid var(--border); background: color-mix(in oklch, var(--bg-2) 80%, transparent); backdrop-filter: blur(8px); flex-shrink: 0; }
  .topbar-title { font-size: 12.5px; font-weight: 600; flex: 1; }
  .topbar-mode-pill { display: flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 99px; font-family: var(--mono); font-size: 10px; border: 1px solid color-mix(in oklch, var(--amber) 30%, transparent); color: var(--amber); background: color-mix(in oklch, var(--amber) 6%, transparent); }
  .topbar-mode-pill .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--amber); }
  .content-area { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  .h1 { font-size: 20px; font-weight: 700; letter-spacing: -.02em; }
  .h1 .sub { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 8px; }
  .desc { font-size: 12.5px; color: var(--text-2); line-height: 1.55; margin-top: 4px; max-width: 640px; }
  .row-flex { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .btn { padding: 7px 14px; border-radius: var(--r-1); font-size: 12.5px; cursor: pointer; font-family: inherit; border: 1px solid var(--border); color: var(--text-2); background: var(--surface); }
  .btn.ghost { background: transparent; }
  .btn.primary { background: color-mix(in oklch, var(--cyan) 12%, transparent); border-color: color-mix(in oklch, var(--cyan) 40%, transparent); color: var(--cyan); }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; margin-bottom: 14px; }
  .panel-h { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .ttl { font-size: 13px; font-weight: 600; }
</style></head><body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark"></div>
      <div class="brand-text"><span class="t1">JML Fleet</span><span class="t2" style="display:block">Identity Console</span></div>
    </div>
    <div class="side-tag"><span class="tenant-dot"></span><span>contoso.onmicrosoft.com</span></div>
    <nav class="nav-items">${navHtml}</nav>
    <div class="hard-mode">
      <div class="hard-mode-lbl">Session Mode</div>
      <div class="hard-mode-toggle"><button class="hard-mode-btn active">Safe</button><button class="hard-mode-btn">Live</button></div>
    </div>
    <div class="who">
      <div class="who-avatar">AW</div>
      <div class="who-meta"><div class="who-name">a.whitfield</div><div class="who-role">admin</div></div>
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
</body></html>`;
}

// ── USERS ─────────────────────────────────────────────────────────────────────
const usersContent = `
<style>
  .search-bar { display: flex; gap: 8px; margin-bottom: 14px; }
  .search-input { flex: 1; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-1); color: var(--text); font-family: var(--sans); font-size: 12.5px; }
  .users-layout { display: grid; grid-template-columns: 1fr 280px; gap: 14px; }
  .u-table { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; }
  .u-row { display: grid; grid-template-columns: 28px 1fr 110px 80px 100px 90px 70px; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); align-items: center; font-size: 12px; }
  .u-row.head { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); background: var(--elev); }
  .u-av { width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center; font-size: 10px; font-weight: 700; flex-shrink: 0; }
  .u-name { font-size: 12.5px; font-weight: 500; }
  .u-upn { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
  .badge { font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 4px; border: 1px solid; width: fit-content; }
  .enabled  { color: var(--emerald); border-color: color-mix(in oklch, var(--emerald) 35%, transparent); background: color-mix(in oklch, var(--emerald) 8%, transparent); }
  .disabled { color: var(--coral);   border-color: color-mix(in oklch, var(--coral) 35%, transparent);   background: color-mix(in oklch, var(--coral) 8%, transparent); }
  .lic-chip { font-family: var(--mono); font-size: 10px; padding: 2px 6px; border-radius: 4px; background: var(--elev-2); color: var(--text-2); border: 1px solid var(--border); margin-right: 3px; }
  .risk-bar { height: 4px; background: var(--elev-2); border-radius: 99px; overflow: hidden; width: 60px; }
  .risk-fill { height: 100%; border-radius: 99px; }
  .detail-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; }
  .dp-head { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .dp-av { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; font-size: 14px; font-weight: 700; background: linear-gradient(135deg, oklch(0.55 0.12 195), oklch(0.40 0.12 280)); color: #fff; flex-shrink: 0; }
  .dp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; padding: 14px 16px; font-size: 12px; border-bottom: 1px solid var(--border); }
  .dp-k { font-family: var(--mono); font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; }
  .dp-v { color: var(--text); font-size: 12.5px; margin-top: 2px; }
  .dp-section { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .dp-section-lbl { font-family: var(--mono); font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
  .tag-row { display: flex; flex-wrap: wrap; gap: 5px; }
  .tag { font-family: var(--mono); font-size: 10.5px; padding: 2px 8px; border-radius: 4px; background: var(--elev-2); border: 1px solid var(--border); color: var(--text-2); }
  .dp-actions { display: flex; gap: 6px; padding: 12px 16px; flex-wrap: wrap; }
  .act-btn { padding: 6px 12px; border-radius: var(--r-1); font-size: 11.5px; font-family: inherit; cursor: pointer; border: 1px solid var(--border); color: var(--text-2); background: var(--bg-2); }
  .act-btn.danger { color: var(--coral); border-color: color-mix(in oklch, var(--coral) 30%, transparent); background: color-mix(in oklch, var(--coral) 6%, transparent); }
</style>

<div class="head">
  <div>
    <h1 class="h1">Users <span class="sub">47 identities</span></h1>
    <p class="desc">Search and inspect Entra ID user accounts. Risk signals, license assignments, and group memberships are cached every 5 minutes.</p>
  </div>
</div>

<div class="search-bar">
  <input class="search-input" placeholder="Search UPN, name, department…" value="engineering">
  <button class="btn primary">Search</button>
  <button class="btn ghost">Clear</button>
</div>

<div class="users-layout">
  <div class="u-table">
    <div class="u-row head"><span></span><span>User</span><span>Department</span><span>Status</span><span>Licenses</span><span>Last sign-in</span><span>Risk</span></div>

    <div class="u-row" style="background: color-mix(in oklch, var(--cyan) 5%, transparent);">
      <div class="u-av" style="background:linear-gradient(135deg,oklch(0.55 0.12 195),oklch(0.40 0.12 280));color:#fff">TC</div>
      <div><div class="u-name">T. Chen</div><div class="u-upn">t.chen@contoso.com</div></div>
      <span style="color:var(--text-2);font-size:12px">Engineering</span>
      <span class="badge enabled">enabled</span>
      <span><span class="lic-chip">E3</span><span class="lic-chip">DfE</span></span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">14:18</span>
      <div><div class="risk-bar"><div class="risk-fill" style="width:12%;background:var(--emerald)"></div></div></div>
    </div>

    <div class="u-row">
      <div class="u-av" style="background:linear-gradient(135deg,oklch(0.60 0.14 155),oklch(0.45 0.10 200));color:#fff">JN</div>
      <div><div class="u-name">J. Nakamura</div><div class="u-upn">j.nakamura@contoso.com</div></div>
      <span style="color:var(--text-2);font-size:12px">Engineering</span>
      <span class="badge enabled">enabled</span>
      <span><span class="lic-chip">E3</span></span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">11:42</span>
      <div><div class="risk-bar"><div class="risk-fill" style="width:8%;background:var(--emerald)"></div></div></div>
    </div>

    <div class="u-row">
      <div class="u-av" style="background:linear-gradient(135deg,oklch(0.55 0.15 280),oklch(0.45 0.12 310));color:#fff">MO</div>
      <div><div class="u-name">M. Okafor</div><div class="u-upn">m.okafor@contoso.com</div></div>
      <span style="color:var(--text-2);font-size:12px">Engineering</span>
      <span class="badge enabled">enabled</span>
      <span><span class="lic-chip">E5</span><span class="lic-chip">DfE</span></span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">09:55</span>
      <div><div class="risk-bar"><div class="risk-fill" style="width:34%;background:var(--amber)"></div></div></div>
    </div>

    <div class="u-row">
      <div class="u-av" style="background:linear-gradient(135deg,oklch(0.60 0.14 50),oklch(0.45 0.12 24));color:#fff">PD</div>
      <div><div class="u-name">P. Dubois</div><div class="u-upn">p.dubois@contoso.com</div></div>
      <span style="color:var(--text-2);font-size:12px">Engineering</span>
      <span class="badge enabled">enabled</span>
      <span><span class="lic-chip">E3</span></span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">Yesterday</span>
      <div><div class="risk-bar"><div class="risk-fill" style="width:5%;background:var(--emerald)"></div></div></div>
    </div>

    <div class="u-row">
      <div class="u-av" style="background:linear-gradient(135deg,oklch(0.50 0.10 252),oklch(0.38 0.08 280));color:#fff">RS</div>
      <div><div class="u-name">R. Santos</div><div class="u-upn">r.santos@contoso.com</div></div>
      <span style="color:var(--text-2);font-size:12px">Engineering</span>
      <span class="badge disabled">disabled</span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--dim)">—</span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">3 d ago</span>
      <div><div class="risk-bar"><div class="risk-fill" style="width:0%;background:var(--emerald)"></div></div></div>
    </div>
  </div>

  <!-- Detail panel for selected user -->
  <div class="detail-panel">
    <div class="dp-head">
      <div class="dp-av">TC</div>
      <div>
        <div style="font-size:14px;font-weight:600">T. Chen</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:2px">t.chen@contoso.com</div>
        <span class="badge enabled" style="margin-top:5px;display:inline-block">enabled</span>
      </div>
    </div>
    <div class="dp-grid">
      <div><div class="dp-k">Department</div><div class="dp-v">Engineering</div></div>
      <div><div class="dp-k">Job Title</div><div class="dp-v">Senior Engineer</div></div>
      <div><div class="dp-k">Office</div><div class="dp-v">London</div></div>
      <div><div class="dp-k">Manager</div><div class="dp-v">a.whitfield</div></div>
      <div><div class="dp-k">Created</div><div class="dp-v">May 20, 2025</div></div>
      <div><div class="dp-k">Risk score</div><div class="dp-v" style="color:var(--emerald)">12 / 100</div></div>
    </div>
    <div class="dp-section">
      <div class="dp-section-lbl">Licenses</div>
      <div class="tag-row">
        <span class="tag">Microsoft 365 E3</span>
        <span class="tag">Defender for Endpoint</span>
      </div>
    </div>
    <div class="dp-section">
      <div class="dp-section-lbl">Groups</div>
      <div class="tag-row">
        <span class="tag">Engineering</span>
        <span class="tag">AllStaff</span>
        <span class="tag">VPN-Users</span>
        <span class="tag">GitHub-Access</span>
      </div>
    </div>
    <div class="dp-actions">
      <button class="act-btn">Move…</button>
      <button class="act-btn danger">Soft Leave</button>
      <button class="act-btn danger">Hard Leave</button>
    </div>
  </div>
</div>
`;

// ── CERTS ─────────────────────────────────────────────────────────────────────
const certsContent = `
<style>
  .cert-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .cert-tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .cert-tile.warn { border-color: color-mix(in oklch, var(--amber) 40%, transparent); background: color-mix(in oklch, var(--amber) 3%, var(--surface)); }
  .ct-top { display: flex; align-items: center; gap: 10px; }
  .ct-sym { width: 32px; height: 32px; border-radius: 8px; background: var(--elev-2); border: 1px solid var(--border); display: grid; place-items: center; font-size: 14px; flex-shrink: 0; }
  .ct-name { font-size: 13px; font-weight: 600; }
  .ct-id { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 1px; }
  .cert-badge { font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 4px; border: 1px solid; width: fit-content; letter-spacing: .05em; }
  .cb-ok   { color: var(--emerald); border-color: color-mix(in oklch, var(--emerald) 35%, transparent); background: color-mix(in oklch, var(--emerald) 8%, transparent); }
  .cb-warn { color: var(--amber);   border-color: color-mix(in oklch, var(--amber) 35%, transparent);   background: color-mix(in oklch, var(--amber) 8%, transparent); }
  .cert-bar { height: 4px; background: var(--elev-2); border-radius: 99px; overflow: hidden; }
  .cert-bar-fill { height: 100%; border-radius: 99px; }
  .ct-meta { font-family: var(--mono); font-size: 10.5px; color: var(--muted); display: flex; justify-content: space-between; }
  .matrix { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; }
  .mx-row { display: grid; grid-template-columns: 130px repeat(7, 1fr); gap: 0; border-bottom: 1px solid var(--border); align-items: center; }
  .mx-row.head { background: var(--elev); font-family: var(--mono); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; color: var(--dim); }
  .mx-cell { padding: 8px 10px; font-size: 12px; border-right: 1px solid var(--border); text-align: center; }
  .mx-cell.agent { text-align: left; font-size: 12.5px; font-weight: 500; }
  .mx-cell:last-child { border-right: none; }
  .granted { color: var(--emerald); }
  .priv    { color: var(--amber); }
</style>

<div class="head">
  <div>
    <h1 class="h1">Certs <span class="sub">8 app registrations · permissions matrix</span></h1>
    <p class="desc">Per-agent certificate health. Certificates rotate automatically via the provisioner; manual rotation available below. All agents use certificate-based auth with DPAPI fallback.</p>
  </div>
  <div class="row-flex">
    <button class="btn ghost">Rotate All…</button>
  </div>
</div>

<div class="cert-grid">
  <div class="cert-tile">
    <div class="ct-top"><div class="ct-sym">◢</div><div><div class="ct-name">Joiner</div><div class="ct-id">app-joiner-01</div></div></div>
    <span class="cert-badge cb-ok">HEALTHY</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:80%;background:var(--emerald)"></div></div>
    <div class="ct-meta"><span>expires 727 d</span><span style="color:var(--dim)">4A:2F…</span></div>
  </div>
  <div class="cert-tile">
    <div class="ct-top"><div class="ct-sym">⇆</div><div><div class="ct-name">Mover</div><div class="ct-id">app-mover-01</div></div></div>
    <span class="cert-badge cb-ok">HEALTHY</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:75%;background:var(--emerald)"></div></div>
    <div class="ct-meta"><span>expires 684 d</span><span style="color:var(--dim)">C1:9E…</span></div>
  </div>
  <div class="cert-tile warn">
    <div class="ct-top"><div class="ct-sym">◣</div><div><div class="ct-name">Leaver</div><div class="ct-id">app-leaver-01</div></div></div>
    <span class="cert-badge cb-warn">ROTATE SOON</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:18%;background:var(--amber)"></div></div>
    <div class="ct-meta"><span style="color:var(--amber)">expires 28 d</span><span style="color:var(--dim)">7B:D3…</span></div>
  </div>
  <div class="cert-tile">
    <div class="ct-top"><div class="ct-sym">⊞</div><div><div class="ct-name">Enroller</div><div class="ct-id">app-enroller-01</div></div></div>
    <span class="cert-badge cb-ok">HEALTHY</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:62%;background:var(--emerald)"></div></div>
    <div class="ct-meta"><span>expires 563 d</span><span style="color:var(--dim)">2D:A1…</span></div>
  </div>
  <div class="cert-tile">
    <div class="ct-top"><div class="ct-sym">◈</div><div><div class="ct-name">Certifier</div><div class="ct-id">app-certifier-01</div></div></div>
    <span class="cert-badge cb-ok">HEALTHY</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:88%;background:var(--emerald)"></div></div>
    <div class="ct-meta"><span>expires 801 d</span><span style="color:var(--dim)">F9:11…</span></div>
  </div>
  <div class="cert-tile">
    <div class="ct-top"><div class="ct-sym">◇</div><div><div class="ct-name">Approver</div><div class="ct-id">app-approver-01</div></div></div>
    <span class="cert-badge cb-ok">HEALTHY</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:70%;background:var(--emerald)"></div></div>
    <div class="ct-meta"><span>expires 638 d</span><span style="color:var(--dim)">E4:7C…</span></div>
  </div>
  <div class="cert-tile">
    <div class="ct-top"><div class="ct-sym">⚙</div><div><div class="ct-name">Provisioner</div><div class="ct-id">app-provisioner-01</div></div></div>
    <span class="cert-badge cb-ok">HEALTHY</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:55%;background:var(--emerald)"></div></div>
    <div class="ct-meta"><span>expires 502 d</span><span style="color:var(--dim)">8A:5F…</span></div>
  </div>
  <div class="cert-tile">
    <div class="ct-top"><div class="ct-sym">◌</div><div><div class="ct-name">Auditor</div><div class="ct-id">app-auditor-01</div></div></div>
    <span class="cert-badge cb-ok">HEALTHY</span>
    <div class="cert-bar"><div class="cert-bar-fill" style="width:91%;background:var(--emerald)"></div></div>
    <div class="ct-meta"><span>expires 829 d</span><span style="color:var(--dim)">3C:88…</span></div>
  </div>
</div>

<div class="matrix">
  <div class="panel-h"><div class="ttl">Graph API Permissions Matrix</div><div style="display:flex;gap:12px;font-family:var(--mono);font-size:11px;color:var(--muted)"><span style="color:var(--emerald)">✓ granted</span><span style="color:var(--amber)">⚠ privileged</span></div></div>
  <div class="mx-row head">
    <div class="mx-cell agent">Agent</div>
    <div class="mx-cell">User.RW</div><div class="mx-cell">Group.RW</div><div class="mx-cell">Dir.RW</div>
    <div class="mx-cell">RoleMgmt</div><div class="mx-cell">DeviceMgmt</div><div class="mx-cell">AuditLog</div><div class="mx-cell">RiskyUser</div>
  </div>
  <div class="mx-row"><div class="mx-cell agent">Joiner</div><div class="mx-cell granted">✓</div><div class="mx-cell granted">✓</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div></div>
  <div class="mx-row"><div class="mx-cell agent">Mover</div><div class="mx-cell granted">✓</div><div class="mx-cell granted">✓</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div></div>
  <div class="mx-row"><div class="mx-cell agent">Leaver</div><div class="mx-cell granted">✓</div><div class="mx-cell granted">✓</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div></div>
  <div class="mx-row"><div class="mx-cell agent">Enroller</div><div class="mx-cell"></div><div class="mx-cell granted">✓</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell granted">✓</div><div class="mx-cell"></div><div class="mx-cell"></div></div>
  <div class="mx-row"><div class="mx-cell agent">Certifier</div><div class="mx-cell"></div><div class="mx-cell granted">✓</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell granted">✓</div><div class="mx-cell"></div></div>
  <div class="mx-row"><div class="mx-cell agent">Approver</div><div class="mx-cell granted">✓</div><div class="mx-cell granted">✓</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell granted">✓</div><div class="mx-cell"></div></div>
  <div class="mx-row"><div class="mx-cell agent">Provisioner</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell priv">⚠</div><div class="mx-cell priv">⚠</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div></div>
  <div class="mx-row" style="border-bottom:none"><div class="mx-cell agent">Auditor</div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell"></div><div class="mx-cell granted">✓</div><div class="mx-cell granted">✓</div></div>
</div>
`;

// ── SETTINGS ──────────────────────────────────────────────────────────────────
const settingsContent = `
<style>
  .settings-layout { display: grid; grid-template-columns: 180px 1fr; gap: 16px; }
  .settings-nav { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); padding: 8px; height: fit-content; position: sticky; top: 0; }
  .sn-section { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); padding: 8px 8px 4px; }
  .sn-item { display: block; padding: 6px 10px; border-radius: var(--r-1); font-size: 12.5px; color: var(--text-2); cursor: pointer; border: none; background: transparent; width: 100%; text-align: left; }
  .sn-item.active { background: color-mix(in oklch, var(--cyan) 8%, transparent); color: var(--text); position: relative; }
  .sn-item.active::before { content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: 3px; height: 60%; border-radius: 99px; background: var(--cyan); }
  .settings-cards { display: flex; flex-direction: column; gap: 12px; }
  .s-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; }
  .s-card-h { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
  .s-card-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .field-row { display: grid; grid-template-columns: 140px 1fr; gap: 10px; align-items: center; }
  .field-lbl { font-size: 12px; color: var(--text-2); }
  .field-input { padding: 7px 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--r-1); color: var(--text); font-family: var(--mono); font-size: 12px; }
  .field-input.active-field { border-color: var(--cyan-dim); }
  .op-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .op-table th { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  .op-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .role-tag { font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 4px; border: 1px solid; }
  .role-admin { color: var(--cyan); border-color: color-mix(in oklch, var(--cyan) 35%, transparent); background: color-mix(in oklch, var(--cyan) 8%, transparent); }
  .role-helpdesk { color: var(--emerald); border-color: color-mix(in oklch, var(--emerald) 35%, transparent); background: color-mix(in oklch, var(--emerald) 8%, transparent); }
  .role-viewer { color: var(--muted); border-color: var(--border); background: transparent; }
  .auth-tag { font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .pip { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 5px; }
  .pip-ok   { background: var(--emerald); box-shadow: 0 0 0 2px color-mix(in oklch, var(--emerald) 18%, transparent); }
  .pip-warn { background: var(--amber);   box-shadow: 0 0 0 2px color-mix(in oklch, var(--amber) 18%, transparent); }
  .policy-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
  .policy-row:last-child { border-bottom: none; }
  .policy-val { font-family: var(--mono); font-size: 11.5px; color: var(--cyan); }
</style>

<div class="head">
  <div>
    <h1 class="h1">Settings</h1>
    <p class="desc">Tenant binding, agent credentials, operator access, and policy configuration.</p>
  </div>
</div>

<div class="settings-layout">
  <div class="settings-nav">
    <div class="sn-section">Identity</div>
    <button class="sn-item">Tenant Binding</button>
    <button class="sn-item">Agent Certificates</button>
    <button class="sn-item active">Operators</button>
    <div class="sn-section">Operate</div>
    <button class="sn-item">Approval Policy</button>
    <button class="sn-item">Freeze Windows</button>
    <button class="sn-item">Sensitive Licenses</button>
    <button class="sn-item">Sensitive Groups</button>
    <div class="sn-section">Govern</div>
    <button class="sn-item">SoD Rules</button>
    <button class="sn-item">Notification Routing</button>
    <div class="sn-section">Appearance</div>
    <button class="sn-item">Theme</button>
  </div>

  <div class="settings-cards">
    <!-- Operators card (active) -->
    <div class="s-card" style="border-color: color-mix(in oklch, var(--cyan) 25%, var(--border));">
      <div class="s-card-h">
        Operators
        <button class="btn primary" style="padding:5px 12px;font-size:11.5px">Save</button>
      </div>
      <div class="s-card-body">
        <table class="op-table">
          <thead><tr><th>User</th><th>Role</th><th>Auth</th><th></th></tr></thead>
          <tbody>
            <tr>
              <td style="font-family:var(--mono);font-size:12px">a.whitfield</td>
              <td><span class="role-tag role-admin">admin</span></td>
              <td><span class="auth-tag">PIN</span></td>
              <td style="color:var(--dim);font-size:11px;cursor:pointer">✕</td>
            </tr>
            <tr>
              <td style="font-family:var(--mono);font-size:12px">j.kim</td>
              <td><span class="role-tag role-helpdesk">helpdesk</span></td>
              <td><span class="auth-tag">Windows</span></td>
              <td style="color:var(--dim);font-size:11px;cursor:pointer">✕</td>
            </tr>
            <tr>
              <td style="font-family:var(--mono);font-size:12px">s.patel</td>
              <td><span class="role-tag role-viewer">viewer</span></td>
              <td><span class="auth-tag">Windows</span></td>
              <td style="color:var(--dim);font-size:11px;cursor:pointer">✕</td>
            </tr>
          </tbody>
        </table>
        <div style="display:flex;gap:8px;align-items:center;padding-top:4px">
          <input class="field-input" placeholder="windows-username" style="flex:1">
          <select class="field-input" style="width:110px"><option>Admin</option><option>Helpdesk</option><option selected>Viewer</option></select>
          <button class="btn primary">Add</button>
        </div>
      </div>
    </div>

    <!-- Approval Policy card -->
    <div class="s-card">
      <div class="s-card-h">Approval Policy</div>
      <div class="s-card-body">
        <div class="policy-row"><span>Token TTL</span><span class="policy-val">30 min</span></div>
        <div class="policy-row"><span>Hard-stage Leaver</span><span class="policy-val">dual-approval required</span></div>
        <div class="policy-row"><span>PIM Group Changes</span><span class="policy-val">dual-approval required</span></div>
        <div class="policy-row"><span>PIN required for Live writes</span><span class="policy-val">enabled</span></div>
      </div>
    </div>

    <!-- Notification Routing card -->
    <div class="s-card">
      <div class="s-card-h">Notification Routing</div>
      <div class="s-card-body" style="font-family:var(--mono);font-size:11.5px;color:var(--text-2)">
        <div style="display:grid;grid-template-columns:1fr 80px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.07em">
          <span>Event</span><span>Severity</span><span>Channels</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 80px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
          <span>leaver.hard</span><span style="color:var(--coral)">critical</span><span>Teams · Sentinel · WinEvent</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 80px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
          <span>drift.detected</span><span style="color:var(--amber)">high</span><span>Teams · Sentinel</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 80px 1fr;gap:8px;padding:8px 0">
          <span>ueba.alert</span><span style="color:var(--amber)">high</span><span>Teams · Sentinel · WinEvent</span>
        </div>
      </div>
    </div>
  </div>
</div>
`;

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  headless: true,
});

async function snap(name, html) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));
  const out = join(__dirname, `${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  console.log(`  ✓  ${name}.png`);
}

console.log('Generating screenshots…');
await snap('users',    shell('users',    usersContent));
await snap('certs',    shell('certs',    certsContent));
await snap('settings', shell('settings', settingsContent));
await browser.close();
console.log('Done.');

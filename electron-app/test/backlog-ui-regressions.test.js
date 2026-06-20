'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('topbar keeps OS window controls visible at narrow launch widths', () => {
  assert.match(css, /\.window-controls\s*\{/);
  assert.match(css, /#btn-minimize,\s*#btn-maximize,\s*#btn-close[\s\S]*?flex-shrink:\s*0/);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)[\s\S]*?\.topbar\s+\.brand-tb[\s\S]*?display:\s*none/);
});

test('every notification is clickable and routes to its related tab', () => {
  assert.match(app, /function addNotification\(icon,\s*title,\s*action/);
  assert.match(app, /function tabForNotification/);
  // All items clickable (not gated on data-action), routed via the resolver.
  assert.match(app, /querySelectorAll\('\.notif-item'\)[\s\S]*?switchTab\(tab\)/);
  // Explicit action.tab is still honoured.
  assert.match(app, /n\.action\.tab\)\s*return\s+n\.action\.tab/);
});

test('attestation export invokes the evidence export API directly', () => {
  assert.match(app, /async function runEvidenceExport/);
  assert.match(app, /window\.api\.exportEvidencePacket\(\{\s*hashes\s*\}\)/);
  assert.match(app, /attest-dialog-build[\s\S]*?runEvidenceExport/);
});

test('agent certificates table shows a rotate-by date, not a per-row rotate button', () => {
  assert.match(app, /Rotate by/);
  assert.doesNotMatch(app, /btn-rotate-cert-/);
});

test('integration config supports SIEM and ITSM/HRIS connectors beyond the original trio', () => {
  for (const key of ['servicenow', 'jira', 'splunk']) {
    assert.match(main, new RegExp(`${key}:\\s*\\{`), `${key} missing in main config defaults`);
    assert.match(app, new RegExp(`${key}:\\s*\\{`), `${key} missing in renderer fields`);
  }
});

test('destructive leaver approvals enforce admin-only final say + separation of duties', () => {
  // Shared gate: fail-closed to admin, and the requester cannot self-approve.
  assert.match(main, /function approvalGate/);
  assert.match(main, /requiredApproverRole \|\| 'admin'/);
  assert.match(main, /Separation of duties/);
  // Both approval surfaces (console + overlay/docked) run through the gate.
  assert.match(main, /const gate = approvalGate\(op\)/);
  assert.equal((main.match(/approvalGate\(op\)/g) || []).length >= 2, true,
    'approvalGate must guard both approve-pending and panel-approve-pending');
  // Non-admin Hard/Both quick leavers are queued for admin, never executed.
  assert.match(main, /_stg === 'Hard' \|\| _stg === 'Both'/);
});

test('queued approvals surface on the Glass Screen as awaiting-approval runs', () => {
  assert.match(main, /function emitApprovalQueued/);
  assert.match(main, /status: 'awaiting-approval'/);
  assert.match(main, /function resolveApprovalOperation/);
});

test('approver can permanently delete users via a gated, separate-from-hard tool', () => {
  // Tool exists and is admin-approval-gated (destructive: Hard or Delete).
  assert.match(main, /name: 'submit_leaver_delete'/);
  assert.match(main, /_stage === 'Hard' \|\| _stage === 'Delete'/);
  // The leaver script has a pure Delete stage (no soft/hard cleanup).
  const leaver = fs.readFileSync(path.join(root, '..', 'leaver', 'Invoke-LeaverProcess.ps1'), 'utf8');
  assert.match(leaver, /ValidateSet\("Both", "Soft", "Hard", "Delete"\)/);
  assert.match(leaver, /Stage -eq "Delete"[\s\S]*Method DELETE/);
  // Lifecycle/Glass Screen recognise the delete tool.
  const opStatus = fs.readFileSync(path.join(root, 'lib', 'operation-status.js'), 'utf8');
  assert.match(opStatus, /submit_leaver_delete: 'delete'/);
});

test('cert view has no retired static cert tiles', () => {
  assert.doesNotMatch(html, /cert-grid|cert-tile/);
  assert.doesNotMatch(css, /cert-grid|cert-tile/);
  assert.doesNotMatch(app, /wireCertTileClicks|cert-tile/);
});

test('exports uses compact roadmap strip instead of empty planned cards', () => {
  assert.match(html, /class="exp-roadmap"/);
  assert.match(css, /\.exp-roadmap\s*\{/);
  assert.doesNotMatch(html, /exp-coming-soon|chip-soon/);
  assert.doesNotMatch(css, /exp-coming-soon|chip-soon/);
});

test('fleet strip initial state stays neutral until health data arrives', () => {
  const strip = html.match(/<div class="v2-fleet-strip"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(strip, 'fleet strip markup must exist');
  assert.doesNotMatch(strip[0], /0 in queue|streaming|standby/i);
  assert.match(app, /const fleetAgents = Array\.isArray\(data\) \? data : \(data\.agents \|\| \[\]\)/);
  assert.match(app, /ft-detail/);
});

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

test('notifications can route the operator to the affected tab', () => {
  assert.match(app, /function addNotification\(icon,\s*title,\s*action/);
  assert.match(app, /class="notif-item"[^>]*data-action/);
  assert.match(app, /switchTab\(n\.action\.tab\)/);
});

test('attestation export invokes the evidence export API directly', () => {
  assert.match(app, /async function runEvidenceExport/);
  assert.match(app, /window\.api\.exportEvidencePacket\(\{\s*hashes\s*\}\)/);
  assert.match(app, /attest-dialog-build[\s\S]*?runEvidenceExport/);
});

test('agent certificates expose one-click Provisioner rotation', () => {
  assert.match(preload, /rotateAgentCertificate/);
  assert.match(main, /ipcMain\.handle\('rotate-agent-certificate'/);
  assert.match(app, /btn-rotate-cert-/);
  assert.match(app, /window\.api\.rotateAgentCertificate/);
});

test('integration config supports SIEM and ITSM/HRIS connectors beyond the original trio', () => {
  for (const key of ['servicenow', 'jira', 'splunk']) {
    assert.match(main, new RegExp(`${key}:\\s*\\{`), `${key} missing in main config defaults`);
    assert.match(app, new RegExp(`${key}:\\s*\\{`), `${key} missing in renderer fields`);
  }
});

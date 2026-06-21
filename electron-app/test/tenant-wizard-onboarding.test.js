'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const setup = fs.readFileSync(path.join(root, 'renderer', 'setup.html'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');

test('OOBE Entra sign-in registers the verified account as the first-run operator', () => {
  assert.match(setup, /let _entraOperator\s*=\s*null/);
  assert.match(setup, /_entraOperator\s*=\s*\{[\s\S]*name:\s*r\.name[\s\S]*role:\s*r\.role/);
  assert.match(setup, /completeFirstRun\(\{[\s\S]*entraOperator:\s*_entraOperator/);

  const handler = main.match(/ipcMain\.handle\('complete-first-run'[\s\S]*?ipcMain\.handle\('skip-first-run'/);
  assert.ok(handler, 'complete-first-run handler must exist');
  assert.match(handler[0], /\{\s*winAuth,\s*tenantId,\s*primaryDomain,\s*entraOperator\s*\}/);
  assert.match(handler[0], /const name = String\(entraOperator\.name\)\.slice\(0, 200\)/);
  assert.match(handler[0], /opsData\.operators\[name\]/);
  assert.match(handler[0], /_verifiedRoles\.set\(name, role\)/);
  assert.match(handler[0], /_verifiedRoles\.set\(String\(entraOperator\.displayName\)\.slice\(0, 200\), role\)/);
});

test('tenant wizard can open admin consent for every created agent app', () => {
  assert.match(html, /id="wizard-grant-all-consent"/);
  assert.match(html, /id="wizard-consent-status"/);
  assert.match(app, /wizard-grant-all-consent/);
  assert.match(app, /openWizardConsentUrls/);
  assert.match(app, /adminconsent\?client_id=/);
  assert.match(app, /window\.api\.openExternal\(url\)/);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

test('security restore-baseline routes the focused drift finding to the real Approver input', () => {
  assert.match(html, /id="sec-drift-restore-v2"/);
  assert.match(app, /function _secRouteToApprover\(msg/);
  assert.match(app, /getElementById\('input-approver'\)/);
  assert.doesNotMatch(app, /getElementById\('chat-input-approver'\)/);

  const restore = app.match(/document\.getElementById\('sec-drift-restore-v2'\)[\s\S]*?\n\}\);/);
  assert.ok(restore, 'Restore baseline listener must exist');
  assert.match(restore[0], /_secFindings\[_secFocused\]/);
  assert.match(restore[0], /_secBuildDriftRestorePrompt\(f\)/);
  assert.match(restore[0], /_secRouteToApprover\(msg\)/);
  assert.doesNotMatch(restore[0], /runDriftRemediation/);
});

test('security remediation buttons prefill the existing Approver input', () => {
  assert.match(html, /id="input-approver"/);
  assert.match(app, /function _secRemRoute\(promptTemplate\)/);
  assert.match(app, /_secRouteToApprover\(msg\)/);
  assert.doesNotMatch(app, /chat-input-approver/);
});

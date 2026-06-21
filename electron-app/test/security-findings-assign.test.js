'use strict';

// Locks the Security findings "Assign…" plumbing. Findings are rebuilt from
// scratch on every scan/poll (assignee defaults to '—'), so assignment only
// works if it is recorded in a session map keyed by the stable finding key and
// reapplied on each rebuild — otherwise the assignee resets on the next poll
// and assignment appears broken.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

test('assignments are stored in a session map keyed by the stable finding key', () => {
  assert.match(app, /let _secAssignments\s*=\s*new Map\(\)/, 'a _secAssignments map must exist');
  assert.match(app, /function _secKey\(f\)\s*\{\s*return \(f\.rule \|\| ''\) \+ '\|' \+ \(f\.title \|\| ''\)/,
    'the stable rule|title key function must exist');
});

test('renderSecurityInbox reapplies saved assignments after rebuilding findings', () => {
  const fn = app.match(/function renderSecurityInbox\(data\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderSecurityInbox must exist');
  assert.match(fn[0], /_secAssignments\.get\(_secKey\(f\)\)/,
    'rebuild must reapply the saved assignee so it survives rescans');
});

test('both the bulk and single assign handlers persist into the map', () => {
  const setCalls = app.match(/_secAssignments\.set\(_secKey\(f\), name\)/g) || [];
  assert.ok(setCalls.length >= 2, 'bulk + single assign must both write to _secAssignments');
});

test('the focused-finding rail shows the assignee', () => {
  assert.match(html, /id="sec-focused-assignee"/, 'focused card needs an assignee slot');
  assert.match(app, /getElementById\('sec-focused-assignee'\)/, 'focusFinding must populate the assignee slot');
});

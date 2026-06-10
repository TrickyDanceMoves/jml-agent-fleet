'use strict';

// Locks the Glass Screen Command Center markup contract: the live-first
// structure is present and the old audit-first replay widget is gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

// Isolate the Glass Screen view so assertions cannot accidentally match
// identifiers belonging to other tabs.
function glassScreenSection() {
  const start = html.indexOf('id="view-glass-screen"');
  assert.ok(start !== -1, 'Glass Screen view is missing');
  const end = html.indexOf('<!-- =====', start);
  return html.slice(start, end === -1 ? html.length : end);
}

test('Command Center scaffold ids are present', () => {
  const section = glassScreenSection();
  for (const id of [
    'gs-command-center',
    'gs-live-hero',
    'gs-pipeline',
    'gs-current-decision',
    'gs-recent-runs',
    'gs-details',
    'gs-view-audit',
  ]) {
    assert.match(section, new RegExp(`id="${id}"`), `Missing #${id}`);
  }
});

test('audit-first replay widget is removed', () => {
  const section = glassScreenSection();
  assert.doesNotMatch(section, /gs-stage-card/, 'old stage card still present');
  assert.doesNotMatch(section, /gs-traveler/, 'old traveler still present');
  assert.doesNotMatch(section, />\s*Audit Trail\s*</, 'Audit Trail heading still present');
  assert.doesNotMatch(section, /id="gs-runs"/, 'old runs list still present');
});

test('details drawer is collapsed by default', () => {
  const section = glassScreenSection();
  const details = section.match(/<details[^>]*id="gs-details"[^>]*>/);
  assert.ok(details, 'gs-details drawer missing');
  assert.doesNotMatch(details[0], /\bopen\b/, 'details drawer must not start open');
});

test('model and controller scripts load before app.js', () => {
  const modelIdx = html.indexOf('glass-screen-model.js');
  const controllerIdx = html.indexOf('glass-screen.js');
  const appIdx = html.lastIndexOf('app.js');
  assert.ok(modelIdx !== -1, 'glass-screen-model.js not loaded');
  assert.ok(controllerIdx !== -1, 'glass-screen.js not loaded');
  assert.ok(modelIdx < appIdx, 'model must load before app.js');
  assert.ok(controllerIdx < appIdx, 'controller must load before app.js');
});

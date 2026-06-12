'use strict';

// Verifies the risk card grounding HTML branch without a DOM: extracts the
// grounding-block builder logic shape that renderRiskScoreCard emits. This
// keeps the Foundry IQ citation UI from silently regressing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appjs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

test('risk card renders a Foundry IQ grounding block', () => {
  // The grounded branch and the fail-closed branch must both exist in the card.
  assert.match(appjs, /Grounded by Foundry IQ/, 'grounded citation header missing');
  assert.match(appjs, /policy grounding unavailable \(failed closed\)/i, 'fail-closed header missing');
  assert.match(appjs, /risk-cites/, 'citation list class missing');
  assert.match(appjs, /d\.grounding/, 'card must read grounding off the risk result');
});

test('glass-screen details drawer surfaces Foundry IQ grounding', () => {
  const gs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'glass-screen.js'), 'utf8');
  assert.match(gs, /Policy grounding/, 'details drawer grounding row missing');
  assert.match(gs, /Foundry IQ/, 'details drawer must name Foundry IQ');
});

test('main wires grounding into score_risk and fails closed', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /getFoundryIQ\(\)/, 'score_risk must call the grounding client');
  assert.match(main, /GroundingUnavailableError/, 'fail-closed handling missing');
  assert.match(main, /res\.blocked = true/, 'fail-closed must block the risk result');
  assert.match(main, /grounding: state\.approver\.lastRisk\?\.grounding/, 'operation must carry grounding to Glass Screen');
});

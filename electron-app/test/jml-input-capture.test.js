'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

test('JML input capture resets lifecycle to an accurate pre-submission state', () => {
  assert.match(app, /window\.__jmlSetApproverInputLifecycle\s*=\s*lcSetIdle/);
  assert.match(
    main,
    /'jml-fleet-input':[\s\S]*?window\.__jmlSetApproverInputLifecycle\?\.\(\)/,
  );
});

test('JML input capture sanitizes tenant identity before capture', () => {
  const captureBlock = main.match(
    /win\.webContents\.send\('operator-switched'[\s\S]*?console\.log\('Captured: jml-fleet-input'\);/,
  );
  assert.ok(captureBlock, 'input capture block must exist');
  assert.match(captureBlock[0], /executeJavaScript\(SANITIZE_TENANT\)/);
  assert.match(captureBlock[0], /operator-switched/);
  assert.match(captureBlock[0], /DEMO_ADMIN/);
  assert.match(captureBlock[0], /switchTab\('approver'\)/);
  assert.match(captureBlock[0], /activeViewId[\s\S]*?view-approver/);
});

test('single-image input capture mode exits before the full tab capture loop', () => {
  assert.match(main, /const INPUT_CAPTURE_ONLY = process\.argv\.includes\('--capture-jml-input'\)/);
  assert.match(main, /const CAPTURE_MODE = process\.argv\.includes\('--capture'\) \|\| INPUT_CAPTURE_ONLY/);
  assert.match(main, /if \(INPUT_CAPTURE_ONLY\) \{\s*app\.quit\(\);\s*return;\s*\}/);
});

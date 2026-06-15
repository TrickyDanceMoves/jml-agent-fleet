'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('current operator IPC preserves the selected session role', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handler = main.match(/ipcMain\.handle\('get-current-operator'[\s\S]*?\n\}\);/);

  assert.ok(handler, 'get-current-operator handler must exist');
  assert.match(handler[0], /role:\s*currentRole/);
  assert.doesNotMatch(handler[0], /ops\[currentOperator\]\s*\|\|\s*'viewer'/);
  assert.doesNotMatch(handler[0], /currentRole\s*=\s*role/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncModeUi } = require('../renderer/mode-ui');

function element(dataset = {}) {
  const classes = new Set();
  return {
    dataset,
    classList: {
      toggle(name, force) { force ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this[name] = value; },
  };
}

test('saved Live mode hides Safe banner and activates Live controls on startup', () => {
  const safeBanner = element();
  const liveBanner = element();
  const softSafe = element({ mode: 'whatif' });
  const softLive = element({ mode: 'live' });
  const hardSafe = element({ hard: 'whatif' });
  const hardLive = element({ hard: 'live' });
  const doc = {
    getElementById(id) {
      return id === 'mode-banner-whatif' ? safeBanner
        : id === 'mode-banner-live' ? liveBanner : null;
    },
    querySelectorAll(selector) {
      return selector === '.mode-btn' ? [softSafe, softLive]
        : selector === '.hard-mode-btn' ? [hardSafe, hardLive] : [];
    },
  };

  syncModeUi(doc, false);

  assert.equal(safeBanner.classList.contains('hidden'), true);
  assert.equal(liveBanner.classList.contains('hidden'), false);
  assert.equal(softLive.classList.contains('active'), true);
  assert.equal(hardLive.classList.contains('active'), true);
  assert.equal(hardLive['aria-selected'], 'true');
});

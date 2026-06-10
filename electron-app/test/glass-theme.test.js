'use strict';

// Locks the approved Uniform Dark Frost material contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function alphaFor(selector, propertyPattern) {
  const block = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}'));
  assert.ok(block, `Missing CSS block for ${selector}`);
  const value = block[1].match(propertyPattern);
  assert.ok(value, `Missing alpha value in ${selector}`);
  return Number(value[1]);
}

function blockFor(selector) {
  const block = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}'));
  assert.ok(block, `Missing CSS block for ${selector}`);
  return block[1];
}

test('glass shell remains visibly transparent instead of becoming a dark theme', () => {
  const bodyAlpha = alphaFor(
    'html[data-theme="glass"] body',
    /oklch\([^/]+\/\s*([0-9.]+)\s*\)\s*;/,
  );
  const sidebarAlpha = alphaFor(
    'html[data-theme="glass"] .sidebar',
    /background:[\s\S]*?oklch\([^/]+\/\s*([0-9.]+)\s*\)/,
  );

  assert.ok(bodyAlpha <= 0.08, `glass body alpha ${bodyAlpha} is too opaque`);
  assert.ok(sidebarAlpha <= 0.16, `glass sidebar alpha ${sidebarAlpha} is too opaque`);
  assert.match(css, /html\[data-theme="glass"\]\s+\.layout,[\s\S]*?background:\s*transparent/s);
  assert.match(css, /html\[data-theme="glass"\]\s+\.content,/s);
});

test('glass theme provides readable text and localized control backings', () => {
  const glassTokens = css.match(/html\[data-theme="glass"\]\s*\{([\s\S]*?)\}/);
  assert.ok(glassTokens, 'Missing glass token block');
  assert.match(glassTokens[1], /--text-2:\s*oklch\(0\.9/);
  assert.match(glassTokens[1], /--muted:\s*oklch\(0\.8/);
  assert.match(glassTokens[1], /--glass-panel-bg:\s*linear-gradient/);
  assert.match(glassTokens[1], /--glass-panel-blur:\s*blur\(2[68]px\)/);
  assert.match(glassTokens[1], /--glass-control-bg:/);
  assert.match(glassTokens[1], /--glass-row-hover:/);

  assert.doesNotMatch(blockFor('html[data-theme="glass"] body'), /text-shadow\s*:/);
  assert.match(css, /html\[data-theme="glass"\]\s+\.panel,[\s\S]*?background:\s*var\(--glass-panel-bg\)/s);
  assert.match(css, /html\[data-theme="glass"\]\s+\.set-card,[\s\S]*?background:\s*var\(--glass-panel-bg\)/s);
  assert.match(css, /html\[data-theme="glass"\]\s+\.message\.assistant\s+\.message-body[\s\S]*?background:\s*var\(--glass-panel-bg\)/s);
  assert.match(css, /html\[data-theme="glass"\]\s+\.btn,[\s\S]*?background:\s*var\(--glass-control-bg\)/s);
  assert.match(css, /html\[data-theme="glass"\]\s+input\[type="text"\],[\s\S]*?backdrop-filter:/s);
  assert.match(css, /html\[data-theme="glass"\]\s+\.brand-mark,[\s\S]*?conic-gradient/s);
  assert.match(css, /html\[data-theme="glass"\]\s+\.brand-mark::after,[\s\S]*?\/\s*0\.1[0-9]\)/s);
});

test('glass nested rows remain flat inside their parent frost panels', () => {
  for (const selector of [
    'html[data-theme="glass"] .evt',
    'html[data-theme="glass"] .finding',
    'html[data-theme="glass"] .sec-finding-row',
    'html[data-theme="glass"] .v2-liveops-row',
  ]) {
    const block = blockFor(selector);
    assert.match(block, /background:\s*transparent/);
    assert.match(block, /backdrop-filter:\s*none/);
    assert.match(block, /box-shadow:\s*none/);
  }

  assert.match(css, /html\[data-theme="glass"\]\s+\.evt:hover,[\s\S]*?background:\s*var\(--glass-row-hover\)/s);
  assert.match(blockFor('html[data-theme="glass"] .v2-hris-grid'), /background:\s*transparent/);
  assert.match(css, /html\[data-theme="glass"\]\s+#udp-licenses\s+\.tag,[\s\S]*?display:\s*inline-flex/s);
});

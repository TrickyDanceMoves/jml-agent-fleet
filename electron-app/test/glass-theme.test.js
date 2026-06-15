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
  const sidebarAlpha = alphaFor(
    'html[data-theme="glass"] .sidebar',
    /background:[\s\S]*?oklch\([^/]+\/\s*([0-9.]+)\s*\)/,
  );

  // Body and app shell are fully transparent: the window is transparent
  // and the desktop shows through the gutters crisp (no OS blur, by
  // user decision). Painting anything here regresses to a flat backdrop.
  assert.match(blockFor('html[data-theme="glass"] body'), /background:\s*transparent/);
  assert.doesNotMatch(blockFor('html[data-theme="glass"] body'), /linear-gradient/);
  assert.match(blockFor('html[data-theme="glass"] .app'), /background:\s*transparent/);
  // Sidebar island frost: near-solid (~85%). Without OS blur the desktop
  // shows through islands CRISP, so readable text needs dense backing;
  // the see-through feel comes from the fully transparent gutters.
  assert.ok(sidebarAlpha <= 0.92, `glass sidebar alpha ${sidebarAlpha} is fully opaque — keep a hint of glow`);
  assert.ok(sidebarAlpha >= 0.72, `glass sidebar alpha ${sidebarAlpha} too thin — crisp desktop bleed makes nav text unreadable`);
  assert.match(css, /html\[data-theme="glass"\]\s+\.layout,[\s\S]*?background:\s*transparent/s);
  // Floating shell geometry: gutters around the grid, rounded islands —
  // sidebar and content column float separately over the desktop.
  assert.match(blockFor('html[data-theme="glass"] .layout'), /gap:\s*10px/);
  assert.match(blockFor('html[data-theme="glass"] .sidebar'), /border-radius:\s*16px/);
  assert.match(blockFor('html[data-theme="glass"] .content'), /border-radius:\s*16px/);
  // Content island carries near-solid frost so loose labels/paragraphs
  // never compete with crisp desktop bleed-through.
  const contentAlpha = alphaFor(
    'html[data-theme="glass"] .content',
    /background:[\s\S]*?oklch\([^/]+\/\s*([0-9.]+)\s*\)/,
  );
  assert.ok(contentAlpha >= 0.75 && contentAlpha <= 0.92,
    `glass content alpha ${contentAlpha} outside dense-island band`);
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
  assert.match(css, /html\[data-theme="glass"\]\s+\.glass-logo\s*\{[\s\S]*?display:\s*block/s);
  assert.match(css, /\.glass-logo\s*\{[\s\S]*?drop-shadow\(0 0 7px rgba\(89, 218, 239, \.24\)\)/s);
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

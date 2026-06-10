'use strict';
// Locks the Glass (Uniform Dark Frost) material contract:
//  - empty shell ~4% tint, chrome 6-12%, text panels ~60% dark frost
//  - text brightened, never shadowed
//  - rows stay flat; parent panels carry the frost
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const glassStart = css.indexOf('GLASS THEME');
assert.ok(glassStart > -1, 'glass theme block exists');
const glass = css.slice(glassStart);

function alphaOf(re) {
  const m = glass.match(re);
  assert.ok(m, `pattern found: ${re}`);
  return parseFloat(m[1]);
}

test('shell wash is nearly transparent (<= 8%)', () => {
  const a = alphaOf(/html\[data-theme="glass"\] body \{[^}]*oklch\(0\.10[^/]*\/ (0\.\d+)\);/s);
  assert.ok(a <= 0.08, `body wash alpha ${a} <= 0.08`);
});

test('sidebar/topbar chrome tint is 6-12%', () => {
  const sidebar = alphaOf(/\.sidebar \{\s*background: oklch\([^/]*\/ (0\.\d+)\)/);
  const topbar  = alphaOf(/\.topbar \{\s*background: oklch\([^/]*\/ (0\.\d+)\)/);
  for (const a of [sidebar, topbar]) assert.ok(a >= 0.06 && a <= 0.12, `chrome alpha ${a} in 6-12%`);
});

test('panel material (--surface) is a readable dark frost (55-70%)', () => {
  const a = alphaOf(/--surface:\s*oklch\([^/]*\/ (0\.\d+)\)/);
  assert.ok(a >= 0.55 && a <= 0.70, `--surface alpha ${a} in 55-70%`);
});

test('secondary text is brightened (L >= 0.80)', () => {
  const m = glass.match(/--text-2:\s*oklch\((0\.\d+)/);
  assert.ok(m && parseFloat(m[1]) >= 0.80, '--text-2 lightness >= 0.80');
});

test('no text-shadow in the glass theme', () => {
  assert.ok(!/text-shadow\s*:/.test(glass), 'glass block contains no text-shadow declarations');
});

test('assistant rows are flat — parent panel carries the frost', () => {
  const m = glass.match(/\.message\.assistant \.message-body \{[^}]*\}/s);
  assert.ok(m, 'assistant message-body override exists');
  assert.ok(/background:\s*none/.test(m[0]), 'assistant body has no own background');
  assert.ok(/backdrop-filter:\s*none/.test(m[0]), 'assistant body has no own blur');
});

test('chat shell uses the uniform panel material', () => {
  assert.ok(/\.chat-shell \{ background: var\(--surface\); \}/.test(glass),
    'chat-shell forced to uniform --surface');
});

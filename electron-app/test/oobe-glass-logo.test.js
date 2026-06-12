'use strict';

// Locks the OOBE Glass brand mark contract (.superpowers/claude-oobe-glass-logo-handoff.md):
// Glass renders an SVG whose outer rings are genuinely transparent (fill="none"),
// Warm/Preview keep the original .seal treatment, the persisted theme is applied
// before first paint, and gradient IDs never collide across documents.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SURFACES = {
  'setup.html': path.join(__dirname, '..', 'renderer', 'setup.html'),
  'operator-select.html': path.join(__dirname, '..', 'renderer', 'operator-select.html'),
};

const read = (file) => fs.readFileSync(SURFACES[file], 'utf8');

for (const file of Object.keys(SURFACES)) {
  test(`${file}: Glass logo is an SVG with transparent outer rings, not a filled parent`, () => {
    const html = read(file);
    const svg = html.match(/<svg class="seal-glass"[\s\S]*?<\/svg>/);
    assert.ok(svg, 'seal-glass SVG must exist');

    // Frame and ice-highlight rings are real holes: fill="none" with stroked outlines.
    const noneFills = svg[0].match(/fill="none"/g) || [];
    assert.ok(noneFills.length >= 2, 'frame + highlight rings must use fill="none"');
    assert.match(svg[0], /stroke="url\(#glass-frame-oobe-/, 'frame ring stroked with the approved gradient');
    assert.match(svg[0], /<rect[^>]*x="11"[^>]*fill="url\(#glass-core-oobe-/, 'center core stays a translucent colored square');
    // The rejected pattern: a full-size filled rect behind the rings.
    assert.ok(!/<rect[^>]*width="34"[^>]*fill="url\(/.test(svg[0]), 'no filled gradient parent behind the rings');
    assert.match(svg[0], /aria-hidden="true"/, 'decorative logo hidden from assistive tech');
  });

  test(`${file}: Glass treatment is theme-gated and Warm/Preview keep the original seal`, () => {
    const html = read(file);
    // Original Warm/Preview seal untouched.
    assert.match(html, /<div class="seal"><\/div>/, 'original .seal element still present');
    assert.match(html, /\.seal\s*\{[\s\S]*?conic-gradient/, 'original .seal conic-gradient treatment intact');
    // Glass gating: SVG hidden by default, swapped in only under data-theme="glass".
    assert.match(html, /\.seal-glass\s*\{\s*display:\s*none/, 'glass logo hidden outside Glass');
    assert.match(html, /\[data-theme="glass"\]\s*\.seal\s*\{\s*display:\s*none/, 'seal hidden in Glass');
    assert.match(html, /\[data-theme="glass"\]\s*\.seal-glass\s*\{[\s\S]*?display:\s*block/, 'glass logo shown in Glass');
    // Restrained glow, and no new animation on the glass logo.
    assert.match(html, /\.seal-glass\s*\{[\s\S]*?drop-shadow\(0 0 7px rgba\(89, 218, 239, \.24\)\)/,
      'approved ambient glow applied in Glass');
    assert.ok(!/\.seal-glass[^}]*animation/.test(html), 'no animation added to the Glass logo');
  });

  test(`${file}: persisted theme applies before first paint`, () => {
    const html = read(file);
    const headBeforeStyle = html.slice(0, html.indexOf('<style>'));
    assert.match(headBeforeStyle, /localStorage\.getItem\('jmlTheme'\)/,
      'theme bootstrap script must run before the stylesheet');
    assert.match(headBeforeStyle, /documentElement\.dataset\.theme/,
      'bootstrap sets data-theme on the document element');
  });
}

test('gradient IDs are unique per OOBE document', () => {
  const ids = [];
  for (const file of Object.keys(SURFACES)) {
    for (const m of read(file).matchAll(/linearGradient id="([^"]+)"/g)) ids.push(m[1]);
  }
  assert.equal(new Set(ids).size, ids.length, `duplicate gradient ids: ${ids.join(', ')}`);
});

'use strict';

// The main console must use the same true-transparent Glass SVG geometry as
// Setup and Operator Select. Warm and Preview retain the existing CSS marks.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'index.html'),
  'utf8',
);
const css = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'styles.css'),
  'utf8',
);

const SURFACES = ['sidebar', 'topbar', 'operator-switch'];

for (const surface of SURFACES) {
  test(`main console ${surface} uses the approved true-transparent Glass SVG`, () => {
    const svg = html.match(
      new RegExp(`<svg class="glass-logo glass-logo-${surface}"[\\s\\S]*?<\\/svg>`),
    );
    assert.ok(svg, `${surface} Glass SVG must exist`);

    const noneFills = svg[0].match(/fill="none"/g) || [];
    assert.ok(noneFills.length >= 2, 'frame and highlight rings use fill="none"');
    assert.match(
      svg[0],
      new RegExp(`stroke="url\\(#glass-frame-main-${surface}\\)"`),
    );
    assert.match(
      svg[0],
      new RegExp(`fill="url\\(#glass-core-main-${surface}\\)"`),
    );
    assert.ok(
      !/<rect[^>]*width="34"[^>]*fill="url\(/.test(svg[0]),
      'no filled parent behind the transparent rings',
    );
    assert.match(svg[0], /aria-hidden="true"/);
  });
}

test('main console swaps CSS marks for SVG only in Glass theme', () => {
  assert.match(css, /\.glass-logo\s*\{[\s\S]*?display:\s*none/);
  assert.match(
    css,
    /html\[data-theme="glass"\]\s+\.brand-mark,[\s\S]*?\.op-switch-header\s+\.seal[\s\S]*?display:\s*none/,
  );
  assert.match(
    css,
    /html\[data-theme="glass"\]\s+\.glass-logo\s*\{[\s\S]*?display:\s*block/,
  );
  assert.doesNotMatch(
    css,
    /html\[data-theme="glass"\]\s+\.brand-mark[\s\S]*?conic-gradient/,
  );
});

test('main console Glass gradient IDs are unique', () => {
  const ids = [...html.matchAll(/linearGradient id="(glass-(?:frame|core)-main-[^"]+)"/g)]
    .map((match) => match[1]);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, ids.length);
});

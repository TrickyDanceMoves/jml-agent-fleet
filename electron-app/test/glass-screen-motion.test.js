'use strict';

// Locks the Glass Screen motion contract: state-driven, one-shot,
// reduced-motion aware. Motion communicates backend state change only —
// no decorative loops, no perpetual glow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

// All .gs- rule bodies, for loop/animation scanning.
function gsRuleBodies() {
  const bodies = [];
  const re = /(^|\})\s*([^{}]*\.gs-[^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) bodies.push({ selector: m[2].trim(), body: m[3] });
  return bodies;
}

test('Command Center classes exist', () => {
  for (const cls of [
    '.gs-command-center',
    '.gs-live-hero',
    '.gs-pipeline',
    '.gs-stage',
    '.gs-stage-orb',
    '.gs-connector',
    '.gs-connector-fill',
    '.gs-current-decision',
    '.gs-recovery',
    '.gs-recent-runs',
    '.gs-recent-run',
    '.gs-details',
  ]) {
    assert.ok(css.includes(cls), `missing ${cls}`);
  }
});

test('old replay widget CSS is removed', () => {
  for (const cls of ['.gs-traveler', '.gs-track-fill', '.gs-node-orb', '.gs-runs-card', '.gs-stage-card']) {
    assert.ok(!css.includes(cls), `stale rule ${cls} still present`);
  }
});

test('connector progress transition is 350ms ease-out (demo-tuned)', () => {
  const fill = css.match(/\.gs-connector-fill\s*\{[^}]*\}/);
  assert.ok(fill, 'gs-connector-fill rule missing');
  assert.match(fill[0], /transition[^;]*350ms\s+ease-out/, 'connector must glide 350ms ease-out');
});

test('stage activation transition is 250ms', () => {
  const orb = css.match(/\.gs-stage-orb\s*\{[^}]*\}/);
  assert.ok(orb, 'gs-stage-orb rule missing');
  assert.match(orb[0], /transition[^;]*250ms/, 'stage orb must settle in 250ms');
});

test('stage enter animation is one-shot and at most 250ms', () => {
  const enter = css.match(/\[data-entered="true"\][^{]*\{([^}]*)\}/);
  assert.ok(enter, 'data-entered one-shot rule missing');
  const anim = enter[1].match(/animation:\s*([^;]+);/);
  assert.ok(anim, 'enter animation missing');
  const dur = anim[1].match(/(\d+)ms/);
  assert.ok(dur && parseInt(dur[1], 10) <= 250, 'enter animation must be <= 250ms');
  assert.match(anim[1], /\b1\b/, 'enter animation must run once');
  assert.doesNotMatch(anim[1], /infinite/, 'enter animation must not loop');
});

test('failure pulse is at most 300ms and runs once', () => {
  const rules = [...css.matchAll(/\[data-state="failed"\][^{]*\.gs-stage-orb[^{]*\{([^}]*)\}/g)];
  assert.ok(rules.length, 'failed stage orb rule missing');
  const withAnim = rules.map(r => r[1].match(/animation:\s*([^;]+);/)).find(Boolean);
  const anim = withAnim;
  assert.ok(anim, 'failure animation missing');
  const dur = anim[1].match(/(\d+)ms/);
  assert.ok(dur && parseInt(dur[1], 10) <= 300, 'failure pulse must be <= 300ms');
  assert.match(anim[1], /\b1\b/, 'failure pulse must run once');
  assert.doesNotMatch(anim[1], /infinite/, 'failure pulse must not loop');
});

test('no infinite animation in any .gs- rule', () => {
  for (const { selector, body } of gsRuleBodies()) {
    assert.doesNotMatch(body, /infinite/, `${selector} has a looping animation`);
  }
});

test('reduced motion is honored for the Command Center', () => {
  const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/);
  assert.ok(reduced, 'prefers-reduced-motion block missing');
  assert.match(reduced[0], /\.gs-command-center/, 'reduced-motion block must cover the Command Center');
  assert.match(reduced[0], /animation-duration:\s*0\.001ms\s*!important/, 'reduced motion must collapse animations');
  assert.match(reduced[0], /transition-duration:\s*0\.001ms\s*!important/, 'reduced motion must collapse transitions');
  assert.match(reduced[0], /animation-iteration-count:\s*1\s*!important/, 'reduced motion must cap iterations');
});

test('recent runs render as flat rows, not nested cards', () => {
  const run = css.match(/\.gs-recent-run\s*\{[^}]*\}/);
  assert.ok(run, 'gs-recent-run rule missing');
  assert.match(run[0], /background:\s*(none|transparent)/, 'recent rows must be flat');
});

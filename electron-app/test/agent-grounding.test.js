'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectGroundingFacts,
  validateGroundedAssistantText,
} = require('../lib/agent-grounding');
const fs = require('node:fs');
const path = require('node:path');

test('blocks UPNs that were not returned by a tool', () => {
  const facts = collectGroundingFacts([
    JSON.stringify({ users: [{ userPrincipalName: 'alex@example.com' }] }),
  ]);

  const result = validateGroundedAssistantText(
    'alex@example.com\nmade.up@example.com',
    facts,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /made\.up@example\.com/);
});

test('blocks audit numeric answers when no tool facts are present', () => {
  const result = validateGroundedAssistantText(
    '102 users are enabled in the tenant.',
    collectGroundingFacts([]),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /numeric tenant claims/i);
});

test('allows numeric answers backed by tool output numbers', () => {
  const facts = collectGroundingFacts([
    JSON.stringify({ total: 107, enabled: 102, disabled: 5, guests: 3 }),
  ]);

  const result = validateGroundedAssistantText(
    '102 users are enabled. 3 are guests.',
    facts,
  );

  assert.equal(result.ok, true);
});

test('allows derived counts (members = enabled - guests)', () => {
  const facts = collectGroundingFacts([
    JSON.stringify({ enabled: 102, guests: 5 }),
  ]);

  const result = validateGroundedAssistantText(
    '102 users are enabled. 97 are regular users.',
    facts,
  );

  // 97 = 102 - 5 is a legitimate derivation, not an invented count.
  assert.equal(result.ok, true);
  assert.equal(result.caveat, undefined);
});

test('ignores query-window and list-position numbers', () => {
  const facts = collectGroundingFacts([
    JSON.stringify({ recentJoins: { count: 4 } }),
  ]);

  // "past 7 days" and "first 20 users" are query params, not tenant claims.
  const result = validateGroundedAssistantText(
    '4 users joined in the past 7 days. Here are the first 20 users.',
    facts,
  );

  assert.equal(result.ok, true);
  assert.equal(result.caveat, undefined);
});

test('surfaces a soft caveat (not a hard block) for figures that do not tie out', () => {
  const facts = collectGroundingFacts([
    JSON.stringify({ enabled: 102, guests: 5 }),
  ]);

  const result = validateGroundedAssistantText(
    '102 users are enabled. 500 are regular users.',
    facts,
  );

  // Answer is kept (ok:true) but the unverifiable figure is flagged.
  assert.equal(result.ok, true);
  assert.match(result.caveat, /\b500\b/);
});

test('main process strips query echoes before streaming assistant text', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const responseBlock = main.match(/if \(textBlocks\.length\) \{[\s\S]*?sender\.send\('msg-chunk', \{ agent, type: 'text', text: safeText \}\);/);

  assert.ok(responseBlock, 'runAgentLoop text response block must exist');
  assert.match(main, /stripQueryEcho/);
  assert.ok(
    responseBlock[0].indexOf('stripQueryEcho') < responseBlock[0].indexOf("sender.send('msg-chunk'"),
    'assistant text must be stripped before it is streamed, stored, or mirrored',
  );
});

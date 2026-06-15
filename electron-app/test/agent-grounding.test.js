'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectGroundingFacts,
  validateGroundedAssistantText,
} = require('../lib/agent-grounding');

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

test('blocks numeric audit answers that invent counts absent from tools', () => {
  const facts = collectGroundingFacts([
    JSON.stringify({ enabled: 102, guests: 5 }),
  ]);

  const result = validateGroundedAssistantText(
    '102 users are enabled. 97 are regular users.',
    facts,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /\b97\b/);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { stripQueryEcho } = require('../lib/response-sanitizer');

test('removes leading "you asked" query echoes from agent replies', () => {
  const query = 'How many hard leavers were processed in the last 30 days?';
  const text = 'You asked how many hard leavers were processed in the last 30 days.\n\n1 hard leaver was processed.';

  assert.equal(stripQueryEcho(text, query), '1 hard leaver was processed.');
});

test('removes leading regarding-style echoes before the actual answer', () => {
  const query = 'List regular users';
  const text = 'Regarding "List regular users":\n\nThere are 8 regular users.';

  assert.equal(stripQueryEcho(text, query), 'There are 8 regular users.');
});

test('removes generic answer preambles without deleting the answer', () => {
  const query = 'Which users are stale?';
  const text = 'To answer your question, I checked stale account signals. No stale enabled accounts were found.';

  assert.equal(stripQueryEcho(text, query), 'No stale enabled accounts were found.');
});

test('keeps direct answers that do not echo the query', () => {
  const query = 'How many users are enabled?';
  const text = '102 users are enabled. 5 are disabled.';

  assert.equal(stripQueryEcho(text, query), text);
});

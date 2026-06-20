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

test('strips a topic-restatement header that echoes the query', () => {
  const query = 'recent joins';
  const text = '**Recent joins:**\n- alex.morgan\n- sam.lee';
  assert.equal(stripQueryEcho(text, query), '- alex.morgan\n- sam.lee');
});

test('strips a colon header echo and a "here are" lead-in', () => {
  assert.equal(
    stripQueryEcho('Recent joins:\n3 users joined this week.', 'recent joins'),
    '3 users joined this week.');
  assert.equal(
    stripQueryEcho('Here are the recent joiners: alex, sam.', 'recent joins'),
    'alex, sam.');
});

test('strips conversational acknowledgements', () => {
  assert.equal(stripQueryEcho('Sure! 12 guests found.', 'how many guests'), '12 guests found.');
});

test('does not strip a header that does not overlap the query', () => {
  const query = 'show license utilization';
  const text = '**Microsoft 365 E5:** 450 / 500 assigned.';
  assert.equal(stripQueryEcho(text, query), text);
});

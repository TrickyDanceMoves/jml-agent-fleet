'use strict';

// Locks the Foundry IQ grounding contract: retrieval shape normalization,
// the not-configured no-op, and - critically - fail-closed behavior when
// grounding is configured but the service is unavailable or errors.
const test = require('node:test');
const assert = require('node:assert/strict');

const { FoundryIQ, GroundingUnavailableError, normalizeRetrieval } = require('../lib/foundry-iq');

const CFG = {
  enabled: true,
  endpoint: 'https://example.search.windows.net',
  apiKey: 'k',
  knowledgeAgent: 'jml-policy',
};

function fetchReturning(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

test('not configured → grounded:false no-op (no throw)', async () => {
  const iq = new FoundryIQ({ enabled: false }, fetchReturning(200, {}));
  const r = await iq.retrieve('any');
  assert.equal(r.grounded, false);
  assert.equal(r.citations.length, 0);
  assert.equal(iq.isConfigured(), false);
});

test('retrieve shape: normalizes response + references into answer and citations', async () => {
  const body = {
    response: [{ content: [{ text: 'Sales and Finance group co-membership is a SoD violation.' }] }],
    references: [{ id: 'sod-001', sourceData: { title: 'SoD Policy', content: 'Sales ⊕ Finance', url: 'corpus/sod.md' }, score: 0.91 }],
  };
  const iq = new FoundryIQ(CFG, fetchReturning(200, body));
  const r = await iq.retrieve('can sarah be in Sales and Finance');
  assert.equal(r.grounded, true);
  assert.match(r.answer, /SoD violation/);
  assert.equal(r.citations.length, 1);
  assert.equal(r.citations[0].title, 'SoD Policy');
  assert.equal(r.citations[0].url, 'corpus/sod.md');
});

test('search-index fallback shape normalizes value[] into citations', () => {
  const out = normalizeRetrieval({ value: [
    { title: 'Offboarding Playbook', content: 'Disable, revoke, then remove licenses.', url: 'corpus/offboarding.md', '@search.score': 4.2 },
  ]});
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0].title, 'Offboarding Playbook');
  assert.match(out.answer, /Disable, revoke/);
});

test('FAIL-CLOSED: configured but service errors → GroundingUnavailableError', async () => {
  const iq = new FoundryIQ(CFG, fetchReturning(503, { error: 'unavailable' }));
  await assert.rejects(() => iq.retrieve('q'), err => {
    assert.ok(err instanceof GroundingUnavailableError);
    assert.equal(err.failClosed, true);
    return true;
  });
});

test('FAIL-CLOSED: configured but network throws → GroundingUnavailableError', async () => {
  const iq = new FoundryIQ(CFG, async () => { throw new Error('ECONNREFUSED'); });
  await assert.rejects(() => iq.retrieve('q'), err => err.failClosed === true);
});

test('FAIL-CLOSED: malformed JSON → GroundingUnavailableError', async () => {
  const iq = new FoundryIQ(CFG, async () => ({
    ok: true, status: 200,
    json: async () => { throw new Error('not json'); },
    text: async () => 'oops',
  }));
  await assert.rejects(() => iq.retrieve('q'), err => err.failClosed === true);
});

test('retrieve mode targets the knowledge-agent retrieve endpoint', () => {
  const iq = new FoundryIQ(CFG);
  assert.equal(iq.mode, 'retrieve');
  assert.match(iq._url(), /\/agents\/jml-policy\/retrieve\?api-version=/);
});

test('search mode is selected when only an index is configured', () => {
  const iq = new FoundryIQ({ enabled: true, endpoint: CFG.endpoint, apiKey: 'k', index: 'jml-policy-index' });
  assert.equal(iq.mode, 'search');
  assert.equal(iq.isConfigured(), true);
  assert.match(iq._url(), /\/indexes\/jml-policy-index\/docs\/search/);
});

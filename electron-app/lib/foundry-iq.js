'use strict';

/*
 * Foundry IQ knowledge grounding for the JML control plane.
 *
 * Microsoft Agents League - Enterprise Agents track requires at least one
 * Microsoft IQ layer. JML uses Foundry IQ (Azure AI Foundry knowledge
 * retrieval) to ground risk and approval decisions in the organisation's own
 * identity-governance policy corpus - SoD rules, approved access patterns,
 * offboarding playbooks, freeze-window policy - instead of relying on the
 * model's parametric memory.
 *
 * Retrieval contract (Azure AI Foundry knowledge / Agent retrieval API):
 *   POST {endpoint}/agents/{knowledgeAgent}/retrieve?api-version=...
 *   body: { messages:[{role:'user', content:[{type:'text', text:<query>}]}],
 *           targetIndexParams?:[...] }
 *   → { response:[{ content:[{ text:<grounded answer> }] }],
 *       references:[{ id, sourceData:{ title, content, url } }] }
 *
 * A direct search index is supported as a fallback shape:
 *   POST {endpoint}/indexes/{index}/docs/search?api-version=...
 *   → { value:[{ '@search.score', title, content, url }] }
 *
 * FAIL-CLOSED: when grounding is enabled but the service is unreachable or
 * errors, retrieve() throws a GroundingUnavailableError. Callers translate
 * that into a blocked decision in Live mode - the control plane refuses to act
 * on ungrounded policy rather than guessing. This is the whole point: an
 * identity system must not approve access it cannot cite a policy for.
 */

class GroundingUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'GroundingUnavailableError'; this.failClosed = true; }
}

const DEFAULT_API_VERSION = '2025-05-01-preview';

function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

// Normalise either response shape into { answer, citations:[{title,snippet,url,score}] }.
function normalizeRetrieval(json) {
  const citations = [];
  let answer = '';

  if (Array.isArray(json?.response)) {
    answer = json.response
      .map(r => (r.content || []).map(c => c.text || '').join(''))
      .join('\n').trim();
  }
  const refs = json?.references || json?.citations;
  if (Array.isArray(refs)) {
    for (const r of refs) {
      const src = r.sourceData || r.source || r;
      citations.push({
        title:   src.title || r.id || 'policy',
        snippet: String(src.content || src.text || '').slice(0, 400),
        url:     src.url || src.filepath || null,
        score:   r.score ?? r.rerankerScore ?? null,
      });
    }
  }

  // Search-index fallback shape
  if (!citations.length && Array.isArray(json?.value)) {
    for (const d of json.value) {
      citations.push({
        title:   d.title || d.id || 'policy',
        snippet: String(d.content || d.text || '').slice(0, 400),
        url:     d.url || d.filepath || null,
        score:   d['@search.score'] ?? null,
      });
    }
    if (!answer && citations.length) answer = citations[0].snippet;
  }

  return { answer, citations };
}

class FoundryIQ {
  /**
   * @param {object} cfg
   * @param {boolean} cfg.enabled
   * @param {string}  cfg.endpoint        Foundry project / search endpoint
   * @param {string}  cfg.apiKey          Foundry or Search admin/query key
   * @param {string}  [cfg.knowledgeAgent] Knowledge (retrieval) agent name
   * @param {string}  [cfg.index]         Search index name (fallback mode)
   * @param {string}  [cfg.apiVersion]
   * @param {string}  [cfg.mode]          'retrieve' | 'search' (auto by which id is set)
   * @param {function}[fetchImpl]         Injectable for tests
   */
  constructor(cfg = {}, fetchImpl) {
    this.enabled        = !!cfg.enabled;
    this.endpoint       = trimSlash(cfg.endpoint);
    this.apiKey         = cfg.apiKey || '';
    this.knowledgeAgent = cfg.knowledgeAgent || '';
    this.index          = cfg.index || '';
    this.apiVersion     = cfg.apiVersion || DEFAULT_API_VERSION;
    this.mode           = cfg.mode || (this.knowledgeAgent ? 'retrieve' : 'search');
    this.timeoutMs      = cfg.timeoutMs || 20000;
    this._fetch         = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  }

  // Configured = the operator turned grounding on and gave us an endpoint+key.
  // When configured, unavailability must fail closed; when not configured,
  // callers treat grounding as simply absent (no policy citation, no block).
  isConfigured() {
    return this.enabled && !!this.endpoint && !!this.apiKey &&
      (this.mode === 'retrieve' ? !!this.knowledgeAgent : !!this.index);
  }

  _url() {
    return this.mode === 'retrieve'
      ? `${this.endpoint}/agents/${encodeURIComponent(this.knowledgeAgent)}/retrieve?api-version=${this.apiVersion}`
      : `${this.endpoint}/indexes/${encodeURIComponent(this.index)}/docs/search?api-version=${this.apiVersion}`;
  }

  _body(query) {
    return this.mode === 'retrieve'
      ? { messages: [{ role: 'user', content: [{ type: 'text', text: query }] }] }
      : { search: query, top: 5, queryType: 'simple' };
  }

  /**
   * Ground a query against the policy corpus.
   * @returns {Promise<{answer:string, citations:Array, grounded:true}>}
   * @throws  {GroundingUnavailableError} when configured but unreachable/erroring
   */
  async retrieve(query) {
    if (!this.isConfigured()) {
      return { answer: '', citations: [], grounded: false };
    }
    if (!this._fetch) throw new GroundingUnavailableError('No fetch implementation available');

    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    let res;
    try {
      res = await this._fetch(this._url(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
        body: JSON.stringify(this._body(query)),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      throw new GroundingUnavailableError('Foundry IQ unreachable: ' + e.message);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch {}
      throw new GroundingUnavailableError(`Foundry IQ error ${res.status}${detail ? ': ' + detail : ''}`);
    }

    let json;
    try { json = await res.json(); }
    catch (e) { throw new GroundingUnavailableError('Foundry IQ returned malformed JSON'); }

    const { answer, citations } = normalizeRetrieval(json);
    return { answer, citations, grounded: true };
  }
}

module.exports = { FoundryIQ, GroundingUnavailableError, normalizeRetrieval };

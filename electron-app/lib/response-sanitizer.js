'use strict';

// Removes query-echo preambles from an agent reply so the answer leads. The
// only "what you asked" cue should be the gray thinking line in the UI — the
// reply itself must not restate the operator's question. Handles both lead-in
// phrases ("You asked…", "Sure, here's…") and topic-restatement headers
// ("Recent joins:", "**License utilization:**") that echo the query.
function stripQueryEcho(text, query) {
  let out = String(text || '');
  const q = String(query || '').trim();
  const quoted = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    /^You asked\b[^.\n!?]*(?:[.!?]\s*|\n+)/i,
    /^You(?:'re| are) asking\b[^.\n!?]*(?:[.!?]\s*|\n+)/i,
    /^Regarding\s+["“]?[^"”\n]+["”]?:?\s*/i,
    /^For your (?:question|request),?\s*/i,
    /^To answer your question,?\s*/i,
    /^I checked\b[^.\n!?]*(?:[.!?]\s*|\n+)/i,
    // Conversational acknowledgements that add nothing.
    /^(?:Sure|Certainly|Of course|Absolutely|Got it|Gotcha|Happy to help|No problem)[.,!:]*\s*/i,
    // "Here are the …:" / "The following is …:" lead-ins (strip up to the colon).
    /^(?:Here(?:'s| is| are)|The following (?:is|are)|Below (?:is|are))\b[^:\n]{0,64}:\s*/i,
  ];

  if (q) {
    patterns.unshift(new RegExp(`^(?:Regarding|Re:)\\s+["“]?${quoted}["”]?:?\\s*`, 'i'));
  }

  // A short leading header line that restates the query topic, e.g.
  // "**Recent joins:**" or "Recent joins:" when the query was "recent joins".
  function stripHeaderEcho(s) {
    if (!q) return s;
    const nl = s.indexOf('\n');
    const first = (nl === -1 ? s : s.slice(0, nl)).trim();
    if (!first || first.length > 72) return s;
    const isMdHeader = /^\*\*.+\*\*:?$/.test(first);
    const endsColon  = /[:：]$/.test(first);
    if (!isMdHeader && !endsColon) return s;            // only header-shaped lines
    const qWords = new Set((q.toLowerCase().match(/[a-z0-9]{3,}/g)) || []);
    if (!qWords.size) return s;
    const overlap = ((first.toLowerCase().match(/[a-z0-9]{3,}/g)) || [])
      .filter(w => qWords.has(w)).length;
    if (overlap < 1) return s;                          // not an echo of the query
    return (nl === -1 ? '' : s.slice(nl + 1)).replace(/^\s+/, '');
  }

  let changed = true;
  while (changed) {
    const before = out;
    for (const pattern of patterns) out = out.replace(pattern, '');
    out = stripHeaderEcho(out);
    out = out.replace(/^\s+/, '');
    changed = out !== before;
  }

  return out.trim();
}

module.exports = { stripQueryEcho };

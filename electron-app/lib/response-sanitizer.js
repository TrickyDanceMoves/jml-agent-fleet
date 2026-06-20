'use strict';

function stripQueryEcho(text, query) {
  let out = String(text || '');
  const q = String(query || '').trim();

  const quoted = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    /^You asked\b[^.\n!?]*(?:[.!?]\s*|\n+)/i,
    /^You(?:'re| are) asking\b[^.\n!?]*(?:[.!?]\s*|\n+)/i,
    /^Regarding\s+["“]?[^"”\n]+["”]?:\s*/i,
    /^For your (?:question|request),?\s*/i,
    /^To answer your question,?\s*/i,
    /^I checked\b[^.\n!?]*(?:[.!?]\s*|\n+)/i,
  ];

  if (q) {
    patterns.unshift(new RegExp(`^(?:Regarding|Re:)\\s+["“]?${quoted}["”]?:\\s*`, 'i'));
  }

  let changed = true;
  while (changed) {
    changed = false;
    const before = out;
    for (const pattern of patterns) {
      out = out.replace(pattern, '');
    }
    out = out.replace(/^\s+/, '');
    changed = out !== before;
  }

  return out.trim();
}

module.exports = { stripQueryEcho };

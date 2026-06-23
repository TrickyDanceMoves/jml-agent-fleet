'use strict';

const UPN_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const NUMBER_RE = /\b\d[\d,]*\b/g;
const AUDIT_TERM_RE = /\b(?:user|users|account|accounts|guest|guests|member|members|regular|standard|enabled|disabled|license|licenses|group|groups|role|roles|join|joins|leaver|leavers|stale|failed|failure|failures)\b/i;
// Numbers that describe the QUERY, not a tenant fact - time windows ("past 7
// days") and list positions ("first 20 UPNs"). These are never tenant claims.
const WINDOW_BEFORE_RE = /\b(?:first|next|last|top|page|past|previous|prior|recent)\b[^.\d]{0,12}$/i;
const WINDOW_AFTER_RE  = /^\s*(?:day|week|month|hour|minute|second|year|upn|result|record|batch|item|row|entry|page)s?\b/i;

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walk(item, visit);
  }
}

function parseToolContent(content) {
  if (typeof content !== 'string') return content;
  try { return JSON.parse(content); } catch { return content; }
}

function collectGroundingFacts(toolContents) {
  const facts = { upns: new Set(), numbers: new Set(), hasToolFacts: false };
  for (const content of toolContents || []) {
    const parsed = parseToolContent(content);
    if (parsed === undefined || parsed === null) continue;
    facts.hasToolFacts = true;
    walk(parsed, (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        facts.numbers.add(String(value));
      } else if (typeof value === 'string') {
        for (const match of value.matchAll(UPN_RE)) facts.upns.add(match[0].toLowerCase());
        if (/^-?\d+(?:\.\d+)?$/.test(value.trim())) facts.numbers.add(String(Number(value)));
      }
    });
  }
  return facts;
}

function numbersInAuditClaims(text) {
  const raw = String(text || '');
  const out = [];
  for (const match of raw.matchAll(NUMBER_RE)) {
    const idx = match.index;
    const sentence = raw.slice(idx, idx + 80).split(/[.;\n]/)[0];
    if (!AUDIT_TERM_RE.test(sentence)) continue;
    const before = raw.slice(Math.max(0, idx - 14), idx);
    const after  = raw.slice(idx + match[0].length);
    if (WINDOW_BEFORE_RE.test(before)) continue; // "past 7 ", "first 20 "
    if (WINDOW_AFTER_RE.test(after))  continue;   // "7 days", "20 UPNs"
    out.push(match[0].replace(/,/g, ''));
  }
  return out;
}

// A claimed number is grounded if it appears verbatim in tool output, or is a
// simple aggregation (sum or difference) of two grounded numbers - e.g. members
// = enabled - guests. Audit answers legitimately derive these breakdowns.
function isGroundedNumber(num, knownNumbers) {
  if (knownNumbers.has(num)) return true;
  const target = Number(num);
  if (!Number.isFinite(target)) return false;
  const vals = [...knownNumbers].map(Number).filter(Number.isFinite);
  if (vals.length > 200) return true; // too many to combine safely - don't false-flag
  for (let i = 0; i < vals.length; i++) {
    for (let j = 0; j < vals.length; j++) {
      if (i === j) continue;
      if (vals[i] + vals[j] === target || vals[i] - vals[j] === target) return true;
    }
  }
  return false;
}

function upnsInText(text) {
  return [...String(text || '').matchAll(UPN_RE)].map((match) => match[0].toLowerCase());
}

function validateGroundedAssistantText(text, facts) {
  const grounding = facts || collectGroundingFacts([]);
  // Ungrounded UPNs are surfaced as a soft suggestion rather than walling off
  // the whole answer - questions like "is paris deleted?" should still get a
  // reply, with a nudge to confirm the exact UPN.
  const unknownUpns = [...new Set(upnsInText(text).filter((upn) => !grounding.upns.has(upn)))];
  if (unknownUpns.length) {
    return {
      ok: true,
      caveat: `I couldn't tie ${unknownUpns.join(', ')} to the latest directory lookup - share the exact UPN or re-run the query so I can confirm.`,
    };
  }

  const claimedNumbers = numbersInAuditClaims(text);
  // Numbers with no tool grounding at all = pure fabrication → hard block.
  if (claimedNumbers.length && !grounding.hasToolFacts) {
    return { ok: false, reason: 'Numeric tenant claims require fresh tool results.' };
  }

  // Tool data exists: accept exact and derived figures. Anything still
  // unaccounted-for is surfaced as a soft caveat rather than walling off the
  // whole answer - the operator sees the response and the unverified figures.
  const ungrounded = [...new Set(
    claimedNumbers.filter((num) => !isGroundedNumber(num, grounding.numbers))
  )];
  if (ungrounded.length) {
    return {
      ok: true,
      caveat: `Some figures couldn't be tied to the latest query result (${ungrounded.join(', ')}). Re-run the exact query to confirm those.`,
    };
  }

  return { ok: true };
}

function groundedFallback(reason) {
  return [
    'I stopped that answer because it included tenant facts I could not verify from the latest tool result.',
    reason ? `Guardrail: ${reason}` : '',
    'Please re-run the exact query so I can answer from fresh directory data.',
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  collectGroundingFacts,
  groundedFallback,
  validateGroundedAssistantText,
};

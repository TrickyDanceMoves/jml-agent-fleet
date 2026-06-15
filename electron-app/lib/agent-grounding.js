'use strict';

const UPN_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const NUMBER_RE = /\b\d[\d,]*\b/g;
const AUDIT_TERM_RE = /\b(?:user|users|account|accounts|guest|guests|member|members|regular|standard|enabled|disabled|license|licenses|group|groups|role|roles|join|joins|leaver|leavers|stale|failed|failure|failures)\b/i;

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
  return [...raw.matchAll(NUMBER_RE)]
    .filter((match) => AUDIT_TERM_RE.test(raw.slice(match.index, match.index + 80).split(/[.;\n]/)[0]))
    .map((match) => match[0].replace(/,/g, ''));
}

function upnsInText(text) {
  return [...String(text || '').matchAll(UPN_RE)].map((match) => match[0].toLowerCase());
}

function validateGroundedAssistantText(text, facts) {
  const grounding = facts || collectGroundingFacts([]);
  const unknownUpns = upnsInText(text).filter((upn) => !grounding.upns.has(upn));
  if (unknownUpns.length) {
    return { ok: false, reason: `Ungrounded UPN(s): ${[...new Set(unknownUpns)].join(', ')}` };
  }

  const claimedNumbers = numbersInAuditClaims(text);
  if (claimedNumbers.length && !grounding.hasToolFacts) {
    return { ok: false, reason: 'Numeric tenant claims require fresh tool results.' };
  }

  const unknownNumbers = claimedNumbers.filter((num) => !grounding.numbers.has(num));
  if (unknownNumbers.length) {
    return { ok: false, reason: `Ungrounded numeric tenant claim(s): ${[...new Set(unknownNumbers)].join(', ')}` };
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

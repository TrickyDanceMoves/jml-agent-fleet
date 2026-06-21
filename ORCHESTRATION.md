# Model Orchestration Hierarchy

How work is divided across models in this repo so output stays high-quality while
being **resourceful and token-mindful**. This complements `AGENTS.md` (repo
workflow) and `SYNC.md` (the Claude ↔ Codex working agreement + acceptance gate).

Governing rule: **use the cheapest model that can do the task reliably, and
escalate only when it actually needs more.** Treat the named models as *tiers* — a
sensible substitute (including a local open-source model) can fill any tier.

## Roles & ownership

| Tier | Default model | Owns |
|------|---------------|------|
| **Parent / Orchestrator** | Claude **Opus** (sub: latest Claude family, e.g. Fable 5) | Holds the full context. Plans, decomposes, delegates, implements or directs implementation, integrates results, makes final calls, and writes the human-facing summary. Most expensive — reserve for orchestration and hard reasoning. |
| **Researcher / mid implementer** | Claude **Sonnet** | Read-only exploration: code search, "where/how is X", pattern discovery, gathering excerpts; normal-difficulty implementation. Returns `file:line + conclusion`, never raw file dumps. Cheaper than Opus → use for breadth and parallel fan-out. |
| **Fast tier** | Claude **Haiku** (sub: a small local model) | Trivial lookups, mechanical/repetitive edits, classification, high-volume low-stakes calls. Cheapest cloud option. |
| **Private & bulk tier** | **Local / open-source** (Ollama, LM Studio) via the app's provider layer (`electron-app/providers/`) | Privacy-sensitive work where tenant/PII data must not leave the machine, offline operation, and zero-marginal-cost bulk drafting/summarization. Quality varies → keep to well-scoped, verifiable tasks. |
| **QA / Acceptance** | **Codex** (external) | Independent runtime QC, design review, security/edge-case checks, acceptance verification. The gate before commit/release (see `SYNC.md`). |

## Model-selection ladder

Pick the lowest rung that can do the job; escalate on failure or uncertainty.

```
Local-OSS / Haiku   →   Sonnet              →   Opus
(mechanical, bulk,      (research, normal       (orchestration, ambiguous
 private, offline)       implementation)         or high-stakes reasoning)
```

- Route anything touching **real tenant data / PII** or that must run **offline** to
  the **local-OSS** tier, regardless of task size.
- Don't start at Opus out of habit — start where the task lives and climb only if the
  cheaper tier stalls.

## Token-mindful principles

- **Act inline when you already have the context.** Don't spawn an agent to re-derive
  what's already in the conversation — a fresh agent is a cold start (expensive).
- **Delegate only when it nets savings:** broad/uncertain search, genuine parallel
  exploration, or independent QA. "Thorough" or "multi-part" is not a reason to spawn.
- **Researchers return distilled findings** (`file:line` + the conclusion), not file
  contents. The orchestrator reads only what it must.
- **Cap parallel fan-out at ≤3** and prefer one tightly-scoped agent over many.
- **Reuse context; never re-litigate** settled decisions or re-read unchanged files.
- **Batch independent tool calls** in one step.
- **Run QA (Codex) at acceptance gates**, not after every change.

## Workflow lifecycle

1. **Plan** — Opus understands the request, decides scope, and decides what (if
   anything) to delegate.
2. **Research** — Sonnet explores (parallel only if scope is uncertain) and returns
   distilled findings.
3. **Implement** — Opus implements (or directs the right tier to).
4. **QA** — Codex verifies against acceptance criteria (runtime, edge cases, security).
5. **Integrate & summarize** — Opus folds in QA feedback, finalizes, and reports.

## Delegation decision rules

- **Do it inline** when: the files are known, the change is small/targeted, or the
  answer is already in context.
- **Drop to the fast/local tier** when: the task is mechanical, repetitive, bulk, or
  privacy-sensitive.
- **Spawn a researcher (Sonnet)** when: scope is uncertain, several areas are
  involved, or you need patterns before acting.
- **Send to QA (Codex)** at the acceptance gate, before commit/release of anything
  non-trivial.
- **Do NOT spawn** for: trivial edits, work you can finish faster yourself, or just to
  "double-check" something low-stakes.

## Handoff brief format

Every delegation states, tightly, so the subagent stays cheap and focused:

- **Goal** — the one outcome wanted.
- **Scope / boundaries** — what's in and explicitly out.
- **Relevant files** — known paths/leads so it doesn't re-discover them.
- **Return format** — e.g. "`file:line` + one-line conclusion," "pass/fail with
  repro," "unified diff." Ask for the distilled result, not the journey.

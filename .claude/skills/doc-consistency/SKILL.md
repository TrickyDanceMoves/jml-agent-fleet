---
name: doc-consistency
description: Sweep the public docs for stale or contradictory claims — version numbers, automated test counts, hackathon dates, and security wording — against the actual repo state, and report/fix mismatches. Use before sharing the repo with judges/reviewers or when asked to "check current state / are the docs consistent".
---

# JML doc-consistency sweep

Judges and reviewers skim fast; a doc that claims "v1.1.8" or "80 tests" when reality
differs reads as unpolished. This skill grounds every public claim in actual state.

## Gather ground truth
- **Version:** `electron-app/package.json` `version`; and `gh release list --limit 3`
  (the Latest tag must match).
- **Test counts (run them, don't trust docs):** for each of `electron-app`, `api`,
  `worker` → `node --test "test/**/*.test.js"` and read the `tests N` / `pass N` line.
- **Dates:** the official Agents League dates are **registration June 12, 2026** and
  **submission June 14, 2026** (already submitted). Flag any other dates.

## Check the docs
Grep these files: `README.md`, `HACKATHON.md`, `docs/hackathon-readiness.md`,
`docs/quality-assurance.md`, `docs/case-study.html`, `docs/security.md`.
- Version refs: `grep -rhoE "v?[0-9]+\.[0-9]+\.[0-9]+"` → all should equal the current version.
- Test-count claims: `grep -rniE "[0-9]+ (automated )?tests"` → must equal the real counts
  (note `case-study.html` has both a hero metric and a body line — check both).
- Date claims: `grep -niE "june|july|deadline|registration|submission"`.
- Security wording: `docs/security.md` Conditional Access / Agent ID rows must agree
  with the README's precise claim (Agent ID-scoped CA policy enabled + verified via
  Graph, pre-staged with an empty principal scope; SP CA gated on Workload Identities
  Premium). Don't let one say "verified" and the other "not verified".

## Report, then fix
List each mismatch as `file:line — claims X, actual Y`. For unambiguous numeric/version
fixes, apply with targeted `sed -i` (precise context to avoid collateral). For
judgment calls (dates, security posture), confirm with the user before changing.
Commit only the doc files touched; push `git push origin HEAD:main`.

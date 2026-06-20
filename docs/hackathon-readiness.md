# Hackathon Readiness Review

Reviewed: June 12, 2026  
Target: Microsoft Agents League Hackathon, Enterprise Agents track

## Executive Decision

The repository is **submission-ready for the Enterprise Agents track**.

The product has a credible enterprise story, a working release, strong interaction
design, a differentiated Agent ID architecture, and a passing automated test suite.
The Enterprise Agents track requirement — use at least one Microsoft IQ layer — is
met by **Foundry IQ** (live; grounds risk/approval decisions on the JML policy corpus).

## Readiness Scorecard

| Area | Status | Evidence |
|---|---|---|
| Product concept | Ready | Clear identity-governance problem and differentiated hybrid trust model |
| Live demo | Ready | Electron console, Glass Screen lifecycle replay, approval and audit surfaces |
| Microsoft identity platform | Ready | Entra ID, Microsoft Graph, and live Entra Agent ID authentication |
| Microsoft IQ requirement | Ready | Foundry IQ grounds risk/approval decisions on the JML policy corpus with citations and fail-closed behavior (`lib/foundry-iq.js`, 8 tests) |
| Automated quality | Ready | 119 Electron tests pass; PowerShell parse checks pass; CI runs the suite |
| Dependency security | Ready | Production dependency audits report zero known vulnerabilities |
| Public release | Ready | Installer and portable ZIP are attached to GitHub Release v1.1.9 |
| Documentation accuracy | Improved | Case study, README, hackathon guide, and QA language aligned to current state |
| Public data hygiene | Needs work | Tenant-specific identifiers and tenant-bearing screenshots remain tracked |
| Open-source governance | Partial | Security and contribution guides are present; repository license still needs an owner decision |
| API and worker tests | Needs work | Validation exists, but API and queue worker do not have automated test scripts |
| Electron hardening | Accepted gap | Main renderer CSP is present; sandbox remains disabled and is documented |

## Blocking Finding — RESOLVED 2026-06-12

### P0 - Enterprise Agents requires a Microsoft IQ layer ✅ DONE & LIVE

The track requires at least one of Foundry IQ, Work IQ, Fabric IQ, or Web IQ.
**JML now integrates Foundry IQ** (Azure AI Foundry knowledge retrieval) to ground
risk and approval decisions in the JML policy corpus (SoD rules, approved access
patterns, freeze windows, offboarding playbook). The grounding source and citations
are shown in the Approver risk card, the Glass Screen run details, and the audit
record.

**Live as of 2026-06-12**: the policy corpus is published to an Azure AI Search
index in the project's pay-as-you-go subscription; the running app's FoundryIQ
client returns grounded citations against it (e.g. a leaver query returns the
offboarding playbook's dual-approval requirement and the SoD policy). Endpoint and
key live in the gitignored `approver/foundry-iq.json`; reproduce with
`provisioner/Publish-PolicyCorpus.ps1`.

Acceptance evidence — all met:

1. ✅ Module calls the IQ layer — `electron-app/lib/foundry-iq.js`, invoked from the
   Approver `score_risk` path in `main.js`.
2. ✅ Tests verify grounded output and fail-closed behavior —
   `electron-app/test/foundry-iq.test.js` (8 tests incl. three fail-closed paths).
3. ✅ A grounded policy match escalates risk and is cited in the UI; fail-closed
   blocks Live submits when grounding is configured-but-unavailable.
4. ✅ README and this doc name the exact IQ layer; architecture/case-study to match.

Corpus: `shared/policy-corpus/*.md`. Publish: `provisioner/Publish-PolicyCorpus.ps1`.
Enable: `approver/foundry-iq.json` (from `approver/foundry-iq.config.example.json`).

## High-Priority Findings

### P1 - Public tenant identifiers remain in tracked artifacts

Tracked documentation, scripts, JSON policy files, and screenshots contain a real
tenant domain, sponsor UPN, application IDs, group IDs, reviewer IDs, and other
tenant-specific object identifiers. These values are not credentials, but they
expose tenant topology and make the public repository look environment-bound.

Before submission:

- Replace tenant-specific defaults with required parameters or example placeholders.
- Move tenant-bound JSON to ignored runtime config and commit `.example.json` files.
- Re-capture screenshots against synthetic identities and a neutral tenant label.
- Run a final public-data scan before pushing the demo commit.

### P1 - CI previously skipped the Electron suite

The public workflow installed API and worker dependencies but did not execute the 48
Electron tests. The quality gate now runs `npm ci` and `npm test` in `electron-app`.

### P1 - Judge install path was stale

Documentation referenced a local `dist` path that is intentionally gitignored. Judge
instructions now point to the actual v1.1.9 GitHub Release assets.

## Medium-Priority Findings

### P2 - API and worker lack automated tests

The Azure Functions API and queue worker have smoke-testable modules but no `test`
scripts. Add focused tests for:

- canonical HR event validation
- BambooHR mapping
- API-key rejection
- event routing
- retry and dead-letter behavior
- idempotent dispatch

### P2 - Repository licensing is incomplete

The repository is public but has no license. `SECURITY.md`, `CONTRIBUTING.md`,
private vulnerability reporting, dependency alerts, automated security updates,
secret scanning, and push protection are now enabled. Select a license intentionally;
do not add one by assumption.

### P2 - Conditional Access claims need exact wording

Service-principal Conditional Access requires Microsoft Entra Workload Identities
Premium. Agent ID policy is a separate path. Public docs should describe the script,
license dependency, and verified tenant state separately, without saying enforcement
is active unless the policy is visible in the demo tenant.

## Verified Evidence

On June 12, 2026:

- `npm test` in `electron-app`: 82 passed, 0 failed.
- PowerShell parser check: all repository `.ps1` files parsed cleanly.
- Production `npm audit` in `electron-app`, `api`, `worker`, `approver`, and `auditor`:
  zero known vulnerabilities.
- GitHub Actions: latest quality and Pages deployments succeeded.
- GitHub Release v1.1.9 contains installer and portable ZIP assets.
- GitHub Pages serves the interactive case study over HTTPS.
- GitHub private vulnerability reporting, dependency alerts, automated security
  updates, secret scanning, and push protection are enabled.

## Go-Live Checklist

- [x] Add and demonstrate one Microsoft IQ layer. **(Foundry IQ — done 2026-06-12)**
- [x] Sanitize public tenant identifiers and screenshots. **(Verified 2026-06-12: no tenant identifiers in tracked files; captures sanitize the domain.)**
- [x] Add API and worker tests. **(Done 2026-06-12: `api/test/` 6 tests — canonical
  schema, BambooHR adapter, api-key gate; `worker/test/` 10 tests — dispatch routing,
  PIM activate/deactivate ordering, payload shapes, queue retry/dead-letter semantics.
  Worker refactored for testability: `src/message-handler.js` factory + injectable
  `dispatch` overrides. CI quality gate already runs `npm test` in both.)**
- [x] Confirm Conditional Access state in the demo tenant. **(Verified 2026-06-12 via
  Graph: `AgentGeneralCAPol` enabled, target `AllAgentIdResources`, grant `block`,
  principal scope empty/pre-staged. No SP policy — Workload Identities Premium not
  held. README wording updated to match.)**
- [x] Decide repository license and add community health files. **(Proprietary / all-rights-reserved license, source-available for evaluation, + CONTRIBUTING + SECURITY.)**
- [x] Record the demo using synthetic identities. **(2026-06-12: 90-second narrated cut rendered from sanitized captures — `.superpowers/jml-demo-video`, output `out/jml-demo-90s.mp4`.)**
- [x] Run CI, dependency audits, and link checks. **(2026-06-12: quality gate green; npm audit 0 vulnerabilities incl. dev after esbuild 0.28.1 override; doc links verified.)**
- [ ] Verify the five-minute public video and final submission links.

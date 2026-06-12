# Hackathon Readiness Review

Reviewed: June 12, 2026  
Target: Microsoft Agents League Hackathon, Enterprise Agents track

## Executive Decision

The repository is **demo-ready but not yet submission-eligible for the Enterprise
Agents track**.

The product has a credible enterprise story, a working release, strong interaction
design, a differentiated Agent ID architecture, and a passing automated test suite.
The blocking gap is the track requirement to use at least one Microsoft IQ layer.

## Readiness Scorecard

| Area | Status | Evidence |
|---|---|---|
| Product concept | Ready | Clear identity-governance problem and differentiated hybrid trust model |
| Live demo | Ready | Electron console, Glass Screen lifecycle replay, approval and audit surfaces |
| Microsoft identity platform | Ready | Entra ID, Microsoft Graph, and live Entra Agent ID authentication |
| Microsoft IQ requirement | **Blocking** | No Foundry IQ, Work IQ, Fabric IQ, or Web IQ integration is present |
| Automated quality | Ready | 48 Electron tests pass; PowerShell parse checks pass; CI now runs the suite |
| Dependency security | Ready | Production dependency audits report zero known vulnerabilities |
| Public release | Ready | Installer and portable ZIP are attached to GitHub Release v1.0.0 |
| Documentation accuracy | Improved | Case study, README, hackathon guide, and QA language aligned to current state |
| Public data hygiene | Needs work | Tenant-specific identifiers and tenant-bearing screenshots remain tracked |
| Open-source governance | Partial | Security and contribution guides are present; repository license still needs an owner decision |
| API and worker tests | Needs work | Validation exists, but API and queue worker do not have automated test scripts |
| Electron hardening | Accepted gap | Main renderer CSP is present; sandbox remains disabled and is documented |

## Blocking Finding

### P0 - Enterprise Agents requires a Microsoft IQ layer

The track announcement requires at least one of Foundry IQ, Work IQ, Fabric IQ, or
Web IQ. Azure AI Foundry inference support does not by itself satisfy that
requirement.

Recommended implementation: use **Foundry IQ** to ground the Approver and Auditor in
the JML policy corpus, including SoD rules, approved access patterns, operating
procedures, and recovery playbooks. Display the grounding source and citation in the
Approver response and Glass Screen run details.

Acceptance evidence:

1. A repository module or service calls the chosen IQ layer.
2. A test verifies grounded output and fail-closed behavior when grounding is
   unavailable.
3. The demo shows a cited policy result affecting a risk or approval decision.
4. The README, architecture, case study, and submission form name the exact IQ layer.

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
instructions now point to the actual v1.0.0 GitHub Release assets.

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

- `npm test` in `electron-app`: 48 passed, 0 failed.
- PowerShell parser check: all repository `.ps1` files parsed cleanly.
- Production `npm audit` in `electron-app`, `api`, `worker`, `approver`, and `auditor`:
  zero known vulnerabilities.
- GitHub Actions: latest quality and Pages deployments succeeded.
- GitHub Release v1.0.0 contains installer and portable ZIP assets.
- GitHub Pages serves the interactive case study over HTTPS.
- GitHub private vulnerability reporting, dependency alerts, automated security
  updates, secret scanning, and push protection are enabled.

## Go-Live Checklist

- [ ] Add and demonstrate one Microsoft IQ layer.
- [ ] Sanitize public tenant identifiers and screenshots.
- [ ] Add API and worker tests.
- [ ] Confirm Conditional Access state in the demo tenant.
- [ ] Decide repository license and add community health files.
- [ ] Record the demo using synthetic identities.
- [ ] Run CI, dependency audits, tenant smoke tests, and link checks.
- [ ] Verify the five-minute public video and final submission links.

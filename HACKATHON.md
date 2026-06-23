# Agents League Hackathon Submission Guide

**Track:** Enterprise Agents

**Registration deadline:** June 12, 2026

**Coding period:** June 1 through June 14, 2026

**Submission deadline:** June 14, 2026 at 11:59 PM Pacific Time - **submitted ✅**

**Judging period:** June 14 through June 30, 2026 - results expected after June 30

**Format:** Virtual, global, public code repository, and public demo video up to five minutes

Official references:

- [Enterprise Agents track announcement](https://devblogs.microsoft.com/microsoft365dev/agents-league-hackathon-2026-enterprise-agents/)
- [Registration and official rules](https://info.microsoft.com/Agents-League-Hackathon-Registration.html)

## Current Decision

**Demo readiness: GO with the checklist below.**

**Enterprise Agents submission eligibility: GO - the Microsoft IQ requirement is met.**

The Enterprise Agents challenge asks teams to use at least one Microsoft IQ layer:
Foundry IQ, Work IQ, Fabric IQ, or Web IQ. **JML integrates Foundry IQ** (Azure AI
Foundry knowledge retrieval): every risk and approval decision is grounded on the
organization's JML policy corpus with citations and fail-closed behavior
(`electron-app/lib/foundry-iq.js`). Model hosting alone would not qualify - this is a
policy-grounding IQ integration, not just inference.

Track this and the remaining repository risks in
[`docs/hackathon-readiness.md`](docs/hackathon-readiness.md).

## Submission Checklist

- [x] Register before June 12, 2026. **(Done - submitted before the June 14 deadline)**
- [x] Integrate and demonstrate at least one Microsoft IQ layer. **(Foundry IQ - done)**
- [ ] Record a public YouTube or Vimeo demo no longer than five minutes.
- [ ] Confirm the repository and demo disclose every third-party component used.
- [ ] Use synthetic identities and sanitized tenant evidence in public screenshots.
- [ ] Run the quality gate and tenant smoke tests.
- [ ] Submit:
  - [ ] Project name: **JML Agent Fleet**
  - [ ] Project description from this guide
  - [ ] Public demo video
  - [ ] GitHub repository: `https://github.com/TrickyDanceMoves/jml-agent-fleet`
  - [ ] Interactive case study: `https://trickydancemoves.github.io/jml-agent-fleet/docs/case-study.html`
  - [ ] Architecture diagram: `docs/images/JML AI Agent Architecture.png`
  - [ ] Microsoft technologies list
  - [ ] Team member details

## Project Description

**JML Agent Fleet** is an identity lifecycle automation system for Microsoft
Entra ID. Eight operational agents coordinate Joiner, Mover, Leaver, enrollment,
approval, provisioning, audit, and access-certification workflows from an Electron
operations console.

The system separates reasoning from privileged execution. Approver and Auditor
authenticate as first-class Microsoft Entra Agent IDs through FMI token exchange.
Directory-write agents remain on least-privilege service principals because Entra
blocks broad write scopes on Agent IDs. The model proposes; policy, approval, and
the execution control plane decide what reaches Microsoft Graph.

Every lifecycle run appears in the Glass Screen command center as it advances
through Request, Risk, Execute, Verify, and Complete. Failed and partial runs remain
failed or partial across the dashboard, operations surfaces, replay, and audit
evidence. Hard-destructive leaver actions require a second operator approval.

The reasoning layer is provider-agnostic and supports Azure AI Foundry, Azure
OpenAI, OpenAI, Anthropic, Ollama, and Qwen-compatible local runtimes. HR events
can enter through Azure Functions, validate against the canonical JSON Schema, and
flow through Azure Storage Queue and Table Storage to the lifecycle agents.

The current build includes a tamper-evident SHA-256 audit chain, UEBA and drift
detection, Microsoft Sentinel and Blob export paths, operator RBAC, Safe and Live
session modes, and 173 automated console tests.

## Microsoft Technologies

| Technology | Use in JML Agent Fleet |
|---|---|
| **Microsoft Entra ID** | Source of truth for users, groups, licenses, app identities, and governance |
| **Microsoft Entra Agent ID** | First-class identities for the Approver and Auditor reasoning agents |
| **Microsoft Graph API** | User lifecycle, group, license, session, risk, device, and identity operations |
| **Microsoft Intune** | Device lifecycle + compliance via managed-device Graph endpoints - sync, remote lock, retire, wipe, BitLocker key rotation, and compliance/encryption state |
| **Microsoft Entra ID Protection** | Risky users and sign-in risk detections feed the security posture and the Approver's risk context |
| **Azure AI Foundry** | Supported model inference provider for the reasoning agents |
| **Azure Functions v4** | HRIS webhook and canonical JML event API |
| **Azure Storage Queue** | Durable event delivery, retry, and dead-letter handling |
| **Azure Table Storage** | Event status tracking |
| **Azure Blob Storage** | Optional audit evidence export |
| **Microsoft Sentinel** | Optional audit and security finding ingestion |
| **Microsoft Purview** | HR connector integration path |
| **Foundry IQ** | Microsoft IQ layer - grounds risk/approval decisions on the JML policy corpus (`lib/foundry-iq.js`) |

## Five-Minute Demo

### 0:00-0:30 - Thesis

- Identity operations need AI assistance without giving a model directory-wide authority.
- Show the case study hero and the hybrid trust model.

### 0:30-1:10 - Architecture

- Approver and Auditor run as Entra Agent IDs.
- Policy-gated write agents use least-privilege service principals.
- Every action emits lifecycle state and tamper-evident audit evidence.
- Call out the Foundry IQ integration grounding risk/approval decisions on the policy corpus.

### 1:10-2:35 - Joiner

- Start with: "Onboard Sarah Chen as a Platform Engineer in the US."
- Show peer recommendations, risk score, policy checks, and confirmation.
- Switch to Glass Screen and follow Request to Complete.
- Open run details and show the operation ID, ticket, operator, and outcome.

### 2:35-3:35 - Failure truth and recovery

- Replay a controlled failed or partial run.
- Show that Verify and Complete are not marked successful.
- Show the same outcome on Dashboard, Operations, and Audit Log.
- Explain the actionable recovery message without exposing raw infrastructure errors.

### 3:35-4:20 - Leaver governance

- Run a soft leaver in Safe mode.
- Show the dual-approval gate for the hard-destructive stage.
- Explain operator RBAC and the Safe versus Live session boundary.

### 4:20-5:00 - Evidence and close

- Show UEBA, drift, audit-chain verification, and Sentinel or Blob export controls.
- Show the Microsoft IQ result or grounding evidence.
- Close on the public repository, case study, release, and 173-test quality gate.

## Judging Alignment

Official judging is based on concept, impact, Microsoft platform use, and quality
of implementation.

| Criterion | Evidence |
|---|---|
| **Concept** | Hybrid Agent ID architecture separates reasoning from privileged execution |
| **Impact** | Reduces manual JML work while preserving approval, traceability, and failure truth |
| **Use of Microsoft Platform** | Entra ID, Entra Agent ID, Microsoft Graph, Intune (device lifecycle), Entra ID Protection, Azure Functions, Storage, Sentinel, Purview, and the Foundry IQ layer |
| **Quality of Implementation** | Live console, replayable lifecycle state, fail-closed controls, 173 tests, CI, threat model, and downloadable release |

## Judge Setup

### Fastest path

1. Download `JML.Console.Setup.1.1.13.exe` from the
   [v1.1.13 GitHub Release](https://github.com/TrickyDanceMoves/jml-agent-fleet/releases/tag/v1.1.13).
2. Install per-user.
3. Open Settings and configure an AI provider.
4. Run the Tenant Binding wizard with an authorized lab tenant.
5. Use Safe mode first.

### Development path

```powershell
cd electron-app
npm ci
npm test
npm start
```

Microsoft Graph PowerShell SDK is required for tenant operations:

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser
```

## Final Gate

Before recording or submitting:

```powershell
cd electron-app
npm test
npm audit --omit=dev --audit-level=high
```

Then run the tenant checks in [`docs/quality-assurance.md`](docs/quality-assurance.md).

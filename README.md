# JML Agent Fleet

AI-powered identity lifecycle automation for Microsoft Entra ID. Seven agents — two AI-backed (Approver, Auditor) and five PowerShell — handle the full Joiner/Mover/Leaver (JML) workflow with zero-trust architecture, UEBA, drift detection, AI-assisted provisioning, and end-to-end HRIS integration, replicating core capabilities of enterprise IGA platforms like SailPoint and Saviynt.

The reasoning agents run as **first-class Microsoft Entra Agent IDs** (live, hybrid by design — see [Agent Identity](#agent-identity--hybrid-entra-agent-id-live)), every operation streams through a live **Glass Screen command center**, and the AI layer is **provider-agnostic**: Approver and Auditor agents run on any OpenAI-compatible backend — **Azure AI Foundry**, Azure OpenAI, OpenAI, Anthropic Claude, or a local Ollama instance — switchable from Settings with no code change.

**[Interactive Case Study](https://trickydancemoves.github.io/jml-agent-fleet/docs/case-study.html)** — walkthrough of the architecture, agent design, and live operation flows.

## ⚡ Judging This for the Hackathon? Start Here

Five minutes to the core of it:

1. **The thesis** — autonomous AI agents should *propose* identity changes, never own directory-write authority. Microsoft Entra itself enforces this: write scopes are blocked on agent identities. This project's hybrid architecture (reasoning agents on **Entra Agent IDs**, execution behind a policy-gated control plane on least-privilege service principals) isn't a workaround — it's the platform-aligned answer, running live in a real tenant.
2. **See it** — the [screenshots below](#screenshots) are real captures from the running console: risk-scored approvals, a tamper-evident hash-chained audit trail replicated to Sentinel/Blob, UEBA findings, and the Glass Screen showing a live operation advance through Request → Risk → Execute → Verify → Complete.
3. **Run it** — download the published release artifact from [JML Console v1.0.0](https://github.com/TrickyDanceMoves/jml-agent-fleet/releases/tag/v1.0.0); the Setup Wizard binds your tenant and provisions the required identities with admin-consent links ([Installation](#installation)). Or run `npm start` from `electron-app/` for the development path.
4. **Audit it** — [threat model](docs/threat-model.md) · [agent identity roadmap (now executed)](docs/agent-identity-roadmap.md) · [Electron hardening](docs/electron-security.md) · 48 automated tests enforced by the CI quality gate.

> **The model proposes; policy and approval decide what executes.**

## Screenshots

| Operator Selector | Auth Selection (PIN / Windows) |
|---|---|
| ![Operator selector](docs/images/operator-select.png) | ![Auth selection](docs/images/auth-select.png) |

| Dashboard | |
|---|---|
| ![Dashboard](docs/images/dashboard.png) | |

| Glass Screen (live operation) | Operations |
|---|---|
| ![Glass Screen](docs/images/glass-screen.png) | ![Operations](docs/images/operations.png) |

| JML Fleet (Input) | JML Fleet (Conversation) |
|---|---|
| ![JML Fleet input](docs/images/jml-fleet-input.png) | ![JML Fleet](docs/images/approver.png) |

| Auditor | Graph Runner |
|---|---|
| ![Auditor](docs/images/auditor.png) | ![Graph](docs/images/graph.png) |

| Approvals | Access Reviews |
|---|---|
| ![Approvals](docs/images/approvals.png) | ![Access Reviews](docs/images/access-reviews.png) |

| Integrations | Security |
|---|---|
| ![Integrations](docs/images/integrations.png) | ![Security](docs/images/security.png) |

| Audit Log | Exports |
|---|---|
| ![Audit Log](docs/images/audit-log.png) | ![Exports](docs/images/exports.png) |

| Users | Certs |
|---|---|
| ![Users](docs/images/users.png) | ![Certs](docs/images/certs.png) |

| Settings | |
|---|---|
| ![Settings](docs/images/settings.png) | |

| Docked Panel | Docked (Sections Collapsed) |
|---|---|
| ![Docked Panel](docs/images/docked-panel-full.png) | ![Docked Collapsed](docs/images/docked-panel-collapsed.png) |

| Slim Hub (collapsed sidebar) | Overlay Mode |
|---|---|
| ![Slim Hub](docs/images/slim-hub.png) | ![Overlay Mode](docs/images/overlay-mode.png) |

## What It Does

Automates identity provisioning and deprovisioning across a Microsoft 365 / Entra ID tenant, replacing manual IT processes with auditable, policy-gated agent workflows that run from a desktop operations console.

## The Problem

HR platforms, identity providers, ticketing tools, manual approval chains. Identity ops live in the seams between systems — and that's where speed, consistency, and auditability go to die.

| | |
|---|---|
| **Delayed** | Provisioning lags behind day-one needs, especially for cross-functional roles. |
| **Excessive** | Permissions accumulate quietly. Access drift becomes the default state. |
| **Fragmented** | Audit trails span four tools, three teams, and one heroic spreadsheet. |
| **Manual** | Approvals route through email, chat, tickets — reviewable, but rarely reviewed. |

> Capability without governance is a liability. Identity is the wrong domain to learn that lesson twice.

The design response: AI works inside guardrails rather than replacing the admin. No single agent has full authority, every action is gated by policy, and the audit trail is tamper-evident by construction.

## Agent Fleet

| Agent | Role |
|---|---|
| **Joiner** | Creates accounts, assigns licenses and groups, fires HR-triggered onboarding |
| **Mover** | Updates attributes, group memberships, and licenses on role/department change |
| **Leaver** | Soft (disable + revoke sessions) then Hard (licenses + groups) offboarding with dual-approval gate |
| **Enroller** | Device enrollment and compliance group assignment |
| **Approver** | Human-in-the-loop approval console with risk scoring and operator RBAC |
| **Provisioner** | Manages app registrations (disabled at rest, enabled only during provisioning sessions) |
| **Auditor** | UEBA, drift detection, Identity Protection scans, access certification campaigns |

**Taxonomy (so the counts are unambiguous):** there are **seven operational agents**
(the table above). They are supported by non-agent services — the **API** (Azure
Functions), the **queue Worker**, the **Certifier** campaign runner, the **Purview**
HR connector, and the **Electron console**. Counting Entra app registrations, the
fleet currently provisions **eight** (the seven agents plus the Certifier service), which
is why some operational views show "8 app registrations." Agents reason and act;
services move data and host the control plane.

## Key Features

### Identity Lifecycle Automation
- Full JML workflow over Microsoft Graph API: account create/update/disable, license assignment, group membership, session revocation
- Ticket reference (`ticketRef`) flows through every operation and is required for leavers
- Staged leaver: Soft (disable + revoke) → confirmation → Hard (licenses + groups)

### AI-Assisted Provisioning
- **Peer-group recommendations**: `Invoke-ProvisioningRecommendation.ps1` queries users in the same department and surfaces licenses/groups held by >50% of peers, with confidence ratings
- **Risk scoring**: `Invoke-RiskScore.ps1` produces a 0–100 risk score across: baseline operation risk, active freeze windows, sensitive licenses/groups, SoD conflicts, and dual-approval requirements
- Risk gates every Live-mode submission: low (<25) proceeds, medium (25–49) warns, high (50–79) requires explicit confirmation, critical (≥80 or blocked) is rejected

### Microsoft IQ — Foundry IQ Policy Grounding
Every risk and approval decision is **grounded in the organization's own identity-governance policy corpus** using **Foundry IQ** (Azure AI Foundry knowledge retrieval) — the project's Microsoft IQ layer for the Enterprise Agents track.
- The Approver's `score_risk` call retrieves relevant policy from a corpus of SoD rules, approved access patterns, freeze windows, and the offboarding playbook (`shared/policy-corpus/`), and **cites the source documents** in the risk card, the Glass Screen run details, and the audit record.
- A grounded policy match (SoD violation, freeze window) escalates the operation's risk level and reasons.
- **Fail-closed**: when grounding is configured but the Foundry IQ service is unreachable, the decision is marked blocked — the control plane refuses to act on ungrounded policy rather than guessing. (`electron-app/lib/foundry-iq.js`, contract locked by `test/foundry-iq.test.js`.)
- Publish the corpus to an Azure AI Search index with `provisioner/Publish-PolicyCorpus.ps1`; enable in `approver/foundry-iq.json` (copy from the committed `.config.example.json`).

### Security Controls
- **SoD policy engine**: `shared/sod-policy.json` defines incompatible group pairs; violations block or warn before any submit
- **PIM for Groups**: Just-in-time activation for privileged group membership with time-limited access
- **Access certification campaigns**: periodic reviewer-driven attestation of user and agent group memberships
- **Dual approval for leavers**: Hard leaver requires a second operator approval; token expires after 30 minutes
- **Operator RBAC**: `approver/operators.json` maps Windows usernames to roles (admin / helpdesk / viewer) that gate which tools each operator may invoke

### Behavioural Monitoring & Threat Detection
- **UEBA**: `Invoke-UEBAAnalysis.ps1` runs 6 behavioural rules over the hash-chained audit log: after-hours ops, high-volume changes, repeated failures, leaver-then-group-add, self-modification, mode abuse
- **Drift detection**: `Invoke-DriftDetection.ps1` compares current Entra state against a known-good baseline; weekly cron or on-demand
- **Identity Protection**: `Invoke-RiskyUserScan.ps1` pulls Microsoft's risky user signals via Graph; 6-hour cron

### HRIS Integration & REST API
- **Azure Functions v4** (`agents/api/`): three endpoints: `POST /api/jml` (canonical HR event), `POST /api/webhooks/{source}` (inbound webhooks), `GET /api/jml/status/{eventId}` (status polling)
- **BambooHR adapter**: maps New Hire, Termination, and Job Change webhook payloads to the canonical HR event schema
- **Queue worker** (`agents/worker/`): polls Azure Storage Queue every 5s, maps hire/terminate/transfer events to the appropriate PS1 scripts, writes status to Azure Table Storage, retries up to 3× then dead-letters
- **Canonical HR event schema**: JSON Schema 2020-12 at `api/src/schemas/hr-event.schema.json`

### Audit & Compliance
- **Hash-chained audit log**: every operation writes a JSONL entry with `prevHash` + `hash` (SHA-256); `Verify-AuditLog.ps1` validates chain integrity
- **Windows Event Log sink**: every audit entry is also written to the Windows Event Log (source: `JMLAgents`)
- **Teams notifications**: leaver operations and critical findings fire Teams MessageCards via webhook
- **Microsoft Sentinel ingestion**: `Invoke-SentinelIngest.ps1` ships audit log and security findings to `JML_AuditLog_CL` and `JML_SecurityFindings_CL` custom log tables
- **Azure Blob Storage export**: `Invoke-BlobExport.ps1` exports the audit log to a configured Blob container with SAS token auth
- **Operator identity stamping**: every audit entry carries the Windows username of the console operator who triggered the operation

### Operations Console (Electron App)
Desktop app (`agents/electron-app/`) with a frameless operator selector at startup:

| Tab | Purpose |
|---|---|
| Dashboard | Fleet health overview |
| Glass Screen | Live command center: the active operation owns the page and advances through Request → Risk → Execute → Verify → Complete from real `operation-status` events — failures stop at the failing stage with a recovery action, recent runs replay on demand, evidence lives in a details drawer |
| JML Fleet | Approver chat agent: submit joiner/mover/leaver/enroller operations |
| Auditor | Auditor chat agent: query audit log, run reports |
| Security | Live UEBA, drift, and Identity Protection findings with count badges |
| Exports | Blob Storage and Sentinel export status + Run Now buttons |
| Approvals | Pending dual-approval leaver tokens |
| Operations | Direct operation dispatch |
| Access Reviews | Recurring entitlement attestation campaigns; reviewers attest in-product, revocations route through Approver |
| Integrations | HRIS, notification, and SIEM connector status; durable event queue with replay and canonical schema viewer |
| Certs | Certificate status per agent app registration |
| Settings | Tenant setup wizard, operator RBAC, freeze windows, SoD rules, notification routing, theme |
| Audit Log | Searchable 7-column audit log (Timestamp · Agent · Subject · Operator · Ticket · Outcome · Mode) |
| Users | User search with UPN autocomplete (cache-first) |
| Graph | Graph Query Runner with AI-suggested queries, 8 quick-pick chips, and AI digest |

### Zero-Trust Architecture
- Each agent has an isolated app registration with least-privilege Graph API permissions
- No agent can modify other app registrations; only the Provisioner can, and it is disabled at rest
- Certificate-based auth (`Connect-AgentGraph` in `Helpers.ps1`) with DPAPI-encrypted secret fallback
- Conditional Access, stated precisely: (1) `New-AgentConditionalAccess.ps1` automates a named-location policy for the service principals, but **SP enforcement requires Microsoft Entra Workload Identities Premium**, which the demo tenant does not hold — no SP policy is deployed; (2) the demo tenant **has an enabled Agent ID-scoped CA policy** (`AgentGeneralCAPol`, target `AllAgentIdResources`, grant `block`) verified via Graph — currently pre-staged with an empty principal scope, demonstrating that Agent ID CA works with the tenant's existing P1/P2 licensing where SP CA cannot
- `Test-AgentPermissions.ps1` detects and optionally repairs permission drift

### Agent Identity — Hybrid Entra Agent ID (live)
- **Auditor and Approver authenticate as Microsoft Entra Agent IDs** — first-class non-human AI identities with native owner/sponsor governance — via the two-step FMI token exchange (blueprint credential → exchange token → agent token), implemented in `Connect-AgentGraph` and validated live in-tenant
- **Write agents (Joiner/Mover/Leaver/Enroller) deliberately stay on least-privilege service principals**: Entra blocks `User.ReadWrite.All` and `GroupMember.ReadWrite.All` on agent identities, which is precisely this project's thesis — reasoning agents propose and score; privileged execution stays behind the approval control plane
- Provisioning is fully scripted: `New-AgentIdentities.ps1` (blueprint + six agent identities), `Grant-AgentIdentityPermissions.ps1`, `Enable-AgentIdAuth.ps1` — see [`docs/agent-identity-roadmap.md`](docs/agent-identity-roadmap.md) for the verified Graph contracts and platform constraints discovered along the way

## Architecture

![JML AI Agent Architecture](docs/images/JML%20AI%20Agent%20Architecture.png)

```
HRIS (BambooHR)
    │  webhook
    ▼
agents/api/          Azure Functions v4  ──► Azure Storage Queue
                                                     │
agents/worker/       Queue worker  ◄─────────────────┘
    │  spawns PS1
    ▼
agents/{joiner,mover,leaver}/   PowerShell + Microsoft Graph
    │  writes
    ▼
agents/audit.jsonl              Hash-chained audit log
    │  ingested by
    ├──► Microsoft Sentinel (JML_AuditLog_CL)
    └──► Azure Blob Storage

agents/electron-app/            Electron operations console
    │  IPC → async PowerShell (warm authenticated Graph session,
    │        ~360ms repeat queries; UI never blocks)
    └──► same PS1 scripts (operator-driven path)

agents/auditor/                 Scheduled intelligence
    ├── Invoke-UEBAAnalysis.ps1        (daily)
    ├── Invoke-DriftDetection.ps1      (weekly)
    └── Invoke-RiskyUserScan.ps1       (6-hour)
```

## Agent Permissions (Least Privilege)

| Agent | User Admin | License Admin | Cloud Device Admin | App Admin |
|---|---|---|---|---|
| Joiner | ✅ | ✅ | - | - |
| Mover | ✅ | ✅ | - | - |
| Enroller | - | ✅ | ✅ | - |
| Leaver | ✅ | ✅ | - | - |
| Provisioner | - | - | - | ✅ (disabled at rest) |

## Tech Stack

| Layer | Technology |
|---|---|
| Identity platform | Microsoft Entra ID (Azure AD) |
| Graph API | Microsoft Graph PowerShell SDK + REST |
| AI provider | **Azure AI Foundry** · Azure OpenAI · OpenAI · Anthropic Claude · Ollama (switchable) |
| Operations console | Electron 42, Node.js |
| HRIS integration | Azure Functions v4 (Node.js), Azure Storage Queue, Azure Table Storage |
| Audit export | Azure Blob Storage (SAS), Microsoft Sentinel (HTTP Data Collector API) |
| Scripting | PowerShell 5.1 |
| Local dev | Azurite (Azure Storage emulator) |

## AI Provider Architecture

The agent intelligence layer is fully abstracted behind a provider interface (`electron-app/providers/`). Every AI call — streaming agent conversations, Graph query suggestions, and API response digests — flows through the same interface regardless of which backend is configured.

| Provider | Notes |
|---|---|
| **Azure AI Foundry** | Recommended for enterprise deployments. Connects to a Foundry project endpoint or the GitHub Models catalogue (`https://models.inference.ai.azure.com`). Supports GPT-4o, Llama, Mistral, and any model in the Azure AI model catalogue. |
| Azure OpenAI | Direct Azure OpenAI resource with deployment-level configuration. |
| OpenAI | OpenAI API with model selection. |
| Anthropic Claude | Claude API with separate agent (Opus) and fast (Haiku) model slots. |
| Ollama | Local inference — no API key or network egress required. |
| Qwen (local) | Qwen 3 family via any OpenAI-compatible local runtime (Ollama `/v1` by default; LM Studio or vLLM by changing the base URL). No API key or egress. |

Switch providers in **Settings → AI Provider** without restarting the app or losing conversation history. The Anthropic message and tool-call format is used as the internal canonical format; each provider adapter converts on the fly.

## Security & Governance Docs

- [`docs/threat-model.md`](docs/threat-model.md) — STRIDE threat model, trust boundaries, fail-closed controls
- [`docs/electron-security.md`](docs/electron-security.md) — renderer isolation, IPC hardening, known gaps
- [`docs/agent-identity-roadmap.md`](docs/agent-identity-roadmap.md) — app registrations → Microsoft Entra Agent ID migration path
- [`api/openapi.yaml`](api/openapi.yaml) — OpenAPI spec for the JML control-plane API (Copilot Studio action surface)

## Copilot / Agent Integration

The identity lifecycle API ([`api/openapi.yaml`](api/openapi.yaml)) is a governed action
surface that a **Microsoft 365 Copilot / Copilot Studio** agent can call. Copilot
captures the intent ("onboard Sarah in Platform Engineering"); the JML control plane
performs risk scoring, policy checks, human approval, just-in-time privilege, audited
Graph execution, and Sentinel evidence. **The model proposes; policy and approval decide
what executes.**

## Just-in-Time Privilege — design note

JIT privilege is enforced at the **control plane**: the Provisioner is disabled at rest
and enabled only during active provisioning sessions, and every privileged action is
risk-scored, policy-checked, and approval-gated before least-privilege execution.

> Microsoft Entra **PIM for Groups does not support service principals as eligible
> members**, so JIT *activation* cannot gate app-only agent identities. This is a platform
> constraint, not a configuration gap — see [`docs/agent-identity-roadmap.md`](docs/agent-identity-roadmap.md).
> `pim-config.json` is retained for user-context PIM; `Invoke-PIMHelper.ps1` treats agent
> PIM activation as non-fatal so agents proceed on their least-privilege app permissions.

## Limitations & Roadmap

Honest current state, so reviewers know what's proven vs. planned:

| Area | Now | Roadmap |
|---|---|---|
| Agent identity | ✅ **Hybrid live**: Auditor + Approver run as Entra Agent IDs (FMI auth); write agents on least-privilege SPs (Entra blocks write scopes on agent identities — by design) | Retire the two legacy read-agent app registrations after soak |
| Credentials | NonExportable cert (SPs); blueprint secret (Agent IDs), DPAPI-protected | Federated identity credentials (no stored secret) |
| JIT privilege | Control-plane (Provisioner at-rest disable + approval) | Agent-scoped governance as Entra supports it |
| Operator RBAC | Local Windows username / PIN | Entra-backed operator identity + group-derived role |
| Conditional Access | Agent ID-scoped CA policy enabled in tenant (pre-staged, empty principal scope); SP CA script present but unenforceable without Workload Identities Premium | Scope the Agent ID policy to the live agent identities after soak |
| Hackathon IQ layer | Not yet integrated | Add and demonstrate at least one Microsoft IQ layer before Enterprise Agents submission |
| AI observability | ✅ Per-turn run telemetry (provider, model, latency, tokens) in Settings → AI Provider | Foundry-native trace correlation IDs |
| Copilot integration | ✅ OpenAPI action surface + Power Platform connector (`api/apiProperties.json`, `docs/copilot-studio-setup.md`) | Live Copilot Studio agent in tenant |
| Electron sandbox | `sandbox: false` (preload needs Node); CSP enforced on main renderer | `sandbox: true` after moving Node logic to IPC |

## Quality Assurance

Release closeout and smoke-test guidance lives in [`docs/quality-assurance.md`](docs/quality-assurance.md). Use it as the gate before demos, packaging, or tenant handoff. Automated checks run in CI via [`.github/workflows/quality-gate.yml`](.github/workflows/quality-gate.yml) (PowerShell parse, secret-scan denylist, Node tests, schema validation).

## Next Product Scope

Planning guidance for the follow-on Azure Network Deployment and Governance Console lives in [`docs/azure-network-console-plan.md`](docs/azure-network-console-plan.md). It extends the same approval, risk, drift, and evidence model from identity automation into Azure networking.

## Installation

Download `JML.Console.Setup.1.0.0.exe` from the [v1.0.0 GitHub Release](https://github.com/TrickyDanceMoves/jml-agent-fleet/releases/tag/v1.0.0). No admin rights are required; it installs per-user to `%LOCALAPPDATA%\Programs\JML Console\`.

**Prerequisite:** Microsoft Graph PowerShell SDK
```powershell
Install-Module Microsoft.Graph -Scope CurrentUser
```

After installing, open the app and go to **Settings > Tenant Binding** to run the Setup Wizard. It handles device-code sign-in, creates all eight app registrations in your tenant, and generates admin-consent links for each one.

## Local Development

### Prerequisites
- Windows with PowerShell 5.1
- Microsoft Graph PowerShell SDK: `Install-Module Microsoft.Graph -Scope CurrentUser`
- Node.js 20+
- Azure Functions Core Tools v4: `npm i -g azure-functions-core-tools@4`
- Azurite: `npm i -g azurite`

### Operations Console
```powershell
cd electron-app
npm install
npm start
```

### Dev API + Worker Stack
```powershell
cd agents
.\dev-start.ps1   # opens 3 windows: Azurite → worker → func start
```

## Tenant

| Property | Value |
|---|---|
| Tenant ID | `<YOUR-TENANT-ID>` |
| Domain | `contoso.onmicrosoft.com` |
| Agent department tag | `AI Agents` |

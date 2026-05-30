# JML Agent Fleet

AI-powered identity lifecycle automation for Microsoft Entra ID. Eight agents — two Claude-backed (Approver, Auditor) and six PowerShell — handle the full Joiner/Mover/Leaver (JML) workflow with zero-trust architecture, UEBA, drift detection, AI-assisted provisioning, and end-to-end HRIS integration, replicating core capabilities of enterprise IGA platforms like SailPoint and Saviynt.

**[Interactive Case Study](https://trickydancemoves.github.io/jml-agent-fleet/docs/case-study.html)** — walkthrough of the architecture, agent design, and live operation flows.

## Screenshots

| Operator Selector | Auth Selection (PIN / Windows) |
|---|---|
| ![Operator selector](docs/images/operator-select.png) | ![Auth selection](docs/images/auth-select.png) |

| Dashboard | |
|---|---|
| ![Dashboard](docs/images/dashboard.png) | |

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

## What It Does

Automates identity provisioning and deprovisioning across a Microsoft 365 / Entra ID tenant, replacing manual IT processes with auditable, policy-gated agent workflows that run from a desktop operations console.

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

## Key Features

### Identity Lifecycle Automation
- Full JML workflow over Microsoft Graph API: account create/update/disable, license assignment, group membership, session revocation
- Ticket reference (`ticketRef`) flows through every operation and is required for leavers
- Staged leaver: Soft (disable + revoke) → confirmation → Hard (licenses + groups)

### AI-Assisted Provisioning
- **Peer-group recommendations**: `Invoke-ProvisioningRecommendation.ps1` queries users in the same department and surfaces licenses/groups held by >50% of peers, with confidence ratings
- **Risk scoring**: `Invoke-RiskScore.ps1` produces a 0–100 risk score across: baseline operation risk, active freeze windows, sensitive licenses/groups, SoD conflicts, and dual-approval requirements
- Risk gates every Live-mode submission: low (<25) proceeds, medium (25–49) warns, high (50–79) requires explicit confirmation, critical (≥80 or blocked) is rejected

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
- Conditional Access Named Location policy blocks agent sign-ins outside the allowed CIDR (setup pending Entra P2 license)
- `Test-AgentPermissions.ps1` detects and optionally repairs permission drift

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
    │  IPC → execFileSync
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
| AI agents | Anthropic Claude API (claude-haiku-4-5 for suggestions, claude-sonnet-4-6 for approver) |
| Operations console | Electron 42, Node.js |
| HRIS integration | Azure Functions v4 (Node.js), Azure Storage Queue, Azure Table Storage |
| Audit export | Azure Blob Storage (SAS), Microsoft Sentinel (HTTP Data Collector API) |
| Scripting | PowerShell 5.1 |
| Local dev | Azurite (Azure Storage emulator) |

## Installation

Run `dist/JML Console Setup 1.0.0.exe`. No admin rights required; it installs per-user to `%LOCALAPPDATA%\Programs\JML Console\`.

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
cd agents/electron-app
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

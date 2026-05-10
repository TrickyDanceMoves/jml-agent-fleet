# Tech Stack

## Core Platform

| Layer | Technology |
|---|---|
| Identity platform | Microsoft Entra ID (Azure AD) |
| API | Microsoft Graph v1.0 + beta |
| Graph SDK | Microsoft.Graph.Users PowerShell v2.36.1 |
| Shell | PowerShell 5.1 (Windows) |
| Auth | App-only client credentials: cert-first, DPAPI secret fallback |

## AI Layer

| Component | Technology |
|---|---|
| AI model | Anthropic Claude (claude-sonnet-4-6) |
| SDK | @anthropic-ai/sdk ^0.94.0 |
| Approver runtime | Node.js 18, packaged via @yao-pkg/pkg |
| Approver binary | `JML-Approver.exe` (42.6 MB, node18-win-x64) |

## Frontend

| Component | Technology |
|---|---|
| Desktop GUI | Electron 42 |
| Renderer | HTML / CSS / Vanilla JS |
| IPC | Electron contextBridge + preload.js |

## Observability

| Sink | Detail |
|---|---|
| Hash-chained audit log | `agents/audit.jsonl`: SHA256 prevHash chain |
| Windows Event Log | Source: `JMLAgents`, EventIds 1001–1004 |
| Teams webhook | MessageCard to configurable webhook URL |
| Per-run logs | JSON + `.log` per agent run in each `logs/` directory |

## Security & Compliance

| Control | Technology |
|---|---|
| Insider risk | Microsoft Purview IRM (HR Connector) |
| HR data upload | `api.consumerdata.microsoft.com` client credentials |
| Audit chain verification | `shared/Verify-AuditLog.ps1` |
| Circuit breaker | Halts after 3 consecutive Graph failures |
| Retry | Exponential backoff on 429/503/504 |
| Credential expiry | 60-day warning via `Test-CredentialExpiry` |

## Provisioning Scripts

| Script | Purpose |
|---|---|
| `New-AgentCertificates.ps1` | Migrates all agents to NonExportable RSA-2048 cert auth |
| `Test-AgentPermissions.ps1` | Audits and optionally fixes permission drift |
| `New-AgentConditionalAccess.ps1` | IP-restricted CA policy (requires Workload ID Premium) |
| `New-PurviewHRConnector.ps1` | Provisions the Purview HR Connector app reg |
| `New-AuditorAgent.ps1` | Fully provisions the Auditor app reg |
| `Grant-GroupPermissions.ps1` | Grants Group.Read.All + GroupMember.ReadWrite.All |
| `Grant-LicensePermissions.ps1` | Grants LicenseAssignment.ReadWrite.All |
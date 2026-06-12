# Tech Stack

## Core Platform

| Layer | Technology |
|---|---|
| Identity platform | Microsoft Entra ID |
| API | Microsoft Graph v1.0 and selected beta endpoints |
| Graph SDK | Microsoft Graph PowerShell SDK plus REST |
| Shell | Windows PowerShell 5.1 compatible scripts |
| Authentication | Hybrid: Entra Agent ID FMI for reasoning agents; certificate-first app-only auth for write agents |

## AI Layer

| Component | Technology |
|---|---|
| Providers | Azure AI Foundry, Azure OpenAI, OpenAI, Anthropic, Ollama, and Qwen-compatible local runtimes |
| SDKs | `openai` and `@anthropic-ai/sdk` behind a provider adapter |
| Agent runtime | Node.js embedded in Electron through IPC |

## Frontend

| Component | Technology |
|---|---|
| Desktop GUI | Electron 42 |
| Renderer | HTML, CSS, and vanilla JavaScript |
| IPC | Electron `contextBridge` and preload APIs |

## Event Plane

| Component | Technology |
|---|---|
| HRIS API | Azure Functions v4 |
| Durable delivery | Azure Storage Queue |
| Event status | Azure Table Storage |
| Local development | Azurite |

## Observability

| Sink | Detail |
|---|---|
| Hash-chained audit log | `audit.jsonl` with SHA-256 `prevHash` and `hash` |
| Windows Event Log | Source `JMLAgents`, Event IDs 1001 through 1004 |
| Microsoft Sentinel | Optional custom-log ingestion |
| Azure Blob Storage | Optional durable audit export |
| Teams webhook | Configurable MessageCard notifications |
| AI run telemetry | Provider, model, latency, and token metadata |

## Security and Compliance

| Control | Technology |
|---|---|
| Agent governance | Microsoft Entra Agent ID for Approver and Auditor |
| Execution boundary | Least-privilege service principals for directory writes |
| Insider risk | Microsoft Purview HR connector path |
| Audit verification | `shared/Verify-AuditLog.ps1` |
| Circuit breaker | Halts after three consecutive Graph failures |
| Retry | Exponential backoff on 429, 503, and 504 |
| Credential expiry | 60-day warning through `Test-CredentialExpiry` |

## Provisioning Scripts

| Script | Purpose |
|---|---|
| `New-AgentIdentities.ps1` | Creates the Agent ID blueprint and agent identities |
| `Enable-AgentIdAuth.ps1` | Switches supported reasoning agents to FMI authentication |
| `New-AgentCertificates.ps1` | Creates NonExportable RSA-2048 execution certificates |
| `Test-AgentPermissions.ps1` | Audits and optionally fixes permission drift |
| `New-AgentConditionalAccess.ps1` | Creates the workload identity Conditional Access policy |
| `New-PurviewHRConnector.ps1` | Provisions the Purview HR connector app registration |
| `Grant-GroupPermissions.ps1` | Grants required group permissions |
| `Grant-LicensePermissions.ps1` | Grants required license permissions |

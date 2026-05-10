# Architecture

## System Overview

```mermaid
graph TB
    subgraph Local["Local Machine"]
        EL[Electron GUI\nJML Console]
        APEXE[JML-Approver.exe]
        PS[PowerShell Agent Scripts]
        SHARED[shared/Helpers.ps1\nAuth · Audit · Retry · Circuit Breaker]
        AUDIT[audit.jsonl\nSHA256 hash-chained]
    end

    subgraph Entra["Microsoft Entra ID"]
        J[Joiner App Reg]
        M[Mover App Reg]
        L[Leaver App Reg]
        E[Enroller App Reg]
        AP[Approver App Reg]
        AU[Auditor App Reg]
        PR[Provisioner App Reg\ndisabled at rest]
    end

    subgraph M365["Microsoft 365 / Azure"]
        GRAPH[Microsoft Graph API]
        TEAMS[Teams Webhook]
        EVTLOG[Windows Event Log]
        PURVIEW[Purview IRM\nHR Connector]
    end

    EL --> APEXE --> PS
    PS --> SHARED
    SHARED --> GRAPH
    GRAPH --> J & M & L & E & AP & AU & PR
    SHARED --> AUDIT
    SHARED --> TEAMS
    SHARED --> EVTLOG
    L -->|Step 6 termination record| PURVIEW
```

## Component Map

| Component | Path | Purpose |
|---|---|---|
| `Invoke-JoinerProcess.ps1` | `agents/joiner/` | Provisions new accounts |
| `Invoke-MoverProcess.ps1` | `agents/mover/` | Updates attributes on role change |
| `Invoke-LeaverProcess.ps1` | `agents/leaver/` | Full offboarding pipeline + Purview IRM |
| `Invoke-EnrollerProcess.ps1` | `agents/enroller/` | Device/compliance group enrollment |
| `approver.js` + `JML-Approver.exe` | `agents/approver/` | Approval agent with RBAC + dual-approval |
| `auditor.js` + `JML-Auditor.exe` | `agents/auditor/` | Audit log query interface |
| `shared/Helpers.ps1` | `agents/shared/` | Auth, audit, retry, circuit breaker, Teams |
| `electron-app/` | `agents/electron-app/` | Electron desktop console |
| `purview/config.json` | `agents/purview/` | Purview HR Connector credentials |

## Authentication Pattern

All agents use **app-only client credentials**: no interactive sign-in, no delegated permissions.

```
cert-first  → Connect-MgGraph -CertificateThumbprint <thumbprint>
fallback    → Connect-MgGraph -ClientSecretCredential (DPAPI-encrypted)
```
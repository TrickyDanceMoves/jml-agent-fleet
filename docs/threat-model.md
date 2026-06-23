# JML Agent Fleet — Threat Model

A STRIDE-informed threat model for an AI-governed identity lifecycle control plane
operating against Microsoft Entra ID. Scope: the agent fleet, the Electron operations
console, the Azure Functions API + queue worker, and the Microsoft Graph execution path.

## Assets

| Asset | Sensitivity | Notes |
|---|---|---|
| Agent credentials (certs / encrypted secrets) | Critical | Per-agent app registration auth material |
| Microsoft Graph permissions | Critical | Application permissions grant directory write |
| Hash-chained audit log (`audit.jsonl`) | High | Tamper-evident evidence of every operation |
| Operator authentication (PIN / Windows / Entra) | High | Gates Live-mode writes and approvals |
| HRIS webhook payloads | Medium | Drive autonomous joiner/mover/leaver actions |
| AI provider API keys (`ai-provider.json`) | High | Foundry / Azure OpenAI / OpenAI / Claude keys |
| Pending approval tokens | Medium | Authorize dual-control privileged actions |

## Trust boundaries

1. **Electron renderer ↔ main process** — renderer is untrusted UI; all privilege lives in main via IPC.
2. **Local machine ↔ Azure** — console and worker run locally; Graph/Functions/Storage are remote.
3. **HRIS ↔ webhook receiver** — external system; payloads are untrusted until validated + signature-checked.
4. **Operator ↔ control plane** — operator identity and role gate what may execute.
5. **AI model ↔ control plane** — the model proposes; it never holds direct authority.

## Threats and mitigations

| # | Threat (STRIDE) | Scenario | Mitigation | Status |
|---|---|---|---|---|
| T1 | Spoofing | Forged HRIS webhook triggers mass provisioning | HMAC-SHA256 signature verification (`BAMBOOHR_WEBHOOK_SECRET`); x-api-key fallback | ✅ |
| T2 | Tampering | Audit log edited to hide an action | SHA-256 hash chain + `Verify-AuditLog.ps1`; Windows Event Log + Sentinel secondary sinks; optional WORM (time-based immutability / legal hold) on the Azure Blob export so evidence cannot be altered or deleted until retention expires | ✅ |
| T3 | Repudiation | Operator denies authorizing a change | Operator identity stamped on every audit entry (UPN/role); ticket ref required for leavers | ✅ |
| T4 | Information disclosure | Secrets committed to the repo | `.gitignore` for config/secret files; CI secret-scan denylist | ✅ |
| T5 | Elevation of privilege | Helpdesk executes a hard leaver directly | Hard leavers from helpdesk route to admin approval queue; server-side role gate on approve | ✅ |
| T6 | Elevation of privilege | Renderer becomes a privileged Graph shell | contextIsolation + nodeIntegration:false; IPC sender + payload validation; see electron-security.md | ⚠️ partial (sandbox) |
| T7 | Denial of service / blast radius | Bulk termination wipes the directory | WhatIf default; risk scoring gates Live; circuit breaker halts after 3 consecutive Graph failures | ✅ |
| T8 | Prompt injection | Malicious input steers the agent to over-provision | Model has no direct authority — every write goes through risk score + policy + approval; SoD engine blocks conflicts | ✅ |
| T9 | Over-permissioning | An agent holds more Graph scope than its job needs | Per-agent least-privilege app permissions; `Test-AgentPermissions.ps1` detects drift | ✅ |
| T10 | Rogue / compromised agent | Agent identity is abused | **Quarantine Agent** kill switch: disable app reg + revoke creds + high-severity audit; Provisioner disabled at rest | ✅ |
| T11 | Credential theft | Long-lived secret exfiltrated | Cert-first auth; secret is DPAPI-encrypted fallback; expiry warnings 60 days out | ✅ (→ federated creds roadmap) |
| T12 | Model hallucination | Agent recommends a wrong/privileged assignment | Peer-prevalence threshold + confidence rating; never auto-recommends privileged groups; human confirms | ✅ |

## Fail-closed controls

The authoritative safety gate is **approval + risk scoring**, not PIM. Privileged
actions fail closed when:
- risk level is `critical` or `blocked` → execution rejected
- a freeze window is active → Live submit blocked
- an SoD conflict is detected → submit blocked
- dual approval is required but absent → execution held
- operator role is insufficient → server-side rejection

> **Note on PIM:** Entra PIM for Groups does not support service principals as
> eligible members, so JIT activation cannot gate app-only agents. JIT privilege
> is therefore enforced at the control plane (Provisioner disabled at rest;
> approval-gated, risk-scored, least-privilege execution). See
> `agent-identity-roadmap.md`.

## Residual risks (documented, not yet mitigated)

- Electron windows run with `sandbox: true` (preloads carry no Node deps; operator username resolved via main-process IPC). See electron-security.md.
- Operator RBAC supports local PIN, Windows session trust, and Entra device-code sign-in (all three implemented).
- Conditional Access for the agent workload identities requires Entra Workload Identities Premium (P2) — script present, not enabled.

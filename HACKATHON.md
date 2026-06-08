# Hackathon Submission Guide — Agents League / Microsoft AI Skills Fest

**Track:** Enterprise Agents  
**Deadline:** June 12, 2026 (registration) · June 14, 2026 (hacking closes)  
**Prize:** $6,468 — Best Enterprise Agent ($55,552 pool)  
**Format:** Virtual, global · public GitHub repo + 5-min demo video

---

## Submission Checklist

- [ ] Register at https://info.microsoft.com/Agents-League-Hackathon-Registration.html
- [ ] Activate profile on the contest platform
- [ ] Record 5-min demo video and upload to YouTube or Vimeo (unlisted is fine)
- [ ] Submit via contest website with:
  - [ ] Project name: **JML Agent Fleet**
  - [ ] Project description (copy from section below)
  - [ ] Demo video link
  - [ ] GitHub repo: `https://github.com/TrickyDanceMoves/jml-agent-fleet`
  - [ ] Architecture diagram: `docs/images/JML AI Agent Architecture.png`
  - [ ] Microsoft tools list (copy from section below)
  - [ ] Team member info

---

## Project Description (copy-paste for submission form)

**JML Agent Fleet** is an enterprise-grade AI agent system that automates the full identity lifecycle — Joiner, Mover, Leaver — across a Microsoft Entra ID tenant. It replaces fragmented manual IT workflows with auditable, policy-gated agent operations that run from a desktop operations console.

Seven agents (two AI-backed, five PowerShell) work together: an Approver agent handles human-in-the-loop provisioning decisions with live risk scoring, peer-group recommendations, and dual-approval gating; an Auditor agent runs UEBA behavioural analysis, drift detection, and Identity Protection scans on schedule. All operations flow through a hash-chained audit log that ingests into Microsoft Sentinel.

The AI layer is **provider-agnostic**: both agents run on any OpenAI-compatible backend — Azure AI Foundry, Azure OpenAI, OpenAI, Claude, or local Ollama — switchable from Settings without touching code or losing context. The recommended enterprise configuration uses Azure AI Foundry for model governance and deployment.

HRIS events (hire, transfer, termination) arrive via Azure Functions v4 webhooks, are validated against a canonical JSON Schema, and queued in Azure Storage Queue for the worker to dispatch to the appropriate agent. BambooHR is implemented; the webhook adapter pattern is extensible to any HRIS.

The operations console is an Electron desktop app with 14 tabs: fleet health, agent chat, access reviews, integrations, security findings, audit log, user lookup, Graph API runner, and more.

---

## Microsoft Technologies Used

| Technology | Where used |
|---|---|
| **Azure AI Foundry** | Recommended AI backend for Approver and Auditor agents; connects via OpenAI-compatible inference endpoint |
| **Microsoft Entra ID** | Identity platform; all provisioning, group, license, and PIM operations via Graph API |
| **Microsoft Graph API** | Core API for all user lifecycle operations (create, update, disable, license, group membership) |
| **Azure Functions v4** | HRIS webhook receiver and event API (`POST /api/jml`, `POST /api/webhooks/{source}`) |
| **Azure Storage Queue** | Durable event queue for HRIS-triggered identity operations with retry and dead-letter |
| **Azure Table Storage** | Event status tracking (queued → processing → completed) |
| **Azure Blob Storage** | Audit log export with SAS token authentication |
| **Microsoft Sentinel** | SIEM ingestion of audit log and security findings via HTTP Data Collector API (`JML_AuditLog_CL`, `JML_SecurityFindings_CL`) |
| **Microsoft Purview** | HR Connector integration for employee data ingestion |
| **Microsoft Identity Platform** | OAuth 2.0 client credentials flow for all agent app registrations |
| **GitHub Copilot** | Used throughout development for code generation and review |

---

## Demo Video Script (5 minutes)

### 0:00 – 0:40 · Problem statement
*Show the problem slide / case study intro*
- Identity ops live in the seams: HR tickets, IT approvals, manual group assignments
- Permissions accumulate silently — access drift is the default state
- Audit trails span four systems and a spreadsheet

### 0:40 – 1:30 · Architecture overview
*Show architecture diagram*
- 7 agents, zero-trust isolation, least-privilege Graph API permissions
- HRIS → Azure Functions → Storage Queue → PowerShell agents → Entra ID
- Everything written to a hash-chained audit log, shipped to Sentinel

### 1:30 – 2:45 · Live demo — Joiner flow
*Open JML Console → JML Fleet tab*
- "Onboard Sarah Chen, she's joining as a Senior Engineer in Platform"
- Watch Approver agent: peer recommendation (which licenses/groups 60% of Platform engineers have), risk score < 25 (low), confirm submit
- Switch to Audit Log — show the hash-chained entry with ticket ref and operator identity

### 2:45 – 3:30 · Live demo — Leaver flow
*Still in JML Fleet*
- "Mark Thompson is leaving today, ticket INC-1234"
- Risk score (leaver is always medium+), soft leaver: disable + revoke sessions
- Dual-approval gate fires — second operator must confirm before hard leaver

### 3:30 – 4:00 · Security tab
*Click Security tab*
- Live UEBA findings (after-hours ops, high-volume changes)
- Drift detection results (group membership changed outside the agent)
- Identity Protection risky user signals pulled from Microsoft

### 4:00 – 4:30 · AI Provider settings
*Click Settings → AI Provider*
- Show provider selector: Azure AI Foundry is the enterprise default
- Enter Foundry endpoint, model, click Test Connection → "connected · azure-foundry"
- Emphasise: swap provider without losing conversation history

### 4:30 – 5:00 · Close
- GitHub repo, case study link
- "Built on Microsoft Entra ID, Graph API, Azure Functions, Azure Storage, Sentinel, and Azure AI Foundry — the full Microsoft enterprise AI stack"

---

## Judging Criteria Mapping

| Criterion (20%) | How JML addresses it |
|---|---|
| Accuracy & Relevance | Enterprise Agents track — automates Microsoft 365 / Entra identity operations end-to-end |
| Reasoning & Multi-step Thinking | Approver runs multi-turn tool-call loops: peer recommendation → risk score → policy check → submit or reject |
| Creativity & Originality | First open-source IGA-class agent fleet on Microsoft's stack; provider-agnostic AI layer; hash-chained audit |
| User Experience & Presentation | Production Electron console with 14 tabs, docked panel, overlay mode, operator RBAC, PIN auth |
| Reliability & Safety | Dual approval, freeze windows, SoD policy, WHATIF mode, circuit breaker, exponential retry, tamper-evident audit |
| Community vote | — |

---

## Setup for Judges (30-second path)

1. Install: run `dist/JML Console Setup 1.0.0.exe` (per-user, no admin needed)
2. Open app → Settings → AI Provider → select **Azure AI Foundry** → paste endpoint + key → Save
3. Settings → Tenant Binding → run Setup Wizard (device-code sign-in, creates app registrations)
4. JML Fleet tab → start chatting with the Approver agent

No PowerShell pre-requisites for the console. Graph PowerShell SDK is only needed if running the PS1 scripts directly.

# JML Agent Fleet

AI-powered identity lifecycle automation for Microsoft Entra ID. Seven Claude-backed agents handle the full Joiner/Mover/Leaver (JML) workflow with zero-trust architecture, hash-chained audit logs, and Microsoft Purview IRM integration.

## Scope

Automates identity provisioning and deprovisioning across a Microsoft 365 / Entra ID tenant — replacing manual IT processes with auditable, policy-gated agent workflows.

| Agent | Role |
|---|---|
| **Joiner** | Provisions accounts, assigns licenses and groups |
| **Mover** | Updates attributes and memberships on role change |
| **Leaver** | Disables, revokes sessions, removes licenses/groups, files Purview IRM termination record |
| **Enroller** | Device enrollment and compliance group assignment |
| **Approver** | Human-in-the-loop approval gate with dual-approval for leavers |
| **Provisioner** | Manages app registrations (disabled at rest, enabled only during provisioning) |
| **Auditor** | Queries the hash-chained audit log |

## Documentation

- [Architecture](docs/architecture.md) — system diagram, component overview
- [Agent Fleet](docs/agents.md) — per-agent roles, permissions, scripts
- [Tech Stack](docs/stack.md) — tools, SDKs, services
- [Workflows](docs/workflows.md) — JML process flows with diagrams
- [Security](docs/security.md) — zero-trust controls, audit chain, known gaps
- [Purview IRM](docs/purview-irm.md) — insider risk integration

## Tenant

| Property | Value |
|---|---|
| Tenant ID | `YOUR-TENANT-ID-PLACEHOLDER-0000` |
| Domain | `contoso.onmicrosoft.com` |
| Agent dept tag | `AI Agents` |
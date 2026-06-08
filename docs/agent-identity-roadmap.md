# Agent Identity Roadmap — App Registrations → Microsoft Entra Agent ID

## Why this matters

The JML agents are **non-human identities** that authenticate app-only (certificate /
client-credentials) and act autonomously against Microsoft Graph. Today each agent is
a dedicated **app registration + service principal**. Microsoft's direction for AI agents
is **Microsoft Entra Agent ID** — a first-class identity type purpose-built to
authenticate, authorize, govern, and protect non-human AI agents. Microsoft's own
guidance is that for most AI agents, an agent identity is the right choice and that
plain service principals / user accounts are not recommended long-term.

## Current implementation vs. Entra-native target

| Concern | Current (this repo) | Entra Agent ID target |
|---|---|---|
| Identity primitive | App registration + service principal per agent | Entra Agent ID per agent |
| Credential | NonExportable RSA cert (DPAPI-encrypted secret fallback) | Platform-managed / federated credentials |
| Provisioning | `provisioner/New-*.ps1` scripts | Provisioned by Foundry Agent Service / Copilot Studio, or Agent ID blueprints |
| Authorization | Per-agent Graph application permissions (least privilege) | Agent-scoped permissions + governance policy |
| JIT privilege | Control-plane (Provisioner disabled at rest; approval-gated) | Agent-scoped PIM / governance as it matures for agent identities |
| Conditional Access | Script present (needs Workload Identities Premium / P2) | CA for agent identities |
| Ownership / lifecycle | Cert/secret expiry tracking | Owner, sponsor, expiry, access reviews native to Agent ID |
| Kill switch | Quarantine Agent (disable app reg + revoke creds + audit) | Disable agent identity + CA token-issuance block |

## What it takes to migrate the SPs to Agent IDs

Entra Agent ID is **not a property flag you toggle on an existing app registration**.
An agent identity is created when an agent is built/registered through a supporting
platform. So "turning the SPs into agent identities" is a re-homing of where the identity
is born, plus a governance wrap. Concretely:

### 1. Pick the issuing platform
- **Azure AI Foundry / Foundry Agent Service** — agents built here are auto-assigned an
  Entra Agent ID. Best fit for JML's Approver/Auditor reasoning agents.
- **Copilot Studio** — agents here also get Agent ID; best if you expose JML through a
  Microsoft 365 Copilot experience (see `../api/openapi.yaml` for the action surface).

### 2. Re-register each agent as a platform agent
For each operational agent (Joiner, Mover, Leaver, Enroller, Approver, Provisioner,
Auditor), recreate it as an agent in the chosen platform so it receives an Agent ID,
rather than hand-rolling an app registration. The JML PowerShell execution layer stays —
only the *identity it authenticates as* changes.

### 3. Re-grant least-privilege permissions to the new identities
Re-apply the existing per-agent Graph scopes (`Test-AgentPermissions.ps1` already encodes
the manifest) to the Agent ID principals, and admin-consent them.

### 4. Move credentials to federated / managed
Replace the NonExportable certs with **federated identity credentials** (no stored secret)
where the platform supports it — eliminating long-lived credential theft (threat T11).

### 5. Wrap with governance
- Assign each Agent ID a **human owner + business purpose + review date**.
- Bring agents into **access reviews** (the Certifier already runs campaigns; point them at
  Agent ID principals).
- Apply **Conditional Access for agent identities** (the `New-AgentConditionalAccess.ps1`
  named-location/IP policy generalizes here; requires P2).

### 6. Cut over and retire the app registrations
Run both in parallel (Agent ID + legacy app reg) behind the provider/config layer, validate
end-to-end, then disable and delete the legacy app registrations via the Provisioner.

## Verified facts (June 2026)

- **GA**: Microsoft Entra Agent ID is generally available and available to all Entra customers.
- **Graph endpoint**: `POST https://graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentity`
  with `displayName`, an agent identity blueprint, and a sponsor reference.
- **Permission**: `AgentIdentity.Create.All` (or `AgentIdentity.CreateAsManager`).
- **No in-place conversion**: agent identities are a distinct service-principal subtype;
  you create new ones and decommission the old app registrations.
- **This tenant**: licensed for the governance add-ons (Entra P1/P2, ID Governance, Entra
  Suite). A read-scope probe of the Agent ID endpoints returned BadRequest — i.e. the
  `AgentIdentity` permission + admin consent are needed to exercise the surface; creation
  must be done by an admin.

## Create them — CONFIRMED working in this tenant (2026-06-08)

`provisioner/New-AgentIdentities.ps1` created all six JML Agent IDs successfully.
The full live creation contract, reverse-engineered against the tenant:

1. **Consent** (admin device-code): `AgentIdentity.Create.All`, `AgentIdentityBlueprint.Create`,
   `Application.ReadWrite.All`, `User.Read.All`. Signed-in admin needs the **Agent ID Administrator** role.
2. **Create the Agent Application blueprint** —
   `POST /v1.0/applications/microsoft.graph.agentIdentityBlueprint`
   ```json
   { "displayName": "...", "sponsors@odata.bind": ["…/users/{id}"], "owners@odata.bind": ["…/users/{id}"] }
   ```
   Use the response **`appId`** (not `id`) as the blueprint id.
3. **Instantiate the blueprint's service principal** (the "Agent Blueprint Principal") —
   `POST /v1.0/servicePrincipals` with `{ "appId": "<blueprintAppId>" }`, then allow ~15s replication.
4. **Create each agent identity** —
   `POST /v1.0/servicePrincipals/microsoft.graph.agentIdentity`
   ```json
   { "displayName": "...", "agentIdentityBlueprintId": "<blueprintAppId>", "sponsors@odata.bind": ["…/users/{id}"] }
   ```
   A sponsor is **required** and must be bound via `sponsors@odata.bind` (the plain `sponsors`
   property is rejected).

```powershell
.\provisioner\New-AgentIdentities.ps1 -WhatIf
.\provisioner\New-AgentIdentities.ps1 -SponsorUpn admin@contoso.onmicrosoft.com
```

Gotchas learned the hard way: PIM-for-Groups can't gate these (SP limitation — see
[[jml-pim-limitation]]); em-dashes break PS 5.1 parsing; PS 5.1 collapses single-element
JSON arrays (build the `@odata.bind` body by hand); each run mints a **new** blueprint app,
so delete orphan "JML Agent Fleet Blueprint" registrations from failed runs.

## Decision: are Agent IDs better than the current app-reg SPs?

| Dimension | App registration + SP (today) | Entra Agent ID |
|---|---|---|
| First-class agent semantics | No — generic app identity | Yes — purpose-built non-human AI identity |
| Ownership / sponsor / review | Manual (cert expiry tracking only) | Native owner + sponsor + lifecycle |
| Conditional Access / risk | Needs **Workload Identities Premium** (tenant lacks it) | Governed via Entra ID P1/P2 (tenant HAS it) |
| Access reviews | Possible but not agent-aware | Agent-aware reviews |
| Credentials | Cert / DPAPI secret | Platform-managed / federated (no stored secret) |
| Provisioning | Hand-rolled scripts | Graph API + blueprint |
| Maturity / risk | Battle-tested, fully working today | GA but new; rollout/schema still settling |
| Effort to adopt | None (in place) | Create new + re-grant scopes + re-point code + retire old |

**Recommendation:** Agent ID is the strategically correct target — it gives agent-aware
governance using licenses this tenant already owns, and (notably) lets Conditional Access
apply *without* the Workload Identities Premium SKU the SP model would require. But it is a
net-new build with a settling rollout. The pragmatic plan for the submission: keep the
working app-reg fleet, **demonstrate Agent ID creation with `New-AgentIdentities.ps1`** as
the forward architecture, and migrate per the 6 steps above once validated in-tenant.

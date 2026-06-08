# Wiring JML into Microsoft 365 Copilot / Copilot Studio

The JML control plane exposes a governed action surface ([`../api/openapi.yaml`](../api/openapi.yaml))
that a Copilot Studio agent can call. Copilot captures the *intent* ("onboard Sarah in
Platform Engineering"); JML performs risk scoring, policy checks, human approval,
just-in-time privilege, audited Graph execution, and Sentinel evidence. **The model
proposes; policy and approval decide what executes.**

## Artifacts in this repo

| File | Purpose |
|---|---|
| `api/openapi.yaml` | OpenAPI 3.0 definition of the JML API (the action surface) |
| `api/apiProperties.json` | Power Platform custom-connector properties: API-key connection + header-injection policy |

## Option A — Custom connector (Power Platform / Copilot Studio)

1. Deploy the JML API to Azure Functions and note its base URL
   (`https://<app>.azurewebsites.net/api`).
2. In **Power Platform admin** → **Custom connectors** → **New** → **Import an OpenAPI file**,
   upload `api/openapi.yaml`.
3. On the **Security** tab choose **API Key**, header name `x-api-key`
   (this matches `apiProperties.json`).
4. Create a connection, pasting the `JML_API_KEY` value for the environment.
5. In **Copilot Studio**, open your agent → **Actions** → **Add an action** →
   select the JML custom connector → expose `submitLifecycleEvent` and
   `getEventStatus`.

## Option B — Direct action from OpenAPI (Copilot Studio)

In Copilot Studio → agent → **Actions** → **New action** → **Connector** /
**REST API**, point at the deployed base URL and import `openapi.yaml`. Configure
API-key auth with header `x-api-key`.

## Suggested agent instructions (Copilot side)

> You help IT operators run identity lifecycle requests. When the user describes a
> hire, transfer, or termination, call `submitLifecycleEvent` with the canonical
> fields. Always echo the returned `eventId` and tell the user the request was
> submitted to the JML control plane for risk scoring and approval — you do not
> execute changes directly. Use `getEventStatus` to report progress when asked.
> Terminations require a ticket reference; ask for one before submitting.

## Demo flow

Copilot request → `POST /api/jml` → JML risk score + policy + approval →
Microsoft Graph execution → hash-chained audit + Sentinel evidence. Show the
returned `eventId`, then the Approvals tab and the audit entry in the JML Console.

## Security notes

- The API key is the coarse gate; per-operation authority still flows through JML's
  risk scoring, SoD engine, freeze windows, and human approval — Copilot cannot
  bypass those.
- For production, prefer Entra ID (OAuth) auth on the connector over a static API
  key; the OpenAPI `securitySchemes` can be extended accordingly.

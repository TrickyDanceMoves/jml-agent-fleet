# OneDrive Shared State, Mobile Access, and Optional Glass Design

Date: 2026-06-10

## Goal

Make the OneDrive checkout the canonical JML library so work can continue across a PC, desktop, and phone without containers or an external database. Durable application state must synchronize through OneDrive, concurrent Windows devices must not overwrite or duplicate work, and a phone browser must receive full authorized functionality through an online capable Windows host.

This work also makes the optional Glass theme brighter and more transparent and makes agent replies more natural.

## Product Decisions

- The OneDrive project is the only durable source of truth.
- Warm remains the default theme. Preview remains available. Glass is opt-in.
- Multiple Windows devices may run JML simultaneously.
- A phone uses a responsive browser interface; there is no native mobile port.
- Remote access uses Tailscale HTTPS. JML does not expose public internet ports.
- Any capable online Windows host may serve the phone.
- Live mutations are serialized through one short-lived execution lease.
- When no host is online, the phone may queue action drafts.
- Queued drafts are never pre-authorized. A host must revalidate and obtain fresh authorization before execution.
- Secrets and reusable authentication material never enter OneDrive.

## Architecture

### Shared State Library

Add a runtime state root under `agents/runtime-state/`. This directory is OneDrive-synchronized but gitignored.

The library contains:

```text
runtime-state/
  schema.json
  devices/<device-id>.json
  heartbeats/<device-id>.json
  journals/<device-id>/<yyyy-mm>/<event-id>.json
  snapshots/<snapshot-id>.json
  leases/execution.json
  attachments/<content-hash>/<filename>
```

Each state change is an immutable event stored in the writing device's journal. A device never appends to or rewrites another device's file. Using one event per file avoids shared-file append corruption and makes OneDrive conflict copies recoverable.

An event includes:

```json
{
  "schemaVersion": 1,
  "eventId": "<device-id>:<monotonic-sequence>:<uuid>",
  "deviceId": "<stable-device-id>",
  "operatorId": "<operator-name>",
  "occurredAt": "<ISO-8601 UTC>",
  "aggregateType": "conversation",
  "aggregateId": "approver:<conversation-id>",
  "eventType": "conversation.message.added",
  "causationId": null,
  "idempotencyKey": null,
  "payload": {}
}
```

Ordering uses aggregate-local causal metadata where present, then UTC timestamp, device ID, sequence, and event ID as deterministic tie-breakers. Events are never silently discarded.

Snapshots are derived caches. They contain the source event watermark used to build them and can always be deleted and rebuilt from journals.

### State Covered

The shared library stores:

- Approver and Auditor conversations, including tool-result summaries
- Security finding status, assignment, acknowledgement, notes, and resolution
- Approval requests and decisions
- Scheduled operations and offline queued drafts
- Operation status and execution receipts
- Audit metadata and report references
- Theme and non-secret appearance settings
- Dashboard layout and visibility settings
- Graph query history and other non-secret recents
- Operator roster and role configuration
- Notification, policy, and integration configuration that contains no secret values
- Generated reports and attachments

Device-local state remains local:

- Window bounds, monitor placement, and transient panel geometry
- Electron and browser caches
- Active UI focus, open modal, and in-progress unsaved text
- Active login sessions

### Secret Boundary

The following must never be written to `runtime-state/`, renderer local storage intended for synchronization, logs, queued drafts, or browser responses:

- API keys and provider secrets
- Passwords and PIN values
- PIN hashes
- OAuth access, refresh, or device-code tokens
- Private certificate material
- Windows credentials
- Reusable write tokens

Each Windows host loads secrets from its existing protected local configuration or Windows credential facilities. Host capability publication exposes only booleans such as `canRunApprover`, `canRunAuditor`, and `canMutateTenant`.

## Concurrent Hosts

### Heartbeats and Capabilities

Each running host writes a heartbeat approximately every 15 seconds containing:

- Device ID and friendly name
- Tailscale hostname or approved address
- JML version and state schema version
- Last heartbeat time
- Available agents and execution capabilities
- Readiness status

A host is healthy while its heartbeat is recent. Stale heartbeats are ignored.

### Execution Lease

Only the execution lease holder may begin a Live mutation. The lease has:

- Holder device ID
- Lease epoch
- Acquired and expiry timestamps
- Random fencing token

The lease is short and renewable. Before every irreversible step, the host verifies that it still owns the current fencing token. Losing the lease stops new work and prevents stale-host completion from being accepted.

Because OneDrive is not a transactional lock service, lease safety is reinforced by operation idempotency:

- Every queued or immediate operation has a stable idempotency key.
- `operation.claimed`, `operation.started`, and `operation.completed` events are recorded.
- A host checks merged state before execution.
- Duplicate claims are resolved deterministically.
- Agent scripts receive the operation ID where practical and must not repeat an already recorded completed operation.

Read operations and chat may run on any healthy capable host. Live mutations require the lease holder and normal RBAC authorization.

## Mobile Web Interface

### Host Service

Extract shared renderer-independent application services from Electron IPC handlers. Electron IPC and an embedded HTTPS API call the same service functions.

Each capable host serves:

- A responsive web shell based on the existing JML renderer
- Authenticated JSON endpoints for reads and commands
- Server-sent events or WebSocket updates for conversation streaming and state changes
- Health and capability metadata

The service binds only to loopback and the approved Tailscale interface. It must not bind to an unrestricted public interface by default.

### Host Discovery and Failover

The approved host registry is stored in the OneDrive state library. The phone reads it through delegated Microsoft Graph access and keeps a local cache of approved Tailscale JML host URLs. On load it:

1. Probes hosts concurrently.
2. Rejects hosts with incompatible schema or app versions.
3. Prefers the healthy execution lease holder.
4. Uses another capable host for reads or chat if the holder is unavailable.
5. Reconnects and reloads merged OneDrive state after failover.

The UI always shows the connected host, sync freshness, capability status, and whether Live execution is currently available.

### Authentication and Authorization

- Operator authentication is required before application data is returned.
- Sessions are short-lived, device-bound, revocable, and stored only on the serving host and client.
- RBAC is enforced in the host service, not only in the renderer.
- Viewer, Helpdesk, and Admin behavior matches the Electron application.
- Live writes require fresh step-up authorization using the configured operator PIN or Windows-backed authorization.
- No PIN or reusable authorization token is stored in OneDrive.
- Remote authentication attempts and privileged commands generate shared audit events without recording secrets.

## Offline Queue

If no capable host is reachable, the phone creates an offline action draft directly in the OneDrive library through the Microsoft Graph OneDrive API. The mobile web client uses delegated Microsoft identity authentication and requests the narrowest practical file scope for the JML state library. Tokens remain in the phone's protected browser session and are never written into the shared state.

A queued draft contains intent and non-secret inputs only. It has status `draft-awaiting-host`.

When a host returns:

1. It validates schema and required fields.
2. It checks the operator still exists and has the required role.
3. It reloads current tenant state.
4. It reruns policy, risk, freeze-window, and conflict checks.
5. It presents any changed impact to the operator.
6. It requests fresh step-up authorization.
7. It creates an executable operation with a stable idempotency key.

Draft expiry and cancellation are explicit events.

## Optional Glass Theme

Warm remains the default when no valid saved theme exists. Theme choices remain:

- Warm: original solid dark appearance
- Preview: purple/blue palette
- Glass: brighter frosted surfaces

Move Glass appearance values into shared theme tokens used by the main console, docked panel, overlay, and mobile shell. Compared with the current Glass theme:

- Reduce dark surface opacity substantially.
- Allow more of the Windows backdrop or mobile background to show through.
- Keep stronger opacity behind text fields, menus, destructive actions, and dense tables.
- Retain visible borders and focus rings.
- Maintain readable text contrast and a solid fallback when backdrop filtering is unavailable.
- Do not make assistant message cards permanently Glass-specific unless their theme tokens preserve readability in all palettes.
- Preserve the existing JML concentric rounded-square logo silhouette, dimensions, and collapsed-sidebar behavior. In Glass only, restyle its layers with translucent cyan, ice-blue, and violet gradients, a fine highlight border, and a restrained ambient glow. Make the recessed dark-blue middle layer mostly transparent so the backdrop remains visible through the mark. Warm and Preview keep their existing logo treatments.

Theme preference becomes a shared non-secret setting, while each device may temporarily override it for the current session.

## Natural Agent Responses

Update Approver and Auditor system prompts and response rendering with these rules:

- Start with the answer or result, not a persona introduction.
- Do not use labels such as "calm gatekeeper" or "forensic analyst."
- Avoid repeating the agent name when the UI already identifies the speaker.
- Avoid canned headings for simple answers.
- Use concise conversational prose for ordinary chat.
- Ask one clear question when required information is missing.
- State important risk, authorization, and execution-mode details plainly.
- Use structured cards only for operations, approvals, findings, plans, or multi-field results.
- Never invent tool calls, timings, evidence, or execution outcomes.
- Preserve exact identifiers and actionable error details when they matter.

Introduce a provider-independent response-policy module responsible for prompt guidance and conservative cleanup of known presentation artifacts. It must not rewrite substantive model content or hide safety and authorization information.

## Migration

On first startup after the feature is enabled:

1. Create or load a stable device ID.
2. Initialize the state schema.
3. Import eligible project runtime files into events without deleting originals.
4. Import eligible renderer local-storage preferences.
5. Import current in-memory conversations only for the active process; future messages persist immediately.
6. Mark migration completion per device.

Existing secret-bearing files remain in place and are never copied wholesale.

The feature is gated by a state schema version and supports read-only startup if a newer incompatible schema is detected.

## Failure Handling

- Partial event files are written to a temporary device-local path, then atomically renamed into the journal.
- Invalid or corrupt events are quarantined and surfaced in Settings with their path and validation error.
- OneDrive conflict copies are scanned and merged if they contain valid unique events.
- If OneDrive is unavailable, local events queue in a device-local outbox and sync when the runtime-state root returns.
- A host with stale state may serve cached reads with a visible warning but cannot execute Live mutations.
- Lease uncertainty disables new Live execution.
- Mobile host loss preserves unsent form content locally and reconnects without duplicating submitted commands.
- If delegated OneDrive access is unavailable or expired while all hosts are offline, the phone clearly reports that the draft is local-only and does not claim it has been queued until the OneDrive write succeeds.

## Testing

### Unit Tests

- Event schema validation and secret-field rejection
- Deterministic event merge and conflict-copy recovery
- Snapshot rebuild equivalence
- Aggregate reducers for conversations, assignments, approvals, and operations
- Lease expiry, fencing, and duplicate-claim resolution
- Idempotency behavior
- RBAC and step-up authorization enforcement
- Response-policy behavior
- Theme token defaults and Glass opt-in behavior

### Integration Tests

- Two simulated devices write concurrent events and converge
- Host failover during reads, chat streaming, and before mutation start
- Lease loss blocks stale-host mutation
- Offline draft revalidation and authorization
- Delegated mobile OneDrive writes are restricted to valid draft events and cannot alter host leases, receipts, or completed operations
- Electron IPC and web API produce equivalent service results
- Secrets never appear in shared state or API payloads
- Migration from existing files and local storage

### UI Verification

- Warm is the default on a clean profile
- Glass is visibly lighter and remains optional
- Main, docked, overlay, and responsive mobile views match the selected theme
- Text, menus, tables, and controls remain readable
- Agent replies flow naturally without persona banners or fabricated telemetry
- Mobile login, host status, queued drafts, approvals, and Live step-up flows work at phone breakpoints

## Delivery Sequence

1. Build and test the state event library and reducers.
2. Persist conversations and shared non-secret preferences.
3. Migrate operational runtime files into aggregate services.
4. Add heartbeat, capability, lease, fencing, and idempotency behavior.
5. Extract service functions from Electron IPC.
6. Add the Tailscale-bound web host and responsive client.
7. Add authentication, RBAC, and Live step-up enforcement.
8. Add delegated Microsoft Graph OneDrive access for host discovery and durable offline drafts.
9. Brighten optional Glass across all clients.
10. Apply and test natural-response policy.
11. Run multi-device, failover, security, and visual verification.

## Explicit Non-Goals

- Containers
- An external database
- A public unauthenticated JML endpoint
- A native phone application
- Synchronizing secrets through OneDrive
- Allowing offline drafts to bypass later policy checks or authorization

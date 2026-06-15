# Demo Safety and Hackathon Captures Design

Date: June 14, 2026

## Goal

Make the seeded JML demo incapable of performing real tenant or infrastructure
writes, correct hackathon-facing contradictions, and produce a consistent
submission screenshot set in Warm, Glass, docked, and overlay modes.

## Safety Boundary

`--demo` and `--demo-drive` are presentation modes. In either mode:

- PowerShell agent execution is denied before a child process can start.
- Lifecycle submit tools return simulated operation receipts.
- Approval, rejection, bulk import, certification, quarantine, exports,
  schedules, policy, operator, provider, and tenant configuration mutations do
  not touch production files or services.
- Demo authentication never mints a production-capable write token.
- Simulated mutations update only process memory and renderer fixtures.
- Every simulated result is labeled `demo: true` and `committed: false`.

Read-only renderer behavior remains available from the seeded in-memory data.
Normal application mode retains its existing execution behavior.

## Documentation Corrections

Hackathon-facing documentation will:

- State that the Enterprise Agents requirement is satisfied by Foundry IQ.
- Use one consistent fleet count and distinguish reasoning, execution, control,
  and certification identities.
- Remove obsolete acrylic guidance from the Glass theme instructions.
- Distinguish the completed 90-second video from the pending five-minute video.
- Record the current automated test count.
- Reconcile the OneDrive/Git workflow so dirty work is never destroyed.

## Capture Set

Full-resolution PNGs will be written to `docs/images/hackathon/`:

- Warm Dashboard
- Warm Approver
- Warm Glass Screen
- Warm Audit
- Glass Dashboard
- Glass Approver
- Glass Glass Screen
- Glass Audit
- Docked panel expanded
- Docked panel slim
- Overlay idle
- Overlay active

Every capture uses synthetic `contoso.onmicrosoft.com` identities and the seeded
demo fixture. No real tenant identifier or credential may appear.

## Acceptance Criteria

1. Automated tests prove demo mode cannot execute lifecycle tools or mint a
   production write token.
2. Automated tests prove normal mode retains its current execution path.
3. All repository Electron tests pass.
4. The screenshot set exists at full resolution and is visually reviewed.
5. A repository scan finds no real tenant identifiers in the new screenshots or
   their supporting capture metadata.


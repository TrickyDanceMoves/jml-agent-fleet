# Glass Screen Command Center Design

## Status

Approved by the user on June 10, 2026.

Implementation owner: Claude Code in the user's local terminal.

Design and acceptance reviewer: Codex.

## Objective

Completely replace the current Glass Screen replay page with a live-first Command Center. The page must make an in-flight JML action immediately understandable, preserve compact context for recent runs, and reveal audit evidence only when requested.

The result is a live operational surface with replay support, not an audit log with an animation above it.

## Current Experience Critique

The existing page has five material problems:

1. The full-width Audit Trail is the strongest visual object, so historical records compete with the live action.
2. The small traveler moving along an evenly spaced rail is decorative. It does not communicate elapsed time, ownership, current work, blocking conditions, or the next consequential action.
3. Every run is represented by the same generic sequence even when the actual lifecycle, failure point, or approval state differs.
4. The page makes users select historical records before it becomes useful. It does not automatically foreground an active operation.
5. Motion is timer-driven replay. It is disconnected from backend state changes and therefore cannot be trusted as an operational signal.

The overhaul must remove these weaknesses rather than restyle the existing rail.

## Product Posture

Use the approved **Live Plus Replay** model:

- An active operation always owns the page.
- The most recent completed operation is shown when nothing is active.
- Three recent runs provide lightweight context.
- Historical replay remains available through the recent-run rows.
- Full audit evidence is moved into an on-demand details drawer.

## Information Hierarchy

### Page Header

Use the title `Glass Screen` with the subtitle `live identity operations`.

The header may contain:

- Connection state
- Reduced-motion-aware replay control when a historical run is selected
- A details toggle

Do not place primary operational status in the header. The hero owns that information.

### Active Operation Hero

The hero is the primary surface and must include:

- State eyebrow: `LIVE OPERATION`, `ACTION FAILED`, `AWAITING APPROVAL`, `COMPLETED`, or `FLEET READY`
- Human-readable action and subject
- Agent
- Operator
- Safe or Live mode
- Ticket reference when present
- Elapsed time
- Current stage
- Plain-language current activity
- Outcome or required intervention

Example:

```text
LIVE OPERATION
Provisioning Tapiwa Ngungu
JOINER · NICK · LIVE · INC-1042                 01:18

Request   Risk   Execute   Verify   Complete
                  active

Authenticating to Microsoft Graph              IN PROGRESS
```

Do not expose raw PowerShell, Graph, certificate, or stack-trace output in the hero.

### Pipeline

Use five stable lifecycle stages:

1. Request
2. Risk
3. Execute
4. Verify
5. Complete

Stage state is one of:

- pending
- active
- succeeded
- partial
- failed
- awaiting-approval

The pipeline must be derived from operation status, not from a fixed replay timer.

For historical records that lack granular stage events, infer a completed path conservatively and label the view as a replay. Do not present inferred timing as live timing.

### Current Decision

Below the pipeline, show one concise sentence describing the current consequential activity.

Examples:

- `Validating manager and group assignments`
- `Authenticating to Microsoft Graph`
- `Creating the Entra identity`
- `Waiting for a second approver`
- `Verifying account and group membership`
- `Graph certificate authentication failed`

This text must come from a centralized formatter, not raw tool names scattered through rendering code.

### Failure and Partial States

Failure stops progress at the actual failing stage.

The failure surface must:

- State what failed in plain language
- State whether any tenant change was committed
- Show one relevant recovery action
- Keep raw errors in the details drawer
- Never display a completion checkmark

Partial outcomes use amber, identify completed work, and name the remaining follow-up.

### Idle State

When no operation is in flight:

- Show `FLEET READY`
- State that live actions will appear automatically
- Show the last completed operation
- Keep the three compact recent runs below
- Do not animate continuously

## Recent Run Context

Replace the Audit Trail table with a maximum of three compact rows.

Each row contains only:

- Outcome indicator
- Action and subject
- Relative timestamp
- Agent
- Safe or Live mode

Clicking a row:

- Selects the historical operation
- Changes the hero into replay mode
- Enables a deliberate Replay action
- Does not open the full audit log automatically

Provide a small `View all in Audit Log` link after the three rows.

## Details Drawer

The collapsed drawer is the only place for technical depth.

It may contain:

- Stage timestamps
- Tool calls and receipts
- Structured error details
- Rollback information
- Audit hash
- Operator and approval evidence
- Links to the related Operations, Approvals, Security, User, or Audit Log view

The drawer must preserve structured formatting and line wrapping. It must not dump unbounded raw output into the page.

## Motion System

Motion communicates state change only.

### Stage Advance

- Connector progress: 350ms ease-out (demo-tuned 2026-06-12; was 400ms)
- New stage activation: 250ms color and scale settle
- Completed stage check: 180ms opacity/scale settle
- No bounce
- No perpetual glow animation

### Active Stage

Use a restrained static halo. A single soft entrance pulse is allowed when the backend advances to the stage.

Do not use an endlessly pulsing orb.

### Failure

- Stop all progress immediately
- Apply one restrained red pulse no longer than 300ms
- Hold the failed state statically
- Reveal the recovery line after the failure settles

### Completion

- Complete the final connector
- Resolve the final stage to success or partial
- Use one subtle confirmation sweep
- Do not use confetti or celebratory looping

### Historical Replay

Replay is deliberate and may sequence known stages.

- Default stage interval: 750ms (demo-tuned 2026-06-12 per Codex review; was 650ms)
- Transition duration: 350ms
- Pause at failure or approval state
- Replay button changes to `Replay again` after completion

### Reduced Motion

Honor `prefers-reduced-motion: reduce`.

Reduced-motion mode:

- Updates all state immediately
- Removes connector travel
- Removes scale pulses and sweeps
- Retains labels, color, icons, and status text

## Visual System

- Continue using the approved Uniform Dark Frost Glass material.
- The hero is one clear frosted panel, not nested dark slabs.
- Non-text gutters remain transparent.
- Recent runs are flat rows with a subtle hover backing.
- The details drawer uses the same material family.
- Use near-white primary text, readable secondary text, and no body text shadow.
- Preserve semantic colors: green success, amber partial/approval, red failure, violet active, cyan verified/informational.
- Avoid large empty black regions when no operation is active.

## Data and State Contract

Use the existing `operation-status` and `operation-statuses` IPC channels as the authoritative live-operation source.

The renderer must maintain:

- `activeOperation`: newest operation with status `running` or `awaiting-approval`
- `selectedOperation`: active operation unless the user explicitly selects history
- `recentOperations`: latest terminal operations, capped for display
- `viewMode`: `live`, `replay`, or `idle`

Live operation updates take priority over a selected historical replay. When a new live operation arrives, the interface returns to live mode and foregrounds it.

Audit data may enrich evidence and historical replay, but it must not override fresher operation-status data.

## Component Boundaries

Keep the implementation understandable:

- Operation view-model formatter
- Pipeline-state mapper
- Command Center renderer
- Recent-run renderer
- Details-drawer renderer
- Motion controller

Do not add more unrelated behavior to the existing general-purpose renderer functions.

Pure mapping and formatting functions should live in a testable module under `electron-app/lib/` or `electron-app/renderer/`.

## Acceptance Scenarios

### Live Success

An operation-status event with `status: running` immediately appears in the hero. Subsequent status updates advance the pipeline. Success reaches Complete and moves the operation into recent runs.

### Live Failure

A failed Joiner operation stops on Execute, shows `Graph certificate authentication failed`, states that the account was not created, and offers a credential recovery path. No success checkmark appears.

### Awaiting Approval

The pipeline pauses at Risk or Execute according to the operation stage, uses amber status, and links to Approvals.

### Partial Outcome

Completed work and remaining follow-up are both visible. The operation is not styled as fully successful.

### Idle

No active operation produces the Fleet Ready state without looping animation. Last completed and three recent runs remain available.

### Replay

Selecting a recent run changes to replay mode. Replay animates only known historical states and never masquerades as live execution.

### Accessibility

Keyboard focus reaches recent rows, Replay, details drawer, and recovery actions. Reduced-motion mode has no travel or pulse animation. Status is never communicated by color alone.

## Tests

Add focused tests for:

- Active-operation precedence
- Stage mapping for running, awaiting approval, success, partial, and failed outcomes
- Failure never maps to Complete
- Human-readable current-action formatting
- Recent runs limited to three
- Live operation interrupts replay selection
- Reduced-motion CSS contract
- Audit Trail table removed from Glass Screen markup
- Details drawer collapsed by default

Run:

```powershell
npm test
node --check main.js
node --check renderer/app.js
git diff --check
```

## Runtime Review Gate

Claude must not push the implementation before Codex reviews:

1. Idle state
2. Live running state
3. Awaiting approval state
4. Failed state
5. Partial state
6. Successful completion
7. Historical replay
8. Reduced-motion behavior
9. Narrow-window layout

Codex will request corrections when hierarchy, motion, readability, or operational truth diverges from this specification.


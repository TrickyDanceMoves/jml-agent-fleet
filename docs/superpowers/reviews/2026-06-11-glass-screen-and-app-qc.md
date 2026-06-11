# Glass Screen and App Runtime QC

Date: June 11, 2026

Reviewer: Codex

Implementation owner: Claude Code

## Verdict

The Command Center architecture is sound and the restrained motion system is a good
base. The current build is not ready for final acceptance because several surfaces can
show contradictory outcomes for the same action or credential. Replay also animates
progress without changing its explanation, so it does not yet communicate causality.

No Figma pass is required before the next build. The main gaps are runtime state,
information hierarchy, and motion behavior rather than missing static layout concepts.

## What Works

- Five stable lifecycle stages are easy to scan.
- Active, approval, failure, partial, success, replay, and reduced-motion states render.
- Motion is one-shot and restrained. There are no distracting infinite loops.
- Failure stops before Verify and Complete.
- Recent runs are substantially calmer than the old Audit Trail.
- Technical details are collapsed and bounded in Glass Screen.
- Narrow layout remains usable at 900 x 760.
- The overall dark-frost visual language is consistent across the console.

## P0: Operational Truth

### 1. A run can look successful and failed at the same time

The Approver capture says `Soft leaver complete` while the lifecycle rail contains a
certificate-authentication failure. The rail is using authoritative operation status,
but the chat copy can still claim success.

Required behavior:

- A terminal `operation-status` result is authoritative.
- Render an explicit outcome receipt after every lifecycle submit.
- If status is failed, no nearby assistant copy may retain a success treatment.
- The receipt must state whether a tenant change was committed.
- Keep the model's prose as explanation, not as the source of outcome truth.

Relevant code:

- `electron-app/main.js`: lifecycle operation creation and classification near
  `runAgentLoop`
- `electron-app/renderer/app.js`: `lcApplyOperation`
- `electron-app/main.js`: Approver capture fixture near `TAB_INJECT.approver`

### 2. Certificate health contradicts itself

In the same runtime capture:

- Dashboard summary says all agent certificates are healthy.
- Dashboard Joiner tile says credential expired.
- Agent Certificates says Joiner is healthy with 727 days remaining.

Required behavior:

- One certificate-health selector must feed Dashboard, Security, Agent Certificates,
  notifications, and Glass recovery.
- Aggregate cards must derive from the same records as agent tiles.
- Capture fixtures must also use one shared fixture object so visual QC catches real
  consistency regressions.

### 3. The OneDrive sync command can destroy work

`sync.cmd` fetches and runs `git reset --hard origin/main`. On a multi-device OneDrive
workflow this can erase uncommitted work from Claude, Codex, or the user.

Required behavior:

- Replace hard reset with a guarded sync that aborts when the worktree is dirty.
- Prefer commit, pull with rebase, then push.
- Detect an already-running JML process before updating app files.
- Never use OneDrive file synchronization as a replacement for Git conflict handling.

## P1: Glass Screen

### 4. Replay animates dots, not the story

`runReplay()` changes only pipeline stage state. The eyebrow, decision sentence,
recovery text, and elapsed context remain at the final outcome during the sequence.
For example, Request can be active while the page says the run completed with
follow-ups remaining.

Required behavior:

- Each replay frame updates a short stage narration:
  - Request: `Request captured from Nick`
  - Risk: `Risk evaluated; no blocking policy`
  - Execute: `Creating the Entra identity`
  - Verify: `Checking account and group membership`
  - Complete: final verified, partial, or failed outcome
- Label inferred history as `RECORDED REPLAY`, not live execution.
- Add a compact `Step 3 of 5` indicator.
- Pause at approval or failure.
- A new live operation must still interrupt replay immediately.
- Do not add a scrolling event log to the hero.

### 5. Fleet Ready tells two stories

After the recent-outcome hold expires, idle mode says `FLEET READY` but keeps the last
operation title, elapsed time, metadata, and completed pipeline in the hero. This reads
like a completed run that is still active.

Required behavior:

- Idle hero title: `No operation in flight`.
- Pipeline becomes a neutral ready rail or is visually de-emphasized.
- Last completed run remains the first Recent Runs row.
- A stale failed run may keep a small recovery badge in Recent Runs, but should not own
  the idle hero.

### 6. Live observation starts too late

Operation records are created only when a `submit_*` tool starts. Request and Risk are
therefore inferred as already complete, and Verify is inferred from the terminal result.
That limits the page's value as a live run viewer.

Required behavior:

- Emit stage events for request capture, risk scoring, approval wait, execution,
  verification, and completion.
- Include `stage`, `stageStatus`, `currentAction`, and timestamp.
- Preserve the stable five-stage visual model while allowing tool-level detail in the
  collapsed drawer.
- Do not expose raw tool names in the hero.

### 7. Failure recovery routes are too generic

Certificate failures currently route to Security. The most direct recovery surface is
Agent Certificates.

Required behavior:

- Certificate, credential, and app-registration failures: `Open Agent Certs`.
- Approval holds: `Open Approvals`.
- Partial group or license changes: `Open Operations`.
- Policy blocks or UEBA findings: `Open Security`.

### 8. Screen-reader announcements are too broad

`aria-live="polite"` wraps the entire Command Center. Updating recent rows or details can
cause verbose announcements.

Required behavior:

- Scope the live region to the eyebrow, active stage, and current-action sentence.
- Use `aria-atomic="true"` for one concise update.
- Do not announce replay decoration or unchanged recent rows.

## P1: App-Wide UX

### 9. Raw infrastructure errors overwhelm the lifecycle rail

Glass Screen sanitizes and bounds raw errors, but the Approver lifecycle rail displays
the full PowerShell command and stack text.

Required behavior:

- Rail summary: `Graph certificate authentication failed`.
- Secondary sentence: `No tenant change was committed`.
- Action: `Open Agent Certs`.
- Raw command and stack remain only in Run Details or Audit.

### 10. Failures need one shared cross-view lifecycle

Dashboard, Operations, Approver, Glass Screen, Audit, and Security currently use partly
independent fixtures and presentation logic. A failed run can disappear from Operations
or show different language elsewhere.

Required behavior:

- One normalized operation record feeds every lifecycle surface.
- In-flight runs appear on Dashboard and Operations immediately.
- Terminal failures remain visible until acknowledged or superseded.
- Status, subject, ticket, agent, mode, committed-change state, and timestamps agree.

### 11. Global LIVE language is too alarming on read-only pages

Users, Audit Agent, and other read-only views still inherit a prominent `LIVE WRITING`
session banner. It describes session capability, but visually implies the current page
is writing.

Required behavior:

- Rename global state to `SESSION: LIVE`.
- Show `WRITING` only on a surface with an active write or armed mutation.
- Keep Audit Agent explicitly `READ-ONLY`.

## P2: Composition and Polish

### Glass Screen composition

- Reduce the page-header slab height. It competes with the operation hero.
- Keep the hero as the dominant island, but tighten unused horizontal and vertical space.
- Make the current-action sentence the strongest element after the operation title.
- Add a very subtle stage-change sweep across the active connector, once per transition.
- Use opacity and transform only; avoid layout-shifting animation.
- Keep Recent Runs visually attached to the hero, with less card-on-card separation.
- Keep Run Details collapsed and quieter than Recent Runs.

### Glass material

Use three material strengths rather than one opacity everywhere:

- Shell/gutters: highly translucent.
- Reading panels: stronger neutral scrim for text contrast.
- Inputs and destructive controls: strongest backing.

Validate over both a bright and dark desktop background. Maintain readable text without
body text shadows.

### Dense utility views

- Audit Log should fix `169 ENTRIES ENTRIES`.
- Graph Runner needs a formatted table/tree default and a Raw JSON toggle.
- Users should merge the result list and selected profile more tightly on wide screens.
- Security should keep the focused finding rail sticky but allow more width for long UPNs.
- Approvals should distinguish approval token from ticket reference.

## Motion Acceptance

- Stage connector: 350-400ms ease-out.
- Stage content crossfade: 160-220ms.
- Failure pulse: one pass, at most 300ms.
- Replay interval: 650-800ms, with narration changing at each stage.
- No perpetual pulse, shimmer, glow, or auto-playing historical replay.
- Reduced motion resolves each frame immediately and retains all text.

## Verification Performed

- `npm test`: 48 passing tests.
- Syntax checks passed for main and renderer modules.
- `git diff --check` passed before this review.
- Glass state capture: 12 scenarios completed.
- Full app capture: 16 views completed.
- Runtime screenshots reviewed at full size and 900 x 760.

## Next Review Gate

Claude should provide fresh captures and test output after P0 and P1 work. Codex should
then perform a live human-flow review from Approver request through operation failure or
success, cross-checking Dashboard, Operations, Glass Screen, Agent Certificates, and
Audit before approval to push.

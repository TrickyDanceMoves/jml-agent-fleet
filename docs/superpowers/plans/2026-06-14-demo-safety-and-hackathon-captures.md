# Demo Safety and Hackathon Captures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent real writes in seeded demo modes, align hackathon documentation, and generate submission-ready screenshots.

**Architecture:** Add a small pure demo-safety module that classifies presentation modes and produces immutable simulated receipts. Gate the main-process execution and mutation entry points with that module, while keeping seeded state in memory. Extend capture mode to render deterministic main, docked, and overlay artifacts without production credentials.

**Tech Stack:** Electron, Node.js, vanilla HTML/CSS/JS, Node test runner, PowerShell launch wrappers.

---

### Task 1: Demo Safety Contract

**Files:**
- Create: `electron-app/lib/demo-safety.js`
- Create: `electron-app/test/demo-safety.test.js`

- [ ] **Step 1: Write failing tests**

Test that `isDemoMode(['--demo'])` and `isDemoMode(['--demo-drive'])` are true,
normal arguments are false, and `demoReceipt()` always returns
`{ demo: true, simulated: true, committed: false }`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/demo-safety.test.js`

Expected: FAIL because `lib/demo-safety.js` does not exist.

- [ ] **Step 3: Implement the pure module**

Export `isDemoMode`, `assertExternalExecutionAllowed`, and `demoReceipt`.
`assertExternalExecutionAllowed(true, action)` must throw a
`DemoWriteBlockedError` before external execution.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/demo-safety.test.js`

Expected: all demo-safety tests pass.

### Task 2: Main-Process Write Isolation

**Files:**
- Modify: `electron-app/main.js`
- Modify: `electron-app/test/demo-safety.test.js`

- [ ] **Step 1: Add source-contract tests**

Assert that PowerShell launch wrappers call the external-execution assertion,
submit tools use simulated receipts in demo mode, and demo PIN verification does
not call `mintWriteToken`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/demo-safety.test.js`

Expected: FAIL on missing guards in `main.js`.

- [ ] **Step 3: Add the process-level guards**

Import the safety module, derive one `PRESENTATION_MODE` flag, guard every
PowerShell launch wrapper, and return demo receipts before lifecycle execution.
Replace demo PIN minting with a non-capability marker accepted only by simulated
demo handlers.

- [ ] **Step 4: Guard mutation IPC**

Short-circuit approval, rejection, exports, bulk import, schedules,
certification, quarantine, policy/operator/provider/tenant saves, and related
mutation handlers. Update only in-memory demo fixture arrays where visual
continuity requires it.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/demo-safety.test.js`

Expected: all demo-safety tests pass.

### Task 3: Hackathon Documentation

**Files:**
- Modify: `SYNC.md`
- Modify: `AGENTS.md`
- Modify: `docs/hackathon-readiness.md`
- Modify: `docs/demo-script.md`
- Modify: `README.md` only if its fleet count conflicts

- [ ] **Step 1: Correct readiness state**

State that Foundry IQ satisfies the Enterprise Agents requirement and distinguish
the remaining submission task: final five-minute video/link verification.

- [ ] **Step 2: Correct product language**

Use the repository's actual identity inventory consistently and remove acrylic
instructions from Glass guidance.

- [ ] **Step 3: Correct collaboration guidance**

Make Git the durable synchronization layer while OneDrive is the shared checkout.
Dirty work must abort sync; no instruction may recommend destroying unknown edits.

- [ ] **Step 4: Verify documentation**

Run focused `rg` searches for stale phrases: `not yet submission-eligible`,
`acrylic`, `48 Electron tests`, and destructive dirty-work instructions.

Expected: no stale hackathon claims remain in active guidance.

### Task 4: Seeded Capture Harness

**Files:**
- Modify: `electron-app/main.js`
- Modify: `electron-app/preload.js` only if a capture-only bridge is required
- Create: `electron-app/test/hackathon-capture.test.js`
- Create artifacts: `docs/images/hackathon/*.png`

- [ ] **Step 1: Add capture-contract tests**

Assert a dedicated `--hackathon-capture` mode exists, uses seeded data, emits
Warm and Glass main views, and opens docked and overlay windows for capture.

- [ ] **Step 2: Verify RED**

Run: `node --test test/hackathon-capture.test.js`

Expected: FAIL because the capture mode is absent.

- [ ] **Step 3: Implement deterministic capture mode**

Create windows with fixed dimensions, apply theme before capture, seed synthetic
data, navigate to each requested view, and write PNGs with stable filenames.
Capture expanded/slim docked and idle/active overlay states.

- [ ] **Step 4: Run capture**

Run: `npm start -- --hackathon-capture --disable-gpu`

Expected: twelve PNG files in `docs/images/hackathon/` and process exit code 0.

### Task 5: Final Verification

**Files:**
- Verify all modified files and generated images

- [ ] **Step 1: Run full tests**

Run: `npm test`

Expected: zero failures.

- [ ] **Step 2: Run diff checks**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Inspect every screenshot**

Confirm readable typography, synthetic identities, no clipped controls, correct
theme, and distinct docked/overlay states.

- [ ] **Step 4: Scan public artifacts**

Search tracked text and capture metadata for real tenant domains and secrets.

Expected: no sensitive identifiers in new submission artifacts.


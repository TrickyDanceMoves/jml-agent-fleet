# Operation Lifecycle Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provisioning state and failures consistent across Approver lifecycle, Operations, and Dashboard, while fixing the stale Safe banner when a saved Live session starts.

**Architecture:** A pure status module classifies tool results and builds canonical operation records. The Electron main process persists those records to a JSONL journal and broadcasts updates; the renderer consumes the same records for lifecycle and Operations. A small renderer helper synchronizes every Session Mode control and banner from one boolean state.

**Tech Stack:** Electron, Node.js CommonJS, browser JavaScript, Node's built-in test runner.

---

### Task 1: Status and mode contracts

**Files:**
- Create: `electron-app/lib/operation-status.js`
- Create: `electron-app/renderer/mode-ui.js`
- Create: `electron-app/test/operation-status.test.js`
- Create: `electron-app/test/mode-ui.test.js`

- [ ] Write tests proving thrown errors, error payloads, failed/partial outcomes, approvals, and success are classified correctly.
- [ ] Run `node --test test/operation-status.test.js` and confirm it fails because the module is absent.
- [ ] Implement the minimal classification module and rerun the test.
- [ ] Write a DOM-stub test proving Live mode hides the Safe banner at initialization.
- [ ] Run `node --test test/mode-ui.test.js`, implement the synchronizer, and rerun both tests.

### Task 2: Main-process operation journal

**Files:**
- Modify: `electron-app/main.js`
- Modify: `electron-app/preload.js`

- [ ] Create an operation when a mutating submit tool starts.
- [ ] Broadcast `operation-status` updates for running and terminal states.
- [ ] Persist terminal records, including failures that occur before PowerShell writes the audit log.
- [ ] Expose journal retrieval and status subscriptions through the preload bridge.

### Task 3: Shared renderer state

**Files:**
- Modify: `electron-app/renderer/index.html`
- Modify: `electron-app/renderer/app.js`
- Modify: `electron-app/renderer/styles.css`

- [ ] Load the mode helper before `app.js` and synchronize controls during startup.
- [ ] Make `msg-complete` end chat rendering only; do not infer lifecycle success.
- [ ] Drive lifecycle stage success, partial, failed, queued, and running visuals from operation records.
- [ ] Populate Operations in-flight and completed cards from operation records merged with audit history.
- [ ] Surface the latest running or failed operation on Dashboard.

### Task 4: Verification

**Files:**
- Modify: `electron-app/package.json`

- [ ] Add a `test` script using `node --test`.
- [ ] Run the focused tests and the full test command.
- [ ] Launch the Electron app and verify saved Live mode shows only the Live banner.
- [ ] Simulate a failed operation record and verify Lifecycle, Operations, and Dashboard agree.

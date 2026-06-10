# Glass Screen Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Glass Screen's audit-first replay widget with a live-first Command Center that accurately renders active, approval, failure, partial, completion, idle, and replay states.

**Architecture:** Add a pure CommonJS-compatible view-model module that maps operation-status records into stable pipeline and presentation state. Keep DOM rendering and motion orchestration in a focused renderer module, while `app.js` only wires IPC data and tab lifecycle into that controller. Use existing `operation-status` IPC as the live authority and audit entries only as historical enrichment.

**Tech Stack:** Electron, vanilla JavaScript, HTML, CSS, Node.js test runner.

---

### Task 1: Operation View Model

**Files:**
- Create: `electron-app/renderer/glass-screen-model.js`
- Create: `electron-app/test/glass-screen-model.test.js`

- [ ] **Step 1: Write failing tests for lifecycle mapping**

Test exported functions:

```js
const {
  buildGlassScreenViewModel,
  selectActiveOperation,
  recentTerminalOperations,
} = require('../renderer/glass-screen-model');
```

Cover:

```js
test('running execute operation activates Execute and leaves later stages pending', () => {});
test('failed execution never marks Verify or Complete succeeded', () => {});
test('awaiting approval pauses at Risk with an amber decision', () => {});
test('partial outcome names completed work and remaining follow-up', () => {});
test('active operation wins over selected historical replay', () => {});
test('recent terminal operations are newest first and limited to three', () => {});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node --test test/glass-screen-model.test.js
```

Expected: FAIL because `renderer/glass-screen-model.js` does not exist.

- [ ] **Step 3: Implement the pure model**

Export:

```js
const PIPELINE_STAGES = ['request', 'risk', 'execute', 'verify', 'complete'];

function selectActiveOperation(operations) {}
function recentTerminalOperations(operations, limit = 3) {}
function buildGlassScreenViewModel({ operations, selectedId, now = Date.now() }) {}
function formatCurrentDecision(operation) {}
function mapPipeline(operation) {}

if (typeof module !== 'undefined') {
  module.exports = {
    PIPELINE_STAGES,
    selectActiveOperation,
    recentTerminalOperations,
    buildGlassScreenViewModel,
    formatCurrentDecision,
    mapPipeline,
  };
}
```

The returned view model must contain:

```js
{
  mode: 'live' | 'replay' | 'idle',
  operation,
  eyebrow,
  title,
  metadata,
  elapsedLabel,
  currentDecision,
  recovery,
  stages: [{ id, label, state }],
  recent,
}
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
node --test test/glass-screen-model.test.js
```

Expected: all Glass Screen model tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add electron-app/renderer/glass-screen-model.js electron-app/test/glass-screen-model.test.js
git commit -m "test: define Glass Screen operation model"
```

### Task 2: Command Center Markup

**Files:**
- Modify: `electron-app/renderer/index.html`
- Create: `electron-app/test/glass-screen-markup.test.js`

- [ ] **Step 1: Write failing markup contract tests**

Assert that `index.html` contains:

```text
gs-command-center
gs-live-hero
gs-pipeline
gs-current-decision
gs-recent-runs
gs-details
gs-view-audit
```

Assert that it no longer contains:

```text
gs-stage-card
gs-traveler
>Audit Trail<
```

Assert `<details id="gs-details">` does not have the `open` attribute.

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
node --test test/glass-screen-markup.test.js
```

Expected: FAIL against the existing audit-first markup.

- [ ] **Step 3: Replace Glass Screen markup**

Use this structure:

```html
<section class="view" id="view-glass-screen">
  <div class="head">
    <div>
      <h1 class="h1">Glass Screen <span class="sub">live identity operations</span></h1>
      <p class="desc">Watch active identity actions advance through request, risk, execution, verification, and completion.</p>
    </div>
    <div class="row-flex">
      <button class="btn ghost" id="gs-replay" hidden>Replay</button>
    </div>
  </div>

  <div class="gs-command-center" id="gs-command-center" aria-live="polite">
    <section class="card gs-live-hero" id="gs-live-hero"></section>
    <section class="gs-recent-section">
      <div class="gs-section-head">
        <span>Recent runs</span>
        <button class="btn-text-link" id="gs-view-audit">View all in Audit Log</button>
      </div>
      <div class="gs-recent-runs" id="gs-recent-runs"></div>
    </section>
    <details class="card gs-details" id="gs-details">
      <summary>Run details <span>tools · evidence · raw error</span></summary>
      <div id="gs-details-body"></div>
    </details>
  </div>
</section>
```

- [ ] **Step 4: Run the markup test**

```powershell
node --test test/glass-screen-markup.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add electron-app/renderer/index.html electron-app/test/glass-screen-markup.test.js
git commit -m "feat: replace Glass Screen audit layout"
```

### Task 3: Command Center Controller

**Files:**
- Create: `electron-app/renderer/glass-screen.js`
- Modify: `electron-app/renderer/index.html`
- Modify: `electron-app/renderer/app.js`
- Create: `electron-app/test/glass-screen-controller.test.js`

- [ ] **Step 1: Add the model and controller scripts**

Load scripts before `app.js`:

```html
<script src="glass-screen-model.js"></script>
<script src="glass-screen.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 2: Write failing controller tests**

Test pure helpers exported by `glass-screen.js`:

```js
const {
  mergeOperationUpdate,
  liveOperationInterruptsReplay,
  detailsRowsForOperation,
} = require('../renderer/glass-screen');
```

Cover:

- Same operation ID is replaced by fresher `updatedAt`
- New running operation interrupts replay selection
- Terminal update removes the active state and preserves history
- Details rows sanitize and bound raw error text
- Audit enrichment never overwrites fresher operation-status outcome

- [ ] **Step 3: Implement controller state**

Use:

```js
const glassScreenState = {
  operations: [],
  selectedId: null,
  replaying: false,
  lastRenderedStage: null,
};
```

Expose:

```js
window.JmlGlassScreen = {
  onShow,
  onOperationStatus,
  onOperationStatuses,
  onAuditEntries,
  render,
  captureState,
};
```

Render:

- Eyebrow, title, metadata, elapsed time
- Five pipeline stages
- Current decision
- Failure or recovery action
- Three recent rows
- Collapsed details content
- Replay button only in replay mode

- [ ] **Step 4: Rewire `app.js`**

Replace the old `gsStages`, `gsPlay`, `gsRenderRuns`, and timer-based implementation.

Forward existing events:

```js
window.api.onOperationStatus(op => window.JmlGlassScreen?.onOperationStatus(op));
window.api.onOperationStatuses(ops => window.JmlGlassScreen?.onOperationStatuses(ops));
```

When `switchTab('glass-screen')` runs:

```js
window.JmlGlassScreen?.onShow();
```

Forward audit entries only for historical enrichment:

```js
window.JmlGlassScreen?.onAuditEntries(entries);
```

- [ ] **Step 5: Run focused and full tests**

```powershell
node --test test/glass-screen-model.test.js test/glass-screen-controller.test.js
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add electron-app/renderer/glass-screen.js electron-app/renderer/index.html electron-app/renderer/app.js electron-app/test/glass-screen-controller.test.js
git commit -m "feat: connect Glass Screen to live operations"
```

### Task 4: Motion and Visual System

**Files:**
- Modify: `electron-app/renderer/styles.css`
- Create: `electron-app/test/glass-screen-motion.test.js`

- [ ] **Step 1: Write failing CSS contract tests**

Assert:

- Command Center classes exist
- Connector transition is 400ms
- Stage activation transition is 250ms
- Failure pulse is at most 300ms and runs once
- `@media (prefers-reduced-motion: reduce)` exists
- Reduced motion disables pipeline transitions and animation
- No infinite animation exists in `.gs-` rules
- Recent runs render as flat rows

- [ ] **Step 2: Run focused test and verify failure**

```powershell
node --test test/glass-screen-motion.test.js
```

Expected: FAIL before CSS replacement.

- [ ] **Step 3: Replace the old Glass Screen CSS**

Implement:

```css
.gs-command-center {}
.gs-live-hero {}
.gs-operation-head {}
.gs-pipeline {}
.gs-stage {}
.gs-stage-orb {}
.gs-connector {}
.gs-current-decision {}
.gs-recovery {}
.gs-recent-runs {}
.gs-recent-run {}
.gs-details {}
```

Use state attributes:

```css
[data-state="active"]
[data-state="succeeded"]
[data-state="partial"]
[data-state="failed"]
[data-state="awaiting-approval"]
```

Motion:

```css
.gs-connector-fill { transition: transform 400ms ease-out; }
.gs-stage-orb { transition: color 250ms ease, border-color 250ms ease, transform 250ms ease; }
.gs-stage[data-entered="true"] .gs-stage-orb { animation: gs-stage-enter 250ms ease-out 1; }
.gs-stage[data-state="failed"] .gs-stage-orb { animation: gs-failure 300ms ease-out 1; }
```

Reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  .gs-command-center *,
  .gs-command-center *::before,
  .gs-command-center *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

- [ ] **Step 4: Run CSS and full tests**

```powershell
node --test test/glass-screen-motion.test.js
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add electron-app/renderer/styles.css electron-app/test/glass-screen-motion.test.js
git commit -m "feat: add state-driven Glass Screen motion"
```

### Task 5: Capture Fixtures and Runtime States

**Files:**
- Modify: `electron-app/main.js`
- Modify: `electron-app/package.json` only if a dedicated capture command is needed

- [ ] **Step 1: Replace the old capture hook**

Support explicit capture fixtures:

```js
window.JmlGlassScreen.captureState('idle');
window.JmlGlassScreen.captureState('running');
window.JmlGlassScreen.captureState('awaiting-approval');
window.JmlGlassScreen.captureState('failed');
window.JmlGlassScreen.captureState('partial');
window.JmlGlassScreen.captureState('success');
window.JmlGlassScreen.captureState('replay');
```

- [ ] **Step 2: Capture each state**

Save review-only artifacts under:

```text
.superpowers/glass-screen-qc/
```

Do not replace documentation screenshots before Codex approval.

- [ ] **Step 3: Verify responsive behavior**

Evaluate at:

- 1440 × 1000
- 1100 × 800
- 900 × 760

The pipeline may compress labels but must not overlap, clip, or require horizontal scrolling.

- [ ] **Step 4: Verify reduced motion**

Emulate reduced motion or add a capture fixture that applies the media behavior. Confirm state appears immediately and no animation loop remains.

- [ ] **Step 5: Run complete verification**

```powershell
npm test
node --check main.js
node --check renderer/app.js
node --check renderer/glass-screen.js
git diff --check
```

- [ ] **Step 6: Commit locally and stop**

```powershell
git add electron-app
git commit -m "feat: overhaul Glass Screen command center"
```

Do not push. Notify Codex that the implementation is ready for review.

### Task 6: Codex Review Gate

**Owner:** Codex

- [ ] Inspect the implementation diff for state-truth regressions.
- [ ] Run the full test suite and syntax checks.
- [ ] Inspect idle, live, approval, failed, partial, success, and replay captures.
- [ ] Check reduced motion and narrow-window behavior.
- [ ] Reject raw audit/error overload, decorative looping, or success styling on failure.
- [ ] Request and verify corrections from Claude.
- [ ] Push the approved implementation to `origin/main`.
- [ ] Restart the Electron app from the OneDrive repository.

---
name: run-jml-console
description: run, start, screenshot, capture, build, launch, test, interact with the JML Console Electron app
---

JML Console is a Windows Electron app for identity lifecycle management. It is driven via a built-in `--capture` mode that injects mock data (no Entra credentials needed), navigates all 17 tabs, and saves PNGs to `agents/docs/images/`. The driver wraps this mode for programmatic use.

## Prerequisites

`node_modules` must be present. If not:
```
npm install
```
No extra system packages on Windows — Electron bundles Chromium.

## Run (agent path)

From `agents/electron-app/`:
```
node .claude/skills/run-jml-console/driver.mjs [tab-name]
```

Valid tab names: `operator-select`, `jml-fleet-input`, `dashboard`, `glass-screen`, `approver`, `auditor`, `security`, `exports`, `approvals`, `operations`, `certifications`, `settings`, `audit-log`, `users`, `integrations`, `certs`, `graph`

Example — screenshot the dashboard:
```
node .claude/skills/run-jml-console/driver.mjs dashboard
```

The driver prints the absolute path to the PNG. Pass that path to the `Read` tool to view the screenshot. The full capture cycle takes ~30s and always captures all tabs regardless of which tab you specify.

## Run (human path)

```
npm start
```
Opens the live window. Requires real Entra credentials for AI agent responses and Graph queries. Close via the window's X button.

## Custom JS injection for UI testing

To test a new UI state (e.g. a new modal or element), add an entry to `TAB_INJECT` in `main.js` at line 1321. Pattern:
```js
const TAB_INJECT = {
  myTab: `(function(){ document.getElementById('my-element').click(); })();`,
  // existing entries...
};
```
The injected JS runs in the renderer immediately before the screenshot is taken.

## Gotchas

- **Screenshots land in `agents/docs/images/`**, not `electron-app/docs/images/`. `CAPTURE_OUT` is computed as `__dirname + '/../docs/images'` where `__dirname` is the `electron-app/` dir.
- **First-run wizard bypass**: capture mode calls `createOperatorWindow()` directly, skipping the `isFirstRun()` check at line 1614. The setup wizard never appears during capture.
- **All tabs always captured**: the capture cycle is sequential and always does all 17 tabs. The driver's `[tab]` arg only selects which PNG path to report.
- **Windows only**: the native Electron binary is `win32-x64`. On Linux/CI, `xvfb-run` and patched native libs would be needed.
- **`docs/images/` must exist**: the driver pre-creates it via `mkdirSync(..., { recursive: true })`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ENOENT: no such file or directory, open '...docs/images/dashboard.png'` | Directory missing; driver now pre-creates it. If running `npm run capture` directly, `mkdir agents/docs/images` first. |
| Window opens but immediately closes | Crash in main process — run `npm run capture` directly to see the stack trace. |
| Screenshot is blank/black | Renderer didn't finish loading. Increase the `sleep(1200)` at line 1452 in `main.js`. |

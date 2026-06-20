# Electron Security Posture — JML Console

The console is a privileged local admin tool: the main process can call Microsoft
Graph, dispatch PowerShell agents, and mutate the Entra tenant. The renderer must
therefore be treated as untrusted UI, with all authority mediated by IPC.

## Current configuration

| Control | State | Where |
|---|---|---|
| `contextIsolation` | ✅ true | every `BrowserWindow` in `main.js` |
| `nodeIntegration` | ✅ false | every `BrowserWindow` |
| `sandbox` | ✅ true | every `BrowserWindow` in `main.js`; preloads carry no Node deps |
| Preload allowlist | ✅ | `preload.js` exposes a fixed `window.api` surface via `contextBridge` |
| No remote content | ✅ | renderer loads only local `renderer/*.html`; no remote URLs |
| External links | ✅ | routed through `shell.openExternal`, never in-app navigation |
| BOM-safe config reads | ✅ | `readJson()` strips UTF-8 BOM before parse |

## IPC hardening

Every mutating IPC handler in the main process enforces:
- **Write-token gate** — `requireWriteToken()` rejects any mutating call without a
  fresh operator write token (issued only after PIN/Windows verification).
- **Role gate** — viewer/guest operators are blocked from Live-mode writes; helpdesk
  hard-leavers route to admin approval; admin-required approvals are checked server-side.
- **Payload shape checks** — handlers read only known fields and pass typed parameters
  to PowerShell (no raw string interpolation of user input into shell).

## Closed: `sandbox: true` on every window

Previously the main preload used Node built-ins (`os` for the operator username),
which forced `sandbox: false`. That logic moved into the main process behind a
synchronous `resolve-current-user` IPC call, so all three preloads
(`preload.js`, `preload-panel.js`, `preload-overlay.js`) now use only
`electron` (`contextBridge`/`ipcRenderer`) and every `BrowserWindow` runs with
`sandbox: true`. The renderer process is now OS-sandboxed in addition to being
context-isolated with Node integration disabled.

## Recommended next steps

- [x] Strict Content-Security-Policy on the main renderer (`index.html`):
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'`.
      (No inline `<script>` or inline event handlers, so `script-src 'self'` holds.)
- [ ] Extend the same CSP to the secondary renderer HTML (operator-select, setup, overlay, docked, palette).
- [x] Set `sandbox: true` after moving Node-dependent preload logic into main-process IPC.
- [ ] Validate `event.senderFrame` origin in each IPC handler (defence in depth).
- [ ] Add a JSON-schema validator for IPC payloads on the highest-privilege channels
      (`run-quick-leaver`, `activate-pim-role`, `create-agent-app-registrations`,
      `quarantine-agent`).

## References
- Electron security checklist: contextIsolation, sandbox, and process model are the
  primary controls for an app that bridges a privileged backend to a web UI.

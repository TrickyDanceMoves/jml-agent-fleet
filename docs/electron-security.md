# Electron Security Posture — JML Console

The console is a privileged local admin tool: the main process can call Microsoft
Graph, dispatch PowerShell agents, and mutate the Entra tenant. The renderer must
therefore be treated as untrusted UI, with all authority mediated by IPC.

## Current configuration

| Control | State | Where |
|---|---|---|
| `contextIsolation` | ✅ true | every `BrowserWindow` in `main.js` |
| `nodeIntegration` | ✅ false | every `BrowserWindow` |
| `sandbox` | ⚠️ false | see "Known gap" below |
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

## Known gap: `sandbox: false`

The preload scripts require Node built-ins (`os` for the operator username, `fs`/`path`
for BOM-safe config reads), which are unavailable under a fully sandboxed renderer.
The renderer itself remains isolated (`contextIsolation: true`, `nodeIntegration: false`),
so this does not expose Node to page scripts — but the preload runs with Node access.

**Remediation path:** move the `os`/`fs` reads out of preload into the main process
behind dedicated IPC calls, then set `sandbox: true`. Tracked for post-submission.

## Recommended next steps

- [ ] Add a strict Content-Security-Policy `<meta>` to every renderer HTML (`default-src 'self'`).
- [ ] Set `sandbox: true` after moving Node-dependent preload logic into main-process IPC.
- [ ] Validate `event.senderFrame` origin in each IPC handler (defence in depth).
- [ ] Add a JSON-schema validator for IPC payloads on the highest-privilege channels
      (`run-quick-leaver`, `activate-pim-role`, `create-agent-app-registrations`,
      `quarantine-agent`).

## References
- Electron security checklist: contextIsolation, sandbox, and process model are the
  primary controls for an app that bridges a privileged backend to a web UI.

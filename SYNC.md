# JML Shared Build Handoff

Updated: June 23, 2026

## Working Agreement

- Claude Code owns implementation in the user's local terminal.
- Codex owns runtime QC, design review, and acceptance verification.
- The OneDrive checkout is the shared source of working state.
- Do not use `sync.cmd` while the worktree is dirty. It runs `git reset --hard origin/main`
  and will erase uncommitted work.
- Before changing files, run `git status -sb` and preserve work from other sessions.

## Current State (post-submission, v1.1.13, 2026-06-23)

- Hackathon submitted June 14, 2026 - **DONE**
- v1.1.13 shipping (Electron hardening release: trusted-sender IPC, payload-schema validation, unsafe-inline removed, renderer nav/popup/webview/permission/CSP lockdown)
- All 173 automated tests pass (electron-app: 173, api: 8, worker: 10)
- Devices tab fully implemented: AI-assisted search, Intune + Entra state, full device lifecycle (sync, disable, lock, retire, wipe, delete) with per-device Safe mode
- Entra operator identity fully implemented (all three auth paths: PIN, Windows session, Entra device-code sign-in)
- Glass Screen Command Center live; acrylic explicitly rejected (crisp transparent shell final)
- Hybrid Entra Agent ID migration COMPLETE: Auditor + Approver as Agent IDs; write agents on SPs by design
- Foundry IQ grounding live with fail-closed behavior
- ORCHESTRATION.md removed (was wrong-repo content, reverted June 23)

## Build Priority

Use the full review in:

`docs/superpowers/reviews/2026-06-11-glass-screen-and-app-qc.md`

Implement in this order:

0. ✅ DONE 2026-06-12 (Codex QC: PASS) — incorporate the user-approved,
   truly transparent Glass JML logo into the OOBE surfaces
   (`electron-app/renderer/setup.html` and
   `electron-app/renderer/operator-select.html`). The approved source and
   implementation acceptance criteria are in
   `.superpowers/claude-oobe-glass-logo-handoff.md`. The outer rounded-square
   middle must remain an actual transparent hole (`fill="none"`), not a
   transparent child that reveals a filled parent gradient. Preserve the Warm
   and Preview logo treatments. Do not commit or push until Codex completes
   runtime QC.
1. Make operation status authoritative across chat, lifecycle, Dashboard, Operations,
   Glass Screen, Agent Certificates, and Audit.
2. ✅ DONE 2026-06-11 — hybrid Entra Agent ID migration complete: blueprint FMI secret
   added (required AgentIdentityBlueprint.ReadWrite.All consent), Auditor validated over
   FMI (live UserSummary query), Approver cut over and validated (token minted as agent
   identity). Execution SPs retained for write agents (platform blocks write scopes on
   agent identities). SP retirement for the two read agents deferred until soak.
3. ✅ DONE 2026-06-11 — Approver rail errors sanitized (`lcSummarizeError` in app.js):
   one human-readable line in the rail; raw output stays on the operation record
   for the Glass Screen details drawer and audit.
4. Upgrade replay from dot animation to narrated stage replay.
5. Clarify the Fleet Ready idle hero.
6. Emit real stage events earlier than `submit_*` so Request, Risk, Execute, and Verify
   are observed rather than inferred.
7. Preserve and runtime-test the async Graph session work from `e35fe07`.

## Acceptance Gate

Do not push the next UI revision until Codex has reviewed:

- one live successful Joiner
- one certificate-authentication failure
- Auditor and Approver Agent ID authentication status
- one awaiting-approval Leaver
- one partial result
- one interrupted replay when a new live operation arrives
- narrow window and reduced-motion behavior
- cross-view agreement for the same operation and certificate

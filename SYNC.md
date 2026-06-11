# JML Shared Build Handoff

Updated: June 11, 2026

## Working Agreement

- Claude Code owns implementation in the user's local terminal.
- Codex owns runtime QC, design review, and acceptance verification.
- The OneDrive checkout is the shared source of working state.
- Do not use `sync.cmd` while the worktree is dirty. It runs `git reset --hard origin/main`
  and will erase uncommitted work.
- Before changing files, run `git status -sb` and preserve work from other sessions.

## Current State

- Glass Screen Command Center is implemented and committed through `b014d3c`.
- All 48 automated tests pass.
- Glass state capture passes for idle, running, approval, failure, partial, success,
  replay, reduced motion, and narrow layouts.
- Full console capture passes for all 16 views.
- Async PowerShell and warm Graph-session work is committed as `e35fe07`.
- The branch is one commit ahead of `origin/main`.
- The only uncommitted work should be this review handoff and review document.

## Build Priority

Use the full review in:

`docs/superpowers/reviews/2026-06-11-glass-screen-and-app-qc.md`

Implement in this order:

1. Make operation status authoritative across chat, lifecycle, Dashboard, Operations,
   Glass Screen, Agent Certificates, and Audit.
2. Sanitize infrastructure errors in the Approver rail. Keep raw output in details.
3. Upgrade replay from dot animation to narrated stage replay.
4. Clarify the Fleet Ready idle hero.
5. Emit real stage events earlier than `submit_*` so Request, Risk, Execute, and Verify
   are observed rather than inferred.
6. Preserve and runtime-test the async Graph session work from `e35fe07`.

## Acceptance Gate

Do not push the next UI revision until Codex has reviewed:

- one live successful Joiner
- one certificate-authentication failure
- one awaiting-approval Leaver
- one partial result
- one interrupted replay when a new live operation arrives
- narrow window and reduced-motion behavior
- cross-view agreement for the same operation and certificate

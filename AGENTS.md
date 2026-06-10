# Working in this repo (humans and AI agents)

This folder lives in OneDrive on Nick's PC and is also edited by cloud
sessions (Claude Code on the web) that push straight to GitHub `main`.
GitHub is the single source of truth — the local folder is just a clone.

## Session workflow — non-negotiable

**At session start**, sync to the latest main before touching anything:

```
git pull origin main
```

If the pull is blocked by leftover local edits you didn't make, they are
stale — discard them with `sync.cmd` (or `git fetch origin && git reset
--hard origin/main`).

**At session end**, push everything. Never leave uncommitted edits in the
working tree — they block the next session's pull and will be destroyed
by the next `sync.cmd`. Run `handoff.cmd`, or manually:

```
git add -A
git commit -m "<what you did>"
git push origin main
```

If the push is rejected because main moved, `git pull --rebase origin main`
then push again.

## Helper scripts (repo root)

- `sync.cmd` — start of session: fetch + hard-reset to `origin/main`.
  DESTROYS uncommitted local work; only run it before you've changed
  anything, never after.
- `handoff.cmd` — end of session: stage, commit, and push everything.

## Gotchas

- Close the JML Console app before `sync.cmd` — OneDrive file locks on
  `electron-app/providers/` and `approver/pending/` can block resets.
- The Electron app is at `electron-app/` (repo root), and this repo's
  root is the `agents` folder on Nick's PC
  (`C:\Users\Nick\OneDrive\JML AI Agent Fleet Lab\agents`).
- Run `npm test` from `electron-app/` before pushing UI changes — it
  locks the glass-theme material contract and lifecycle status logic.

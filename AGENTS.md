# Working in this repo (humans and AI agents)

This folder lives in OneDrive on the maintainer's PC and is also edited by cloud
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

## Commit identity & attribution (every clone / machine)

The repo history was scrubbed of personal data — keep it that way. These are
**per-clone** git settings, so set them on each machine (or globally):

- **Commit as a GitHub no-reply email, never a personal address:**
  `git config user.email "TrickyDanceMoves@users.noreply.github.com"`
  and `git config user.name "TrickyDanceMoves"`.
- **Keep Claude/AI tools off the contributor list:** do NOT add
  `Co-Authored-By: Claude …` or "Generated with Claude Code" trailers, and never
  let a commit be authored/committed as Claude/Anthropic.
- Do not reintroduce real tenant identifiers, personal names, local paths, or the
  `nicholasdbohanan@gmail.com` address into tracked files (runtime configs that
  hold them are gitignored — see `shared/*-config.json`, `approver/*.json`).

## Gotchas

- Close the JML Console app before `sync.cmd` — OneDrive file locks on
  `electron-app/providers/` and `approver/pending/` can block resets.
- The Electron app is at `electron-app/` (repo root), and this repo's
  root is the `agents` folder of your local clone.
- Run `npm test` from `electron-app/` before pushing UI changes — it
  locks the glass-theme material contract and lifecycle status logic.

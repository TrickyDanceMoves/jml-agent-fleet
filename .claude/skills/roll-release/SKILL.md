---
name: roll-release
description: Roll/cut/ship the next version of JML Console — bump the version, build the signed installers, refresh winget manifests, publish the GitHub release with auto-update assets, and push. Use when the user says "roll the next version", "cut a release", "ship v1.1.x", or similar.
---

# Roll a JML Console release

End-to-end release of the Electron app. Repo root is the `agents/` folder; the app
lives in `electron-app/`. Default bump is **patch** (1.1.12 → 1.1.13) unless the user
says minor/major.

## Preconditions / gotchas
- Local branch is **`JML-Agent-Fleet`** tracking `origin/main` → push with
  `git push origin HEAD:main`.
- **Never `git add -A`.** Stage only the files this skill changes. Never commit
  secrets/PII (`approver/*.json` state files, `audit.jsonl*`, `*.bak`).
- CRLF warnings on commit are harmless.
- Build signs binaries with signtool and needs the publish config already in
  `electron-app/package.json` (GitHub provider) — already present.

## Steps
1. **Pick the version.** Read `electron-app/package.json` `version`; compute the next
   (patch unless told otherwise). Call it `X.Y.Z`.
2. **(Optional) Security:** `cd electron-app && npm audit fix` (non-breaking only);
   note any patched transitive deps for the release notes.
3. **Bump** `electron-app/package.json` `version` → `X.Y.Z`.
4. **Refresh doc version refs** — replace the old version string in `HACKATHON.md`,
   `docs/hackathon-readiness.md`, `docs/case-study.html`, and `README.md`
   (`sed -i 's/<old>/X.Y.Z/g'`). Verify no stray old refs remain.
5. **Test:** `cd electron-app && npm test` — must pass before building.
6. **Build:** `cd electron-app && npm run build`. Confirm `dist/` has:
   `JML.Console.Setup.X.Y.Z.exe`, `JML.Console.Setup.X.Y.Z.exe.blockmap`,
   `latest.yml`, `JML.Console.X.Y.Z.msi`, `JML.Console.X.Y.Z.zip`.
7. **SHA256:** `(Get-FileHash dist\JML.Console.Setup.X.Y.Z.exe -Algorithm SHA256).Hash`.
8. **Winget:** create `packaging/winget/X.Y.Z/` with three manifests — copy the prior
   version's `NicholasBohanan.JMLConsole.yaml`, `.installer.yaml`, `.locale.en-US.yaml`,
   updating `PackageVersion`, the installer `InstallerUrl` (`.../download/vX.Y.Z/...`),
   `InstallerSha256`, `ReleaseDate` (today), `DisplayVersion`, and `ReleaseNotesUrl`.
   `git rm -r` the previous version's winget folder (supersede; keep only the latest).
9. **Commit + push** only: `electron-app/package.json`, `electron-app/package-lock.json`
   (if audit-fixed), the four docs, and `packaging/winget/X.Y.Z` (+ removed prior).
   Message: `Roll vX.Y.Z: <one-line summary>`. Push `git push origin HEAD:main`.
10. **Publish release** from `electron-app/dist`:
    ```
    gh release create vX.Y.Z --target main --title "JML Console vX.Y.Z" \
      --notes "<notes>" \
      JML.Console.Setup.X.Y.Z.exe JML.Console.Setup.X.Y.Z.exe.blockmap \
      latest.yml JML.Console.X.Y.Z.msi JML.Console.X.Y.Z.zip
    ```
    Include `latest.yml` + the `.blockmap` — they drive electron-updater auto-update.
11. **Verify:** `gh release list` shows `vX.Y.Z` as **Latest** with all 5 assets;
    `git status` is clean except known untracked local secrets/backups. Report what shipped.

# winget manifest - JML Console

Community-repo manifest for installing JML Console via `winget`.

```
winget install NicholasBohanan.JMLConsole
```

## Files (`1.1.12/`)
- `NicholasBohanan.JMLConsole.yaml` - version manifest
- `NicholasBohanan.JMLConsole.installer.yaml` - installer (NSIS / `nullsoft`, x64, per-user)
- `NicholasBohanan.JMLConsole.locale.en-US.yaml` - listing metadata

Validated with `winget validate` (schema 1.6.0). Installer SHA256 is pinned to the
`v1.1.12` GitHub release asset `JML.Console.Setup.1.1.12.exe`.

## Submitting to the public catalog

The manifest must be PR'd into [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs)
under `manifests/n/NicholasBohanan/JMLConsole/1.1.12/`.

Easiest path - let the tool build and open the PR for you:

```
winget install Microsoft.WingetCreate
wingetcreate submit --token <github-pat> ".\packaging\winget\1.1.12"
```

Or `wingetcreate new <installer-url>` to regenerate from scratch, then `submit`.

## Before submitting - known caveats
- **The installer is currently unsigned.** winget moderation accepts unsigned
  installers, but users will hit a SmartScreen warning and the automated
  validation pipeline gives unsigned packages extra scrutiny. Code-signing the
  NSIS installer (electron-builder `win.certificateFile` / Azure Trusted Signing)
  is strongly recommended before going public.
- The CI sandbox performs a real silent install (`/S`). Confirm a clean-machine
  launch reaches the OOBE without a configured tenant.
- Bump `PackageVersion`, `InstallerUrl`, `InstallerSha256`, and `ReleaseDate`
  for every new release (a new `<version>/` folder per release).

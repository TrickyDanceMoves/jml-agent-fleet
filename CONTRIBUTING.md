# Contributing

JML Agent Fleet is an identity-security project. Contributions should preserve
least privilege, failure truth, and operator accountability.

## Before Opening a Pull Request

1. Keep secrets, certificates, tenant IDs, object IDs, UPNs, and operational logs
   out of commits.
2. Use synthetic identities and sanitized screenshots.
3. Keep directory-write operations behind policy and approval controls.
4. Add or update focused tests for behavior changes.
5. Run:

```powershell
cd electron-app
npm ci
npm test
npm audit --omit=dev --audit-level=high
```

6. Confirm every PowerShell script parses cleanly.
7. Update public documentation when architecture, permissions, or known gaps change.

Report security issues through [`SECURITY.md`](SECURITY.md), not a public issue.

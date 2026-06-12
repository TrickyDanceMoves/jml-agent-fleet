# Security Controls

## Zero-Trust Status

| Control | Status | Detail |
|---|---|---|
| Application-only auth | Active | FMI Agent ID tokens or service-principal tokens; no delegated permissions |
| Agent ID authentication | Active | Approver and Auditor use first-class Entra Agent IDs through FMI |
| Certificate-based execution auth | Active | NonExportable RSA-2048 with DPAPI secret fallback |
| Isolated workload identities | Active | Separate Agent IDs or service principals by responsibility |
| Least privilege | Active | Each execution identity receives only the roles required for its function |
| Provisioner disabled at rest | Active | Enabled only during controlled provisioning sessions |
| Hash-chained audit log | Active | SHA-256 chain verified by `Verify-AuditLog.ps1` |
| Circuit breaker | Active | Halts after three consecutive Graph API failures |
| Retry with backoff | Active | Exponential backoff on 429, 503, and 504 |
| Ticket correlation | Active | `ticketRef` is required and logged for leaver operations |
| Dual approval for leavers | Active | Hard cleanup requires a second operator and expiring token |
| Operator RBAC | Active | Admin, helpdesk, and viewer roles in `operators.json` |
| Policy guardrails | Active | Sensitive entitlements and freeze windows in `policies.json` |
| Credential expiry alerts | Active | 60-day warning through `Test-CredentialExpiry` |
| Purview integration path | Implemented | Termination records can flow to the configured HR connector |
| Workload Identity Conditional Access | Gap | Service-principal enforcement requires Entra Workload Identities Premium; Agent ID policy must be verified separately |

## Audit Log Format

Location: `audit.jsonl`

```json
{
  "timestamp": "2026-05-07T18:49:23.000Z",
  "agent": "leaver",
  "action": "LeaverProcess",
  "subject": "user@contoso.com",
  "whatif": false,
  "outcome": "success",
  "details": {
    "ticketRef": "INC-001",
    "accountDisabled": true
  },
  "prevHash": "abc123...",
  "hash": "def456..."
}
```

Validate integrity:

```powershell
.\shared\Verify-AuditLog.ps1
```

Secondary sinks include Windows Event Log, Microsoft Sentinel, Azure Blob Storage,
and Teams notifications when configured.

## Known Gaps

| Gap | Risk | Mitigation |
|---|---|---|
| Service-principal Workload Identity CA not verified | Medium | Certificate auth, isolated identities, least privilege, and quarantine controls; policy script requires the premium SKU |
| Agent ID Conditional Access not verified | Medium | Native owner and sponsor governance, read-only Agent ID scopes, and separate write execution identities |
| Electron sandbox disabled | Medium | CSP, context isolation, bounded preload APIs, and documented migration path |
| Tenant-specific public artifacts | Medium | Sanitize screenshots and move tenant-bound identifiers to ignored runtime config before submission |

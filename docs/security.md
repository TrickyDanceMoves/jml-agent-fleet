# Security Controls

## Zero-Trust Status

| Control | Status | Detail |
|---|---|---|
| App-only auth (no user context) | ✅ Active | Client credentials, no delegated permissions |
| Certificate-based auth | ✅ Active | NonExportable RSA-2048, DPAPI secret fallback |
| Isolated app registrations | ✅ Active | One app reg per agent, no shared credentials |
| Least-privilege roles | ✅ Active | Only roles required for each agent function |
| Provisioner disabled at rest | ✅ Active | Enabled only during active provisioning sessions |
| Hash-chained audit log | ✅ Active | SHA256 chain, verified by `Verify-AuditLog.ps1` |
| Circuit breaker | ✅ Active | Halts after 3 consecutive Graph API failures |
| Retry with backoff | ✅ Active | Exponential backoff on 429/503/504 |
| Ticket correlation | ✅ Active | `ticketRef` required and logged on all leaver ops |
| Dual approval for leavers | ✅ Active | Pending token, 30-min expiry, second admin required |
| Operator RBAC | ✅ Active | admin / helpdesk / viewer in `operators.json` |
| Policy guardrails | ✅ Active | Sensitive licenses + freeze windows in `policies.json` |
| Credential expiry alerts | ✅ Active | 60-day warning via `Test-CredentialExpiry` |
| Purview IRM integration | ✅ Active | Termination record on every leaver run |
| Workload Identity CA policy | ⚠️ Gap | Requires Entra Workload Identities Premium (separate SKU, ~$3/SP/month, not included in Entra Suite). Risk accepted; mitigated by cert-only auth. |

## Audit Log Format

Location: `agents/audit.jsonl`

```json
{
  "timestamp": "2026-05-07T18:49:23.000Z",
  "agent": "leaver",
  "action": "LeaverProcess",
  "subject": "user@domain.com",
  "whatif": false,
  "outcome": "success",
  "details": { "ticketRef": "INC-001", "accountDisabled": true, ... },
  "prevHash": "abc123...",
  "hash": "def456..."
}
```

Validate integrity:
```powershell
.\agents\shared\Verify-AuditLog.ps1
```

Secondary sinks: Windows Application Event Log (source `JMLAgents`, EventIds 1001–1004) and Teams webhook.

## Known Gaps

| Gap | Risk Level | Mitigation |
|---|---|---|
| No Workload Identity CA (IP restriction) | Low | Mitigated by cert-only auth and isolated app regs. CA policy script ready (`New-AgentConditionalAccess.ps1`); requires Entra Workload Identities Premium (separate purchase, not in Entra Suite). |
| No MFA on agent accounts | Low | App-only accounts have no password; cannot be phished or MFA-bypassed via interactive login. |
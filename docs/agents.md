# Agent Fleet

## App Registrations

| Agent | Client ID | Config |
|---|---|---|
| ClaudeAgentJoiner | `JOINER-APP-CLIENT-ID-00000000001` | `agents/joiner/config.json` |
| ClaudeAgentMover | `MOVER-APP-CLIENT-ID-000000000002` | `agents/mover/config.json` |
| ClaudeAgentLeaver | `LEAVER-APP-CLIENT-ID-000000000003` | `agents/leaver/config.json` |
| ClaudeAgentEnroller | `ENROLLER-APP-CLIENT-ID-00000000004` | `agents/enroller/config.json` |
| AgentApprover | `APPROVER-APP-CLIENT-ID-00000000005` | `agents/approver/config.json` |
| ClaudeAgentProvisioner | `PROVISIONER-APP-CLIENT-ID-0000006` | `agents/provisioner/config.json` |
| Claude IAM Agent Auditor | see config | `agents/auditor/config.json` |
| JML-PurviewHRConnector | `PURVIEW-APP-CLIENT-ID-00000000008` | `agents/purview/config.json` |

## Entra Role Assignments (Least Privilege)

| Agent | User Admin | License Admin | Cloud Device Admin |
|---|---|---|---|
| Joiner | ✅ | ✅ | |
| Mover | ✅ | ✅ | |
| Enroller | | ✅ | ✅ |
| Leaver | ✅ | ✅ | |
| Approver | | | |

## Graph API Permissions (Application type)

| App | Permissions |
|---|---|
| Joiner | User.ReadWrite.All, Group.Read.All, GroupMember.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| Mover | User.ReadWrite.All, Group.Read.All, GroupMember.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| Enroller | User.ReadWrite.All, Group.Read.All, GroupMember.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| Leaver | User.ReadWrite.All, LicenseAssignment.ReadWrite.All, GroupMember.ReadWrite.All |
| Approver | User.Read.All, Group.Read.All |
| Provisioner | Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All |
| Auditor | User.Read.All, Group.Read.All, Directory.Read.All, AuditLog.Read.All, Reports.Read.All |

## Approver Risk Mitigations

| Control | Detail |
|---|---|
| WHATIF/LIVE banner | Prominent mode indicator before every dispatch |
| Input validation | `Invoke-ValidateInputs.ps1` called pre-dispatch |
| Dual approval for leaver | Pending token in `approver/pending/`, 30-min expiry |
| Staged leaver | Soft (disable+revoke) then Hard (licenses+groups) with confirmation |
| Operator RBAC | `approver/operators.json` — admin / helpdesk / viewer roles |
| Policy guardrails | `approver/policies.json` — sensitive licenses/groups + freeze windows |
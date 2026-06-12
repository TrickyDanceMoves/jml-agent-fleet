# Agent Fleet

## Operational Agents

| Agent | Identity type | Runtime config |
|---|---|---|
| Joiner | Least-privilege execution service principal | `joiner/config.json` |
| Mover | Least-privilege execution service principal | `mover/config.json` |
| Leaver | Least-privilege execution service principal | `leaver/config.json` |
| Enroller | Least-privilege execution service principal | `enroller/config.json` |
| Approver | Microsoft Entra Agent ID through FMI | `approver/config.json` |
| Provisioner | Service principal, disabled at rest | `provisioner/config.json` |
| Auditor | Microsoft Entra Agent ID through FMI | `auditor/config.json` |

The API, queue worker, Certifier campaign runner, Purview connector, and Electron
console support the fleet but are not counted as operational agents.

## Entra Role Assignments

| Agent | User Admin | License Admin | Cloud Device Admin |
|---|---|---|---|
| Joiner | Yes | Yes | |
| Mover | Yes | Yes | |
| Enroller | | Yes | Yes |
| Leaver | Yes | Yes | |
| Approver | | | |
| Auditor | | | |

## Microsoft Graph Application Permissions

| Identity | Permissions |
|---|---|
| Joiner | User.ReadWrite.All, Group.Read.All, GroupMember.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| Mover | User.ReadWrite.All, Group.Read.All, GroupMember.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| Enroller | User.ReadWrite.All, Group.Read.All, GroupMember.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| Leaver | User.ReadWrite.All, LicenseAssignment.ReadWrite.All, GroupMember.ReadWrite.All |
| Approver Agent ID | User.Read.All, Group.Read.All |
| Provisioner | Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All |
| Auditor Agent ID | User.Read.All, Group.Read.All, Directory.Read.All, AuditLog.Read.All, Reports.Read.All |

Microsoft Entra blocks broad directory-write scopes on Agent IDs. The fleet therefore
keeps privileged mutations on least-privilege execution service principals behind
the approval and policy control plane.

## Approver Risk Controls

| Control | Detail |
|---|---|
| Safe / Live session mode | Persistent mode state and visible execution boundary |
| Input validation | `Invoke-ValidateInputs.ps1` runs before dispatch |
| Dual approval for leaver | Pending token with a 30-minute expiry and second-operator requirement |
| Staged leaver | Soft disable and revoke, then approved hard cleanup |
| Operator RBAC | `approver/operators.json` maps admin, helpdesk, and viewer roles |
| Policy guardrails | `approver/policies.json` defines sensitive licenses, groups, and freeze windows |

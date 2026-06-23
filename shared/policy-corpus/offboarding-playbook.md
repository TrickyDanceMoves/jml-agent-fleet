# Leaver / Offboarding Playbook

The Leaver agent executes offboarding in two gated stages. The Approver grounds
leaver risk decisions against this playbook via Foundry IQ.

## Stage order (never reorder)

1. **Soft stage** - disable the account, then revoke all active sign-in sessions.
   Reversible within the rollback window. No license or group change yet.
2. **Confirmation** - Soft stage must complete and be confirmed before Hard.
3. **Hard stage** - remove licenses, then group memberships. Irreversible.

## Approval requirements

- **Hard-stage leavers require dual approval.** A helpdesk operator may request
  but not execute a Hard leaver; an admin must approve from the Approvals tab.
- A leaver for a user holding any **privileged directory role** is always routed
  to admin approval, even from an admin operator, and is logged as sensitive.

## Rollback window

- Soft-stage actions are reversible for **24 hours**. After that the account is
  treated as permanently offboarded and Hard stage may proceed automatically if
  scheduled.

## Anti-pattern (UEBA-flagged)

- **Leaver-then-group-add**: offboarding a user and then adding them to any group
  within 72 hours is a high-severity anomaly - it usually means a mistaken or
  malicious re-grant. Block and escalate.

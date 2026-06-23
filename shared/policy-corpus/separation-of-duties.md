# Separation of Duties (SoD) Policy

These rules define group and role combinations that must never co-exist on a
single identity. The Approver agent grounds every risk decision against this
corpus via Foundry IQ; a match escalates risk and requires explicit review.

## Prohibited group combinations

- **Sales-Team + Finance-Approvers** - a user who books revenue must not also
  approve the corresponding financial entries. Co-membership is a SoD violation.
- **Engineering-All + Production-DBA** - write access to product code and to the
  production datastore on one identity defeats change-control segregation.
- **Helpdesk-Operators + Identity-Admins** - ticket handlers must not also hold
  directory-admin rights; this is the classic privilege-escalation path.
- **Procurement + Vendor-Management** - raising a purchase order and onboarding
  the paying vendor must be two people.

## Sensitive single memberships (dual approval required)

- **Global-Administrator**, **Privileged-Role-Admins**, **Security-Admins** —
  any assignment requires a second approver regardless of operation risk score.

## Enforcement

A grounded SoD match raises the operation to at least **high** risk. A user who
already holds one side of a prohibited pair cannot be granted the other in Live
mode without an admin override recorded to the audit chain.

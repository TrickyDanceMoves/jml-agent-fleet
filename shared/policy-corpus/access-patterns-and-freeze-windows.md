# Approved Access Patterns & Freeze Windows

Grounding source for joiner/mover provisioning decisions and time-based holds.

## Approved baseline access by department

- **Engineering** - `Microsoft 365 E3`, groups `Engineering-All`, `M365-E3-Users`.
  Production database access (`Production-DBA`) is request-only, never baseline.
- **Sales** - `Microsoft 365 E3`, `Power BI Standard`, group `Sales-Team`.
  Never baseline `Finance-Approvers` (see separation-of-duties).
- **Finance** - `Microsoft 365 E5`, groups `Finance-Approvers`, `Procurement`.
- **Contractors / External** - `Microsoft 365 F3` only, no standing group
  membership; access is time-boxed and certified every 30 days.

## Least-privilege principle

Provisioning should match the peer baseline for the user's department (the
ProvisioningRecommendation engine computes >50%-prevalence peer access). Anything
above baseline requires a justification captured in the ticket reference.

## Freeze windows

- **Quarter-end financial close** (last 3 business days of each quarter) - no
  changes to `Finance-Approvers`, `Procurement`, or any E5 license assignment.
- **Change-freeze** (declared incidents) - no production access grants of any
  kind while a Sev-1/Sev-2 incident is open.

A grounded freeze-window match blocks the operation and instructs the operator to
reschedule after the window closes.

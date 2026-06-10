# Glass Theme Uniform Panels Design

## Goal

Make the optional Glass theme highly transparent outside information surfaces while keeping every text-bearing card, control, table, chat turn, and status panel consistently readable.

## Selected Direction

Use **Uniform Dark Frost**:

- Empty shell, content gutters, and unused regions remain nearly transparent.
- Every text-bearing surface uses one shared dark-frost material.
- Primary text is near-white; secondary and metadata text remain visibly distinct but readable.
- Remove the global text halo. Use no text shadow on normal copy and only a minimal local shadow where a control overlays a transparent shell.
- Keep the existing concentric rounded-square Glass logos.

## Panel Contract

The shared Glass text panel uses:

- A consistent 62–66% neutral blue-black backing.
- 26–28px backdrop blur.
- One subtle light inner edge and one restrained outer shadow.
- The same border color and radius behavior as the component’s normal theme.

This contract applies to cards, panels, tables, dashboard tiles, agents, event rows, security findings, user records, operation cards, audit rows, settings cards, chat turns, lifecycle panels, popovers, modals, and input controls.

Rows inside a parent panel remain transparent or use a slight hover tint. They do not each become separate dark cards unless they are independently actionable.

## Typography

- Primary: near-white.
- Secondary: soft white around 90% perceptual lightness.
- Metadata: brighter than the current muted token, around 80–84%.
- Disabled text remains clearly disabled without becoming illegible.
- No body-wide text shadow.
- Status colors remain semantic and must meet readable contrast against the shared frost panel.

## Interaction

- Buttons and form fields use the same panel material, with stronger borders than passive cards.
- Active navigation and mode controls use a localized accent tint.
- Hover states change border and local fill without reducing text contrast.
- Focus states remain clearly visible.

## Runtime QC

Evaluate the theme as an operator across:

- Dashboard
- Approver and Auditor chat
- Operations and Approvals
- Security
- Users
- Audit Log
- Graph
- Settings

Check text hierarchy, panel uniformity, empty-area transparency, hover/focus states, dense tables, failure states, scrolling, and readability over both light and dark desktop backgrounds.

## Tests

Automated CSS contract tests will verify:

- Empty-shell opacity remains low.
- Global body text shadow is absent.
- The shared panel selectors use the same material.
- Text tokens meet the selected brightness thresholds.
- Inputs, buttons, chat turns, tables, and settings cards participate in the panel system.

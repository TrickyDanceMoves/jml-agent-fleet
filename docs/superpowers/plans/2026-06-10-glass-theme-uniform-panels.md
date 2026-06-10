# Glass Theme Uniform Panels Implementation Plan

**Goal:** Implement the approved Uniform Dark Frost Glass theme with transparent shell areas, consistent readable text panels, restrained text effects, and runtime visual verification.

## Task 1: Define the CSS contract

**Files:**
- Modify: `electron-app/test/glass-theme.test.js`

1. Replace the body text-shadow expectation with an explicit no-shadow contract.
2. Require shared Glass material tokens for panels, controls, borders, blur, shadows, and row hover states.
3. Require representative text-bearing surfaces to use the shared panel material.
4. Require nested event, finding, security, live-operations, and table rows to remain transparent until hover.
5. Run the focused test and confirm it fails before implementation.

## Task 2: Implement the approved material system

**Files:**
- Modify: `electron-app/renderer/styles.css`

1. Add shared Glass material custom properties.
2. Keep the application shell and non-text gutters nearly transparent.
3. Apply one uniform dark-frost material to text-bearing cards, panels, tables, dialogs, chat surfaces, and inputs.
4. Remove body-wide text shadow and rely on high-contrast text colors.
5. Flatten nested rows so they do not become stacked dark cards.
6. Preserve semantic status colors and existing Glass logo geometry.

## Task 3: Verify behavior and appearance

**Files:**
- Modify only if needed: `electron-app/main.js`
- Modify only if needed: `electron-app/package.json`

1. Run the focused Glass test, full test suite, JavaScript syntax checks, and whitespace validation.
2. Use the existing Electron capture workflow to render the Glass theme across representative tabs.
3. Inspect Dashboard, Approver, Operations, Security, Users, Audit Log, Graph, and Settings captures for readability, material consistency, and transparent spacing.
4. Correct any visual regressions and rerun checks.

## Task 4: Launch the canonical OneDrive app

1. Stop stale JML Electron processes that reference this OneDrive project.
2. Start `npm start` from `electron-app`.
3. Confirm the application process remains running.

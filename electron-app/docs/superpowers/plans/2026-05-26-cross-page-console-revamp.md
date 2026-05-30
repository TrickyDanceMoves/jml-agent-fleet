# Cross-Page Console Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every JML Console page into the same V2 operator-console language, then review the result against the app's identity lifecycle purpose.

**Architecture:** Keep page functionality and existing DOM hooks intact. Add a shared page-brief component from `renderer/app.js` and shared visual rules in `renderer/styles.css` so each tab gets consistent operational context without one-off rewrites.

**Tech Stack:** Electron, plain HTML/CSS/JavaScript renderer, existing capture mode via `npm.cmd run capture`.

---

### Task 1: Shared Cross-Page Briefs

**Files:**
- Modify: `renderer/app.js`
- Modify: `renderer/styles.css`

- [ ] Add a `PAGE_BRIEFS` map keyed by tab id.
- [ ] Inject one `.v2-view-brief` after each non-dashboard `.head`.
- [ ] Style the brief as compact operational tiles using the V2 palette.
- [ ] Verify `node --check renderer/app.js`.

### Task 2: Global Non-Dashboard Header Pass

**Files:**
- Modify: `renderer/styles.css`

- [ ] Upgrade `.view > .head`, `.h1`, `.h1 .sub`, and `.desc` so all non-dashboard pages match the V2 density and hierarchy.
- [ ] Keep buttons and controls in `.row-flex` usable and aligned.
- [ ] Verify screenshots for at least Dashboard, Approver, Security, Audit Log, Users, Graph, Settings.

### Task 3: Functional/Visual Review

**Files:**
- Read: generated screenshots in `../docs/images/`

- [ ] Run `npm.cmd run capture`.
- [ ] Review captured tabs against the core app goal: safe identity lifecycle execution with human approval, least privilege, and tamper-evident audit.
- [ ] Document remaining risks or follow-up recommendations in the final response.

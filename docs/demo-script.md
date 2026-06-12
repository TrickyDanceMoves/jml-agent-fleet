# JML Agent Fleet — Demo Script

**Target:** Microsoft Agents League, Enterprise Agents track
**Length:** 5 minutes (timed below). A 90-second "lightning" cut is marked with ⚡.
**Thesis in one line:** *The model proposes; policy and approval decide what executes.*

> Run with synthetic identities only. The console's screenshots/captures already
> sanitize the tenant domain to `contoso.onmicrosoft.com`; do the same on camera —
> sign in as a demo operator, act on demo users (Sarah Chen, Robert Martinez).

---

## Before you hit record (presenter checklist)

- [ ] App launched once already so the **Foundry IQ + Graph session are warm** — the
      first risk/query of a cold session takes ~20s; never demo that wait.
- [ ] Theme set to **Glass**; window **focused** (acrylic blur pauses when the window
      loses focus — don't alt-tab mid-shot).
- [ ] Sidebar **collapsed** for the Glass Screen beat so the pipeline owns the frame.
- [ ] AI provider reachable (Claude key set, or Qwen models pulled). Verify with
      Settings → AI Provider → **Test connection** showing green.
- [ ] `approver/foundry-iq.json` present and `enabled: true` (grounding is live).
- [ ] A terminated demo user exists for the leaver beat (e.g. Robert Martinez).

---

## Runsheet

### 0:00 — Cold open (15s) ⚡
> "Identity operations die in the seams between HR, the directory, ticketing, and
> manual approvals. JML Agent Fleet puts AI agents in those seams — but with a hard
> rule: **an agent can propose any identity change and can execute none on its own
> authority.** Let me show you."

Open on the **Dashboard** — fleet health, today's triage, live operations.

### 0:15 — The architecture in one breath (30s) ⚡
> "Seven agents. Two reason — Approver and Auditor — and they authenticate as
> **first-class Microsoft Entra Agent IDs**. Five execute, and they deliberately
> stay on least-privilege service principals — because Entra itself *blocks*
> directory-write scopes on agent identities. That constraint isn't a limitation we
> worked around; it's the whole thesis, enforced by the platform."

Click **Agent Certs** → show the permissions matrix (who can do what) and the
Auditor/Approver rows running as Agent IDs.

### 0:45 — Grounded risk + approval (75s) — the core beat
Go to **Approver Agent**. Type:
> "Offboard Robert Martinez — INC-1042, he was terminated yesterday."

As the agent runs `score_risk`, point at the **risk card**:
> "Every decision is **grounded in our own policy corpus through Foundry IQ** — our
> Microsoft IQ layer. See the citations: the offboarding playbook's dual-approval
> rule, the separation-of-duties policy. This isn't the model's memory — it's
> retrieval from an Azure AI Search index of *our* governance documents. And it
> **fails closed**: if grounding is unreachable, the operation is blocked, not
> guessed."

Show the **dual-approval gate**: a hard leaver requires a second approver. Note the
**Safe/Live** toggle — we're in Safe (WhatIf), nothing is written yet.

### 2:00 — Watch it execute on the Glass Screen (75s) — the showpiece
Switch to **Glass Screen** (sidebar collapsed). Trigger / show the live operation:
> "This is the command center. The operation owns the page and advances through
> Request → Risk → Execute → Verify → Complete from real backend events — not a
> timer."

**Click the Execute stage.** The detail card opens:
> "Each stage shows who owns it and exactly what it ran. Execute here is the Leaver
> agent making these specific Graph calls — disable the account, revoke sessions.
> Click Risk and you see the policy citations again; click Complete and you see the
> audit seal. Nothing is hidden, nothing is decorative."

Show a **failed** run if available (or the replay of one): the pipeline stops at the
failing stage with a plain-language recovery action — never a false success.

### 3:15 — Tamper-evident evidence (45s)
Go to **Audit Log**:
> "Every operation is hash-chained — each entry signs the previous one, so the trail
> is tamper-evident by construction. It's replicated to **Microsoft Sentinel** and
> **Azure Blob** for SIEM. The operator identity on each entry is the real
> **Entra-authenticated** person who triggered it, not a local username."

Point at the integrity ribbon (chain verified) and the Operator column.

### 4:00 — Close (30s) ⚡
> "So: agents reason and propose, grounded in real policy they must cite. Risk
> scoring, separation-of-duties, freeze windows, and human approval all gate
> execution. Privileged writes live on least-privilege identities behind that gate.
> And every action is provable after the fact. **The model proposes; policy and
> approval decide what executes** — which is the only way you'd ever let an agent
> near your directory."

End on the Glass Screen idle "Fleet Ready" state.

### 4:30 — Buffer / Q&A seed
If time: show **Settings → AI Provider** (provider-agnostic: Foundry, Azure OpenAI,
OpenAI, Claude, Ollama, Qwen) and **Security** (UEBA/drift/Identity Protection findings).

---

## If something breaks on camera
- **AI call hangs / errors** → switch provider to a known-good one in Settings, or
  fall back to a pre-recorded clip of this beat. Don't debug live.
- **Grounding shows "unavailable / failed closed"** → that's *correct, demoable
  behavior*: "notice it refused to proceed rather than guess." Then reconnect.
- **Glass blur looks gray** → click the window to refocus it (acrylic pauses unfocused).
- **First query is slow** → you skipped the warm-up; talk over it once, never twice.

## One-paragraph submission blurb (for the form)
> JML Agent Fleet is an enterprise identity-governance system where AI agents run the
> full Joiner/Mover/Leaver lifecycle on Microsoft Entra ID under a hard
> propose-but-never-self-execute rule. Reasoning agents authenticate as Microsoft
> Entra Agent IDs; risk and approval decisions are grounded in the organization's own
> policy corpus via **Foundry IQ** (with citations, and fail-closed when grounding is
> unavailable); privileged execution stays on least-privilege service principals
> behind risk scoring, separation-of-duties checks, freeze windows, and human
> approval. Every action is hash-chained and replicated to Microsoft Sentinel. A live
> "Glass Screen" command center shows each operation advancing through Request → Risk
> → Execute → Verify → Complete with per-stage, per-call detail.

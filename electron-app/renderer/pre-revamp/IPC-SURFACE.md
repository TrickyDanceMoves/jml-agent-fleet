# app.js DOM Surface — Preservation Catalog

Every selector `app.js` reads, writes, or wires. Group = view/feature area.
Action codes: `R` read value/textContent · `W` write text/innerHTML · `L` attach event listener · `C` toggle class · `S` set style/display · `Q` querySelector lookup target.

## Global navigation & view shell

- `.nav-item` `L` click → `switchTab(dataset.tab)` · `C` `active` toggled by tab.
- `.nav-item[data-tab]` `R` — `dataset.tab` is the canonical tab key. **CRITICAL.** Valid values: `dashboard`, `approver`, `auditor`, `users`, `operations`, `graph`, `security`, `approvals`, `certifications`, `exports`, `audit-log`, `settings`.
- `.view` `C` `active` toggled when id matches `view-<tab>`.
- `#view-<tab>` — every tab MUST have a `.view` with id `view-` + the `data-tab` key. **CRITICAL pairing.**
- `body` `C` `role-admin` / `role-helpdesk` / `role-viewer` (drives role-based CSS gating).

## Title bar / window controls

- `#btn-minimize`, `#btn-maximize`, `#btn-close` `L` click → window IPC.
- `#btn-help` `L` open help drawer.
- `#btn-help-close` `L` close help drawer.
- `#help-drawer` `C` `open`.
- `#help-overlay` `C` `open` · `L` click → close.

## Sidebar footer / operator

- `#sidebar-operator-name` `W` current operator display name.
- `#sidebar-role-badge` `W` text + `C` className `role-badge role-<r>`.
- `#btn-switch-operator` `L` click → opens operator switch modal.

## Operator switch modal

- `#op-switch-overlay` `S` `display: flex|none` · `L` backdrop click closes.
- `#op-switch-list` `W` innerHTML with `.op-switch-btn[data-name][data-role]` entries.
- `.op-switch-btn` (dynamic) `L` click → `switchOperator` · `C` `active` for current.
- `#op-switch-cancel` `L` click → hide.

## Notification bell (title bar)

- `#btn-notif-bell` `L` click → toggle dropdown display.
- `#notif-bell-wrap` (wrapper, used for outside-click detection).
- `#notif-badge` `W` count, `S` `display: inline-block|none`.
- `#notif-dropdown` `S` `display: flex|none` · `L` click stops propagation.
- `#notif-list` `W` innerHTML with `.notif-item` rows.
- `#btn-notif-clear-all` `L` click → clear notifications.
- `.notif-dismiss[data-id]` (dynamic) `L` click → remove single notif.

## Toast / overlays

- `#toast-container` `W` append `.toast` children (auto-removed in 3s).

---

## Dashboard (`#view-dashboard`)

Stat cards — all have `loading` class removed by JS once data arrives:

- `#stat-users-total` `W` text · `C` `loading`.
- `#stat-users-detail` `W` text · `C` `loading`.
- `#stat-licenses-total` `W` text · `C` `loading`.
- `#dash-license-bars` `W` innerHTML — generated `.dash-lic-row` / `.dash-lic-track` / `.dash-lic-fill.ok|warn|danger` bars.
- `#stat-activity-total` `W` text · `C` `loading`.
- `#stat-activity-detail` `W` text · `C` `loading`.
- `#stat-approvals-count` `W` text · `C` `loading`.
- `#stat-approvals-detail` `W` text.

Security-at-a-glance strip:

- `#dash-tile-ueba`, `#dash-tile-drift`, `#dash-tile-risky` — buttons (all carry class `.dash-sec-tile`).
- `.dash-sec-tile` `L` click → `switchTab('security')`.
- `#dash-ueba-counts`, `#dash-drift-counts`, `#dash-risky-counts` `W` innerHTML with `.count-badge` chips.
- `#dash-open-security` `L` click → `switchTab('security')`.

Quick actions:

- `#dash-action-joiner` `L` click → switch to approver + prefill.
- `#dash-action-mover` `L` click → switch to approver + prefill.
- `#dash-action-leaver` `L` click → switch to approver + prefill.
- `#dash-action-audit` `L` click → switch to auditor + focus input.

Recent activity:

- `#recent-activity-list` `W` innerHTML (`.activity-item` rows).
- `.activity-item` (dynamic) `L` click → `C` `expanded` toggle.
- `#btn-view-all-activity` `L` click → `switchTab('audit-log')`.

---

## Approver chat (`#view-approver`)

- `#mode-toggle` (wrapper).
- `.mode-btn[data-mode]` `L` click — values `whatif`, `live`. `C` `active`. **CRITICAL — drives `isWhatif` state.**
- `#mode-banner-whatif` `C` `hidden` toggled by mode.
- `#mode-banner-live` `C` `hidden` toggled by mode.
- `#role-access-banner` `C` `hidden` (shown for viewer/helpdesk).
- `#role-access-text` `W` text.
- `#clear-approver` `L` click → clear history IPC.
- `#messages-approver` `W` innerHTML reset on clear; `appendChild` for messages; `scrollTop` set.
- `#input-approver` `R/W/L` value, keydown(Enter), input(slash menu), disabled toggle. Also queried as outside-click anchor.
- `#send-approver` `L` click → `sendMessage('approver')` · `disabled` toggled.
- `#approver-assist-bar` — wrapper.
- `#approver-assist-bar .assist-chip[data-prompt]` `L` click → prefill input. **`data-prompt` REQUIRED.**
- `.example-chip` `L` click (`closest('#view-approver')` determines agent) → prefill + auto-send.
- `#slash-dropdown` `C` `hidden` · `W` innerHTML with `.slash-item[data-prompt]`.
- `.slash-item` (dynamic) `L` mousedown → fill input · `C` `active` keyboard nav.

## Auditor chat (`#view-auditor`)

- `#clear-auditor` `L` click → clear history.
- `#messages-auditor` `W` (same pattern as approver).
- `#input-auditor` `R/W/L` same pattern + queried by dashboard "Run Audit Query" quick action.
- `#send-auditor` `L` click + `disabled`.
- `.example-chip` inside `#view-auditor` (resolved via `closest`).

### Streaming message DOM (dynamically generated inside `#messages-<agent>`)

These class names are written by `appendUserMessage` / `appendAssistantPlaceholder` and **read back** during chunk streaming — preserve them:

- `.message`, `.message.user`, `.message.assistant`
- `.message-bubble`
- `.message-avatar`, `.avatar-approver`, `.avatar-auditor`
- `.message-body`, `.message-text` (`Q` per-chunk, `dataset.raw` storage), `.tool-indicators` (`Q`), `.typing-indicator` (`Q`, `S` display)
- `.tool-indicator` `C` `running`/`done`/`failed`, `dataset.tool="<toolName>"` or `"<toolName>-batch"` (`Q` `[data-tool="..."]`).
- `.tool-spinner`, `.tool-status-icon`, `.tool-label` (`Q` and rewritten).
- `.welcome-msg`, `.welcome-title`, `.welcome-body`, `.welcome-examples` (rendered by `appendWelcome`).
- `.error-text` (written inside `.message-text` on error).

---

## Security (`#view-security`)

- `#refresh-security` `L` click → reload.
- `#security-last-updated` `W` text (currently unused-write but referenced).
- Summary tiles: `#sec-ueba`, `#sec-drift`, `#sec-risky` (inline-onclick scrollIntoView — kept in markup, not JS).
- For each id prefix `ueba`/`drift`/`risky` JS reads/writes:
  - `#sec-<id>-counts` `W` innerHTML (count badges).
  - `#sec-<id>-meta` `W` text "Last run …".
  - `#sec-<id>-run` `W` text (inside section header).
  - `#sec-<id>-badge` `W` text · `C` className `sec-section-badge badge-critical|warning|clear`.
  - `#sec-<id>-list` `W` innerHTML (finding cards).
- Section anchors used by inline scrollIntoView in HTML: `#sec-section-ueba`, `#sec-section-drift`, `#sec-section-risky`.
- Dynamic finding card classes (written by JS — preserve in CSS): `.sec-finding-card`, `.sev-border-critical|warning|info`, `.sec-finding-top`, `.sec-sev-chip.sev-*`, `.sec-rule-id`, `.sec-finding-title`, `.sec-finding-count`, `.sec-finding-chips`, `.sec-upn-chip`, `.sec-finding-footer`, `.sec-agent-tag`, `.sec-ts`, `.sec-finding-note`, `.sec-clear-state`, `.sec-risky-user-card`, `.sec-risky-avatar`, `.sec-risky-body`, `.sec-risky-top`, `.sec-risky-name`, `.sec-risky-upn`, `.sec-risky-meta`, `.sec-risky-state`, `.sec-risky-detail`, `.count-badge.critical|warning|info|ok|loading`.

Agent Health:

- `#agent-health-grid` `W` innerHTML — `.agent-health-card.status-<status>`, `.health-card-name`, `.health-cred-badge.cert|secret|unknown`, `.health-expiry`, `.days-critical|warning|ok`, `.health-activity`, `.health-outcome-badge.<outcome>`.

Stale Account Manager (collapsible `#sec-stale`):

- `#stale-days` `R` value.
- `#btn-scan-stale` `L` click · `disabled`/`textContent`.
- `#btn-disable-stale` `S` display · `L` click · `disabled`/`textContent`.
- `#stale-results` `W` innerHTML (`.stale-table`, `.stale-check[data-id]`, `#stale-check-all` master checkbox).

Certificate Expiry (collapsible `#sec-cert-expiry`):

- `#sec-cert-expiry` `L` toggle event → fetch on open.
- `#cert-expiry-body` `W` innerHTML (`.cert-expiry-table`, `.days-critical|warning|ok`).

SoD Conflict Tester (collapsible `#sec-sod-tester`):

- `#sod-test-group-a` `R`, `#sod-test-group-b` `R`, `#sod-test-upn` `R` (also gets autocomplete).
- `#btn-test-sod` `L` click · `disabled`/`textContent`.
- `#sod-tester-result` `W` innerHTML · `C` className `sod-tester-result sod-result-block|warn|pass` · `S` display.

PIM Roles (collapsible `#sec-pim`):

- `#btn-load-pim` `L` click · `disabled`/`textContent`.
- `#pim-roles-list` `W` innerHTML (`.pim-role-table`, `#pim-row-<idx>` rows, `.btn-pim-activate[data-idx][data-id]`).
- Dynamic per-row IDs: `pim-row-<idx>`, `pim-just-<idx>`, `pim-dur-<idx>`. **Generated.**
- Dynamic buttons: `.btn-pim-activate`, `.btn-pim-confirm`, `.btn-pim-cancel`, `.pim-inline-form-row`, `.pim-activate-form`.

---

## Exports (`#view-exports`)

- `#refresh-exports` `L` click.
- `#exports-last-updated` `W` text.

For `blob` and `sentinel` (parameterised — both prefixes are valid keys):

- `#<type>-status-chip` `W` text · `C` className `export-status-chip chip-unknown|unconfigured|error|ok|configured`.
- `#<type>-last-run` `W` text.
- `#<type>-error` `W` text.
- `#btn-run-<type>` `L` click · `disabled`/`textContent`. (`blob` → "Export Now"/"Exporting…"; `sentinel` → "Ingest Now"/"Ingesting…".)
- Blob-specific: `#blob-container` `W`, `#blob-entries` `W`.
- Sentinel-specific: `#sentinel-workspace` `W`, `#sentinel-events` `W`.

License utilization (collapsible `#export-license-util`):

- `#btn-load-license-util` `L` click · `disabled`/`textContent`.
- `#license-util-body` `W` innerHTML (`.license-util-table`, `.util-ok|warn|crit`).

HR Event Queue:

- `#hr-azurite-chip` `W` text · `C` className `export-status-chip chip-ok|error`.
- `#hr-queue-body` `W` innerHTML (`.queue-events-table`, `.queue-depth-badge`).

---

## Approvals (`#view-approvals`)

- `#refresh-approvals` `L` click.
- `#approvals-list` `W` innerHTML with `.approval-card[data-id]` entries.
- `#approvals-count` `W` text.
- Dynamic per-card: `.approval-card.expired`, `.approval-header`, `.approval-upn`, `.approval-badge.joiner|hard|soft|expired-badge`, `.approval-token`, `.approval-meta`, `.dim-label`, `.approval-detail-table`, `.approval-risk`, `.risk-chip.risk-high|risk-low`, `.approval-actions`.
- `.btn-approve[data-id]` (dynamic) `L` click → `approvePending`.
- `.btn-reject[data-id]` (dynamic) `L` click → `rejectPending`.

---

## Operations (`#view-operations`)

Quick Mover (collapsible `#ops-quick-mover` — `setAttribute('open','')` from user detail panel):

- `#qm-upn` `R/W` value (autocomplete attached).
- `#qm-dept` `R`, `#qm-title` `R`, `#qm-manager` `R`.
- `#qm-whatif` `R` checked.
- `#btn-run-quick-mover` `L` click · `disabled`/`textContent`.
- `#qm-result` `W` innerHTML · `S` display. Inner classes: `.qop-action`, `.qop-warn`, `.qop-error`, `.qop-whatif`.

Quick Leaver (collapsible `#ops-quick-leaver` — `setAttribute('open','')`):

- `#ql-upn` `R/W` value (autocomplete attached).
- `input[name="ql-stage"]` `R` checked, value `Soft`/`Hard`. **`name="ql-stage"` is REQUIRED — selected via `document.querySelector('input[name="ql-stage"]:checked')` and `[value="Soft"]`/`[value="Hard"]`.**
- `#ql-reason` `R`, `#ql-whatif` `R` checked.
- `#btn-run-quick-leaver` `L` click · `disabled`/`textContent`.
- `#ql-result` same pattern as `#qm-result`.

Bulk Import:

- `#bulk-csv-input` `R/L` input event for preview count.
- `#bulk-preview-count` `W` text.
- `#bulk-whatif` `R` checked.
- `#btn-run-bulk` `L` click.
- `#bulk-progress-list` `W` clear + `appendChild` of `.bulk-progress-row#bulk-row-<i>` (with `.bulk-icon`, `.bulk-upn`, `.bulk-status`). Dynamic IDs `bulk-row-0..n`. `C` `done`/`error`.

Scheduled Ops:

- `#sched-op` `R` value (select).
- `#sched-upn` `R/W` value (autocomplete attached).
- `#sched-when` `R/W` value (datetime).
- `#sched-whatif` `R` checked.
- `#btn-schedule` `L` click.
- `#sched-list` `W` innerHTML (`.sched-item[data-id]`, `.sched-op`, `.sched-upn`, `.sched-when`, `.sched-status.<status>`, `.btn-cancel-sched[data-id]`).

---

## Certifications (`#view-certifications`)

- `#btn-refresh-certs` `L` click.
- `#cert-whatif` `R` checked.
- `#btn-cert-all` `L`, `#btn-cert-user-groups` `L`, `#btn-cert-agent-pim` `L`.
- `#cert-result` `S` display.
- `#cert-result-lines` `W` innerHTML.
- `#cert-result-table-wrap` `W` innerHTML (`.cert-campaign-card`, `.cert-campaign-header`, `.cert-campaign-type-icon`, `.cert-campaign-name`, `.cert-status-badge.cert-status-active|completed|error|pending`, `.cert-campaign-meta`, `.cert-meta-item`).
- `#cert-history-body` `W` innerHTML (`.cert-hist-entry`, `.cert-hist-icon.cert-hist-ok|fail|neutral`, `.cert-hist-body`, `.cert-hist-top`, `.cert-hist-subject`, `.cert-hist-ts`).

---

## Settings (`#view-settings`)

Sensitive Licenses:

- `#policy-sensitive-licenses` `W` innerHTML (`.policy-tag`, `.policy-tag-remove[data-field][data-index]`).
- `#input-add-license` `R/W` value.
- `#btn-add-license` `L` click.

Sensitive Groups:

- `#policy-sensitive-groups` `W` innerHTML (same pattern).
- `#input-add-group` `R/W` value.
- `#btn-add-group` `L` click.

Freeze Windows:

- `#freeze-tbody` `W` innerHTML — rows hold `input[data-fi][data-fk]` (`data-fk` in `name`/`days`/`allDay`) plus delete button with `data-fi`. **Per-row `data-fi`/`data-fk` REQUIRED.**
- `#btn-add-freeze` `L` click.

Policy save:

- `#btn-save-policies` `L` click.
- `#policies-save-status` `W` text.

SoD rules:

- `#sod-tbody` `W` innerHTML (`.btn-del-sod[data-i]`).
- `#sod-id`, `#sod-desc`, `#sod-action` (select), `#sod-a-type`, `#sod-a-name`, `#sod-b-type`, `#sod-b-name` all `R/W` value (cleared after add).
- `#btn-add-sod-rule` `L` click.
- `#btn-save-sod` `L` click.
- `#sod-save-status` `W` text.

Operators:

- `#op-tbody` `W` innerHTML (`.btn-del-op[data-user]`).
- `#input-add-op-user` `R/W` value.
- `#input-add-op-role` `R` value (select).
- `#btn-add-operator` `L` click.
- `#btn-save-operators` `L` click.
- `#operators-save-status` `W` text.

---

## Audit Log (`#view-audit-log`)

- `#refresh-log` `L` click.
- `#log-count` `W` text.
- `#btn-toggle-timeline` `L` click · `C` `active` · `S` color.
- Filter bar:
  - `#log-filter-agent` (select) `R` value, populated dynamically with `<option>` per agent.
  - `#log-filter-outcome` (select) `R` value.
  - `#log-filter-upn` (input) `R` value (autocomplete attached).
  - `#log-filter-date-from` `R` value.
  - `#log-filter-date-to` `R` value.
  - `#btn-log-filter-apply` `L`, `#btn-log-filter-clear` `L`.
- `#log-table` `S` display (toggled with timeline).
- `#log-tbody` `W` innerHTML. **Row colspan is `7` in JS — keep 7-column header.** Cells: `.mono`, `.outcome.success|partial|failed`, `.badge-whatif`/`.badge-live`, `.dim`, `.empty-row`.
- `#log-timeline` `S` display · `W` innerHTML (`.timeline-list`, `.timeline-item`, `.timeline-dot-wrap`, `.timeline-dot.success|partial|failed|whatif`, `.timeline-line`, `.timeline-content`, `.timeline-header`, `.timeline-agent`, `.timeline-action`, `.timeline-subject`, `.timeline-time`).

---

## Users (`#view-users`)

- `#user-search-input` `R/W/L` value, keydown(Enter) — also has autocomplete attached.
- `#btn-user-search` `L` click — also `.click()`-ed programmatically when autocomplete selects.
- `#user-search-count` `W` text.
- `#user-results-list` `W` innerHTML — `.user-result-item[data-id][data-upn]` with `.user-result-badge.enabled|disabled`, `.user-result-name`, `.user-result-upn`. Items get `C` `active`.
- `#user-detail-panel` `S` display.
- `#udp-name` `W` text.
- `#udp-upn` `W` text.
- `#udp-badge` `W` text · `C` className `user-detail-badge enabled|disabled` · `S` background/color.
- `#udp-details` `W` innerHTML (`.user-detail-row`, `.user-detail-key`, `.user-detail-val`).
- `#udp-licenses` `W` innerHTML (`.user-tag`).
- `#udp-groups` `W` innerHTML (`.user-tag`).
- `#udp-manager` `W` innerHTML (`.user-tag`).
- `#udp-btn-mover` `L` click → switch to operations + open `#ops-quick-mover`.
- `#udp-btn-leaver-soft` `L` click → switch to operations + open `#ops-quick-leaver` + check Soft radio.
- `#udp-btn-leaver-hard` `L` click → switch to operations + open `#ops-quick-leaver` + check Hard radio.

---

## Graph (`#view-graph`)

- `#graph-method` (select) `R/W` value · `L` change → toggle body area.
- `#graph-url` `R/W` value.
- `#graph-body` (textarea) `R/W` value · `S` display (hidden unless POST/PATCH).
- `#btn-run-graph` `L` click · `disabled`/`textContent`.
- `#btn-copy-graph-resp` `L` click · `S` display.
- `#btn-color-json` `L` click · `C` `active` · `W` text "Plain"/"Color" · `S` display.
- `.graph-cq-chip[data-method][data-url]` `L` click → prefill method+url. **Both data attrs REQUIRED.**
- `#graph-assist-input` `R/L` value, keydown(Enter).
- `#btn-graph-assist` `L` click · `disabled`/`textContent`.
- `#graph-recent-wrap` `S` display.
- `#graph-recent-list` `W` innerHTML (`.graph-recent-item[data-idx]`, `.graph-recent-method`, `.graph-recent-url`).
- `#graph-response-panel` `S` display.
- `#graph-resp-meta` `W` text.
- `#graph-response-pre` `W` text/innerHTML (highlighted JSON: spans `.gjn|.gjk|.gjs|.gjb|.gjz`).
- `#graph-digest-card` `S` display.
- `#graph-digest-text` `W` text.
- `.graph-content` inside `#view-graph` `Q` — JS **appends `#graph-archiver-wrap` dynamically** to it. The wrap then contains `#archiver-source-filter` (select) and `#btn-clear-archive`.

---

## Cross-cutting / shared

### Autocomplete (`setupUserAutocomplete`)

Attached at startup to these inputs (must remain queryable by ID):
- `#user-search-input`, `#qm-upn`, `#ql-upn`, `#sod-test-upn`, `#sched-upn`, `#log-filter-upn`.

Creates a floating `.ac-dropdown` appended to `body` with `.ac-item[data-upn][data-name]`, `.ac-name`, `.ac-upn`, `.ac-loading`. Positioned via `getBoundingClientRect()` on the input — input must be a real positioned element.

### Selectors used in MULTIPLE places

- `.nav-item` — iterated for tab switching (top of file) AND iterated again at the bottom inside the Graph archiver block to attach an extra listener on the `graph` tab. **`data-tab` must remain on every nav button.**
- `.example-chip` — present in BOTH `#view-approver` and `#view-auditor`; agent inferred via `chip.closest('#view-approver')`. Keep both wrappers as ancestors.
- `.mode-btn` — iterated globally for `active` class reset (only present in approver; safe but bear in mind).
- `.dash-sec-tile` — iterated globally to wire `switchTab('security')`.
- `.graph-cq-chip` — iterated to wire quick-pick chips.
- `input[name="ql-stage"]` — queried globally by `document.querySelector(...:checked)` AND by `[value="Soft"]`/`[value="Hard"]`. Both radios must share `name="ql-stage"`.
- `input[type="text"]` and `input[type="checkbox"]` inside `#freeze-tbody` — iterated per render; must carry `data-fi` + `data-fk`.

### Dynamically generated IDs (cannot be hand-written in HTML, but downstream CSS/JS expects them)

- `bulk-row-<i>` (one per CSV row).
- `pim-row-<idx>`, `pim-just-<idx>`, `pim-dur-<idx>` (one per PIM role).
- `graph-archiver-wrap`, `archiver-source-filter`, `btn-clear-archive` (injected into `.graph-content`).
- `stale-check-all` (inside `#stale-results`).
- The floating autocomplete `.ac-dropdown` (appended to `body`).

### Data-attributes that drive behaviour (preserve names exactly)

- `data-tab` on `.nav-item` — keys listed at top.
- `data-mode` on `.mode-btn` — `whatif` | `live`.
- `data-prompt` on `.assist-chip` and `.slash-item`.
- `data-method` + `data-url` on `.graph-cq-chip`.
- `data-id` on `.approval-card`, `.btn-approve`, `.btn-reject`, `.sched-item`, `.btn-cancel-sched`, `.user-result-item`, `.stale-check`, `.notif-item`, `.notif-dismiss`, `.ac-item` (also `data-upn`/`data-name`), `.btn-pim-activate`.
- `data-upn` on `.user-result-item`, `.ac-item`.
- `data-name` on `.ac-item`, `.op-switch-btn`.
- `data-role` on `.op-switch-btn`.
- `data-user` on `.btn-del-op`.
- `data-field` + `data-index` on `.policy-tag-remove`.
- `data-fi` + `data-fk` on freeze-window inputs.
- `data-i` on `.btn-del-sod`.
- `data-idx` on `.btn-pim-activate`, `.graph-recent-item`.
- `data-tool` on `.tool-indicator` (value = tool name or `<tool>-batch`).
- `dataset.raw` on `.message-text` (stores accumulating markdown).

### Class flags toggled by JS (preserve in CSS)

- `active` — on `.nav-item`, `.view`, `.mode-btn`, `.slash-item`, `.user-result-item`, `.op-switch-btn`, `#btn-toggle-timeline`, `#btn-color-json`.
- `hidden` — on `#mode-banner-whatif`, `#mode-banner-live`, `#role-access-banner`, `#slash-dropdown`.
- `loading` — on stat values + count badges.
- `expanded` — on `.activity-item`.
- `open` — on `#help-drawer`, `#help-overlay`.
- `done`, `error`, `failed`, `running` — on `.bulk-progress-row`, `.tool-indicator`.

### CSS variables read by JS (must remain defined)

`--accent`, `--success`, `--success-soft`, `--danger`, `--danger-soft`, `--warning`, `--text-dim`, `--text-muted`, `--bg-card`, `--border`, `--radius`, `--clr-danger`.

### IDs queried but currently no-op write

- `#stats-grid`, `#stat-users`, `#stat-licenses`, `#stat-activity`, `#stat-approvals` — wrapper IDs in HTML; JS only writes to inner `*-total`/`*-detail` children. Wrappers serve as CSS hooks only.

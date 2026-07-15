# Cortex OS — Current State

> **Last updated:** 2026-07-14 (Cloudflare Access security fix, Budget Editor data layer + write path, Identity v5, teal rebrand)
> **Updated by:** Claude (Sebas, work account)
>
> This is a **snapshot of the system right now**, not a history. If a section feels stale, rewrite it. History lives in `/sessions/`.
>
> **⚠ Reconciliation note (2026-06-01):** the pacing data layer was rebuilt (native tables + n8n webhook) and the docs lagged behind. This version reconciles the pacing pipeline to what actually runs, while preserving Nate's CTM section from the 05-30 update. If you find it stale again, `git pull` first, verify against the running system (LEARNINGS L-013), and rewrite.
>
> **Update (2026-06-17, session 7):** Nextdoor spend moved off the other-channels Sheet to a direct API pipeline (Cloud Run Job → `budget.nextdoor_spend_daily`). `actual_spend_all` now has a third CTE and excludes Nextdoor from the Sheet branch. See ADR-010.
>
> **Update (2026-06-17, session 8):** Post-deploy fixes. Backfilled the June 1–13 Nextdoor ingestion gap. Fixed SPENT MTD $0 (all channels) — the pacing webhook query was a stale explicit column list, now `p.*`; that webhook is now **administered by us**. Swapped Nextdoor in `actual_spend_mtd` too (Sheet → API), the second of the two parallel spend views. See LEARNINGS L-019/L-020, PENDING P-TECH-12/13.
>
> **Update (2026-07-05, Meta ingest session):** Meta Ads spend moved off the other-channels Sheet to a direct API pipeline (Cloud Run Job → `budget.meta_spend_daily`). Both `actual_spend_all` and `actual_spend_mtd` now read Meta from the API table and exclude it from the Sheet branch. Second channel on the ADR-010 template. See ADR-011, LEARNINGS L-021. Reconciliation surfaced a Sheet under-capture (Savannah, P-OPS-09) and a bad Daytona account id (resolved via a per-channel crosswalk INSERT).
>
> **Update (2026-07-13/14, security + Budget Editor + Identity + rebrand session):** Six things landed: (1) **Critical security fix** — `cortex-cmv.pages.dev` was publicly accessible with no auth (a Cloudflare Access app existed but its hostname rule covered only `*.cortex-cmv.pages.dev`, not the apex domain); fixed by adding the apex as a second public hostname. The site is now gated to `@rightideacreative.net` only. (2) **Budget Editor** shipped: a BigQuery data layer (`budget.budget_events` append-only log, `budget.budget_base_current`, `budget.budget_pacing_rollover` implementing an automatic rollover model) plus a working write path (`functions/api/budget-events.js`) and a `budget-history.html` audit-log UI. RJ Nelson's committed-budget/actual split (name mismatch "RJ Nelson" vs "RJ Nelson Co.") was fixed in the planner Sheet as part of this work. (3) **Identity v5** replaced the Budget Editor's original fixed-role permission table with a capability-based system (new `identity` dataset) — see "Identity & Permissions" below and ADR-012. (4) **Rebrand**: `cortex-shell.js` and `index.html` moved to a teal (`#00D4AA`) on carbon (`#0d0d12`) identity, wordmark "CORTEX OS"; all page `<title>` tags corrected from "Córtex" to "CORTEX". The 10 internal pages still carry the old light/blue styling (pending pass, P-TECH-15). (5) An **Admin nav category** was added to the shell with a link to Identity management, gated to `admin.users` capability. (6) Confirmed the `/kpi` page has never worked (server 500 on `api/kpi`, unrelated to any of the above) — P-TECH-17.

## Platform

Cortex OS is a static web app hosted on **Cloudflare Pages**, connected to this GitHub repo for auto-deploy on push to `main`.

- **Production URL:** https://cortex-cmv.pages.dev
- **Pacing module path:** `/ad-spend-pacing` (the `.html` path 308-redirects to this).
- **Auto-deploy:** push to `main` re-renders the site (~1-2 min). **Verified 2026-06-17 (session 8):** Cloudflare Pages is connected to `right-idea-creative/cortex` with automatic deployments; the active production deployment ties to a `main` commit and the deployment history shows **no Direct Uploads**. The repo IS the source of truth — production serves what's on `main`.
- **Tech stack:** HTML + vanilla JS + Chart.js (CDN). No build step, no framework, no server runtime. A shared shell was extracted to `cortex-shell.js` (2026-05-31), now on its third revision (v3, capability-gated nav — see Identity section).
- **Security:** gated end-to-end by Cloudflare Access as of 2026-07-13 (see "Security: Cloudflare Access" below). Before this date the production URL was unintentionally public.

## Modules

| Module | Path | Status | Data source | Refresh |
| --- | --- | --- | --- | --- |
| Home | `/` (`index.html`) | Live | static, dark/teal, all modules grouped by category | manual |
| Call Tracking | `/call-tracking.html` | Live | `data.json` | manual |
| Ad Spend Pacing | `/ad-spend-pacing` | Live | n8n webhook `odc-pacing-data` → `budget.pacing_api` | live (browser fetches webhook on load, no cache) |
| Campaign Triage | `/triage.html` | Live | `triage_data.json` / webhook | — |
| Budget Planning | `/budget-planning.html` | Live, active development | `functions/api/budget-events.js` → `budget.budget_events` (BigQuery, direct writes) | live |
| Budget History | `/budget-history.html` | Live | `functions/api/budget-events.js` (read + admin soft-delete) | live |
| Tickets | `/tickets.html` | Live | n8n webhook (`monday-proxy.js`) | live |
| Roadmap | `/roadmap.html` | Live | `functions/api/roadmap.js` | — |
| Strategy | `/strategy.html` | Live | `functions/api/strategy.js` (Neon-backed) | — |
| KPI Criteria | `/kpi.html` | **Broken — 500 error** | `functions/api/kpi.js` (Neon-backed) | — see P-TECH-17 |
| Account Standard | `/account-standard.html` | Live | `functions/api/account-standard.js` | — |

**The pacing module reads its data live from an n8n webhook.** No static JSON, no export script, no GitHub Action in the live path (removed — see ADR-009 and session 2026-06-01).

## Pacing data flow (the important part)

```
committed_budget_long (Sheet) ─► raw_budget.committed_budget_long (external)
                                  └─► budget.committed_budget_live (NATIVE, daily 05:00 UTC) ─┐
                                                                                              │
raw_google_ads (Google Ads DTS, daily)                                                        │
other_channels Sheet ─► raw_budget.other_channels_normalized (external)                        │
                        └─► budget.other_channels_live (NATIVE, daily 05:00 UTC) ─┐            │
                                                                                  ▼            ▼
                                                          budget.actual_spend_all (VIEW) ◄──────┤
                                                          budget.actual_spend_mtd (VIEW) ◄──────┘
                                                                                  │
client_crosswalk (active=TRUE) ─► AM + source_group enrichment ───────────────────┤
                                                                                  ▼
                                                          budget.pacing_api (VIEW)
                                                                                  │
                              n8n webhook odc-pacing-data (SELECT * FROM pacing_api + mondayClientId)
                                                                                  │
                                          Dashboard https://cortex-cmv.pages.dev/ad-spend-pacing (live fetch)
```

**Nextdoor (ADR-010) and Meta (ADR-011):** neither comes from the other-channels Sheet any more. Cloud Run Jobs (`cortex-nextdoor-ingest`, `cortex-meta-ingest`) pull their APIs daily into native tables; `actual_spend_all` and `actual_spend_mtd` read those channels from the API tables and exclude them from the Sheet branch. The Sheet path now carries **Bing and LSA only**.

Why native tables instead of querying the Sheets directly: an external table on a Google Sheet fails the **entire** view when the Drive credential drops. Materializing to native tables isolates that failure. See ADR-008 and LEARNINGS L-014.

## Security: Cloudflare Access

`cortex-cmv.pages.dev` is gated by **Cloudflare Access** (Zero Trust), account `right-idea-creative`. The application "cortex - Cloudflare Pages" covers **two** public hostnames: `*.cortex-cmv.pages.dev` (wildcard) and the apex `cortex-cmv.pages.dev` (added 2026-07-13 — the wildcard alone left the apex, i.e. the actual production URL, completely unprotected; anyone with the link could see all client budgets, spend, and names). Policy "Allow Members - Cloudflare Pages": `Include → Emails ending in → rightideacreative.net`. Login method: One-Time PIN, "Select all" identity providers. Verified via the Policy Tester that all current team emails (Cole, Eli, Nate, Martin, Wendy, Kyle, Juanes, Sebas) resolve to `allowed` — no manual per-user approval needed; the tester is diagnostic only, not a queue.

**Do not rename the Access "team"** (shows as `odc-chippewa-valley` on login screens — cosmetic leftover, not a bug) without care, since it affects every app's login URL.

## Budget Editor

Lets account managers edit committed budgets directly in Cortex instead of the fragile `committed_budget_long` Google Sheet, with an automatic rollover model and full audit history. Status: data layer + write path + audit UI are live; the AM-scoped edit UI (`budget-planning.html`) is in active development (gained month-range add 2026-07-14).

**BigQuery objects (dataset `budget`):**

| Object | Type | What it is |
| --- | --- | --- |
| `budget_events` | NATIVE, append-only | The edit log. Never UPDATE/DELETE — every change is a new row (`event_id, client, channel, year, month, amount, alloc_type, event_type, changed_by, changed_at, note`). Partitioned by `changed_at`. Soft-delete tombstones added 2026-07-14 (ADR-012) rather than physical deletes. |
| `budget_base_current` | VIEW | Current base budget per client/channel/month: most recent `budget_events` row wins; falls back to `committed_budget_live` if no event exists. Casts `committed_budget_live`'s STRING `year`/`month` to INT64 to align types. |
| `budget_pacing_rollover` | VIEW | Implements the rollover model: `available_amount = base_amount + rollover_in`, where `rollover_in` is the running sum of `(base − actual)` for prior months of the **same calendar year** (resets to 0 every January). Joins `budget_base_current` against `actual_spend_all`. Overspend rolls negative on purpose (the "agency absorbs it" case) — validated on ODC Allentown. |

**Permissions:** originally `budget.am_directory` (simple editor/viewer/admin roles + a `monday_am_name` bridge to `client_mapping.account_manager`); **superseded 2026-07-14 by Identity v5** (see below). `am_directory` is kept only as a legacy fallback in the write path.

**Frontend:** `budget-planning.html` (edit UI; gained month-range add — From/To, defaulting current month through December — 2026-07-14) and `budget-history.html` (append-only audit log UI; gained admin selection/soft-delete 2026-07-14). Backend: `functions/api/budget-events.js` (Pages Function; reads `identity.user_access` first, falls back to `budget.am_directory`).

**Known fixed incidents:** both `budget.am_directory` and (later) `identity.users` were found with duplicated rows from non-idempotent seed re-runs, breaking affected users' ability to edit (surfaced as "it won't let me edit" with no visible error — first Eli, then Juanes). Both deduplicated via `ROW_NUMBER()` partitioned by email. See LEARNINGS L-022 — this is a known recurring failure mode for identity/permission tables, not a one-off; watch for it in any future seed.

## Identity & Permissions (dataset `identity`)

**Added 2026-07-14 (Identity v5, ADR-012).** Replaces `budget.am_directory`'s fixed roles with capability-based access control.

| Object | Type | Purpose |
| --- | --- | --- |
| `identity.roles` | table | 6 roles (`admin`, `executive`, `account_manager`, `analyst`, `developer`, `client`), each with a `capabilities` array (`budgets.view`, `budgets.edit`, `budgets.delete`, `budgets.history`, `kpi.view`, `accounts.view`, `admin.console`, `admin.users`, etc). `admin` = wildcard `["*"]`. |
| `identity.users` | table | Per-person: email, display name, job title, `monday_am_name` (bridge to `client_mapping.account_manager`), assigned role, `extra_capabilities`/`revoked_capabilities` (per-person overrides), `active`. |
| `identity.user_access` | table | Resolved effective capabilities per email — what `functions/api/budget-events.js` and `cortex-shell.js` actually query. |

**Current assignments:** Cole Bauer, Eli Monson, Kyle Stazzoni → `account_manager`. Nate Rutledge → `executive`. Sebas Guzman → `admin`. Martin Rodriguez, Wendy Velasquez, Juanes Morales → `analyst`. `developer`/`client` roles defined, not yet assigned/wired.

**Shell integration:** `cortex-shell.js` v3 gates nav by capability (e.g. `budgets.history` link only renders for roles that carry it), replacing the old hardcoded `adminOnly`/`gated` flags. An **Admin nav category** was added (2026-07-14, commit `fd15cf7`) with a link to Identity management, visible only to capability `admin.users`.

## Frontend rebrand (2026-07-13/14)

`cortex-shell.js` and `index.html` moved from the original navy/blue identity to **teal (`#00D4AA`) on carbon (`#0d0d12`)**, wordmark "CORTEX OS" (was "Córtex OS") with an inline SVG mark. `index.html` was redesigned dark and now surfaces **all** nav modules grouped by category (Performance / Budgets / Ops), not just 4 featured cards. All page `<title>` tags across the site corrected from "Córtex" to "CORTEX". The n8n ticket-bot widget was retargeted to teal/carbon by direct-class CSS overrides (its `--chat--*` CSS variables are not honored by the installed widget version; targeting `.chat-header`/`.chat-window-toggle`/etc. directly works — including a fix for the widget rendering flush against the left edge). The bot's PWA `manifest.json` link was removed from the shell's injected tags — Cloudflare Access intercepts and CORS-blocks it, which only polluted the console with no functional loss.

**Not yet migrated:** the 10 internal pages (`strategy.html`, `kpi.html`, `account-standard.html`, `budget-planning.html`, `budget-history.html`, `triage.html`, `call-tracking.html`, `ad-spend-pacing.html`, `tickets.html`, `roadmap.html`) still carry the pre-rebrand light/blue body styling — only the shared shell chrome and `index.html` are on the new identity so far. See P-TECH-15.

## Repo layout

```
right-idea-creative/cortex/
├── index.html                    # Home — dark/teal, all modules by category
├── call-tracking.html
├── ad-spend-pacing.html          # Reads n8n webhook; uses cortex-shell.js
├── budget-planning.html          # Budget Editor edit UI
├── budget-history.html          # Budget Editor audit log UI
├── triage.html
├── tickets.html
├── roadmap.html
├── strategy.html
├── kpi.html                      # BROKEN — 500 on api/kpi, see P-TECH-17
├── account-standard.html
├── cortex-shell.js                # Shared shell — v3, teal/carbon, capability-gated nav
├── favicon.svg / favicon.ico / favicon-*.png   # Teal brand favicon set
├── manifest.json                  # PWA manifest (not linked from shell — CORS/Access conflict)
├── data.json / triage_data.json
├── pacing_api_view.sql            # STALE vs live view, see PENDING P-TECH-08
├── nextdoor-ingest/                # Cloud Run Job: Nextdoor Ads API -> BigQuery (ADR-010)
├── meta-ingest/                    # Cloud Run Job: Meta Marketing API -> BigQuery (ADR-011)
├── functions/
│   ├── monday-proxy.js            # Monday ticket proxy (Bearer token)
│   └── api/
│       ├── budget-events.js       # Budget Editor read/write, Identity-gated
│       ├── kpi.js                 # BROKEN, returns 500
│       ├── strategy.js            # Neon-backed
│       ├── roadmap.js
│       ├── roadmap-agent.js       # posts to n8n webhook
│       └── account-standard.js
├── README.md
└── docs/                          # This shared brain
```

Removed 2026-06-01 (old static-JSON pacing pipeline): `export_pacing_data.py`, `pacing-data.json`, `requirements.txt`, `.github/workflows/refresh-pacing.yml`.

## GCP infrastructure

**Project:** `rightidea-cortex` (number `427224510681`)

### BigQuery datasets

| Dataset | Purpose |
| --- | --- |
| `raw_google_ads` | Daily transfer from Master MCC `611-819-8619`. Main table: `p_ads_CampaignBasicStats_6118198619`. |
| `raw_budget` | External tables on the source Sheets: `committed_budget_long` and `other_channels_normalized`. |
| `budget` | **The live pacing pipeline + Budget Editor.** Native tables + views (see below). |
| `identity` | **Added 2026-07-14.** Capability-based access control: `roles`, `users`, `user_access`. See "Identity & Permissions" above. |
| `ctm_data` | CallTrackingMetrics data. See CTM section below. |
| `reference` | `client_mapping` (synced from Monday). Source of AM mappings; pacing reads `client_crosswalk`, not this directly. |
| `transformed` | **Legacy** pacing views. Superseded by the `budget` dataset. Not in the live path. |

### Key objects in `budget`

| Object | Type | What it is |
| --- | --- | --- |
| `committed_budget_live` | NATIVE table | Materialized from the `committed_budget_long` Sheet. Daily 05:00 UTC. `year`/`month` stored as STRING (downstream views cast to INT64). |
| `other_channels_live` | NATIVE table | Materialized from the other-channels Sheet. Daily 05:00 UTC. **Bing only** as of the cleanup after the Meta session (Nextdoor, Meta, LSA rows removed from source Sheet). |
| `nextdoor_spend_daily` | NATIVE table | Nextdoor spend/performance from the Ads API. Partitioned by `report_date`, clustered by `advertiser_id`. Written daily by Cloud Run Job `cortex-nextdoor-ingest` via MERGE. (ADR-010.) |
| `meta_spend_daily` | NATIVE table | Meta Ads spend at campaign/day grain. Partitioned by `date`. Written daily by Cloud Run Job `cortex-meta-ingest` via staging + range DELETE+INSERT. (ADR-011.) |
| `actual_spend_all` | VIEW | Google Ads UNION LSA UNION other_channels_live (Bing only) UNION meta_spend_daily UNION nextdoor_spend_daily; joined to `client_crosswalk`. |
| `actual_spend_mtd` | VIEW | Same union, current-month-to-date. Duplicated union with `actual_spend_all` is tech debt — PENDING P-TECH-12. |
| `pacing_api` | VIEW | committed_budget_live FULL OUTER JOIN actual_spend_all + AM/source_group enrichment + spent_mtd + day-of-month dims. **What the webhook serves.** |
| `client_crosswalk` | table | customer_id → canonical_client → account_manager → source_group. Multi-channel by design (one row per channel id). |
| `budget_events` | NATIVE, append-only | Budget Editor edit log. See "Budget Editor" section above. |
| `budget_base_current` | VIEW | Budget Editor current-state view. See above. |
| `budget_pacing_rollover` | VIEW | Budget Editor rollover model. See above. |
| `am_directory` | table | **Legacy fallback** for Budget Editor permissions (superseded by `identity.*`). |
| `committed` | VIEW | **ORPHANED.** Reads old `committed_budget_seed` (stale). Not used by `pacing_api`. See PENDING P-TECH-07. |

### Scheduled queries (BigQuery Data Transfer)

| Name | Schedule | Action |
| --- | --- | --- |
| `committed_budget_live_refresh` | Daily 05:00 UTC | `CREATE OR REPLACE TABLE budget.committed_budget_live AS SELECT ... FROM raw_budget.committed_budget_long` |
| `other_channels_live_refresh` | Daily 05:00 UTC | `CREATE OR REPLACE TABLE budget.other_channels_live AS SELECT ... FROM raw_budget.other_channels_normalized` |

### Cloud Run Jobs (API ingestion — ADR-010, ADR-011)

| Name | Type | Schedule | Action |
| --- | --- | --- | --- |
| `cortex-nextdoor-ingest` | Cloud Run Job (`us-central1`) | triggered by Scheduler | Loops `/me` advertisers → synchronous `/stats` per advertiser/day → MERGE into `budget.nextdoor_spend_daily`. SA `cortex-nextdoor@`, token from Secret Manager `nextdoor-ads-token`. |
| `cortex-nextdoor-daily` | Cloud Scheduler | 09:00 America/New_York daily | Executes `cortex-nextdoor-ingest`. |
| `cortex-meta-ingest` | Cloud Run Job (`us-central1`) | triggered by Scheduler | Enumerates active accounts via `/me/adaccounts` → insights per account/day → staging + range DELETE+INSERT into `budget.meta_spend_daily`. SA `cortex-meta@`, token from Secret Manager `meta-access-token`. |
| `cortex-meta-daily` | Cloud Scheduler | 08:00 America/New_York daily | Executes `cortex-meta-ingest`. Staggered 1h before Nextdoor. |

**Secret Manager:**
- `nextdoor-ads-token` — expires 2027-06-16 (P-TECH-10).
- `meta-access-token` — exposed in build chat 2026-07-05, rotation pending (P-TECH-14).

### Google Sheets connected to BQ

| Sheet | ID | Connected via | Materialized to | Used in |
| --- | --- | --- | --- | --- |
| committed_budget_long | `15Ju5gm9q5lu8RbevwrVlbrLS3sMqcrY-_KW4tldKOR4` | `raw_budget.committed_budget_long` | `budget.committed_budget_live` | Committed budget (source of truth for the base; Budget Editor events can override per client/channel/month) |
| Other Channel Spend | `1pJ8GyxepeoO_yddEvVleUaUQ8zAN7_EVckJ_zvg93G4` | `raw_budget.other_channels_normalized` | `budget.other_channels_live` | **Bing only** — Nextdoor, Meta, LSA all migrated off this sheet. |

### Data transfers

- **Google Ads transfer** from Master MCC `611-819-8619` to `raw_google_ads`, daily ~06:00 UTC, ~1-day lag.
- Meta and Nextdoor have no DTS connector — their Cloud Run Jobs are the transfer.

## Service accounts in use

| SA | Used for |
| --- | --- |
| `cortex-bigquery@...` | General BigQuery; Viewer on source Sheets. |
| `cortex-pacing-gha@...` | GitHub-side automation (secret `GCP_SA_KEY`); Viewer on `committed_budget_long`. |
| `ctm-pipeline-sa@...` | Call Tracking pipeline. |
| `cortex-nextdoor@...` | Nextdoor API → BigQuery ingestion. |
| `cortex-meta@...` | Meta Marketing API → BigQuery ingestion. |

## n8n

- Instance: `naterimc.app.n8n.cloud` (hosted on Nate's personal account; the pacing workflow is administered by us — P-CARRY-01 tracks migrating this off a personal account).
- **Pacing data webhook:** `https://naterimc.app.n8n.cloud/webhook/odc-pacing-data` — workflow `ODC Pacing — Data API`. `SELECT p.*, m.monday_item_id AS mondayClientId FROM budget.pacing_api p LEFT JOIN reference.client_mapping m ...`. Uses `p.*` deliberately so it inherits new `pacing_api` columns (L-019).
- **Pacing agent webhook:** `https://naterimc.app.n8n.cloud/webhook/odc-pacing-agent`.
- Also powers Tickets and the ticket bot in the shell.

## Monday.com

- Workspace: Right Idea Creative.
- Master Client List board `18406601738`; old board `18400692411` deprecated.

## CTM data pipeline

Dataset `ctm_data`, loaded daily at 04:01 UTC by `ctm-pipeline-sa@`. Layers: `ctm_calls` (raw, `called_at_ts` broken — L-011) → `ctm_calls_enriched` → `ctm_calls_daily` / `ctm_calls_heatmap` / `v_chatbot_calls`. Where it runs is still unconfirmed — P-TECH-05.

## Known divergences to watch

- **`budget.committed` (orphaned, seed) vs `committed_budget_live` (live, Sheet)** — two committed-budget objects, different data. `pacing_api` uses the live one. (P-TECH-07.)
- **Repo `pacing_api_view.sql` vs live `pacing_api`** — repo file is a simplified template; the live view is more complex. (P-TECH-08.)
- **`actual_spend_all` / `actual_spend_mtd` duplicate their channel union** — any channel-source change must be applied to both. (P-TECH-12.)
- **`budget.am_directory` vs `identity.*`** — `am_directory` is legacy fallback only; `identity.user_access` is the source of truth as of 2026-07-14. Don't edit `am_directory` expecting it to take effect — edit `identity.users`/`identity.user_access` instead. (P-TECH-16 tracks retiring the fallback.)
- **10 internal pages still on the pre-rebrand light/blue theme** while the shell and `index.html` are on teal/carbon. (P-TECH-15.)
- **`/kpi` returns a 500** and has never worked — unrelated to the rebrand or Identity v5. (P-TECH-17.)

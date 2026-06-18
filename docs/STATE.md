# Cortex OS — Current State

> **Last updated:** 2026-06-17 (session 8)
> **Updated by:** Claude (Sebas, work account)
>
> This is a **snapshot of the system right now**, not a history. If a section feels stale, rewrite it. History lives in `/sessions/`.
>
> **⚠ Reconciliation note (2026-06-01):** the pacing data layer was rebuilt (native tables + n8n webhook) and the docs lagged behind. This version reconciles the pacing pipeline to what actually runs, while preserving Nate's CTM section from the 05-30 update. If you find it stale again, `git pull` first, verify against the running system (LEARNINGS L-013), and rewrite.
>
> **Update (2026-06-17, session 7):** Nextdoor spend moved off the other-channels Sheet to a direct API pipeline (Cloud Run Job → `budget.nextdoor_spend_daily`). `actual_spend_all` now has a third CTE and excludes Nextdoor from the Sheet branch. See ADR-010.
>
> **Update (2026-06-17, session 8):** Post-deploy fixes. Backfilled the June 1–13 Nextdoor ingestion gap. Fixed SPENT MTD $0 (all channels) — the pacing webhook query was a stale explicit column list, now `p.*`; that webhook is now **administered by us**. Swapped Nextdoor in `actual_spend_mtd` too (Sheet → API), the second of the two parallel spend views. See LEARNINGS L-019/L-020, PENDING P-TECH-12/13.

## Platform

Cortex OS is a static web app hosted on **Cloudflare Pages**, connected to this GitHub repo for auto-deploy on push to `main`.

- **Production URL:** https://cortex-cmv.pages.dev
- **Pacing module path:** `/ad-spend-pacing` (the `.html` path 308-redirects to this).
- **Auto-deploy:** push to `main` re-renders the site (~1-2 min). **Caveat:** the live pacing HTML that Cloudflare serves is newer than the repo copy — Nate uploads the production pacing page outside the repo's auto-deploy. The repo's `ad-spend-pacing.html` is a stale older copy (see PENDING P-TECH-09).
- **Tech stack:** HTML + vanilla JS + Chart.js (CDN). No build step, no framework, no server runtime. A shared shell was extracted to `cortex-shell.js` (2026-05-31).

## Modules

| Module | Path | Status | Data source | Refresh |
| --- | --- | --- | --- | --- |
| Home | `/` (`index.html`) | Live (Nate) | static | manual |
| Call Tracking | `/call-tracking.html` | Live (Nate) | `data.json` | manual |
| Ad Spend Pacing | `/ad-spend-pacing` | **Live** | **n8n webhook** `odc-pacing-data` → `budget.pacing_api` | **live** (browser fetches webhook on load, no cache) |
| Budget Planning | `/budget-planning.html` | Live (Nate, new ~2026-05-31) | webhook (reads `committed` data) | live |
| Triage | `/triage.html` | Live (Nate) | `triage_data.json` / webhook | — |
| Tickets | `/tickets.html` | Live (Nate) | n8n webhook | live |

**The pacing module reads its data live from an n8n webhook.** No static JSON, no export script, no GitHub Action in the live path anymore (that was the pre-06-01 design; removed — see ADR-009 and session 2026-06-01).

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

**Nextdoor (added 2026-06-17, ADR-010):** Nextdoor spend no longer comes from the other-channels Sheet. A Cloud Run Job (`cortex-nextdoor-ingest`) pulls the Nextdoor Ads API daily into the native table `budget.nextdoor_spend_daily`; `actual_spend_all` reads Nextdoor from there and excludes it from the Sheet branch. The diagram above still shows the Sheet path, which now carries Bing/LSA/Meta only.

Why native tables instead of querying the Sheets directly: an external table on a Google Sheet fails the **entire** view when the Drive credential drops, which took the whole dashboard down once. Materializing to native tables isolates that failure — a failed refresh keeps the last good copy and the dashboard stays up. See ADR-008 and LEARNINGS L-014.

## Repo layout

```
right-idea-creative/cortex/
├── index.html                 # Home (Nate)
├── call-tracking.html         # Call Tracking module (Nate)
├── ad-spend-pacing.html       # STALE copy (reads old JSON). Not what prod serves. See PENDING P-TECH-09.
├── budget-planning.html       # Budget Planning module (Nate, new)
├── triage.html                # Triage module (Nate)
├── tickets.html               # Tickets module (Nate)
├── cortex-shell.js            # Shared site shell (header/nav/styles)
├── data.json                  # Source for Call Tracking
├── triage_data.json           # Source for Triage
├── pacing_api_view.sql        # DDL of pacing_api — STALE vs live view, see PENDING P-TECH-08
├── nextdoor-ingest/           # Cloud Run Job: Nextdoor Ads API -> BigQuery daily ingestion (ADR-010)
├── functions/monday-proxy.js  # Cloudflare Function: Monday ticket proxy
├── README.md
└── docs/                      # This shared brain
```

Removed 2026-06-01 (old static-JSON pacing pipeline, no longer used): `export_pacing_data.py`, `pacing-data.json`, `requirements.txt`, `.github/workflows/refresh-pacing.yml`.

## GCP infrastructure

**Project:** `rightidea-cortex` (number `427224510681`)

### BigQuery datasets

| Dataset | Purpose |
| --- | --- |
| `raw_google_ads` | Daily transfer from Master MCC `611-819-8619`. Main table: `p_ads_CampaignBasicStats_6118198619`. |
| `raw_budget` | External tables on the source Sheets: `committed_budget_long` and `other_channels_normalized`. |
| `budget` | **The live pacing pipeline.** Native tables + views below. |
| `ctm_data` | CallTrackingMetrics data. See CTM section below. |
| `reference` | `client_mapping` (synced from Monday). Source of AM mappings; pacing reads `client_crosswalk`, not this directly. |
| `transformed` | **Legacy** pacing views (`pacing_calculations`, `pacing_dashboard_view`, `spend_combined`, `budgets_normalized`). Superseded by the `budget` dataset. Not in the live path. Left in place, not maintained. |

### Key objects in `budget` (the live pacing pipeline)

| Object | Type | What it is |
| --- | --- | --- |
| `committed_budget_live` | NATIVE table | Materialized from the `committed_budget_long` Sheet. Daily 05:00 UTC. Live committed-budget source of truth. |
| `other_channels_live` | NATIVE table | Materialized from the other-channels Sheet. Daily 05:00 UTC. Channels consumed by `actual_spend_all`: Bing, LSA, Meta Ads. (Nextdoor rows still physically present but excluded downstream — see `nextdoor_spend_daily` / ADR-010.) |
| `nextdoor_spend_daily` | NATIVE table | Nextdoor spend/performance from the Ads API. Partitioned by `report_date`, clustered by `advertiser_id`. Written daily by Cloud Run Job `cortex-nextdoor-ingest` via MERGE on `(advertiser_id, report_date)`. Source of Nextdoor in `actual_spend_all`. (ADR-010.) |
| `nextdoor_spend_daily_staging` | NATIVE table | WRITE_TRUNCATE staging for the Nextdoor MERGE. Holds the current run's rows only. |
| `actual_spend_all` | VIEW | Three CTEs: Google Ads (cost de-micro'd) UNION other_channels_live (excl Nextdoor) UNION nextdoor_spend_daily; all joined to `client_crosswalk` on `customer_id` (Nextdoor matches `advertiser_id = customer_id`). |
| `actual_spend_mtd` | VIEW | Same union, filtered to current-month-to-date. **Fixed 06-01** to include all channels (was Google-only). **Session 8 (06-17):** now 3 CTEs incl a `nextdoor` CTE reading `nextdoor_spend_daily` (Sheet branch excludes Nextdoor), mirroring `actual_spend_all`. Feeds `spent_mtd` in pacing_api. Duplicated union with `actual_spend_all` is tech debt — PENDING P-TECH-12. |
| `pacing_api` | VIEW | committed_budget_live FULL OUTER JOIN actual_spend_all + AM/source_group enrichment + spent_mtd + day-of-month dims (America/Chicago), filtered to current year. **This is what the webhook serves.** |
| `client_crosswalk` | table | customer_id → canonical_client → account_manager → source_group. `pacing_api` reads it with `active = TRUE`. |
| `committed` | VIEW | **ORPHANED.** Reads old `committed_budget_seed` (no Yelp, stale). **Not used by pacing_api.** See PENDING P-TECH-07. |
| `committed_budget_seed` | table | Old hand-loaded committed budget. Source for the orphaned `committed` view only. |

### Scheduled queries (BigQuery Data Transfer)

| Name | Schedule | Action |
| --- | --- | --- |
| `committed_budget_live_refresh` | Daily 05:00 UTC | `CREATE OR REPLACE TABLE budget.committed_budget_live AS SELECT ... FROM raw_budget.committed_budget_long` |
| `other_channels_live_refresh` | Daily 05:00 UTC | `CREATE OR REPLACE TABLE budget.other_channels_live AS SELECT ... FROM raw_budget.other_channels_normalized` |

Both verified SUCCEEDED on their first unattended run (overnight 05-31 → 06-01).

### Cloud Run Jobs (Nextdoor ingestion — ADR-010)

| Name | Type | Schedule | Action |
| --- | --- | --- | --- |
| `cortex-nextdoor-ingest` | Cloud Run Job (region `us-central1`) | triggered by Scheduler | Loops `/me` advertisers → synchronous `/stats` per advertiser/day → MERGE into `budget.nextdoor_spend_daily`. `LOOKBACK_DAYS=3` trailing re-statement window. SA `cortex-nextdoor@`, token from Secret Manager `nextdoor-ads-token`. Source in repo `nextdoor-ingest/`. |
| `cortex-nextdoor-daily` | Cloud Scheduler (region `us-central1`) | 09:00 America/New_York daily | POSTs to the Run Jobs API to execute `cortex-nextdoor-ingest`. |

**Secret Manager:** `nextdoor-ads-token` — Nextdoor Ads API v3 bearer token, **expires 2027-06-16** (rotation tracked in PENDING P-TECH-10).

### Google Sheets connected to BQ

| Sheet | ID | Connected via | Materialized to | Used in |
| --- | --- | --- | --- | --- |
| committed_budget_long | `15Ju5gm9q5lu8RbevwrVlbrLS3sMqcrY-_KW4tldKOR4` | `raw_budget.committed_budget_long` | `budget.committed_budget_live` | Committed budget (live truth) |
| Other Channel Spend | `1pJ8GyxepeoO_yddEvVleUaUQ8zAN7_EVckJ_zvg93G4` | `raw_budget.other_channels_normalized` | `budget.other_channels_live` | Other-channel actual spend (weekly). Bing/LSA/Meta only — Nextdoor migrated to API (ADR-010); its Sheet rows are now dead (P-OPS-08). |

The refreshes read Sheets, so whatever identity runs them needs a valid Drive credential at run time — which is exactly why the downstream layer is materialized.

### Data transfers

- **Google Ads transfer** from Master MCC `611-819-8619` to `raw_google_ads`, daily ~06:00 UTC, ~1-day lag (today's spend appears tomorrow).
- Jan-Mar 2026 backfill: ~35 of 49 affected combos recovered; ~14 likely permanently `BQ Data Gap` (CID was outside MCC). Acceptable.

## Service accounts in use

| SA | Used for |
| --- | --- |
| `cortex-bigquery@...` | General BigQuery; Viewer on source Sheets. |
| `cortex-pacing-gha@...` | GitHub-side automation (secret `GCP_SA_KEY`); Viewer on `committed_budget_long`. |
| `ctm-pipeline-sa@...` | Call Tracking pipeline (Nate). |
| `cortex-nextdoor@...` | Nextdoor API → BigQuery ingestion (Cloud Run Job). Roles: `bigquery.dataEditor`, `bigquery.jobUser`, `run.invoker`, `secretmanager.secretAccessor` on `nextdoor-ads-token`. |

## n8n

- Instance: `naterimc.app.n8n.cloud` (Nate's account hosts it; the pacing workflow below is administered by us).
- **Pacing data webhook:** `https://naterimc.app.n8n.cloud/webhook/odc-pacing-data` — workflow **`ODC Pacing — Data API`** (n8n id `y6Y8uzQ9lntdFiLp`), 3 nodes: `Pacing Data Request` (webhook GET) → `Query pacing_api` (BigQuery executeQuery) → `Respond With Rows`. The query is `SELECT p.*, m.monday_item_id AS mondayClientId FROM budget.pacing_api p LEFT JOIN reference.client_mapping m ON LOWER(TRIM(p.client))=LOWER(TRIM(m.client_name)) ORDER BY p.client, p.channel, p.month`. **Live data source for the pacing dashboard. Administered by us (Cortex/Sebas) as of 2026-06-17 (session 8)** — was previously treated as Nate's black box. The `p.*` (not an explicit column list) is deliberate so it inherits new `pacing_api` columns; see LEARNINGS L-019. To test: Publish then `curl` the production URL (the webhook trigger does not auto-fire on editor "Execute workflow").
- **Pacing agent webhook:** `https://naterimc.app.n8n.cloud/webhook/odc-pacing-agent`.
- Also powers Tickets and (via webhook) Budget Planning (Nate's workflows).
- **Side note (unverified):** a duplicate workflow `Monday → BigQuery: Client Mapping Sync copy` (created 11 June) exists alongside the original. Two client-mapping syncs could collide — worth auditing.

## Monday.com

- Workspace: Right Idea Creative.
- Master Client List board `18406601738` (the good one); old board `18400692411` deprecated.
- Old bitácora docs (`39619258`, `42308796`) superseded by this `/docs/` folder.

## CTM data pipeline

Dataset `ctm_data` contains data sourced from the CallTrackingMetrics API. Loaded daily at **04:01 UTC** by service account `ctm-pipeline-sa@rightidea-cortex.iam.gserviceaccount.com` using a staging-swap pattern.

**Layers (bottom-up):**

1. `ctm_data.ctm_calls` — master raw table, 90+ columns, partitioned by `DATE(called_at_ts)`, clustered by `account_id, source`. **Note:** `called_at_ts` stores epoch values not real TIMESTAMPs due to an upstream pipeline bug (LEARNINGS L-011). Partition pruning silently does not work.
2. `ctm_data.ctm_calls_enriched` — cleaned/normalized (created by Nate 2026-05-27). Schema: `account_id, client_name, google_ads_customer_id, call_date, day_of_week_sun1, hour_of_day, call_status, duration, is_missed, source, web_source, medium, channel`. Active ODC clients only. Use `call_date` (real DATE) for date filtering.
3. `ctm_data.ctm_calls_daily` — VIEW: daily aggregates by client + channel.
4. `ctm_data.ctm_calls_heatmap` — VIEW: hourly aggregates by client + day-of-week + hour.
5. `ctm_data.v_chatbot_calls` — VIEW: chatbot-friendly formatting.

**Mechanics:** each run creates `ctm_data.ctm_calls_staging_<unix_ms>` with fresh API data, then `MERGE INTO ctm_calls USING staging ON T.id = S.id`. Staging tables are not cleaned up automatically (PENDING P-TECH-06).

**Where it runs:** unconfirmed as of 2026-05-30. Candidates: Cloud Run, Cloud Function, n8n flow, external. See PENDING P-TECH-05.

## Known divergences to watch

- **`budget.committed` (orphaned, seed) vs `committed_budget_live` (live, Sheet)** — two committed-budget objects, different data. `pacing_api` uses the live one. Anything reading `budget.committed` gets stale data. (PENDING P-TECH-07.)
- **Repo `pacing_api_view.sql` vs live `pacing_api`** — repo file is a simplified template; the live view is more complex. (PENDING P-TECH-08.)
- **Repo `ad-spend-pacing.html` vs production** — repo copy stale (old JSON); prod serves a newer webhook version uploaded outside the repo. (PENDING P-TECH-09.)
- **`budget.other_channels_live` still carries Nextdoor rows** — the Sheet was not cleaned after Nextdoor moved to the API (ADR-010). `actual_spend_all` excludes them so there is no double count, but the Sheet and native table carry dead Nextdoor rows. (PENDING P-OPS-08.)

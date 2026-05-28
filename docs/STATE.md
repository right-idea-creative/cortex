# Cortex OS — Current State

> **Last updated:** 2026-05-27 (session 4)
> **Updated by:** Claude (Sebas, work account)
>
> This is a **snapshot of the system right now**, not a history. If a section feels stale, rewrite it. History lives in `/sessions/`.

## Platform

Cortex OS is a static web app hosted on **Cloudflare Pages**, connected to this GitHub repo for auto-deploy on push to `main`.

- **Production URL:** https://cortex-cmv.pages.dev
- **Preview URLs:** Cloudflare generates a `<hash>.cortex-cmv.pages.dev` per commit; production is the un-hashed root.
- **Auto-deploy:** triggered on every push to `main`. Takes ~1-2 min after push.
- **Tech stack:** HTML + vanilla JS + Chart.js (CDN). No build step. No framework. No server runtime.

## Modules

| Module | Path | Status | Data source | Refresh |
| --- | --- | --- | --- | --- |
| Home | `/` (`index.html`) | Live (Nate) | static | manual |
| Call Tracking | `/call-tracking.html` | Live (Nate) | `data.json` | manual via `export_data.py` |
| Ad Spend Pacing | `/ad-spend-pacing.html` | **Live** | `pacing-data.json` | **auto daily 8 AM CT** via GitHub Actions |
| Tickets | `/tickets.html` | Live (Nate) | n8n webhook | live (no cache) |

## Repo layout

```
right-idea-creative/cortex/
├── index.html                            # Home (Nate)
├── call-tracking.html                    # Call Tracking module (Nate)
├── ad-spend-pacing.html                  # Pacing module (Sebas)
├── tickets.html                          # Tickets module (Nate)
├── data.json                             # Source for Call Tracking
├── pacing-data.json                      # Source for Pacing (auto-generated)
├── export_pacing_data.py                 # Generates pacing-data.json from BigQuery
├── requirements.txt                      # Python deps for export script
├── .gitignore
├── .github/workflows/refresh-pacing.yml  # Daily cron for pacing refresh
└── docs/                                 # This shared brain
```

## GCP infrastructure

**Project:** `rightidea-cortex` (number `427224510681`)

### BigQuery

| Dataset | Purpose |
| --- | --- |
| `raw_google_ads` | Daily transfer from Master MCC `611-819-8619`. Main table: `p_ads_CampaignBasicStats_6118198619`. |
| `raw_budget` | Source-of-truth budget data. Includes `planner_sheet` external table (linked to ODC Forecast 2026 LIVE Sheet) and `other_channels_sheet` external table (linked to Other Channel Spend OFFICIAL Sheet). |
| `reference` | Reference data including `client_mapping`. **Note:** `client_mapping` is NOT used in the current pacing pipeline; Nate explicitly removed it. Use it only for things outside pacing. |
| `transformed` | Derived views consumed by dashboards. Includes `spend_combined`, `budgets_normalized`, `pacing_calculations`, `pacing_dashboard_view`. |

### Key views (pacing pipeline)

1. **`raw_budget.budgets_normalized`** — normalized planner data, one row per account × platform × month.
2. **`raw_budget.other_channels_normalized`** — normalized other-channels spend from the manual sheet. **Filters `WHERE Date IS NOT NULL`** which silently drops rows; see LEARNINGS.
3. **`transformed.spend_combined`** — union of `raw_google_ads` (Google Ads via transfer) + `other_channels_normalized` (Bing/Meta/Nextdoor/LSA via manual sheet). Has columns `customer_id, platform, spend_date, year, month_num, month, spend, view_refreshed_at`.
4. **`transformed.pacing_calculations`** v3 — joins budgets + spend, computes pacing ratios, forecasts, capture accuracy, BQ Data Gap detection, status, severity, annual status. **This is the core analytical view.**
5. **`transformed.pacing_dashboard_view`** v2 — windowed/filtered/decorated version of `pacing_calculations` optimized for dashboard consumption. Returns ~700-800 rows per refresh covering rolling 7-month window (3 past + current + 3 future).

### Google Sheets connected to BQ

| Sheet | ID | Connected via | Used in |
| --- | --- | --- | --- |
| ODC Forecast - 2026 (LIVE) | `1uk_4iYe_UaAZbxgD-Hv4I4WnJ07pIa_A4JOMOp8T2WA` | `raw_budget.planner_sheet` external table | Pacing budgets |
| Other Channel Spend [OFFICIAL] | `1pJ8GyxepeoO_yddEvVleUaUQ8zAN7_EVckJ_zvg93G4` | `raw_budget.other_channels_sheet` external table | Pacing other-platforms spend |

Both Sheets are shared as Viewer with the service account `cortex-bigquery@rightidea-cortex.iam.gserviceaccount.com`.

### Data transfers

- **Google Ads transfer** from Master MCC `611-819-8619` to `raw_google_ads`, running daily at 06:00 UTC.
- Backfill for Jan-Mar 2026 was triggered 2026-05-26. Partial recovery: some accounts that were unlinked from MCC during that period (~35 combos) may never be backfilled by Google — they will permanently show as `BQ Data Gap` for those months. This is acceptable.

## Service accounts in use

| SA | Role(s) | Used for |
| --- | --- | --- |
| `cortex-bigquery@...` | `bigquery.admin` (project) + Viewer on both Sheets | Pacing export script (local + GitHub Actions) |
| `ctm-pipeline-sa@...` | `bigquery.dataEditor`, `bigquery.jobUser` | Call Tracking pipeline (Nate) |
| `cortex-pacing-gha@...` | created but unused; kept as placeholder for future GHA isolation | — |

## GitHub Actions

| Workflow file | Trigger | What it does |
| --- | --- | --- |
| `.github/workflows/refresh-pacing.yml` | Cron `0 14 * * *` (= 8 AM Central in DST, 9 AM in standard time) + manual `workflow_dispatch` | Runs `python export_pacing_data.py` using SA key from secret `GCP_SA_KEY`, then commits `pacing-data.json` if changed. |

## GitHub Secrets

| Secret name | Value | Used by |
| --- | --- | --- |
| `GCP_SA_KEY` | JSON key for `cortex-bigquery@...` SA | refresh-pacing.yml |

## n8n

- Self-hosted instance at `naterimc.app.n8n.cloud` (URL is the MCP endpoint, not the UI).
- Currently powers the Tickets module via webhook.
- Future use planned for: budget pacing alerts, AM Planner sync, sprint automation.

## Monday.com

- Workspace: Right Idea Creative (`rightideacreative-team.monday.com`).
- **Old bitácora doc ID `39619258`** — superseded by this `/docs/` folder on 2026-05-27. Will eventually be archived.
- New bitácora doc ID `42308796` — also superseded by this folder. Last entry: session 4 (2026-05-27).
- Client Mapping board ID `18406601738` — operational, not used by pacing pipeline anymore.

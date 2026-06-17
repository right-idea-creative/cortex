# Session 2026-06-17 — Nextdoor Ads API → BigQuery ingestion

**Driver:** Sebas (work)
**Outcome:** Nextdoor spend migrated off the manual other-channels Sheet to a fully automated, daily API pipeline. New ADR-010, LEARNINGS L-017/L-018.

## Objective

Connect Nextdoor to BigQuery directly via its Ads API and retire the Nextdoor slot of the manual other-channels Sheet, joining Nextdoor spend into `actual_spend_all` alongside the other channels.

## What we did

### Discovery (Nextdoor Ads API v3)
- Access had been granted to Nate by Ben Miles (Nextdoor). Token is created in the Ads UI (ads.nextdoor.com → Ads API → Create API token) under the logged-in user `digital@rightideacreative.net` (business profile "Press2 Digital").
- Key facts from the v3 OpenAPI spec (corrected several assumptions from the public v2 docs):
  - Auth is a **Bearer JWT** from the UI; **expires after 1 year** (not 7 days). No client_credentials flow in v3. Our token `cortex-bq-prod` expires **2027-06-16**.
  - Tokens are **user-level**: cover every advertiser tied to the user. `GET /me` returned **26 advertisers, all `CLIENT_ADMIN`** — superset of Nate's 17, so we iterate `/me` rather than hardcoding IDs.
  - We do **not** need CAPI (separate agreement); reporting/spend is the Ads API.

### Endpoint decision — `/stats` (synchronous), not `/reports` (async)
- Started on `/reports` (async CSV, supports DAY grain). It completed instantly for an empty account-month but **stalled at `IN_PROGRESS` for 15–20+ min** for any account with real data — no error, no timeout, no diagnostic field. Same data came back from `/stats` in seconds.
- Also hit an **undocumented** metric-conflict rule: `BILLABLE_SPEND` + `LEAD` → `REPORT_BUILDER_CONFLICT_PARAMETER`. Resolved by using `SPEND`; for the pipeline we settled on `/stats` which returns `billable_spend`.
- Decision: build on the synchronous `/stats` endpoint, advertiser/day grain. (LEARNINGS L-017.)

### Data format
- Money arrives as currency-prefixed strings (`"USD 9458.925231"`), rates up to 12 decimals; BigQuery `NUMERIC` max scale is 9. Parser strips the currency code, quantizes to 9 decimals, formats fixed-point (zero must serialize as `0.000000000`, not `0E-9`). (LEARNINGS L-018.)
- CTR/CPC come in percent units already.

### Build (`nextdoor-ingest/` in the repo)
- `nextdoor_to_bq.py`: `/me` → per advertiser fetch profile (name, currency, timezone) + per-day `/stats` → parse → load staging (WRITE_TRUNCATE) → MERGE into `budget.nextdoor_spend_daily` on `(advertiser_id, report_date)`. Skips zero-activity account-days. `LOOKBACK_DAYS=3` trailing re-statement window; `START_DATE`/`END_DATE` override for backfill; `ADVERTISER_IDS` override for testing.
- Table `budget.nextdoor_spend_daily`: partitioned by `report_date`, clustered by `advertiser_id`. Columns: report_date, advertiser_id, advertiser_name, currency_code, billable_spend (NUMERIC), impressions, clicks, ctr, cpc, cpm, total_conversions, lead_conversions, load_timestamp.
- `Dockerfile`, `requirements.txt`, `DEPLOY.md` alongside.

## Validation

- Smoke test (ODC Glens Falls, one month): auth → /stats → parse → MERGE → 30 rows; idempotent re-run stayed at 30 (UPDATE, no dup).
- Backfill Jan 1 – May 31 2026, all 26 advertisers: **1,322 active account-days, 0 failures**.
- Parity vs the Sheet (the migration gate): per client×month deltas all within ±$0.15 (rounding). Global: Sheet $75,511.07 (Jan–May) vs API $78,700.62. The +$3,189.55 is entirely **June** (ODC Glens Falls, which the Sheet did not have) plus sub-cent rounding. Conclusion: the API is the more precise and more complete source over the overlapping period.
- The join is by ID: `nextdoor_spend_daily.advertiser_id = client_crosswalk.customer_id` (the Nextdoor IDs were already in the crosswalk). No name matching needed.

## The `actual_spend_all` swap

- `CREATE OR REPLACE VIEW budget.actual_spend_all` with a third CTE `nextdoor` (reads `nextdoor_spend_daily`, joined to crosswalk), and `o.channel <> 'Nextdoor'` added to the other-channels CTE to prevent double counting.
- Post-swap: `channel='nextdoor'` totals $78,700.62 over 57 client-months; duplicate check (client×year×month with >1 row) returned empty.

## Deployed (now autonomous)

- Secret Manager `nextdoor-ads-token`; SA `cortex-nextdoor@` with bigquery.dataEditor + jobUser + run.invoker + secretmanager.secretAccessor.
- Cloud Run Job `cortex-nextdoor-ingest` (`--source .`, Dockerfile build).
- Cloud Scheduler `cortex-nextdoor-daily`, 09:00 America/New_York.
- Manual Scheduler trigger confirmed a job execution **running as the SA** (`RUN BY cortex-nextdoor@...`), Succeeded. Pattern mirrors the CTM pipeline (SA + Secret Manager + scheduled trigger).

## Decisions / learnings recorded

- **ADR-010** — Nextdoor ingested via the API (Cloud Run Job), not the Sheet; supersedes the Nextdoor slot of ADR-008.
- **L-017** — Nextdoor's async `/reports` is unreliable; use synchronous `/stats`.
- **L-018** — ad-API money is currency-prefixed strings that overflow NUMERIC scale; strip + quantize + fixed-point.

## Pending opened

- **P-OPS-08** — clear dead Nextdoor rows from the Other Channel Spend Sheet.
- **P-TECH-10** — rotate `nextdoor-ads-token` before 2027-06-16.
- **P-TECH-11** — TEST/TRASH advertisers land in the raw table (cosmetic; excluded from `actual_spend_all`).

## Notes for the next instance

- The token was exposed in screenshots during this session; if it was not rotated at the end, rotate it (Refresh in the Ads UI → `gcloud secrets versions add nextdoor-ads-token`).
- Metric is `billable_spend` (billed), not gross delivery spend — correct for pacing; gross would be a separate pull.
- This is the **first Cloud Run Job** in Cortex. Future channel APIs (e.g. Yelp, P-OPS-07) can follow the same `nextdoor-ingest/` template.

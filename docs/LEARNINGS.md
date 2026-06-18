# Cortex OS — Learnings

> **Purpose:** mistakes we already made, so no future instance burns hours making them again. Each entry should be short (1-3 sentences) plus a "what to do instead" line.

> **When to add:** append to this file whenever a session ends with a "we should have known this" realization. If it's just a normal bug fix with no transferable lesson, it goes in the session log, not here.

---

## L-001: Schema-first. Always.

**Mistake:** Wrote queries assuming column names from memory or pattern-matching from other tables. Wasted multiple iterations on `date` vs `spend_date`, `year` not existing in `budgets_normalized`, etc.

**Rule:** Before writing any SQL that touches a table or view not verified in the current session, run `INFORMATION_SCHEMA.COLUMNS` first. No exceptions.

---

## L-002: External tables on Google Sheets need explicit Drive scope

**Mistake:** Service account had BigQuery admin and was shared as Viewer on the Sheet, but the export script still got `403 Permission denied while getting Drive credentials`.

**Why:** The default Python BigQuery client only requests `cloud-platform` OAuth scope. To read a Sheet-backed external table, the client must explicitly request the `drive` scope at credential construction time.

**Rule:** When authenticating via SA JSON key for a query that touches Sheet-backed external tables:

```python
credentials = service_account.Credentials.from_service_account_file(
    path,
    scopes=[
        "https://www.googleapis.com/auth/bigquery",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/cloud-platform",
    ],
)
client = bigquery.Client(credentials=credentials, project=...)
```

See `export_pacing_data.py` for the canonical implementation.

---

## L-003: Workspace OAuth blocks user-account access to Drive scopes

**Mistake:** Tried `gcloud auth application-default login --scopes=...drive...` from a `@rightideacreative.net` user account. Google blocked the app with "This app is blocked".

**Why:** The Workspace admin has restrictions on third-party apps requesting sensitive scopes. gcloud CLI is treated as a third-party app.

**Rule:** Never authenticate user accounts for Drive-scoped operations. Use a service account instead. SAs are not subject to Workspace OAuth restrictions.

---

## L-004: Check what teammates already built before designing infrastructure

**Mistake:** Spent ~3 hours building Cloud Run + Flask + Docker for a dashboard that ultimately deployed to Cloudflare Pages. Nate had already established the static-site pattern. We didn't look.

**Rule:** Before proposing infrastructure for a feature that connects to another module, **clone the existing module's repo and read it.** Match patterns where possible. Diverge only with explicit justification.

---

## L-005: Filtered VIEWs hide upstream data quality issues

**Mistake:** `other_channels_normalized` filters `WHERE Date IS NOT NULL`, which silently dropped ~2,348 rows of malformed sheet data. The downstream dashboard showed "Bing has no data" instead of "Bing has 124 broken rows."

**Rule:** Any defensive WHERE in a view that filters out source rows should be accompanied by a visible metric (a count, a freshness check, or a separate "QA" view) that surfaces the suppressed rows. Otherwise the filter quietly papers over real problems.

---

## L-006: AM Over-reported is not always real mis-reporting

**Mistake:** Treated 157 rows of "BQ shows $0 but AM reported $X" as proof that AMs were inflating numbers. Verified manually: the AM data was correct; BQ had a coverage gap from MCC unlink/relink history.

**Rule:** Before raising "discrepancy" alarms, separate three orthogonal axes:
1. **Data presence** — does BQ even have data for this period × account?
2. **Pacing** — assuming data is present, is spend tracking budget?
3. **Capture accuracy** — assuming data is present, does AM-reported match BQ?

The pacing pipeline now expresses these as `bq_data_available`, `status`, and `capture_accuracy_ratio` independently.

---

## L-007: Re-use existing service accounts before creating new ones

**Mistake:** Created `cortex-pacing-gha` SA, hit a propagation lag, got "Invalid service account" errors trying to grant roles. Lost 15 minutes. Eventually reused `cortex-bigquery` which already had the needed permissions.

**Rule:** Before creating a new SA, list existing SAs with `gcloud iam service-accounts list` and check whether one already has the required roles. Re-use when reasonable; create new only when isolation matters.

---

## L-008: Don't paste blocks with shell-illegal characters into Terminal

**Mistake:** Pasted instructions including `# Commented lines (in parentheses with `(reemplaza)`)` directly into zsh. Parens broke parsing.

**Rule:** When providing multi-line instructions, separate the *commentary* (instructions for the human) from the *commands* (lines safe to paste). Or use heredocs / `cat > file <<EOF`. When delivering large/markdown content, deliver it as a file to download, not a paste block (markdown backticks and `$` corrupt on paste).

---

## L-009: macOS Finder shows localized folder names but the filesystem uses English

**Mistake:** Tried `ls ~/Descargas/` because Finder showed "Descargas". Failed because the real directory is `~/Downloads/`.

**Rule:** Always use English directory names in shell paths on macOS regardless of Finder's display language: `Downloads`, `Desktop`, `Documents`, `Pictures`, `Movies`, `Music`, `Public`, `Library`.

---

## L-010: Bitácora discipline matters more than tooling

**Observation, not a single mistake:** The Monday.com doc that served as a bitácora for 3 months worked because someone wrote in it. The shared-brain folder in this repo will work only if every session commits an update. The format is secondary; the discipline is primary.

**Rule:** At end of every session, **before closing**, complete the end-of-session protocol from `README.md`. If it's not committed, it didn't happen.

---

## L-011: `ctm_data.ctm_calls.called_at_ts` is epoch, not TIMESTAMP

**Observation, not a single mistake:** the `called_at_ts` column in `ctm_data.ctm_calls` is declared TIMESTAMP and used as the partition key, but the upstream pipeline stores raw epoch numeric values in it. This means `PARTITION BY DATE(called_at_ts)` partitions exist but **partition pruning silently does not work** — queries that filter on `called_at_ts` end up scanning the entire table.

**Rule:** do NOT attempt to "fix" `called_at_ts` by casting or converting it in BigQuery without first understanding the upstream pipeline. The fix has to happen at write time in the CTM pipeline code, not at read time in a view. Nate has documented this in the DDL of `ctm_calls_enriched`; treat that as the source of truth until the upstream is fixed.

If a future query needs date-based filtering on CTM data, use `call_date` from `ctm_calls_enriched` instead — that column is a real DATE and partition-prunes correctly.

---

## L-012: Reverse-engineering invisible BigQuery pipelines via JOBS_BY_PROJECT

When a BigQuery dataset has data being written to it by a process you didn't build and can't immediately locate (no scheduled query, no obvious Cloud Function, no documentation), you can reconstruct the pipeline from BigQuery's own audit logs:

```sql
SELECT
  user_email,
  statement_type,
  start_time,
  destination_table.table_id,
  SUBSTR(query, 1, 500) AS query_preview
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
  AND destination_table.dataset_id = '<DATASET>'
  AND statement_type IN ('INSERT', 'MERGE', 'CREATE_TABLE_AS_SELECT')
ORDER BY start_time DESC
LIMIT 50;
```

This reveals **who** writes (user_email — SA name if it's a service account), **when** (cadence visible in `start_time`), **what** (SQL preview), and **volume** (`total_bytes_processed`).

Combined with `INFORMATION_SCHEMA.TABLES` to inspect table DDLs, this gives a complete picture of a pipeline's structure and cadence without ever seeing the code that runs it. Used this technique on 2026-05-30 to fully map the CTM pipeline in 10 minutes.

---

## L-013: Docs drift silently when someone else rebuilds the system

**Mistake (session 2026-06-01):** The shared brain described an older architecture (static JSON, `pacing_dashboard_view`, GitHub Action export) as current. But the pacing data layer had since been rebuilt — new `budget` dataset, native tables, scheduled queries, and an n8n webhook replacing the static JSON. We spent a long session reverse-engineering the *running* system to discover the docs described a system that no longer existed. Multiple debugging dead-ends came from trusting the docs (e.g. querying `budget.committed`, the orphaned seed view, instead of `committed_budget_live`).

**Rule:** When picking up Cortex after any gap, **verify the running system before trusting STATE.md**, and **`git pull` before doing anything** — your local copy may be days behind the remote. Cheap checks first: list the `budget` dataset objects, read the DDL of `pacing_api`, curl the webhook, confirm what the production URL fetches. Treat the brain as a hypothesis to validate, not ground truth — especially when another person (Nate, via `digital@`) edits the pipeline in parallel.

---

## L-014: Sheet-backed external tables take down the whole view when the Drive credential drops — materialize them

**Mistake:** `actual_spend_all` read `other_channels_normalized` (an external table on a Google Sheet) directly. When the Sheet's Drive credential dropped, the **entire** view failed — not just the other-channels rows, but Google Ads too — taking the whole dashboard down. Someone had to comment out the other-channels slot just to rescue Google Ads.

**Rule:** Never let a Sheet-backed external table sit directly in a production view's critical path. Materialize it to a **native** table on a scheduled query, and have the view read the native table. If a refresh fails, the native table keeps the last good copy and the dashboard stays up. This is now ADR-008. Applies to both `committed_budget_live` and `other_channels_live`.

---

## L-015: Never delete files from an auto-deploy repo without verifying what production serves

**Near-miss (session 2026-06-01):** We were about to `git rm pacing-data.json`. Before doing it, we checked what the production URL actually fetches — it reads the n8n webhook (`DATA_WEBHOOK_URL`), not the JSON, and the repo's HTML copy is stale and not even what Cloudflare serves. So the delete was safe. Had production been reading the JSON, the delete would have broken the live dashboard. Also verified `budget-planning.html` (Nate's new page) reads a webhook, not the JSON.

**Rule:** Before deleting any data/asset from a repo wired to auto-deploy, `curl` the production URL(s) and grep what they actually reference — including any *new* pages a teammate added. Confirm no live path depends on the file. The repo copy and the deployed copy can diverge (here they did).

---

## L-016: The recurring failure mode is a view that covers only one channel/source

**Pattern (seen twice):** `actual_spend_all` originally had only the `google_ads` block (other channels commented out → actual = 0 for them). Then `actual_spend_mtd` was found with the *same* defect — only `google_ads`, so month-to-date was 0 for every other channel. Both silently produced wrong totals that looked plausible.

**Rule:** Any view that aggregates spend must union **all** channels (Google Ads + other_channels_live, normalized via the channel CASE). When you touch or review a spend view, explicitly check every UNION slot is present. A view that returns only Google Ads is the default-wrong state here, not the exception.

---

## L-017: Nextdoor's async report builder is unreliable — use the synchronous `/stats` endpoint

**Mistake / near-miss (session 2026-06-17):** Designed the Nextdoor ingestion around the async `/reports` endpoint (one call → full daily time series as CSV). It completed instantly for an empty account-month, so it looked fine — but every report with real data stalled at `IN_PROGRESS` for 15–20+ minutes with no error, no timeout, and no diagnostic field on the report object. The synchronous `/stats` endpoint returned the identical figures for the same advertiser/window in seconds.

**Rule:** For Nextdoor ingestion use `GET /api/v3/advertisers/{id}/stats?startTime=&endTime=` in a per-advertiser, per-day loop. Treat `/reports` as unreliable for unattended automation. Separately, the report builder enforces **undocumented** metric-conflict rules (e.g. `BILLABLE_SPEND` + `LEAD` → `REPORT_BUILDER_CONFLICT_PARAMETER`). General lesson: an endpoint that "succeeds" only because the result set was empty has not been validated — test against real, non-empty data before building on it.

---

## L-018: Ad-API money fields are currency-prefixed strings that overflow BigQuery NUMERIC scale

**Mistake (session 2026-06-17):** Loaded Nextdoor `/stats` values straight into `NUMERIC` columns and the load failed. Money fields arrive as currency-prefixed strings like `"USD 9458.925231"`, and derived rates (`cpc`, `cpm`) carry up to 12 decimal places — more than BigQuery `NUMERIC`'s maximum scale of 9. Subtler second failure: quantizing zero with `Decimal` produced `0E-9` (scientific notation), which BigQuery also rejects as a NUMERIC literal.

**Rule:** When loading money from any ad API into a `NUMERIC` column: (1) strip the currency-code prefix (`split()[-1]`), (2) `quantize` to ≤9 decimal places, (3) format fixed-point with `format(value, "f")` so zero serializes as `0.000000000`, not `0E-9`. Applies to any future channel API (Yelp, etc.). Note Nextdoor's CTR/CPC are already in percent units — don't multiply by 100 again downstream.

---

## L-019: The n8n webhook projected a stale explicit column list — use `p.*`

**Mistake (session 2026-06-17b):** The pacing dashboard showed SPENT MTD = $0 for **every** channel, including Google Ads which clearly had spend. `budget.pacing_api` had the correct `spent_mtd`, but the n8n webhook's BigQuery node selected an explicit column list (`client, channel, year, month, committed, actual` + the `mondayClientId` JOIN) from an older version of the view, before `spent_mtd` and the enrichment/day columns existed. Those columns never reached the browser, so the dashboard rendered $0 silently.

**Rule:** The webhook query node (`Query pacing_api` in workflow `ODC Pacing — Data API`) uses `SELECT p.*` plus the `mondayClientId` JOIN, so it inherits any column added to `pacing_api`. When you add a column to `pacing_api`, the webhook now passes it through automatically — but if anyone reverts it to an explicit list, this bug returns. Same family as L-016 (a slot that silently covers less than the whole). Note: an n8n webhook trigger does **not** auto-fire on "Execute workflow" in the editor (it waits for the Test URL); validate by Publishing and `curl`-ing the production webhook, after confirming the SQL in BigQuery directly.

---

## L-020: Channel spend lives in TWO parallel views — change both

**Mistake (session 2026-06-17b):** After migrating Nextdoor to the API and swapping `actual_spend_all`, the dashboard showed Nextdoor ACTUAL correctly but SPENT MTD = $0. Cause: `budget.actual_spend_mtd` is a **separate** view with its own duplicated copy of the channel union, and it still read Nextdoor from the Sheet (`other_channels_live`, no June data). The session-1 swap only touched `actual_spend_all`.

**Rule:** Spend is assembled in two parallel views — `actual_spend_all` (annual) and `actual_spend_mtd` (month-to-date) — each with the same channel union duplicated. Any change to a channel's source (or a new channel) must be applied to **both**, or the dashboard goes half-right (ACTUAL correct, MTD wrong). Better: refactor `actual_spend_mtd` to derive from the same base as `actual_spend_all` (PENDING P-TECH-12) so the union exists once. Until then, treat them as a pair.

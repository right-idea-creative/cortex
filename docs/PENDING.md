# Cortex OS — Pending Items

> **Purpose:** what's open, blocked, or waiting. Only live items. **Delete resolved items** — they belong in session logs, not here.

> **Last updated:** 2026-05-27 (session 4)

---

## Operational (need human action, not code)

### P-OPS-01: Backfill incomplete for some MCC-unlinked accounts
- **What:** Google Ads transfer backfill for Jan-Mar 2026 partially recovered ~35 of the 49 affected combos. The remaining ~14 are likely permanently lost (Google refuses to backfill periods when the CID was outside the MCC).
- **Owner:** Sebas to confirm final state once backfill fully completes, then update STATE.md and close this.
- **Status:** waiting

### P-OPS-02: ~14 accounts "Spending Without Budget" in current month
- **What:** As of 2026-05-27, the pacing dashboard shows ~14 account×platform combos that are spending money but have no budget row in the new `ODC Forecast - 2026 LIVE` planner.
- **Likely cause:** the planner migration left some active CIDs without a row in May.
- **Owner:** Cole (AM operations) to verify and either add missing budgets or mark accounts as off-boarded.
- **Status:** waiting on Cole

### P-OPS-03: ~6 CIDs spending without any planner row at all
- **What:** Six customer_ids (4 Google Ads, 2 Nextdoor) appear in BQ spend with no corresponding row in `budgets_normalized`. They show as `source_group = NULL` in the dashboard.
- **CIDs:** `2573072690`, `6889598437`, `7867391182`, `9077355543` (all Google Ads); `801934534030395109`, `801931604434879609` (Nextdoor).
- **Owner:** Cole / Nate to identify which accounts these are and decide: add to planner, or filter from dashboard.
- **Status:** waiting

### P-OPS-04: Manual sheet capture process generates Date NULL rows
- **What:** The Other Channel Spend sheet had 2,348 rows with `Date NULL` on 2026-05-27 — fixed manually by Sebas. The root cause (probably a copy-paste or export error) hasn't been identified. Will recur if not fixed.
- **Owner:** Cole / whoever maintains the manual capture.
- **Status:** waiting

### P-OPS-05: 34 real AM Over-reported cases need reconciliation
- **What:** After backfill and removing false positives, 34 historical month×account×platform rows remain in the `Captured Mismatch (AM Over-reported)` bucket. These are likely real reporting discrepancies (AM logged spend that doesn't show in BQ even though BQ has coverage for that period).
- **Owner:** Cole to spot-check and either reconcile in planner or escalate.
- **Status:** waiting

### P-OPS-06: 24 AM Under-reported cases (~$24k total)
- **What:** Same bucket as above but inverted — AM logged less than what BQ shows. Less alarming than over-reporting but should still be reconciled.
- **Owner:** Cole.
- **Status:** waiting

---

## Technical (code/infra changes)

### P-TECH-01: GitHub Actions `Node.js 20 deprecated` warning
- **What:** The current workflow uses `actions/checkout@v4`, `actions/setup-python@v5`, `google-github-actions/auth@v2`. GitHub's runner warns these depend on Node.js 20 which is being deprecated. Workflow still runs green.
- **Fix:** bump to whichever versions GitHub publishes for Node 22+.
- **Priority:** low. Warning only, not failure.

### P-TECH-02: Long-lived JSON key for `cortex-bigquery` SA
- **What:** Currently the GHA workflow uses a JSON SA key stored as `GCP_SA_KEY` secret. This is a long-lived credential.
- **Better:** migrate to Workload Identity Federation so GitHub Actions can short-lived auth via OIDC without a static key.
- **Priority:** medium. Not urgent but cleaner security posture.

### P-TECH-03: Notify Nate about the new pacing module
- **What:** Nate may not yet have seen the live pacing dashboard. He should review and provide feedback before we add more features.
- **Owner:** Sebas to message Nate.
- **Priority:** high (blocking further pacing iteration).

### P-TECH-04: Pacing dashboard has no historical snapshot retention
- **What:** Every refresh overwrites `pacing-data.json`. We can't currently look back at "what did pacing look like 7 days ago?".
- **Fix idea:** also write `pacing-data-YYYY-MM-DD.json` to a separate folder, or store snapshots in GCS.
- **Priority:** low. Add when someone asks for trend analysis.

---

## Carry-over (long-running)

### P-CARRY-01: Migrate n8n to self-hosted on GCP
- Currently runs on `naterimc.app.n8n.cloud`. Goal: move to GCP for unified billing and infra.
- Owner: Sebas + Daniel.

### P-CARRY-02: Pipeline for non-ODC ("Other clients") budget data via API
- Other clients' budgets aren't currently fed into the pacing pipeline programmatically. May or may not be in scope — depends on Nate's direction.

### P-CARRY-03: Conflict between Monday automations and n8n auto-assignment
- Two systems can both assign tasks; they collide. Stand-by with Nate to decide which wins.
- See session `2026-04-*` for context (TODO: migrate that session log into this folder).

### P-CARRY-04: Extend `client_mapping` with CIDs for Meta / Nextdoor / LSA / Bing
- Currently only Google Ads CIDs are mapped. Other platforms use their own IDs (Meta page IDs, Nextdoor business IDs, etc.). Map them to the same `account_name` for consistency.
- Priority: medium.

---

## Resolved this week (will be deleted on next update)

Nothing yet — this section gets purged at the start of each new session.

## Added in session 2026-05-30

### P-TECH-05: Locate where CTM pipeline actually runs
- **What:** The CTM pipeline writes to BigQuery daily at 04:01 UTC as `ctm-pipeline-sa@`. The code that creates the staging tables and runs the MERGE is somewhere outside the BigQuery audit logs.
- **Candidates:** Cloud Run service, Cloud Function, n8n flow, external server, Cloud Scheduler triggering one of the above.
- **Owner:** Sebas to ask Nate directly (fastest), or run `gcloud functions list` / `gcloud run services list` / `gcloud scheduler jobs list` to find it.
- **Priority:** medium — pipeline works, but we need to know where to debug or modify it.

### P-TECH-06: Orphan CTM staging tables in `ctm_data`
- **What:** The CTM pipeline creates `ctm_data.ctm_calls_staging_<unix_ms>` tables but doesn't drop them after MERGE completes. At least 3 orphan tables exist as of 2026-05-30.
- **Fix:** add cleanup step to the pipeline (drop staging after successful MERGE), OR add a scheduled query that drops staging tables older than 7 days.
- **Priority:** low — cost is negligible, but it's untidy and could mask real failures if pipeline run-count metrics are derived from table presence.

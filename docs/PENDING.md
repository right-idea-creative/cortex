# Cortex OS — Pending Items

> **Purpose:** what's open, blocked, or waiting. Only live items. **Delete resolved items** — they belong in session logs, not here.

> **Last updated:** 2026-06-17 (session 7)

---

## Operational (need human action, not code)

### P-OPS-01: Backfill incomplete for some MCC-unlinked accounts
- **What:** Google Ads transfer backfill for Jan-Mar 2026 partially recovered ~35 of the 49 affected combos. The remaining ~14 are likely permanently lost (Google refuses to backfill periods when the CID was outside the MCC).
- **Owner:** Sebas to confirm final state once backfill fully completes, then update STATE.md and close this.
- **Status:** waiting

### P-OPS-02: ~14 accounts "Spending Without Budget" in current month
- **What:** account×platform combos spending money but with no budget row. Needs re-verification against the live committed budget (`committed_budget_live`).
- **Owner:** Cole (AM operations).
- **Status:** waiting on Cole

### P-OPS-03: ~6 CIDs spending without any planner row at all
- **What:** Six customer_ids (4 Google Ads, 2 Nextdoor) appear in BQ spend with no corresponding budget row. They show as `source_group = NULL`.
- **CIDs:** `2573072690`, `6889598437`, `7867391182`, `9077355543` (Google Ads); `801934534030395109`, `801931604434879609` (Nextdoor).
- **Note (2026-06-17):** the two Nextdoor CIDs now appear in `budget.nextdoor_spend_daily` (API feed, ADR-010). The gap is the missing **budget** row, not missing spend data.
- **Owner:** Cole / Nate.
- **Status:** waiting

### P-OPS-04: Manual sheet capture generates Date NULL rows
- **What:** The Other Channel Spend sheet periodically has rows with `Date NULL` that get silently dropped by `WHERE Date IS NOT NULL`. Root cause (copy-paste/export error) not identified; will recur.
- **Owner:** Cole / whoever maintains the manual capture.
- **Status:** waiting

### P-OPS-05: 34 real AM Over-reported cases need reconciliation
- **What:** 34 historical month×account×platform rows in the `Captured Mismatch (AM Over-reported)` bucket — likely real reporting discrepancies.
- **Owner:** Cole.
- **Status:** waiting

### P-OPS-06: 24 AM Under-reported cases (~$24k total)
- **What:** Inverted version of P-OPS-05 — AM logged less than BQ shows.
- **Owner:** Cole.
- **Status:** waiting

### P-OPS-07: Yelp has committed budget but no actual-spend feed
- **What:** Yelp appears as a channel in the live committed budget (`committed_budget_long` Sheet → `committed_budget_live`), with real committed amounts for several ODC clients (e.g. ODC Dallas Fort Worth, ODC Denver). But `pacing_api` shows actual = 0 for Yelp because there is no Yelp actual-spend feed — Yelp is not in the other-channels Sheet (`other_channels_normalized`).
- **Effect:** the dashboard shows Yelp as ~100% under-spent for every client with Yelp budget. That's a capture gap, not under-spend.
- **Decision needed:** either (a) add a Yelp actual-spend feed to the other-channels Sheet, or (b) decide Yelp is committed-only for now and suppress/annotate it in the dashboard.
- **Owner:** Nate / whoever maintains the other-channels Sheet.
- **Status:** waiting. (Same class of gap as LSA historically.)

### P-OPS-08: Remove Nextdoor rows from the Other Channel Spend Sheet
- **What:** Nextdoor now flows from the API (`budget.nextdoor_spend_daily`, ADR-010). `actual_spend_all` excludes Nextdoor from the Sheet branch, but the Other Channel Spend Sheet (and therefore `other_channels_live`) still physically carries ~1,689 Nextdoor rows. They are dead — ignored by the view — but waste space and will confuse whoever edits the Sheet.
- **Fix:** stop entering Nextdoor in the Sheet going forward; optionally clear historical Nextdoor rows from it.
- **Owner:** whoever maintains the Other Channel Spend Sheet (Cole / Nate).
- **Status:** waiting

---

## Technical (code/infra changes)

### P-TECH-01: GitHub Actions `Node.js 20 deprecated` warning
- **What:** Workflow actions depend on Node.js 20 which GitHub is deprecating. (Note: the pacing refresh workflow itself was removed 2026-06-01 — see P-TECH-09. Verify whether any remaining workflow still triggers this warning before actioning.)
- **Priority:** low. Warning only.

### P-TECH-02: Long-lived JSON key for the GitHub Actions SA
- **What:** GitHub-side automation uses a static JSON SA key in secret `GCP_SA_KEY`. Long-lived credential.
- **Better:** migrate to Workload Identity Federation (OIDC, short-lived).
- **Priority:** medium. With the pacing Action removed (P-TECH-09), audit whether this secret is still used by anything before rotating/removing it.

### P-TECH-03: Notify Nate about the pacing module
- **What:** carryover — confirm Nate has reviewed the live pacing dashboard and the pipeline changes.
- **Owner:** Sebas.
- **Priority:** medium.

### P-TECH-04: Pacing dashboard has no historical snapshot retention
- **What:** No way to look back at "what did pacing look like 7 days ago?". (Note: the old static-JSON snapshot approach is gone; if snapshots are wanted now, they'd come from snapshotting `pacing_api` output, e.g. to GCS.)
- **Priority:** low.

### P-TECH-05: Locate where CTM pipeline actually runs
- **What:** The CTM pipeline writes to BigQuery daily at 04:01 UTC as `ctm-pipeline-sa@`. The code that creates staging tables and runs the MERGE is somewhere outside the BigQuery audit logs.
- **Candidates:** Cloud Run, Cloud Function, n8n flow, external server, Cloud Scheduler.
- **Owner:** Sebas to ask Nate directly, or run `gcloud functions list` / `gcloud run services list` / `gcloud scheduler jobs list`.
- **Priority:** medium.

### P-TECH-06: Orphan CTM staging tables in `ctm_data`
- **What:** The CTM pipeline creates `ctm_data.ctm_calls_staging_<unix_ms>` tables but never drops them. At least 3 orphans as of 2026-05-30.
- **Fix:** add cleanup to the pipeline, or a scheduled query dropping staging tables older than 7 days.
- **Priority:** low.

### P-TECH-07: Decide fate of orphaned `budget.committed`
- **What:** `budget.committed` is a VIEW reading the old `committed_budget_seed` (hand-loaded, no Yelp, stale). It is **not** used by `pacing_api` (which uses `committed_budget_live`). It still exists and looks authoritative by name.
- **Risk:** Nate's `budget-planning.html` is specced to show "what's in budget/committed". If it (or its webhook) reads `budget.committed`, it shows stale seed data divergent from the live dashboard. Two different "committed budget" numbers in one product. (The repo's `pacing_api_view.sql` also still references `committed`, not `committed_budget_live` — see P-TECH-08.)
- **Fix:** repoint `budget.committed` to read `committed_budget_live`, or delete it and point consumers at `committed_budget_live`. Confirm with Nate first.
- **Priority:** high (blocks a correct budget-planning page).

### P-TECH-08: `pacing_api_view.sql` in the repo is stale vs the live view
- **What:** The repo's `pacing_api_view.sql` is a simplified/template version (uses `your_project` placeholder, reads `committed`, lacks the enrichment / `actual_spend_mtd` / day-of-month dims). The **live** `pacing_api` in BigQuery is significantly more complex (verified via DDL 2026-06-01).
- **Fix:** dump the live `pacing_api` DDL into `pacing_api_view.sql` so the repo matches production. Same for `actual_spend_all` / `actual_spend_mtd` if we want them versioned.
- **Priority:** medium.

### P-TECH-09: Replace stale repo `ad-spend-pacing.html` with the production version
- **What:** The repo's `ad-spend-pacing.html` reads the old `pacing-data.json` (now deleted). Production serves a newer HTML that reads the n8n webhook, uploaded by Nate outside the repo's auto-deploy. The repo no longer matches what's deployed.
- **Context:** The old static-JSON pipeline (`refresh-pacing.yml`, `export_pacing_data.py`, `pacing-data.json`, `requirements.txt`) was removed 2026-06-01 after verifying production reads the webhook, not the JSON.
- **Fix:** pull the production HTML into the repo so it's the source of truth and auto-deploy stops diverging from manual uploads.
- **Priority:** medium. Doesn't break production, but it's the "code lives outside git, uploaded by hand" hazard that caused pain on 05-01.

### P-TECH-10: Rotate the Nextdoor API token before it expires
- **What:** Secret Manager secret `nextdoor-ads-token` holds the Nextdoor Ads API v3 bearer used by `cortex-nextdoor-ingest`. It **expires 2027-06-16** (1-year UI token; no client_credentials flow exists in v3).
- **Fix:** ~May 2027, Refresh the token in the Nextdoor Ads UI (ads.nextdoor.com → Ads API) and `gcloud secrets versions add nextdoor-ads-token --data-file=-` with the new value. The job reads `:latest`, so **no redeploy** is needed.
- **Owner:** Sebas. Set a calendar reminder.
- **Priority:** low now, hard deadline 2027-06.

### P-TECH-11: TEST/TRASH advertisers land in `nextdoor_spend_daily`
- **What:** `/me` returns 26 advertisers including non-client junk (`TEST 1 [DO NOT USE]`, `TEST 2 [DO NOT USE]`, `TRASH`, `Trash`). They are written to the raw `nextdoor_spend_daily` table. They do **not** reach `actual_spend_all` (not present in `client_crosswalk`, so the join drops them), so this is cosmetic.
- **Fix (optional):** exclude by name in the job, or filter the `/me` list against an allowlist derived from `client_crosswalk`.
- **Priority:** low.

---

## Carry-over (long-running)

### P-CARRY-01: Migrate n8n off `naterimc.app.n8n.cloud`
- The pacing webhook (`odc-pacing-data`) and tickets bot run on Nate's n8n cloud instance. Single point of failure outside our GCP project, and we've seen it serve cached data. Consider self-hosting on GCP for unified infra/billing and cache control.
- **Owner:** Sebas.

### P-CARRY-02: Pipeline for non-ODC ("Other clients") budget data
- Other clients' budgets aren't fully fed into the pacing pipeline. Depends on Nate's direction.

### P-CARRY-03: Conflict between Monday automations and n8n auto-assignment
- Two systems can both assign tasks; they collide. Stand-by with Nate to decide which wins.

### P-CARRY-04: Extend the channel mapping with non-Google IDs natively
- The crosswalk is built from Google Ads CIDs + a join to `client_mapping`. Non-Google channel IDs (Meta/Nextdoor/LSA/Bing/Yelp) currently need manual inserts that get wiped on rebuild. Rewrite the crosswalk build to UNPIVOT `client_mapping` so all channel IDs map natively.
- **Note (2026-06-17):** Nextdoor IDs are already present in `client_crosswalk` and matched 1:1 in the Nextdoor backfill (ADR-010), but per this item they can be wiped on a crosswalk rebuild — the native UNPIVOT fix would make them durable. `reference.client_mapping` already has a `nextdoor_id` column to source from.
- **Priority:** medium.

### P-CARRY-05: Delete empty remote repo `cortex-budget-pacing`
- `right-idea-creative/cortex-budget-pacing` is an empty GitHub repo (created 05-27, never populated) from the abandoned Cloud Run + GCS approach. Local clone already deleted.
- **Fix:** delete the remote repo from GitHub. Quick confirm with Nate since it's in the org.
- **Priority:** low (inert).

---

## Resolved in session 2026-06-17 (will be deleted on next update)

- Built and deployed the Nextdoor Ads API → BigQuery pipeline end-to-end (ADR-010): Cloud Run Job `cortex-nextdoor-ingest` + Scheduler `cortex-nextdoor-daily` + SA `cortex-nextdoor@` + Secret `nextdoor-ads-token` + native table `budget.nextdoor_spend_daily`.
- Backfilled Jan 1 – May 31 2026 for all 26 advertisers (1,322 active account-days); validated parity vs the Sheet to the cent.
- Swapped `actual_spend_all` to read Nextdoor from the API table (third CTE) and excluded Nextdoor from the Sheet branch; verified no double counting.
- Confirmed idempotency of the MERGE and a Scheduler-triggered execution running as the SA.

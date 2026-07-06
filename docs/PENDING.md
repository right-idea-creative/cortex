# Cortex OS — Pending Items

> **Purpose:** what's open, blocked, or waiting. Only live items. **Delete resolved items** — they belong in session logs, not here.

> **Last updated:** 2026-07-05 (Meta ingest session + Sheet cleanup)

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
- **What:** The Other Channel Spend sheet periodically has rows with `Date NULL` that get silently dropped by `WHERE Date IS NOT NULL`. Root cause (copy-paste/export error) not identified; will recur. **Note (2026-07-05):** the Sheet is now Bing-only, so the surface area for this shrank considerably.
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
- **Decision needed:** either (a) add a Yelp actual-spend feed, or (b) decide Yelp is committed-only for now and suppress/annotate it in the dashboard.
- **Owner:** Nate / whoever maintains the other-channels Sheet.
- **Status:** waiting. (Same class of gap as LSA historically.) **Note:** now that two channels (Nextdoor, Meta) follow the Cloud Run Job template, a Yelp API pull would be the natural (a) option — same `meta-ingest/` scaffold.

### P-OPS-09: ODC Savannah under-captured in the Meta Sheet (~$895)
- **What:** Reconciling the Meta API backfill against the Sheet, ODC Savannah (`2758529924464378`) showed +$379 (March) and +$516 (April) in the API vs the Sheet. Drill-down confirmed the API is correct (consecutive days, one real campaign, no dupes) — the manual Sheet capture **under-recorded ~$895** of real Meta spend across the two months.
- **Effect:** historical Meta reporting for Savannah was low by ~$895. Now corrected at source (API).
- **Owner:** Cole (or whoever maintains the manual Meta capture) — flag that the manual process missed real spend.
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
- **Fix:** dump the live `pacing_api` DDL into `pacing_api_view.sql` so the repo matches production. Same for `actual_spend_all` / `actual_spend_mtd` if we want them versioned. **Note (2026-07-05):** `actual_spend_all` and `actual_spend_mtd` are now more complex too (Meta CTE added, ADR-011) — worth versioning all three view DDLs together.
- **Priority:** medium.

### P-TECH-10: Rotate the Nextdoor API token before it expires
- **What:** Secret Manager secret `nextdoor-ads-token` holds the Nextdoor Ads API v3 bearer used by `cortex-nextdoor-ingest`. It **expires 2027-06-16** (1-year UI token; no client_credentials flow exists in v3).
- **Fix:** ~May 2027, Refresh the token in the Nextdoor Ads UI (ads.nextdoor.com → Ads API) and `gcloud secrets versions add nextdoor-ads-token --data-file=-` with the new value. The job reads `:latest`, so **no redeploy** is needed.
- **Owner:** Sebas. Set a calendar reminder.
- **Priority:** low now, hard deadline 2027-06.

### P-TECH-11: TEST/TRASH advertisers land in `nextdoor_spend_daily`
- **What:** `/me` returns 26 advertisers including non-client junk (`TEST 1 [DO NOT USE]`, `TEST 2 [DO NOT USE]`, `TRASH`, `Trash`). They are written to the raw `nextdoor_spend_daily` table. They do **not** reach `actual_spend_all` (not present in `client_crosswalk`, so the join drops them), so this is cosmetic.
- **Fix (optional):** exclude by name in the job, or filter the `/me` list against an allowlist derived from `client_crosswalk`.
- **Priority:** low.

### P-TECH-12: Refactor `actual_spend_mtd` to not duplicate the channel union
- `actual_spend_mtd` (month-to-date) carries its own copy of the channel union that `actual_spend_all` (annual) already has. This duplication is what caused the session-8 bug: Nextdoor was swapped in one view but not the other, so the dashboard went half-right (ACTUAL correct, MTD $0). **Reinforced 2026-07-05:** Meta had to be swapped in both views for the same reason. Refactor so the MTD figure derives from the same base/source as the annual view and the union exists once. Until then, any channel-source change must be applied to **both** views (LEARNINGS L-020).
- **Priority:** medium (grows each time a channel is added).

### P-TECH-13: Verify `committed = "0.0"` is not hitting ODC clients with budget
- The webhook returns `committed = "0.0"` for some clients with real `actual` (e.g. CharterWest Bank — but that's `source_group: Other`, likely legitimately no committed budget). Confirm this is **not** happening for any **ODC** client that does have committed budget in the planner. If it is, the bug is likely in the `pacing_api` FULL OUTER JOIN with `committed_budget_live` (a client present in actuals but unmatched on the committed side yields 0). Low urgency; verify with a targeted query across ODC clients.

### P-TECH-14: Rotate the Meta access token (exposed in build chat)
- **What:** Secret Manager secret `meta-access-token` holds the Meta System User token used by `cortex-meta-ingest`. It was **pasted in plaintext in the build chat session** on 2026-07-05, so it must be rotated regardless of its natural expiry.
- **Fix:** in Business Manager → System User `cortex-bigquery` (`61591760422985`) → revoke the current token, generate a new one (`ads_read`), then `gcloud secrets versions add meta-access-token --project=rightidea-cortex --data-file=-` with the new value. The job reads `:latest`, so **no redeploy** is needed.
- **Owner:** Sebas. Do next session.
- **Priority:** medium-high (security; a live read token was exposed).

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
- **Note (2026-07-05):** Daytona's Meta id (`1414845413594090`) was **manually inserted** into `client_crosswalk` this session (ADR-011 / L-021) and is exactly the kind of per-channel row a rebuild would wipe. Meta ids in general are now a live dependency of this item.
- **Priority:** medium.

### P-CARRY-05: Delete empty remote repo `cortex-budget-pacing`
- `right-idea-creative/cortex-budget-pacing` is an empty GitHub repo (created 05-27, never populated) from the abandoned Cloud Run + GCS approach. Local clone already deleted.
- **Fix:** delete the remote repo from GitHub. Quick confirm with Nate since it's in the org.
- **Priority:** low (inert).

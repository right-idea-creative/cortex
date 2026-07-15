# Cortex OS — Pending Items

> **Purpose:** what's open, blocked, or waiting. Only live items. **Delete resolved items** — they belong in session logs, not here.

> **Last updated:** 2026-07-14 (security fix, Budget Editor, Identity v5, rebrand)

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
- **Owner:** Cole / Nate.
- **Status:** waiting

### P-OPS-04: Manual sheet capture generates Date NULL rows
- **What:** The Other Channel Spend sheet periodically has rows with `Date NULL` that get silently dropped. Root cause not identified; will recur. The Sheet is now Bing-only, so the surface area shrank considerably.
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
- **What:** Yelp appears as a channel in the live committed budget with real committed amounts for several ODC clients, but there is no Yelp actual-spend feed, so the dashboard shows ~100% under-spent — a capture gap, not real under-spend.
- **Decision needed:** add a Yelp actual-spend feed (Cloud Run Job, same template as Meta/Nextdoor), or mark Yelp committed-only and annotate it.
- **Owner:** Nate.
- **Status:** waiting

### P-OPS-09: ODC Savannah under-captured in the Meta Sheet (~$895)
- **What:** The manual Sheet capture under-recorded ~$895 of real Meta spend for ODC Savannah across March+April; corrected at source now that Meta comes from the API.
- **Owner:** Cole — flag that the manual process missed real spend historically.
- **Status:** waiting

---

## Technical (code/infra changes)

### P-TECH-01: GitHub Actions `Node.js 20 deprecated` warning
- **What:** Workflow actions depend on Node.js 20 which GitHub is deprecating. Verify whether any remaining workflow still triggers this before actioning.
- **Priority:** low. Warning only.

### P-TECH-02: Long-lived JSON key for the GitHub Actions SA
- **What:** GitHub-side automation uses a static JSON SA key in secret `GCP_SA_KEY`. Long-lived credential.
- **Better:** migrate to Workload Identity Federation (OIDC, short-lived).
- **Priority:** medium.

### P-TECH-03: Notify Nate about the pacing module
- **What:** carryover — confirm Nate has reviewed the live pacing dashboard and the pipeline changes.
- **Owner:** Sebas.
- **Priority:** medium.

### P-TECH-04: Pacing dashboard has no historical snapshot retention
- **What:** No way to look back at "what did pacing look like 7 days ago?".
- **Priority:** low.

### P-TECH-05: Locate where CTM pipeline actually runs
- **What:** The CTM pipeline writes to BigQuery daily at 04:01 UTC. The code that runs it is unconfirmed.
- **Candidates:** Cloud Run, Cloud Function, n8n flow, external server, Cloud Scheduler.
- **Owner:** Sebas to ask Nate directly, or `gcloud functions list` / `gcloud run services list` / `gcloud scheduler jobs list`.
- **Priority:** medium.

### P-TECH-06: Orphan CTM staging tables in `ctm_data`
- **What:** The CTM pipeline creates staging tables but never drops them.
- **Fix:** add cleanup, or a scheduled query dropping staging tables older than 7 days.
- **Priority:** low.

### P-TECH-07: Decide fate of orphaned `budget.committed`
- **What:** `budget.committed` reads old `committed_budget_seed` (stale, no Yelp). Not used by `pacing_api`. Risk: anything reading it directly shows stale data divergent from the live dashboard.
- **Fix:** repoint to `committed_budget_live` or delete and point consumers there. Confirm with Nate first.
- **Priority:** high.

### P-TECH-08: `pacing_api_view.sql` in the repo is stale vs the live view
- **What:** The repo file is a simplified template; the live `pacing_api` is significantly more complex (now includes Meta CTE, ADR-011).
- **Fix:** dump the live DDL into the repo file so it matches production. Same for `actual_spend_all`/`actual_spend_mtd` if versioning them.
- **Priority:** medium.

### P-TECH-10: Rotate the Nextdoor API token before it expires
- **What:** `nextdoor-ads-token` expires 2027-06-16 (1-year UI token).
- **Fix:** ~May 2027, refresh in the Nextdoor Ads UI and `gcloud secrets versions add nextdoor-ads-token ...`. No redeploy needed.
- **Owner:** Sebas. Set a calendar reminder.
- **Priority:** low now, hard deadline 2027-06.

### P-TECH-11: TEST/TRASH advertisers land in `nextdoor_spend_daily`
- **What:** `/me` returns junk test accounts written to the raw table. Cosmetic — they don't reach `actual_spend_all` (not in crosswalk).
- **Priority:** low.

### P-TECH-12: Refactor `actual_spend_mtd` to not duplicate the channel union
- **What:** `actual_spend_mtd` carries its own copy of the channel union that `actual_spend_all` has. Every channel change (Nextdoor, then Meta) had to be applied to both, or the dashboard goes half-right.
- **Fix:** derive MTD from the same base as the annual view so the union exists once.
- **Priority:** medium (grows each time a channel is added).

### P-TECH-13: Verify `committed = "0.0"` is not hitting ODC clients with budget
- **What:** confirm the FULL OUTER JOIN in `pacing_api` isn't zeroing committed for any ODC client that does have budget.
- **Priority:** low, verify with a targeted query.

### P-TECH-14: Rotate the Meta access token (exposed in build chat)
- **What:** `meta-access-token` was pasted in plaintext in a build chat on 2026-07-05.
- **Fix:** revoke + regenerate in Business Manager → System User `cortex-bigquery`, then `gcloud secrets versions add meta-access-token ...`. No redeploy needed.
- **Owner:** Sebas.
- **Priority:** medium-high (security).

### P-TECH-15: Migrate remaining internal pages off the old light/blue theme
- **What:** `strategy.html`, `kpi.html`, `account-standard.html`, `budget-planning.html`, `budget-history.html`, `triage.html`, `call-tracking.html`, `ad-spend-pacing.html`, `tickets.html`, `roadmap.html` still use the pre-rebrand light background + blue pill/button styling. Only the shared shell (nav/header) and `index.html` are on the teal/carbon identity so far.
- **Fix:** migrate page-by-page, no rush.
- **Priority:** low/cosmetic.

### P-TECH-16: Retire `budget.am_directory` once `identity.*` is proven stable
- **What:** `am_directory` is kept only as a legacy fallback in `functions/api/budget-events.js` (ADR-012). Once `identity.user_access` has run without incident for a while, drop the fallback code path and archive/drop the table.
- **Priority:** low, not urgent — harmless as-is.

### P-TECH-17: KPI page returns 500 (never worked, not a regression)
- **What:** `/kpi` fails with a server 500 on `api/kpi`, surfaced in-browser as `SyntaxError: Unexpected token '<'...` (endpoint returns an HTML error page instead of JSON). Confirmed never functional — unrelated to the rebrand or Identity v5.
- **Fix:** inspect `functions/api/kpi.js` and its backing store (Neon) for the actual failure; needs its own investigation session.
- **Priority:** medium (a whole module is non-functional, but not urgent/blocking).

### P-TECH-18 (pattern to watch, not a standing action item): identity/permission table duplication
- Two separate tables (`budget.am_directory`, then `identity.users`) were found duplicated due to non-idempotent seeds, both fixed via `ROW_NUMBER()`-based dedup. See LEARNINGS L-022. If a third instance of this happens, promote it to a real action item (add an idempotency check to the seed scripts themselves).

---

## Carry-over (long-running)

### P-CARRY-01: Migrate n8n off `naterimc.app.n8n.cloud`
- The pacing webhook and tickets bot run on Nate's personal n8n cloud instance. Single point of failure outside our GCP project.
- **Owner:** Sebas.

### P-CARRY-02: Pipeline for non-ODC ("Other clients") budget data
- Other clients' budgets aren't fully fed into the pacing pipeline. Depends on Nate's direction.

### P-CARRY-03: Conflict between Monday automations and n8n auto-assignment
- Two systems can both assign tasks; they collide. Stand-by with Nate to decide which wins.

### P-CARRY-04: Extend the channel mapping with non-Google IDs natively
- The crosswalk needs manual inserts for non-Google channel IDs that get wiped on rebuild (Daytona's Meta id is a live example, ADR-011/L-021). Rewrite the crosswalk build to UNPIVOT `client_mapping` so all channel IDs map natively.
- **Priority:** medium.

### P-CARRY-05: Delete empty remote repo `cortex-budget-pacing`
- Empty GitHub repo from an abandoned approach. Confirm with Nate, then delete.
- **Priority:** low (inert).

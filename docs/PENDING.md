# Cortex OS — Pending Items

## Added 2026-07-30 (late) — two new projects scoped for their own sessions

### P-ALERT-01 — Campaign-health alert system (Juanes / analysts' request)

**What they asked for (Google Chat, Digital Team, 2026-07-28):** alerts when a campaign
breaks. Seven triggers requested:
1. No spend in 3 days
2. Overspend +10% for the week vs actual budget
3. Campaign status "Not eligible" / "All Ads disapproved"
4. Advertiser Verification pending or failed
5. Landing page / URL problems ("Destino no válido", "URL final no válida", "URL disapproved: Destination mismatch")
6. Phone number problems ("Phone number disapproved", "Unverified phone number")
Plus Sebas's own priority: **campaigns that pause without anyone knowing** (e.g. paused
because a credit card was declined).

**Data audit — partial, done this session (this is half the first-phase work):**
- The Google Ads Data Transfer (`raw_google_ads`, MCC `6118198619`) has the **full tree**:
  `ads_Campaign`, `ads_Ad`, `ads_Asset`, `ads_CampaignAsset`, `ads_Customer`, `ads_Budget`,
  `ads_LandingPageStats`, plus partitioned `p_ads_*` daily tables. Most triggers have a
  candidate table.
- **Confirmed viable now:** `ads_Campaign` has `campaign_status` (ENABLED/PAUSED/REMOVED)
  and `campaign_serving_status` (SERVING/SUSPENDED/ENDED). Real values checked on latest
  partition. **The gold trigger: `campaign_status='ENABLED' AND campaign_serving_status='SUSPENDED'`**
  = the AM wants it running, Google blocked it, they don't know. (Latest snapshot: 1 such
  campaign; 7 PAUSED+SUSPENDED, 5 REMOVED+SUSPENDED.)
- **Triggers 1 & 2 (no spend / overspend):** trivial — come from pacing data already in use
  (`p_ads_CampaignBasicStats` → `spend_daily_unified`).
- **Key limitation found:** `campaign_status='PAUSED'` does NOT tell you WHY it paused —
  manual pause vs card-declined look identical at campaign level. The pause *reason* (card,
  billing) is account/billing-level, not campaign-level. `SUSPENDED` is the closest signal
  ("blocked") but doesn't say "by the card". The declined-card trigger may need `ads_Customer`
  / `ads_Budget` billing fields (unaudited) or the Google Ads API directly — may not be
  available via Data Transfer at all. **Set expectations: "campaign is blocked/paused and you
  didn't know" is achievable and 10x better than finding out a week later; "paused *because
  of the card* specifically" may not be.**

**Still to audit (first task of the alert session — we know WHICH tables to look at):**
- `ads_Ad` → does it carry `policy_approval_status` / disapproval reasons? (triggers 3, 5)
- `ads_Asset` / `ads_CampaignAsset` → call assets, phone-number approval status? (trigger 6)
- `ads_Customer` → advertiser verification status? (trigger 4)
- `ads_Budget` / `ads_Customer` → any billing / payment / account-status field? (declined card)

**Design decision (pending, Sebas's stated direction):**
- Alerts must **live in Cortex**, not email (too noisy, ignored) and not chat (lost in
  scroll). Persistent, stateful, visible.
- Open question: Cortex-native alert entity (with its own new/in-progress/resolved state,
  shown as a dashboard/popup) **vs** feeding Monday to create tickets (assign to the right
  person, or a pool of alert tickets surfaced in Cortex). **Recommendation on record:**
  start **Cortex-native** (Cortex already renders tickets via the pacing Monday-tickets
  module; a native alert entity avoids replicating the "Monday boards go to die" problem —
  the same adoption risk flagged for Linear). Add Monday integration later only if adoption
  needs it. Adapt to how tickets are created either way.
- Adoption is the real risk, not the tech: **whatever is built has to actually get used.**

**Scope note:** this is its own project / session. Do NOT start building mid-another-session.
First phase = finish the data audit above, then design triggers only for what has data.

### P-AGENT-01 — Cortex knowledge agent (Sebas's idea, separate from alerts)

**What it is:** an agent that answers pointed questions about how Cortex works — e.g. "how
is the budget calculated", "why does this client show a $0 target", the committed/rollover
logic — reading the Share Brain, and getting richer as `/docs` grows. This is the
"brain of Cortex OS" already sketched (phases 0–3: knowledge audit → Claude Project sandbox
→ Cloud Run + read-only tools like `query_bigquery`/`search_docs`/`get_monday_tickets` →
write actions with confirmation). Design principle: the agent never holds knowledge that
isn't in git or a queryable source.

**Explicitly NOT the same as P-ALERT-01.** This is a *knowledge/Q&A* assistant (you ask it
things). Alerts are *detection/notification* (it tells you when something breaks). Juanes'
request is P-ALERT-01, not this. Keep them separate — don't build the agent expecting it to
solve the alerts, and don't let the alerts project balloon into the agent.

**Status:** lower urgency than P-ALERT-01 (nobody is blocked on it; it's Sebas's initiative).
Own session when the time comes. The Share Brain being current (as of this session) is the
prerequisite that makes it feasible — the agent reads `/docs`, so doc quality = agent quality.


## Added 2026-07-30 (pacing session + Norfolk)

### 🔴 Structural — #1 priority (own dedicated session, not a mid-session patch)

- **P-TECH-19 — Complete the Sheet→Editor committed-budget migration.** `budget_base_current` = `COALESCE(latest_events, committed_budget_live)`. Only ~23% migrated: 20 clients on the editor, **67 still on the Google Sheet** (`committed_budget_live`, refreshed daily 05:00 from `raw_budget.committed_budget_long`). The Sheet is the live fallback for 77% of clients — do NOT remove it from the COALESCE until migration is done. Plan: migrate remaining clients into `budget_events`, then retire the Sheet leg. (See L-027.)
- **P-TECH-20 — Unify client identity: resolve committed by `customer_id`, not name.** Actual joins by `customer_id` → crosswalk (robust); committed matches on client *name* as free text (fragile) — root cause of Norfolk desync (L-025) and will recur with any name-sharing client. Fix: join committed to the crosswalk by `customer_id` too, single identity source. Related to P-CARRY-04 (extend crosswalk with non-Google IDs natively). Do P-CARRY-04 as part of this.

### Design decision (needs Nate + analysts)

- **P-DESIGN-01 — Issue 9: `actual` real-time vs through-yesterday.** Analysts want spend-through-yesterday for pacing (today is incomplete, distorts the number). Metric-definition change: touches `spend_daily_unified`/`actual_spend_all` (filter `date < CURRENT_DATE`), and has chain effects — `days_elapsed` must stay consistent, and it interacts with the issue-8 `+1` in `dailyRec()`. Not superficial. Decide together before implementing.

### Ops cleanup

- **P-OPS-10 — Clean up the two Norfolk ghosts.** After the split, "ODC Norfolk" (Sheet) and "ODC Norfolk, VA" (old `budget_events` row) still show committed with $0 actual under old names the crosswalk no longer produces. Cleanup: tombstone the old "ODC Norfolk, VA" event via `event_tombstones` (SQL — editor has no tombstone UI), and remove/rename the "ODC Norfolk" Meta row in the Sheet. Also: Virginia's LSA has actual but no committed (assign a budget or leave — P-OPS-03 family).


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

# Cortex OS — Pending Items

### P-SEC-01 — `cortex-bigquery` service account has 8 keys, 5 that never expire — audit and consolidate

**Found 2026-08-05** during the MacBook migration. Listing the keys of
`cortex-bigquery@rightidea-cortex.iam.gserviceaccount.com` returned **8 active keys, none
disabled**, with these expirations:
- `4629bed0…` exp 2027-04-06 (1 yr)
- `c3fe03e2…` exp 2027-04-06 (1 yr)
- `109ffe7d…` exp 2028-06-01
- `3466cb3b…` exp **9999-12-31 (never)**
- `51f10668…` exp **9999-12-31 (never)**
- `162fe634…` exp **9999-12-31 (never)**
- `26850ca6…` exp **9999-12-31 (never)** ← the one that was on the old MacBook's Desktop (`gcp-sa-key.json`, file deleted, machine wiped)
- `c33c0326…` exp **9999-12-31 (never)**

**Why this is real security debt:** eight downloaded keys means up to eight JSON files in
unknown locations (machines, services, maybe pasted somewhere). Five never expire, which is
exactly the "long-lived credential" pattern to avoid. Sebas's instinct during the migration
("I don't think only I use this key") was correct — there are far more keys than one person's.

**Constraint — do NOT revoke blind.** `cortex-bigquery` is the general BigQuery SA (STATE:
"General BigQuery; Viewer on source Sheets"). Some of these keys may be in use by scheduled
queries, Cloud Run Jobs, or the secondary Mac. Revoking a key that a live process uses breaks
it. GCP lists the keys but not what uses each one — the audit is: check IAM/usage logs to map
each `key_id` to a caller (IP/service), identify which are dead, then revoke the orphans and
put expiration on any that must stay.

**Plan:**
1. Audit usage per key (Cloud Logging / IAM logs) — which `key_id` authenticated recently, from where.
2. Identify dead keys (no recent use) → revoke.
3. For keys that must stay, prefer replacing with short-lived auth (Workload Identity / ADC)
   or at minimum set an expiration — kill the `9999-12-31` ones.
4. Consolidate to the minimum necessary.

**Related:** fits the credential-rotation debt already tracked — P-TECH-14 (Meta token
exposed), P-TECH-02 (long-lived JSON key for the GitHub Actions SA, migrate to WIF/OIDC).
This is the largest of the three. Priority: medium-high (security), own focused session.


### P-SEO-01 — SEO Agent (sibling system, repo `Seo-Agent`)

**What it is:** a pipeline that generates and publishes SEO articles (Python, Claude + OpenAI,
WordPress). External owner. **Decision:** lives in its own separate repo, integrates into
Cortex via BigQuery — same "producer pushes to BQ directly" pattern as ADR-010 (Nextdoor API)
and ADR-011 (Meta API), i.e. a sibling data producer, not a coupled module.

**Open requests:**
- **(a)** Fix QA cost attribution + add OpenAI text-generation tracking.
- **(b)** Post-run sink to a new dataset `seo_content` with three tables: `articles_published`,
  `qa_results`, `content_costs`.
- **(c)** Use the crosswalk's `canonical_client` in `site.json` — **P-TECH-20 applies here**:
  the SEO Agent would hit the exact same client-identity problem Norfolk exposed if it keys
  on client name instead of resolving via the crosswalk. Unify identity from the start.
- **(d)** Record `model` + `prompt version` on every row (traceability, same versioning
  discipline used elsewhere).

**What to import INTO Cortex from this work (reusable patterns for the LLM consumers coming
next):**
- **`llm_gateway`** — failover on 529 / rate-limit across providers.
- **`budget_service`** — per-model cost tracking + a hard spend cap.
These two patterns are needed by every upcoming LLM consumer: the knowledge agent (P-AGENT-01,
"§8"), P-ALERT-01 if it uses an LLM for triage, and the SEO Agent itself. Build/extract them
once, reuse across all three — don't reimplement per consumer.

**Scope note:** external owner drives the repo; Cortex's side is the BQ integration + the two
shared patterns. Own session/coordination when picked up.


## Added 2026-07-30 (late) — two new projects scoped for their own sessions

### P-ALERT-01 — Campaign-health alert system (Juanes / analysts' request)

**What they asked for (Google Chat, Digital Team, 2026-07-28):** alerts when a campaign
breaks. Seven triggers + Sebas's two priorities. **Data audit COMPLETE (2026-08-03).**
Every trigger mapped against the Google Ads Data Transfer (`raw_google_ads`, MCC
`6118198619`). Two clean phases: Phase 1 = viable now via Data Transfer; Phase 2 = requires
the Google Ads API directly, one integration unblocks all four. **Phase-2 access application
is in flight as of 2026-08-05 — see status at the bottom.**

**Requested triggers:** (1) no spend 3 days, (2) overspend +10% weekly vs actual budget,
(3) campaign "Not eligible" / ads disapproved, (4) advertiser verification pending/failed,
(5) landing-page / URL problems ("Destino no válido", "URL disapproved: Destination
mismatch"), (6) phone-number problems ("Phone number disapproved"), + Sebas: campaign
paused without knowing (e.g. card declined).

---

#### PHASE 1 — Viable NOW via Data Transfer (zero new dependencies)

| Trigger | Condition | Source (verified) |
| --- | --- | --- |
| No spend 3 days | spend = 0 across 3 days | `p_ads_CampaignBasicStats` → `spend_daily_unified` (pacing) |
| Overspend +10% | weekly actual > 110% of target | pacing data (already computed) |
| Ads disapproved | `ad_group_ad_policy_summary_approval_status = 'DISAPPROVED'` **in ENABLED campaigns** | `ads_Ad` × `ads_Campaign` |
| **Campaign blocked** (Sebas priority) | `campaign_status='ENABLED' AND campaign_serving_status='SUSPENDED'` | `ads_Campaign` |
| **Bonus** (not requested): budget-capped | daily spend ≈ `campaign_budget_amount_micros` (limited by budget) | `ads_Budget` + spend |

**Verified real values (latest partition, 2026-08-03):**
- `ad_group_ad_policy_summary_approval_status`: APPROVED_LIMITED 2866, APPROVED 2309,
  **DISAPPROVED 1038**, UNKNOWN 283, AREA_OF_INTEREST_ONLY 128. → **1,038 disapproved ads
  right now.** Alert must cross with `ads_Campaign` ENABLED, else it drowns Juanes in
  irrelevant paused/removed ads.
- `campaign_status` × `campaign_serving_status`: 1 ENABLED+SUSPENDED, 7 PAUSED+SUSPENDED,
  5 REMOVED+SUSPENDED. ENABLED+SUSPENDED is the gold trigger.
- Channel mix: SEARCH 503 / DISPLAY 50 / PERFORMANCE_MAX 37 / LOCAL_SERVICES 24 / VIDEO 24
  — clients are ~77% Search (relevant to Phase 2).

---

#### PHASE 2 — Requires the Google Ads API directly (one integration unblocks all four)

Data Transfer does NOT expose these — confirmed by exhaustive column/table search:

| Trigger | Why Data Transfer can't do it (verified) |
| --- | --- |
| Advertiser verification (4) | No `verif`/`identity` column anywhere in `raw_google_ads` (query `[]`). `ads_Customer` has only id, currency, name, manager, test_account, time_zone, auto_tagging. |
| Phone/call disapproved (6) | `ads_Asset` has only `asset_type` (CALL = 1343 assets exist, no approval). `ads_CampaignAsset` policy/status search `[]`. |
| Card declined / billing (Sebas) | No `billing`/`payment`/`account_budget` **table** exists (query `[]`). `ads_Budget.campaign_budget_status` is the budget object status, NOT payment. |
| URL disapproval *reason* (5) | `ads_Ad` has only `..._approval_status` (aggregate), no `policy_topic_entries` — know it's DISAPPROVED, not that it's the URL. |

**Evidence Phase 2 is feasible:** `ads_AssetGroupAsset` (Performance Max) DOES carry the
full trio (`..._approval_status`, `..._policy_topic_entries`, `..._review_status`). Google
exposes approval + reason; the Data Transfer just ships it for PMax asset groups and not
regular ads/call assets. The API returns `policy_topic_entries` for regular resources too.
BUT PMax is only 37 of 655 campaigns (~6%) — real coverage needs the API.

**What Phase 2 needs (one integration → all four triggers):**
1. **Google Ads API developer token at the MCC, Basic Access level** — Test-level token
   already exists; Basic Access requires Google's approval (external dependency).
2. **OAuth** — client ID/secret + refresh token with MCC access.
3. **A Cloud Run Job** querying via **GAQL**, writing to BQ — same pattern as ADR-010/011
   and the scoped Bing pipeline. Not new architecture.
4. **GAQL resources per trigger:** `customer` identity verification (4);
   `asset.policy_summary` (6); `BillingSetup`/`AccountBudget` (card); and
   `ad_group_ad.policy_summary.policy_topic_entries` (URL reason, 5).

**Shared-infra synergy:** the Phase-2 developer-token + Cloud Run Job + GAQL stack is the
same infrastructure as the Bing/Microsoft Ads pipeline. Build once, reuse. (Parallels
`llm_gateway`/`budget_service` for the LLM consumers.)

---

#### PHASE 2 — CURRENT STATUS (2026-08-05)

**Blocked on Google's Basic Access approval. Nothing further to build until it lands.**

- ✅ **Google Ads API enabled** on the project: `gcloud services enable googleads.googleapis.com` done.
- ✅ **Developer token exists** in the MCC (611-819-8619) API Center, at **Test Account
  Access** level — works only against test accounts, not production.
- ✅ **Basic Access application SUBMITTED** — reference **`3-4822000041135`**. Standard
  review ~5 business days (no guaranteed final decision in that window). Application declared
  the tool as **read-only internal campaign-health monitoring** (design doc PDF submitted:
  read-only, internal users only, GAQL/Cloud Run/BigQuery, campaign types Search/PMax/
  Display/Local Services/Video, capability = Reporting only).
- ✅ **Ravina Ranjan (`ravinaranjan@google.com`), our Google rep for the account**, was sent
  the application reference to help expedite internally.
- ❌ **Brand verification: ATTEMPTED AND ABANDONED — do NOT retry without reading this.**
  Brand verification is Google's optional accelerator for Basic Access. It requires the OAuth
  consent screen set to External / In production (done) AND passing a check that found **three
  problems**, two of which are unsolvable for an internal tool:
    1. The homepage `rightideacreative.com` "is not registered to your name" → fixable by
       verifying the domain in Search Console (Scott manages the Right Idea site), but a
       single fixed problem does not unblock — all three must pass.
    2. "The homepage does not explain the purpose of the app" → would require putting Cortex
       tool info on Right Idea's public homepage. Not applicable — Cortex is internal.
    3. "The app name 'Cortex Bigquery' does not match the app name on your homepage" → same
       root cause; the internal tool name won't match the agency's public site.
  Problems 2 and 3 are structural: brand verification is built for public-facing apps, not
  internal tools that reuse the agency domain. **Abandoned. The Basic Access application
  proceeds on the normal timeline regardless.** See LEARNINGS L-028.
- **OAuth consent screen left as External / In production** (harmless to Cortex — Cortex uses
  service accounts, OAuth-user metrics showed zero traffic; and External is the right mode for
  the Phase-2 refresh-token OAuth anyway). Not reverted to Internal on purpose.

**Next step: wait for Google's decision on `3-4822000041135`.** When Basic Access is granted:
create the OAuth client, generate a refresh token, build the Cloud Run Job with the GAQL
queries above, sink to BQ, wire into the alert system. Until then, Phase 2 cannot be built
(a Test-level token only hits test accounts).

---

#### Design decision (pending — Sebas's stated direction)

- Alerts must **live in Cortex**, not email (noisy, ignored) and not chat (lost in scroll).
- Cortex-native alert entity (own new/in-progress/resolved state, dashboard/popup) **vs**
  feeding Monday tickets. **Recommendation on record:** start Cortex-native (avoids
  replicating the "Monday boards go to die" problem — same adoption risk flagged for Linear);
  add Monday later only if adoption needs it.
- **Adoption is the real risk, not the tech.**

#### Sequencing recommendation

- **Phase 1 is a standalone deliverable** — five real, high-impact alerts (esp. 1,038
  disapproved ads + ENABLED+SUSPENDED), zero external dependency. Ship first; proves the
  system and drives adoption while Phase 2's token is in Google's queue.
- **Phase 2** gated on the `3-4822000041135` approval. Scope alongside Bing (shared infra).
- Do NOT promise Juanes all 8 up front — deliver Phase 1, set Phase 2 as "needs Google Ads
  API integration, application in review."

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

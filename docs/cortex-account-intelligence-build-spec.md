# Córtex OS — Account Intelligence System
## Build Specification v1.1 · July 2026

**Owner:** Nate · **Primary builder:** Nate + Sebas · **Status:** Red-lined draft (v1.1)

This document is the single source of truth for building the Account Intelligence System: the account situation board, verdict engine, wasted spend analysis, change tracking, and AI diagnostic agent. It is written to be shared with Sebas and pasted into other Claude/AI chats as context. Everything here was decided in the July 2026 planning conversation; nothing is set in stone, but changes should be made **in this document** so it stays canonical.

### v1.1 changelog (red-line session, July 2026 — decided, do not relitigate without Nate)

| # | Decision |
|---|---|
| R1 | Relevant-but-nonconverting spend is **not** a waste line. It routes to Converting-stage evidence only. The "weak ad copy" diagnosis is powered by ad-level evidence (§4.8), not a dollar bucket. |
| R2 | **Full ad-level evidence in v1**: ad strength, RSA asset performance, and actual ad text go into a new `ad_evidence` layer (§4.8) and the agent packet (§8.2). |
| R3 | Every change window carries a **collateral guardrail metric** (defaults per change type, §7.1) checked alongside the target metric. Fixes the Mesa contradiction. |
| R4 | Relevance classifier gets **version stamps on every row + monthly sampled precision audit** (§4.3.5). |
| R5 | Window checks are baseline-only in v1, but schema carries `vs_portfolio` columns from day one so portfolio-relative comparison drops in later (§4.6, §12). |
| R6 | Overlapping windows on the same account × target metric are **allowed but auto-flagged `attribution_ambiguous`** (§7). |
| R7 | Conversions stay **lumped** (`metrics_conversions`) in v1. The platform-conversions vs CTM-qualified-calls **juxtaposition is elevated to a core trust display** (§4.5, §10), not a Track B footnote. |
| R8 | **Backfill the snapshot** from `raw_google_ads` history as far as the data allows (target 90–180d) — conditional on the §4.1 history-depth verification (§4.2, §11). |
| R9 | `bid_strategy_type` + targets added to snapshot and agent packet (§4.2, §8.2). |
| R10 | Compelling stage computes **relevant-terms CTR where visible** + agent precedence rule: a Compelling fail co-occurring with a Relevant fail is downstream until relevance is fixed (§4.2, §6.2, §8.1). |
| R11 | Dispositions stay **one per account** (single active case file; text covers all open problems). Problem-level traceability lives in `agent_recommendations.diagnosis_stage` and per-change windows (§5). |
| R12 | `warn` = **automatic proximity state**: metric within X% of its fail line (X per rule, `[PLACEHOLDER]`, §6.2). |
| R13 | **Board is pull-only in v1.** No Chat/push notifications; Cortex OS Chat wiring is deferred backlog (§12). |
| R14 | Portfolio medians stay the default benchmark, with a **per-account manual override** table (`account_rule_overrides`, §5) — driver is market-size variance, not client goals. Proper benchmarking is a separate future project (§12). |

> ⚠️ **Placeholder warning — read first.** Every numeric threshold in this document marked `[PLACEHOLDER]` was invented for illustration and MUST be replaced with values from a working session + portfolio statistics before go-live. No placeholder is an established industry standard. The verdict engine must never ship with unreviewed placeholders. The full list is in §13.

> ⚠️ **Schema warning.** SQL in this doc is written against *assumed* column names (standard Google Ads API report fields). §4.1 contains a mapping table of every assumed column — verify each against the actual `raw_google_ads` schema before running anything. `campaign_advertising_channel_type` is confirmed to exist; the rest are assumptions.

---

## 1. What we are building and why

### 1.1 The four questions

The system exists to answer, for every one of ~81 ODC franchise accounts, at any moment:

1. **Is performance good — yes or no?**
2. **If not, what is the problem?** (diagnosis, evidence-backed)
3. **What is being done about it, and why do we believe that's the right fix?**
4. **Is it working?** (trajectory, before/after measurement)

Secondary goals that fall out of answering these well:

- **Visibility and accountability across the team** — created by making the situation visible, never by scoreboarding people (see principles).
- **Wasted spend recovery** — quantified, decomposed by cause, tracked from detection to resolution.
- **Upsell pipeline** — accounts that pass efficiency but fail volume on lost-to-budget are budget-conversation candidates, backed by verified CPA. This is the long-term commercial payoff.
- **AI agent training corpus** — every diagnosis, recommendation, review, and outcome is recorded as structured data from day one.

### 1.2 Critical context

- The team is **not currently capable of authoring diagnoses**. The AI agent produces the diagnostic; humans **fact-check cited evidence and sanity-check actions** (verifying is easier than authoring). This raises the urgency of the agent layer — it is Sprint 2, not the final layer.
- Client budgets are hard-capped by clients. Spend increases are only possible after we can demonstrate strong verified CPA — which is what this system produces evidence for.
- Speed matters. Ship on API-native data first; the CTM verification layer hardens the last funnel stages afterward.

### 1.3 Design principles (check every build decision against these)

1. **Verdicts are code; prose is presentation.** Every colored cell traces to a rule row in Postgres. The agent narrates and connects verdicts; it never renders them. Two people looking at the same account must reach the same verdict.
2. **No judgment without sufficient data.** Every stage verdict has a data floor. Below the floor → `cant_assess`, never pass or fail. The system says "can't assess: QS unavailable on 78% of spend" rather than guessing. This is the anti-hallucination requirement enforced by architecture.
3. **Trust before performance.** Broken conversion tracking voids all downstream performance verdicts (mirrors the existing KPI-system rule that exceptions void verdicts entirely). Judging performance on dead tracking is narrating fiction.
4. **Visibility creates accountability — don't hammer it.** State labels describe the work ("Needs a plan", "Being worked", "On track", "Review early"), never the person. No days-unowned counters, no red shame numbers on the board. Owner is muted metadata in the drill-down, present only for routing.
5. **Windows are guardrails, not blackouts.** Observation windows suppress routine alerts but check the target metric weekly against the pre-change baseline. Two consecutive weeks worse than baseline → window breaks open early ("Review early"). Target hit early → close early. Nobody waits 30 days watching something burn.
6. **The agent never applies anything.** Recommendations come from a constrained action menu; a human clicks apply; every applied action enters the change log with a window. Blast radius of a wrong diagnosis = a declined suggestion.
7. **"No effect" and "made it worse" are recorded outcomes,** not silent failures. (Origin: the negative-keyword revamp that didn't move wasted spend, discovered late because nothing measured it.)
8. **Efficiency vs volume are separate verdict families.** Efficiency = stages 3–5 + verified CPA (is each click good?). Volume = stages 1–2 (are we getting enough clicks?). Efficiency-pass + volume-fail-on-budget = upsell segment. Never blend them into one score.
9. **Account-first information architecture.** The primary view is the account situation board (one row per account answering the four questions). Topic views (waste, change ledger, team, compliance, rules) are secondary lenses.
10. **Reuse existing infrastructure.** BigQuery (`rightidea-cortex`) + Neon Postgres + n8n + Cloudflare Pages/Functions + Monday.com. New services only where a hard constraint forces it (precedent: Nextdoor pipeline → Cloud Run because of nested loops).

### 1.4 The funnel (settled — schema-level decision, do not change casually)

Seven stages, mechanically mirroring how Google Ads works. Changing stage structure later means migrating the snapshot table and breaking the time series; changing thresholds is a one-row Postgres update. Stages are computed **per campaign type** (brand / service / LSA parsed from campaign name, regex already exists in Campaign Triage); the board shows the account-level worst-stage rollup; drill-down exposes the split.

| # | Stage | Question | Primary metrics |
|---|-------|----------|-----------------|
| 1 | **Eligible** | Can ads even run, and can we trust the data? | enabled status, disapprovals, policy issues, billing, **conversion tracking health**, auto-apply settings |
| 2 | **Visible** | Are we in the auctions, and where? | search impression share (IS), lost-to-budget, lost-to-rank, absolute top rate |
| 3 | **Compelling** | When we show, do we earn the click? | CTR vs campaign-type portfolio median, QS components (expected CTR, ad relevance), ad strength |
| 4 | **Relevant** | Are the clicks we buy the right ones? | irrelevant-spend % (classifier), wasted spend $, geo waste, hours waste, negative-conflict detection |
| 5 | **Converting** | Do right clicks become conversions? | CVR (relevant clicks) vs portfolio median, LP functional health, LP-experience QS component |
| 6 | **Answered** | Do calls get picked up? *(Track B)* | CTM answer rate, after-hours miss rate |
| 7 | **Verified** | Are conversions real leads? *(Track B)* | verification ratio (qualified CTM calls ÷ platform conversions), verified CPA |

Stages 6–7 exist in the schema from day one and render `cant_assess` until Track B ships. "Booked" (real revenue) is acknowledged as beyond the measurement boundary — becomes stage 8 only if ODC ever shares booking data.

Notes carried from the analysis phase:

- **Lost-to-budget vs lost-to-rank are separate sub-verdicts.** Lost-to-budget with healthy QS = healthy account, upsell candidate. Lost-to-rank with low QS = the double-penalty profile (overpaying per click AND invisible; QS sits in the CPC pricing formula, so this is the single highest-leverage efficiency lever).
- **Absolute-top rate is a diagnostic, not a maximize-me metric.** Observed pattern: lower-position clicks can convert better (self-selected, deliberate searchers). Verdict logic must not punish low position when CVR is strong.
- **A non-converting search term is not automatically irrelevant.** Two-axis classification: relevance (semantic) × performance. Irrelevant → negative candidate regardless of performance. Relevant-but-non-converting → routes to Converting-stage investigation (copy, position, LP). **Decided (R1): this spend gets no dollar line in the waste view** — not all relevant clicks can convert, and a waste figure here would be statistically dishonest. The "relevant term, weak ad" diagnosis is instead powered by full ad-level evidence in the agent packet (§4.8, §8.2): the agent sees the actual ads next to the non-converting relevant terms.
- **Stages are not independent — Relevant pollutes Compelling (R10).** Irrelevant queries drag raw CTR down, so a Compelling fail can really be a Relevant problem wearing a different hat. Mitigations: (a) the snapshot carries `relevant_ctr_visible` — CTR computed over visible, relevant-classified terms — used for the Compelling verdict when visible coverage clears the floor; (b) the agent precedence rule (§8.1): Compelling fail + Relevant fail on the same campaign type ⇒ diagnose Relevant first; the Compelling verdict is treated as downstream until relevance is fixed.

---

## 2. System architecture

```
┌────────────────────────────  DATA SOURCES  ────────────────────────────┐
│ Google Ads API (MCC 6118198619)   CTM (Cloud Run pipeline → BQ)        │
│  · campaign/ad group daily stats   · calls, duration, tracking number   │
│  · search terms report             Monday.com (tickets, client_mapping) │
│  · QS / IS / auction fields        Neon Postgres (rules, dispositions)  │
│  · change history (NEW ingestion)                                       │
└───────────────┬────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────  BIGQUERY · rightidea-cortex  ───────────────────┐
│ raw_google_ads.* (existing)      raw CTM tables (existing)             │
│ analytics.account_snapshot_daily (NEW · append-only · the time series) │
│ analytics.search_term_analysis_view (existing · extend)                │
│ analytics.wasted_spend_decomposed (NEW · precedence dedupe)            │
│ analytics.change_log + change_window_checks (NEW)                      │
│ analytics.ctm_qualified_calls + verification (Track B)                 │
└───────────────┬────────────────────────────────────────────────────────┘
                ▼
┌────────────────────  VERDICT ENGINE (n8n scheduled)  ──────────────────┐
│ Reads: snapshot (BQ) + rules (Neon Postgres kpi_* tables)              │
│ Writes: funnel_verdicts (Postgres, current) + verdicts_daily (BQ, hist)│
│ Logic: data floor → cant_assess · trust-void · flat all/any conditions │
└───────────────┬────────────────────────────────────────────────────────┘
                ▼
┌──────────────────  AI DIAGNOSTIC AGENT (n8n or Cloud Run)  ────────────┐
│ Input: verdict/evidence JSON packet (only source of facts)             │
│ Output: 3-part record (why / doing / expect) + recs from action menu   │
│ Writes: agent_recommendations (Postgres) · NEVER applies changes       │
└───────────────┬────────────────────────────────────────────────────────┘
                ▼
┌────────────────  CÓRTEX UI (Cloudflare Pages + Functions)  ────────────┐
│ situation-board.html (primary) · secondary: waste / ledger / rules /   │
│ team / compliance · cortex-shell.js nav · Cloudflare Access protected  │
│ Reads: nightly board JSON (proven Campaign Triage pattern) +           │
│ Pages Functions → Neon for interactive writes (dispositions, reviews)  │
│ Monday tickets via existing monday-proxy.js                            │
└─────────────────────────────────────────────────────────────────────────┘
```

**Placement decisions and why:**

- **BigQuery = analytical history** (snapshot, waste, change measurement, CTM). Append-only tables, never restated — this is the changes-over-time foundation spreadsheets never provided.
- **Neon Postgres = transactional state the UI edits** (rules, verdicts-current, dispositions, agent recommendations, reviews). Extends the existing KPI criteria project. Keep it in the **same Neon project as the kpi_\* tables** (not the Account Standard project) so rules and verdicts share a connection.
- **Board reads = nightly static JSON** regenerated by scheduled job (the proven Campaign Triage pattern — fast, cheap, no live-query fragility), plus a small set of Pages Functions hitting Neon for writes and for the drill-down's live disposition state.
- **n8n = orchestration** for scheduled jobs and the agent call. If any job hits n8n's limits (deep nesting, long runtimes), promote it to Cloud Run per the Nextdoor precedent — but start in n8n.

---

## 3. Data sources inventory

| Source | Status | What we take | Known caveats (do not skip) |
|---|---|---|---|
| `raw_google_ads` (BQ) | ✅ Existing | Daily campaign stats, spend, clicks, impressions, conversions, IS fields, QS fields, search terms | Verify column names (§4.1). LSA spend present (~$42K/15 campaigns), filter `campaign_advertising_channel_type = 'LOCAL_SERVICES'` — decide whether LSA is in or out of funnel v1 (recommend **out** for v1; different mechanics). |
| Google Ads **search terms report** | ✅ Existing (feeds `search_term_analysis_view`) | Query text, matched keyword, spend, clicks, conv | **Privacy masking:** a material share of spend has no visible query. Masked spend must be tracked as its own `unattributable` bucket — never silently assumed clean. Likely part of why the negatives revamp "didn't work." |
| Google Ads **change history** | 🆕 New ingestion | Change events per account/user/date for the change ledger + touches context | Available via API `change_event` resource; retention is limited (order of weeks) — ingest on a schedule so history accumulates in BQ. Basic API access is sufficient. |
| Google Ads **ad-level data** (R2) | 🆕 New ingestion | Per ad: serving status, ad strength, RSA headlines/descriptions (full text), asset performance labels (`ad_group_ad_asset_view`), per-ad CTR/spend | Feeds `analytics.ad_evidence` (§4.8). Asset performance labels are null below traffic thresholds ("PENDING"/unrated) — carry a coverage %, same discipline as QS. Ad text is content, not metrics: it lives in the ad_evidence layer, never in the daily snapshot. |
| Google Ads **bidding fields** (R9) | 🆕 In snapshot ingest | `bidding_strategy_type` per campaign, tCPA / tROAS targets where set | Spend-weighted dominant strategy rolled up to account × campaign_type. Context for agent hypotheses (starved smart bidding throttling spend); not a verdict input in v1. |
| Quality Score fields | ✅ In API | `quality_score` + component fields per keyword | **Null below traffic thresholds** — in thin franchise accounts possibly most keywords. Always compute spend-weighted QS + a coverage % (share of spend with QS present). Coverage is the sufficiency gate. |
| Impression share fields | ✅ In API | IS, lost-to-budget, lost-to-rank, abs-top | IS below 10% reports as `< 10%` (string/floor) — handle in parsing; store both raw and numeric-floor value. |
| CTM (BQ, via Cloud Run pipeline) | ✅ Existing | Calls, duration, tracking number, timestamps | **`called_at_ts` is broken (null across all rows).** Use `called_at` string or `unix_time`. Account-level attribution via tracking-number → franchise mapping is reasonably solid; keyword-level attribution is NOT trusted yet. `v_chatbot_calls` view exists as a reference implementation. |
| `reference.client_mapping` (BQ) | ✅ Existing | Canonical Monday ↔ Google Ads account join | Synced from Monday board `18406601738` every 6h. **All joins between systems go through this table.** Known past failure mode: crosswalk fan-out broke `pacing_api` — every new view must be tested for join fan-out (§4.7). |
| `committed_budget_live` (BQ) | ✅ Existing | Committed budgets (63 clients) | This is the correct source; the `committed` view is stale — never use it. |
| Monday.com | ✅ Existing | Ticket creation/status for dispositions | Via existing `monday-proxy.js` Cloudflare Function + raw GraphQL. Boards: Digital Tickets (AMs) `8682614199`, Digital Operations `18409255608`. |
| Neon Postgres (KPI project) | ✅ Existing | `kpi_statuses`, `kpi_rules`, `kpi_conditions` | Design already settled: plain-English condition text is canonical, structured fields optional for machine eval, exceptions void verdicts, flat all/any logic only. Extend, don't replace. |
| GA4 / landing-page crawler | 🔜 Deferred | LP functional health, post-click behavior | LP crawler is deferred backlog (§12) but its verdict slot exists from day one (`lp_health = cant_assess`). Precedent for why it matters: JS-error walls found on franchise LPs in the AV audit. |

**Hard rule inherited from the pacing_api incident:** no analytical view feeding this system may read from a Google-Sheets-linked external table — Drive credentials break the n8n service account. Materialize any Sheets data into native BQ tables first.

---

## 4. BigQuery layer

### 4.1 Conventions + assumed-column mapping

- Project: `rightidea-cortex`. New objects live in `analytics` unless noted.
- All new fact tables are **append-only, partitioned by `snapshot_date` (or `event_date`), clustered by `account_id`**. Corrections are new rows, never UPDATEs — history is the product.
- Every table carries `loaded_at TIMESTAMP` and `source_job STRING` for pipeline debugging.

**Assumed columns — VERIFY EACH against the real `raw_google_ads` schema before running any SQL below.** Where your names differ, fix the SQL, not the design.

| Assumed name in this doc | Meaning | Confidence |
|---|---|---|
| `customer_id` | Google Ads account (child of MCC 6118198619) | Assumed |
| `campaign_id`, `campaign_name` | — | Assumed |
| `campaign_advertising_channel_type` | SEARCH / LOCAL_SERVICES / etc. | **Confirmed exists** |
| `segments_date` | Stats date | Assumed |
| `metrics_cost_micros`, `metrics_clicks`, `metrics_impressions`, `metrics_conversions` | Standard metrics | Assumed |
| `metrics_search_impression_share`, `metrics_search_budget_lost_impression_share`, `metrics_search_rank_lost_impression_share`, `metrics_absolute_top_impression_percentage` | IS family | Assumed |
| `ad_group_criterion_quality_info_quality_score` (+ component fields) | keyword-level QS | Assumed |
| `search_term_view_search_term`, keyword/matched fields | search terms report | Assumed (view exists: `search_term_analysis_view`) |
| `campaign_bidding_strategy_type`, `campaign_target_cpa_micros` / `campaign_maximize_conversions_target_cpa_micros` | bidding strategy + targets (R9) | Assumed — field naming varies by strategy; verify per strategy type in use |
| `ad_group_ad_*` (ad strength, RSA text fields), `ad_group_ad_asset_view` labels | ad-level evidence (R2) | Assumed — may require a **new ingestion job**, not just new columns; verify whether the existing pipeline pulls ad-level resources at all |

**History-depth verification (R8) — part of the same §4.1 verification pass.** Before Sprint 1, establish: (a) how far back `raw_google_ads` daily stats actually go, (b) which of the assumed fields exist across that history (IS/QS fields may have started later than spend/clicks), (c) whether ad-level and bidding fields exist historically or only from their new-ingestion start date. The backfill plan in §4.2 is conditional on these answers — backfill whatever exists, leave the rest NULL with `cant_assess` doing its job.

### 4.2 `analytics.account_snapshot_daily` — the spine of everything

One row per account per campaign-type per day. This is the time series — start it in Sprint 1.

**Backfill (R8).** The "history never recovered" urgency applies to `change_event` (limited API retention), **not** to this table: `raw_google_ads` already holds daily history, so Sprint 1 runs the build job as a backfill loop over the trailing **90–180 days** (as far as the §4.1 history-depth verification says the data supports). This is what makes 30d data floors, trailing baselines, and the agent's 12-week series live **at launch** instead of a month after. Fields that don't exist historically (likely ad-level, bidding, possibly QS/IS depending on ingestion start) stay NULL for backfilled dates — `cant_assess` handles the gap honestly. Backfilled rows carry `source_job = 'snapshot_backfill_v1'` so they're distinguishable forever.

```sql
CREATE TABLE IF NOT EXISTS `rightidea-cortex.analytics.account_snapshot_daily` (
  snapshot_date            DATE      NOT NULL,
  account_id               STRING    NOT NULL,   -- Google Ads customer_id
  client_key               STRING,               -- from reference.client_mapping
  campaign_type            STRING    NOT NULL,   -- 'brand' | 'service' | 'lsa' | 'other' (regex from Campaign Triage)

  -- Outcomes
  spend                    NUMERIC,
  clicks                   INT64,
  impressions              INT64,
  conversions              NUMERIC,              -- platform-reported
  cpc                      NUMERIC,
  ctr                      NUMERIC,
  cvr                      NUMERIC,
  platform_cpa             NUMERIC,

  -- Stage 2 · Visible
  impression_share         NUMERIC,              -- numeric floor applied when API returns '<10%'
  is_floored               BOOL,                 -- TRUE when raw value was the '<10%' floor
  lost_is_budget           NUMERIC,
  lost_is_rank             NUMERIC,
  abs_top_rate             NUMERIC,

  -- Stage 3 · Compelling
  qs_spend_weighted        NUMERIC,
  qs_coverage_pct          NUMERIC,              -- share of spend with QS present (sufficiency gate)
  exp_ctr_below_avg_spend_pct   NUMERIC,
  ad_relevance_below_avg_spend_pct NUMERIC,
  ctr_vs_portfolio         NUMERIC,              -- this account ÷ campaign-type portfolio median (same day window)
  ad_strength_poor_avg_spend_pct NUMERIC,        -- R2: share of spend on poor/average ad-strength ads (gives the §6.2 rule its data source)
  relevant_ctr_visible     NUMERIC,              -- R10: CTR over visible terms classified 'relevant' (30d trailing)
  relevant_ctr_coverage_pct NUMERIC,             -- R10: share of spend behind relevant_ctr_visible (sufficiency gate)

  -- Stage 4 · Relevant
  irrelevant_spend_pct     NUMERIC,              -- from classifier, 30d trailing
  wasted_spend_30d         NUMERIC,              -- deduped total from §4.4
  masked_spend_pct         NUMERIC,              -- spend on privacy-masked terms (unattributable bucket)

  -- Stage 5 · Converting
  cvr_relevant_clicks      NUMERIC,
  cvr_vs_portfolio         NUMERIC,
  relevant_clicks_30d      INT64,                -- sufficiency gate for CVR verdict
  lp_health                STRING,               -- 'pass' | 'fail' | 'cant_assess' (crawler deferred → cant_assess)

  -- Stage 1 · Eligible / trust
  conv_tracking_state      STRING,               -- 'ok' | 'warn' | 'fail' (silence detector §6.3)
  days_since_last_conv     INT64,
  disapproved_ads_count    INT64,
  budget_limited           BOOL,

  -- Bidding context (R9 — agent context, not a verdict input in v1)
  bid_strategy_type        STRING,               -- spend-weighted dominant strategy for this account × campaign_type
  target_cpa               NUMERIC,              -- NULL when strategy has no tCPA
  target_roas              NUMERIC,              -- NULL when strategy has no tROAS

  -- Stages 6–7 · Track B (NULL until CTM layer ships)
  qualified_calls_30d      INT64,
  answer_rate_30d          NUMERIC,
  verification_ratio_30d   NUMERIC,
  verified_cpa_30d         NUMERIC,

  loaded_at                TIMESTAMP NOT NULL,
  source_job               STRING
)
PARTITION BY snapshot_date
CLUSTER BY account_id;
```

Build job (daily, n8n-scheduled or BQ scheduled query — sketch; adapt names):

```sql
-- Sketch of the daily INSERT. Portfolio medians computed per campaign_type
-- over the trailing 30d across all accounts, then joined back.
INSERT INTO `rightidea-cortex.analytics.account_snapshot_daily`
WITH base AS (
  SELECT
    segments_date                         AS snapshot_date,
    customer_id                           AS account_id,
    -- Campaign-type regex: port the exact expression from Campaign Triage
    CASE
      WHEN campaign_advertising_channel_type = 'LOCAL_SERVICES' THEN 'lsa'
      WHEN REGEXP_CONTAINS(LOWER(campaign_name), r'brand')      THEN 'brand'
      ELSE 'service'
    END                                   AS campaign_type,
    SUM(metrics_cost_micros)/1e6          AS spend,
    SUM(metrics_clicks)                   AS clicks,
    SUM(metrics_impressions)              AS impressions,
    SUM(metrics_conversions)              AS conversions
    -- + IS fields (weighted appropriately), QS aggregation from keyword-level
    --   stats with coverage %, etc.
  FROM `rightidea-cortex.raw_google_ads.<campaign_stats_table>`   -- ← real name
  WHERE segments_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  GROUP BY 1,2,3
),
mapped AS (
  SELECT b.*, m.client_key
  FROM base b
  LEFT JOIN `rightidea-cortex.reference.client_mapping` m
    ON b.account_id = m.google_ads_account_id          -- verify join key; test for fan-out (§4.7)
),
portfolio AS (
  SELECT campaign_type,
         APPROX_QUANTILES(SAFE_DIVIDE(clicks, impressions), 100)[OFFSET(50)] AS median_ctr,
         APPROX_QUANTILES(SAFE_DIVIDE(conversions, clicks), 100)[OFFSET(50)] AS median_cvr
  FROM mapped GROUP BY 1
)
SELECT
  m.*,
  SAFE_DIVIDE(SAFE_DIVIDE(m.clicks, m.impressions), p.median_ctr) AS ctr_vs_portfolio,
  SAFE_DIVIDE(SAFE_DIVIDE(m.conversions, m.clicks),  p.median_cvr) AS cvr_vs_portfolio,
  CURRENT_TIMESTAMP() AS loaded_at,
  'snapshot_daily_v1'  AS source_job
FROM mapped m JOIN portfolio p USING (campaign_type);
```

Notes:
- Trailing-30d fields (irrelevant_spend_pct, wasted_spend_30d, verification, relevant_clicks_30d) are computed in upstream views (§4.3–4.5) and joined in; keeping them denormalized on the snapshot makes the verdict engine and dashboard trivially simple.
- **Portfolio medians are computed per campaign type** — blended medians hide service-campaign bleed behind brand campaigns.

### 4.3 Search-term relevance (extend the existing view)

`analytics.search_term_analysis_view` + the Python export script (deterministic flagging + Anthropic SDK rationale) + `NEGATION_RULES.md` already exist. Extensions needed:

1. **Two-axis output.** Every visible term gets `relevance_class` ('relevant' | 'irrelevant' | 'review') independent of `performance_class`. Irrelevant → negative candidate regardless of conversions. Relevant + non-converting → evidence packet for the Converting stage, with abs-top-rate attached (tests the "too low on the page" hypothesis).
2. **Masked-spend accounting.** Emit per account: `visible_spend`, `masked_spend`, `masked_spend_pct`. Masked spend is its own bucket in the waste view — reported, never classified.
3. **Negative-conflict detection (new view).** Existing negatives (account/campaign/shared lists via API) matched against *converting* historical queries → `analytics.negative_conflicts`. This is waste's invisible twin (precedent: ODC Mobile pattern — negatives blocking repair-intent terms).
4. **Shared-list propagation queue.** A term confirmed irrelevant for one ODC franchise is almost certainly irrelevant portfolio-wide. One human review → propagate to the shared negative list → 80 accounts. Table: `analytics.negative_propagation_queue` (term, source_account, review_status, applied_list_id).
5. **Classifier governance (R4).** The relevance classifier is the one LLM inside the "verdicts are code" principle — stage 4 verdicts and the entire waste view are only as deterministic as it is stable. Two requirements, both v1:
   - **Version stamps.** Every classified row carries `classifier_version` (prompt version + model string), same discipline as the agent (§8.6). A reclassification under a new version is a new row, never an overwrite.
   - **Monthly sampled precision audit.** Each month, sample N terms `[PLACEHOLDER — suggest 100, spend-weighted]` across classes, human-label them blind, log precision/recall per class to `analytics.classifier_audits` (audit_date, classifier_version, sample_n, precision_irrelevant, recall_irrelevant, notes). Precision drift = the stage-4 verdict drifting silently; the audit table is the tripwire. No dashboard metric in v1 — the table is queryable and that's enough.
6. **Relevant-terms CTR feed (R10).** The view emits, per account × campaign_type, 30d visible-relevant impressions/clicks → `relevant_ctr_visible` + `relevant_ctr_coverage_pct` on the snapshot. Used by the Compelling verdict when coverage clears the floor (§6.2); raw CTR is the fallback.

### 4.4 `analytics.wasted_spend_decomposed` — precedence dedupe

**Rule: every wasted dollar is counted exactly once.** A 3 AM click on an irrelevant term outside the geo is ONE wasted dollar. Precedence order (first match claims the spend):

> **Decided (R1) — relevant-but-nonconverting spend is deliberately absent from this view.** It is `clean` here and routes to Converting-stage evidence instead. Rationale: a baseline share of relevant clicks will always fail to convert; putting a dollar figure on it would overstate recoverable waste. The diagnosis it deserves (weak copy, position, LP) is served by §4.8 ad evidence in the agent packet, not by a waste line. Do not add it back without a red-line.

1. `irrelevant_term` (classifier says the query is not our service/area)
2. `negative_conflict` (inverted waste — reported alongside, not summed into the same total)
3. `geo_nonconverting` (zips with zero conversions **against a pooled portfolio prior** — see below)
4. `hours_nonconverting` (hour bands non-converting against pooled prior)
5. `unattributable` (privacy-masked spend — reported as its own line, excluded from the waste total, never assumed clean)

```sql
CREATE OR REPLACE VIEW `rightidea-cortex.analytics.wasted_spend_decomposed` AS
WITH classified AS (
  SELECT account_id, campaign_type, spend, term_visible,
    CASE
      WHEN NOT term_visible                          THEN 'unattributable'
      WHEN relevance_class = 'irrelevant'            THEN 'irrelevant_term'
      WHEN geo_flag  = 'nonconverting_pooled'        THEN 'geo_nonconverting'
      WHEN hour_flag = 'nonconverting_pooled'        THEN 'hours_nonconverting'
      ELSE 'clean'
    END AS waste_cause
  FROM `rightidea-cortex.analytics.search_term_spend_enriched`   -- upstream join view
  WHERE spend_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
)
SELECT account_id, campaign_type, waste_cause,
       SUM(spend) AS spend_30d
FROM classified
GROUP BY 1,2,3;
```

**Statistical honesty requirement for geo/hours flags:** single-account hour-of-day or zip-level cells are too sparse to conclude anything (a handful of clicks, 0–1 conversions = noise). Flags 3 and 4 MUST use pooled portfolio priors — "across ~80 structurally similar accounts, this hour/zip-class converts at X% of baseline" — the same family of thinking as Campaign Triage's portfolio-median CPA benchmarks. Empirical-Bayes shrinkage toward the portfolio rate is the target implementation; v1 may ship with a simpler pooled-rate + minimum-sample gate, clearly labeled. Confound to respect: garage-door emergencies genuinely happen after hours — validate after-hours value against CTM call outcomes before anyone sets an ad schedule from click-time data.

### 4.5 CTM layer (Track B — schema now, fill later)

```sql
-- Qualified calls: v1 = duration threshold; v2 = transcription scoring
CREATE OR REPLACE VIEW `rightidea-cortex.analytics.ctm_qualified_calls` AS
SELECT
  m.google_ads_account_id            AS account_id,
  DATE(TIMESTAMP_SECONDS(c.unix_time)) AS call_date,   -- called_at_ts is BROKEN (all null); use unix_time
  COUNT(*)                            AS calls,
  COUNTIF(c.duration_seconds >= 60)   AS qualified_calls,   -- [PLACEHOLDER] 60s threshold
  SAFE_DIVIDE(COUNTIF(c.answered), COUNT(*)) AS answer_rate
FROM `rightidea-cortex.<ctm_dataset>.<calls_table>` c        -- real names from CTM pipeline
JOIN `rightidea-cortex.reference.client_mapping` m
  ON c.tracking_number = m.ctm_tracking_number               -- verify mapping path
GROUP BY 1,2;
```

- **Verification ratio** = qualified_calls_30d ÷ platform_conversions_30d, per account. ~0.8+ → platform data trustworthy for daily work. Low ratio → tracking inflation OR lead-quality problem — itself a finding routed to the queue. **Verified CPA** = spend ÷ qualified calls.
- **The juxtaposition is the product, not a footnote (R7).** Google-reported conversions and CTM-qualified calls (later: verified leads) rendered **side by side** is the core trust display of the whole system — it's how the team stops arguing about whose number is real. From the day Track B ships, the drill-down shows both series on one chart per account (§10). Related decision: `metrics_conversions` stays **lumped** in v1 (no conversion-action segmentation); the CTM parallel layer is the trust instrument, not conversion-action forensics. Conversion-action-level auditing (incl. checking whether untrusted CTM *imports* are polluting the platform number on any account) is deferred backlog (§12).
- Attribution boundary: **account-level only** for now (tracking number → franchise is solid). Keyword-level CTM attribution is untrusted — do not build on it.
- Call qualification v2 (transcription scoring: new customer? booked? in area?) is a separate, well-bounded AI task — deferred backlog, high value.

### 4.6 Change ledger + guardrail checks

```sql
CREATE TABLE IF NOT EXISTS `rightidea-cortex.analytics.change_log` (
  change_id        STRING NOT NULL,        -- uuid
  account_id       STRING NOT NULL,
  campaign_type    STRING,
  change_date      DATE   NOT NULL,
  change_source    STRING NOT NULL,        -- 'api_change_history' | 'manual_annotation' | 'agent_applied'
  change_summary   STRING NOT NULL,        -- 'Negatives batch — 214 terms from classifier review'
  changed_by       STRING,                 -- Google Ads user email (context, not scoreboard)
  target_metric    STRING,                 -- snapshot column name, e.g. 'irrelevant_spend_pct'
  expected_direction STRING,               -- 'down' | 'up'
  baseline_value   NUMERIC,                -- computed at window open (trailing 30d avg [PLACEHOLDER window])
  guardrail_metric STRING,                 -- R3: collateral metric watched alongside target (default per change type, §7.1)
  guardrail_baseline NUMERIC,              -- R3: computed at window open, same window as baseline_value
  attribution_ambiguous BOOL,              -- R6: TRUE when another window on same account × target_metric was open at open-time
  window_days      INT64,                  -- e.g. 21
  window_opens     DATE,
  window_closes    DATE,
  window_state     STRING,                 -- 'open' | 'closed_ok' | 'closed_no_effect' | 'closed_worse' | 'broke_open_early'
  outcome_value    NUMERIC,                -- computed at close
  guardrail_outcome_value NUMERIC,         -- R3: guardrail at close — 'target hit but guardrail bled' is a recorded, visible outcome
  outcome_notes    STRING,
  loaded_at        TIMESTAMP NOT NULL
) PARTITION BY change_date CLUSTER BY account_id;

CREATE TABLE IF NOT EXISTS `rightidea-cortex.analytics.change_window_checks` (
  change_id     STRING NOT NULL,
  check_date    DATE   NOT NULL,
  metric_value  NUMERIC,
  vs_baseline   NUMERIC,                   -- signed % vs baseline_value
  vs_portfolio  NUMERIC,                   -- R5: signed % vs portfolio movement, same window. NULL in v1 — populated when the portfolio movement series exists; checks ignore until then
  guardrail_value NUMERIC,                 -- R3
  guardrail_vs_baseline NUMERIC,           -- R3: signed % vs guardrail_baseline
  check_result  STRING,                    -- 'on_track' | 'drifting' | 'worse'
  guardrail_result STRING,                 -- R3: 'ok' | 'collateral_worse'
  loaded_at     TIMESTAMP NOT NULL
) PARTITION BY check_date CLUSTER BY change_id;
```

- **Ingestion:** a scheduled n8n job pulls the Google Ads `change_event` resource per account (batch pattern already proven in the MCC scripts) and inserts `api_change_history` rows for *major* change classes; minor churn is aggregated into a daily touches count (team-view context only). Manual annotations ("negative list revamp") are entered from the UI in one click. Agent-applied actions insert automatically on apply.
- **Pilot case:** retroactively log the negative-keyword revamp and run the autopsy. Candidate explanations to test: (a) whack-a-mole — broad match reallocated freed budget to new junk queries; (b) negatives targeted visible-but-low-spend terms; (c) a chunk of the waste sits in masked terms that can't be negated. The masked-spend accounting in §4.3 makes (c) checkable for the first time.

### 4.7 Fan-out test (mandatory for every new view)

Precedent: the crosswalk fan-out that broke `pacing_api`. Before any view joining through `client_mapping` ships:

```sql
-- Row count must be identical before and after the mapping join
SELECT COUNT(*) FROM <view_pre_join>;
SELECT COUNT(*) FROM <view_post_join>;
-- And: no account_id may map to >1 client_key
SELECT google_ads_account_id, COUNT(DISTINCT client_key) c
FROM `rightidea-cortex.reference.client_mapping`
GROUP BY 1 HAVING c > 1;
```

### 4.8 `analytics.ad_evidence` — ad-level evidence layer (R2 · NEW)

This is what makes "the term is relevant but the ad is weak" a diagnosable claim instead of a shrug. Ad **text is content, not a metric** — it lives here, never in the daily snapshot. One row per enabled ad, refreshed daily (full refresh is fine; this is small data):

```sql
CREATE TABLE IF NOT EXISTS `rightidea-cortex.analytics.ad_evidence` (
  snapshot_date        DATE   NOT NULL,
  account_id           STRING NOT NULL,
  campaign_type        STRING NOT NULL,     -- same regex as snapshot
  campaign_id          STRING,
  ad_group_id          STRING,
  ad_group_name        STRING,
  ad_id                STRING NOT NULL,
  ad_strength          STRING,              -- EXCELLENT | GOOD | AVERAGE | POOR | PENDING/unrated
  headlines            ARRAY<STRING>,       -- full RSA headline text
  descriptions         ARRAY<STRING>,       -- full RSA description text
  low_performing_assets ARRAY<STRING>,      -- asset text with 'LOW' performance label (ad_group_ad_asset_view)
  asset_label_coverage_pct NUMERIC,         -- share of assets with any rating (labels null below traffic — QS discipline applies)
  spend_30d            NUMERIC,
  clicks_30d           INT64,
  impressions_30d      INT64,
  ctr_30d              NUMERIC,
  serving_status       STRING,
  loaded_at            TIMESTAMP NOT NULL
) PARTITION BY snapshot_date CLUSTER BY account_id;
```

- **Snapshot rollup:** `ad_strength_poor_avg_spend_pct` (§4.2) is computed from this table — the §6.2 ad-strength rule finally has a data source.
- **Packet feed:** for accounts failing Compelling or carrying relevant-nonconverting evidence, the packet assembler pulls the **worst N ads** (N `[PLACEHOLDER — suggest 5]`, ranked by spend × weakness: poor/average strength, low-labeled assets, bottom-decile CTR in their campaign type) with full text, plus the ad-group linkage from visible relevant-nonconverting terms → the agent reads the actual query next to the actual ad that answered it (§8.2).
- **Ingestion caveat:** this likely requires a **new API ingestion job** (`ad_group_ad` + `ad_group_ad_asset_view`), not just new columns on an existing pull — confirm during §4.1 verification.
- Fan-out test (§4.7) applies to any join through `client_mapping`, as always.

---

## 5. Postgres layer (Neon — extend the KPI criteria project)

Existing, keep as designed: `kpi_statuses`, `kpi_rules`, `kpi_conditions` — plain-English condition text canonical, optional structured fields for machine evaluation, exceptions void verdicts entirely, flat all/any only. New tables below live in the same project/database.

```sql
-- Funnel stage verdicts: current state per account × campaign_type × stage.
-- History goes to BigQuery (analytics.verdicts_daily, same shape + snapshot_date).
CREATE TABLE funnel_verdicts (
  account_id      TEXT NOT NULL,
  campaign_type   TEXT NOT NULL,
  stage           TEXT NOT NULL,        -- eligible|visible|compelling|relevant|converting|answered|verified
  verdict         TEXT NOT NULL,        -- 'pass' | 'fail' | 'warn' | 'cant_assess'
  rule_id         INT REFERENCES kpi_rules(id),   -- which rule tripped (NULL for pass)
  rule_version    INT,                  -- rules are versioned; historical verdicts stay explainable
  evidence        JSONB NOT NULL,       -- {metric: value} pairs actually evaluated
  sufficiency     JSONB NOT NULL,       -- {metric: 'ok'|'low'} per gate
  evaluated_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, campaign_type, stage)
);

-- Account-level rollup the board reads
CREATE TABLE account_state (
  account_id      TEXT PRIMARY KEY,
  performing      TEXT NOT NULL,        -- 'yes' | 'no' | 'unknown'  (unknown = trust issue)
  verdict_family  TEXT,                 -- 'healthy'|'efficiency_fail'|'volume_fail_upsell'|'trust_issue'
  first_failing_stage TEXT,
  board_state     TEXT NOT NULL,        -- 'performing'|'needs_plan'|'being_worked'|'on_track'|'drifting'|'review_early'
  days_in_state   INT,                  -- drill-down metadata only; NEVER a board column
  updated_at      TIMESTAMPTZ NOT NULL
);

-- The three-part disposition record (why / doing / expect).
-- Plain language: a "disposition" is the CASE FILE opened on an account's problem —
-- why we think it's happening / what we're doing / what we expect, by when.
-- The board's "What's being done" column displays action_summary verbatim.
--
-- Decided (R11): ONE disposition per account — a single active case file whose text
-- covers all open problems on that account (enforce: partial unique index on account_id
-- WHERE status IN ('draft','active','observing')). Problem-level traceability survives
-- underneath: agent_recommendations.diagnosis_stage is per stage, and every applied
-- change carries its own target_metric + guardrail + window — so "did it work" stays
-- answerable per intervention even though the case file is account-level.
CREATE TABLE dispositions (
  disposition_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      TEXT NOT NULL,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL,        -- 'draft'|'active'|'observing'|'closed'
  why_hypothesis  TEXT NOT NULL,        -- "Why we think this is happening"
  action_summary  TEXT NOT NULL,        -- "What we're doing" (board shows this, verbatim)
  expected_outcome TEXT NOT NULL,       -- "What we expect, by when"
  authored_by     TEXT NOT NULL,        -- 'agent' | user identifier
  approved_by     TEXT,                 -- human who accepted an agent draft
  monday_ticket_id TEXT,                -- via monday-proxy.js
  change_id       TEXT,                 -- links to BQ change_log when action ships
  owner           TEXT,                 -- routing metadata; muted in UI
  closed_at       TIMESTAMPTZ,
  close_outcome   TEXT                  -- 'resolved'|'no_effect'|'worse_reverted'|'superseded'
);

-- Agent output + human review = the eval dataset
CREATE TABLE agent_recommendations (
  rec_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  input_packet    JSONB NOT NULL,       -- EXACT packet sent to the model (reproducibility)
  model           TEXT NOT NULL,
  diagnosis_why   TEXT NOT NULL,
  diagnosis_stage TEXT NOT NULL,        -- must match a failing verdict stage — enforced in code
  actions         JSONB NOT NULL,       -- array of {action_type, params, evidence_rule_ids, est_impact_usd, impact_basis}
  confidence_note TEXT,                 -- model's own stated uncertainty, surfaced to reviewer
  review_status   TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'accepted'|'edited'|'declined'
  review_reason_code TEXT,              -- enum §8.5 — REQUIRED for edited/declined
  review_free_text TEXT,
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  applied_change_id TEXT               -- BQ change_log id if action applied
);

-- Per-account threshold overrides (R14). Portfolio medians are the default benchmark,
-- but performance varies greatly by MARKET SIZE — a rural franchise judged against the
-- blended portfolio median gets false fails. Overrides are manual, reasoned, audited.
-- Proper benchmarking (market-size cohorts) is a separate future project (§12) — this
-- table is the release valve until then. The verdict engine checks overrides FIRST.
CREATE TABLE account_rule_overrides (
  override_id     SERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL,
  rule_id         INT  NOT NULL REFERENCES kpi_rules(id),
  override_params JSONB NOT NULL,       -- e.g. {"threshold": 0.20} — shape mirrors the rule's structured fields
  reason          TEXT NOT NULL,        -- REQUIRED — "small market, IS structurally low" etc.
  set_by          TEXT NOT NULL,
  set_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,          -- optional; NULL = standing. Expired overrides revert silently to portfolio default
  UNIQUE (account_id, rule_id)
);
```

---

## 6. Verdict engine

### 6.1 Evaluation loop (n8n, daily after snapshot build)

1. Pull yesterday's `account_snapshot_daily` rows (BQ).
2. Pull active rules (`kpi_rules`/`kpi_conditions`, current version) **+ `account_rule_overrides` (R14) — an override replaces the rule's params for that account; `evidence` records `override_id` so the verdict stays explainable.**
3. Per account × campaign_type × stage: **sufficiency gates first** → any gate below floor ⇒ `cant_assess` for that stage, done. Then evaluate conditions (flat all/any). **Warn (R12) is automatic proximity, not separately authored rules:** a metric within X% of its fail line ⇒ `warn` (X per rule `[PLACEHOLDER]`, stored on the rule row, set in the working session). One threshold per rule to maintain; warn falls out for free.
4. **Trust-void:** `eligible.conv_tracking_state IN ('warn','fail')` ⇒ Converting/Answered/Verified verdicts forced to `cant_assess` with `evidence.voided_by = 'tracking'`. CTM call volume, if available, is attached as corroborating context (steady calls + zero platform conversions ⇒ tracking broke, not marketing).
5. Write `funnel_verdicts` (Postgres, upsert) + append `analytics.verdicts_daily` (BQ).
6. Roll up `account_state`: worst stage → verdict family → board state. Efficiency/volume split per principle 8.

### 6.2 Initial rules table — **every threshold `[PLACEHOLDER]`**, structure is the deliverable

| Stage | Metric | Fail condition (canonical text for kpi_conditions) | Data floor |
|---|---|---|---|
| Eligible | Tracking health | Zero conversions 7d with clicks > 200 → warn; > 14d → fail; voids downstream | 7d window |
| Eligible | Ad approvals | Any disapproved/limited ad in an enabled ad group | none |
| Eligible | Auto-apply | Any auto-apply recommendation enabled outside the approved list | none |
| Visible | Impression share | IS < portfolio p25 by campaign type `[PLACEHOLDER]` | ≥500 eligible impr/30d; is_floored handled |
| Visible | Lost to budget | > 30% for 14 consecutive days `[PLACEHOLDER]` | ≥500 eligible impr |
| Visible | Lost to rank | > 35% AND qs_spend_weighted < 5 `[PLACEHOLDER]` (double-penalty compound) | qs_coverage ≥ 50% |
| Compelling | CTR vs portfolio | < 0.75× campaign-type median, 30d `[PLACEHOLDER]` — **uses `relevant_ctr_visible` when `relevant_ctr_coverage_pct` ≥ 60% `[PLACEHOLDER]`, else raw CTR (R10)**; evidence records which was used | ≥300 impressions |
| Compelling | QS spend-weighted | < 5.0 `[PLACEHOLDER]` | qs_coverage ≥ 50% |
| Compelling | Ad strength | > 50% of spend on poor/average ads `[PLACEHOLDER]` — source: `ad_strength_poor_avg_spend_pct` from §4.8 (R2) | ad-level ingest live |
| Relevant | Irrelevant spend % | > 15% of 30d spend `[PLACEHOLDER]` | ≥60% spend visible (masked accounted) |
| Relevant | Geo waste | > 10% of spend in pooled-flagged zips `[PLACEHOLDER]` | pooled model min-sample |
| Converting | CVR relevant clicks | < 0.6× campaign-type median `[PLACEHOLDER]` | ≥100 relevant clicks/30d |
| Converting | LP functional | crawl error / JS wall / 4xx | crawler deferred ⇒ cant_assess |
| Answered | Answer rate | < 80% in business hours `[PLACEHOLDER]` | ≥20 calls/30d · Track B |
| Verified | Verification ratio | < 0.6 `[PLACEHOLDER]` | ≥15 platform conv/30d · Track B |

Also: `wasted_spend_30d` is **informational** — it never gates a verdict; it feeds alert dollar-ranking. Abs-top rate is diagnostic-only (principle: don't punish low position when CVR is strong).

### 6.3 Tracking-silence detector

Runs inside snapshot build: `days_since_last_conv` vs click volume in the same window. This is the single highest-value deterministic check in the system — a silent tracking break poisons every downstream analysis and historically goes unnoticed for weeks.

---

## 7. Guardrail mechanics (observation windows)

- Window opens when a disposition's action ships → `change_log` row with `baseline_value` = trailing-30d avg of `target_metric` **and `guardrail_baseline` = same-window avg of `guardrail_metric` (R3 — default per change type, §7.1)** `[PLACEHOLDER window length per change type]`.
- **Collision check at open (R6):** if another window is already open on the same account × target_metric, set `attribution_ambiguous = TRUE` on **both** rows. Windows are never blocked — but an ambiguous window's outcome can't be read as clean cause-and-effect, and the ledger UI badges it. Outcome notes on ambiguous windows must acknowledge the overlap.
- **Weekly check** (n8n, Mondays) evaluates **both metrics**:
  - *Target:* current vs baseline → `on_track` (moving in expected_direction beyond noise), `drifting` (flat within tolerance ±X% `[PLACEHOLDER]`), `worse` (beyond tolerance in the wrong direction).
  - *Guardrail (R3):* current vs `guardrail_baseline` → `ok` or `collateral_worse` (beyond tolerance in the harmful direction `[PLACEHOLDER tolerance]`).
- **Break-open rule: two consecutive `worse` checks OR two consecutive `collateral_worse` checks ⇒ `broke_open_early`**, board_state → `review_early`, account returns to the top of the board. This is what actually catches the Mesa scenario (waste −38% but conversions −41%): the *target* looked great — only the guardrail sees the bleed. Without R3, that window would have closed `closed_ok` while volume cratered.
- Target reached early **with guardrail `ok`** ⇒ close early, `closed_ok`. Target hit but guardrail bled at close ⇒ the outcome is recorded as such (`guardrail_outcome_value` on the ledger row) — "it worked but it cost us" is a first-class outcome, never a silent success.
- *(R5, future)* `vs_portfolio` on each check row stays NULL in v1. When the portfolio movement series exists, weekly checks additionally compare the account's movement against the portfolio's over the same window — the ~80 structurally similar accounts are a natural control group that separates "our negatives worked" from "July is slow for garage doors everywhere." Schema is ready; no migration needed.
- While a window is open: routine alerts for that account/metric are **suppressed but visible** (grayed, auditable — never hidden).
- At close: outcome computed automatically; `closed_no_effect` triggers a mandatory "why" note — this is how the next negatives-revamp mystery gets an answer in weeks.

### 7.1 Default guardrail metric per change type (R3 — `[PLACEHOLDER]` defaults, working session confirms)

| Change type (action menu) | Target metric (typical) | Default guardrail | Watching for |
|---|---|---|---|
| `add_negatives` / `propagate_to_shared_list` | irrelevant_spend_pct ↓ | conversions | Negatives choking real traffic (ODC Mobile pattern) |
| `exclude_geo` | geo waste ↓ | conversions | Excluded zips were quietly converting |
| `adjust_ad_schedule` | hours waste ↓ | conversions | After-hours emergencies were real (§4.4 confound) |
| `pause_entity` | spend on paused entity ↓ | conversions | Paused entity was carrying volume |
| `rsa_rewrite_request` | ctr / relevant_ctr_visible ↑ | cvr_relevant_clicks | Clickbait effect: CTR up, conversion quality down |
| `route_to_dev` (LP/tracking) | cvr_relevant_clicks ↑ / conv_tracking_state | clicks | Fix broke something upstream |
| `budget_conversation` (applied budget change) | conversions ↑ | platform_cpa | Marginal-auction haircut proving true (caveat 10) |

A human can override the default at window open; the override is just a different `guardrail_metric` value on the row — no special machinery.

---

## 8. AI diagnostic agent

### 8.1 Role and hard boundaries

The agent **connects and narrates verdicts that already exist** and proposes actions from a fixed menu. It does not compute metrics, does not render verdicts, does not apply changes. The team fact-checks cited evidence and sanity-checks actions; they are not expected to author diagnoses.

Anti-hallucination is architectural, not prompt-hopeful:
1. The input packet is the **only** source of facts. Every claim must reference a `rule_id` or a packet field. Post-generation validation (code, not model): every number in the output must appear in the packet; `diagnosis_stage` must be a failing/warn stage in the packet; every action must be a valid menu entry. Violations → discard and retry once → then flag for Nate.
2. Insufficient data is a valid and expected answer: the agent must output `"diagnosis": "insufficient_data"` + what's missing rather than reach.
3. Output is a **draft** until a human accepts it. Accepted → disposition record; applied action → change_log + window.
4. **Diagnostic precedence (R10), in the system prompt:** when Compelling and Relevant both fail on the same campaign type, diagnose Relevant first — irrelevant queries drag CTR down, so the Compelling fail is presumed downstream until relevance is fixed. The agent must not recommend `rsa_rewrite_request` as the fix for a CTR problem while an unaddressed Relevant fail exists on the same campaign type.

### 8.2 Input packet (assembled by n8n per non-passing account)

```json
{
  "account_id": "...", "client_name": "...",
  "as_of": "2026-07-04",
  "funnel_verdicts": [
    {"stage": "relevant", "verdict": "fail", "rule_id": 14, "rule_text": "...",
     "evidence": {"irrelevant_spend_pct": 0.34, "wasted_spend_30d": 1842},
     "sufficiency": {"terms_visible_pct": "ok"}}
  ],
  "snapshot_trailing": {"weeks": 12, "platform_cpa": [108,112,"..."], "target_metric_series": {}},
  "open_changes": [{"change_id": "...", "summary": "...", "window_state": "open", "checks": []}],
  "waste_decomposition": {"irrelevant_term": 1842, "geo": 0, "hours": 0, "unattributable_pct": 0.18},
  "ctm": {"available": false},
  "top_irrelevant_terms": [{"term": "...", "spend": 0, "clicks": 0}],
  "bidding": {"bid_strategy_type": "TARGET_CPA", "target_cpa": 95, "target_roas": null},
  "ads": {
    "ad_strength_distribution": {"poor_avg_spend_pct": 0.62, "label_coverage_pct": 0.8},
    "worst_ads": [
      {"ad_group": "Garage Door Repair", "ad_strength": "AVERAGE", "ctr_30d": 0.021,
       "spend_30d": 640,
       "headlines": ["..."], "descriptions": ["..."],
       "low_performing_assets": ["..."]}
    ],
    "relevant_nonconverting_terms": [
      {"term": "...", "spend": 0, "clicks": 0, "ad_group": "Garage Door Repair", "abs_top_rate": 0.31}
    ]
  },
  "prior_dispositions": [{"why": "...", "outcome": "no_effect"}]
}
```

Packet notes (R1/R2/R9/R10):
- **`ads` (R2)** is what makes the "relevant term, weak ad" diagnosis possible without a waste dollar line (R1): the agent reads the actual query next to the actual ad text that answered it. `worst_ads` = top N `[PLACEHOLDER — suggest 5]` from §4.8 ranked by spend × weakness; included only when Compelling fails or `relevant_nonconverting_terms` is non-empty, to keep packets lean.
- **`bidding` (R9)** is hypothesis context (starved smart bidding throttling spend, tCPA set unrealistically low), never verdict input.
- Post-generation validation extends naturally: any ad text or term the agent quotes must appear verbatim in the packet, same rule as numbers.
- Precedence rule (R10) applies at generation time — see §8.1.4.

### 8.3 Action menu (v1 — closed enum; expanding it is a spec change)

`add_negatives` (term list + level) · `propagate_to_shared_list` · `exclude_geo` (zips) · `adjust_ad_schedule` · `pause_entity` · `rsa_rewrite_request` (routes to creative) · `route_to_dev` (LP/tracking) · `budget_conversation` (upsell packet) · `open_investigation` (when evidence is ambiguous) · `escalate_to_nate` · `no_action_monitor`

### 8.4 Output schema

```json
{
  "diagnosis_stage": "relevant",
  "why_hypothesis": "1-3 sentences, plain language, evidence-cited",
  "what_to_do": [
    {"action_type": "add_negatives",
     "params": {"terms": ["..."], "level": "campaign"},
     "evidence_rule_ids": [14],
     "expected_effect": {"metric": "irrelevant_spend_pct", "direction": "down",
                          "window_days": 21},
     "est_impact_usd_month": 1500,
     "impact_basis": "current spend on cited terms — arithmetic from packet, not projection"}
  ],
  "expected_outcome_text": "What we expect, by when — becomes the disposition field",
  "confidence_note": "what would change this diagnosis / what data is missing",
  "insufficient_data": false
}
```

### 8.5 Review workflow (the eval dataset)

Reviewer sees packet-side evidence next to each claim. Verdicts: **accept** (→ disposition created, action queued for apply) / **edit** (diffs stored) / **decline** (reason code REQUIRED). Reason codes v1: `evidence_wrong` · `evidence_insufficient` · `action_wrong` · `action_right_diagnosis_wrong` · `client_context_missing` · `duplicate` · `other`. Decline patterns → prompt/rule fixes (near-term "training" = prompt refinement + few-shot from accepted records + rule extraction from declines; not fine-tuning). **Outcome tracking closes the loop:** applied recommendation → change_log → window outcome → joined back to rec_id. "Was the agent right" becomes a queryable table.

### 8.6 Runtime

n8n workflow (HTTP → Anthropic API) is fine for v1: one call per non-passing account per day (~30–45 calls), no nesting depth issues. The existing search-terms export script (Python + Anthropic SDK) is the proven in-house pattern if Cloud Run is preferred. System prompt = §1.3 principles + funnel definitions + action menu + output schema + "insufficient data is success, invention is failure." Keep the prompt in the repo, versioned; store `model` + prompt version on every rec.

---

## 9. Scheduled workflows (n8n unless noted)

| # | Workflow | Schedule | Reads → Writes |
|---|---|---|---|
| W1 | Snapshot build | Daily 05:00 | raw_google_ads (+§4.3–4.5 views) → `account_snapshot_daily` |
| W2 | Change-history ingest | Daily 05:30 | Ads API change_event (batch, MCC-script pattern) → `change_log` (+ daily touches aggregate) |
| W3 | Verdict engine | Daily 06:00 | snapshot + kpi rules → `funnel_verdicts`, `account_state`, `verdicts_daily` |
| W4 | Agent diagnostics | Daily 06:30 | packets for non-passing accounts w/o active disposition → `agent_recommendations` |
| W5 | Guardrail checks | Weekly Mon 07:00 | open windows → `change_window_checks`, break-open transitions |
| W6 | Board JSON publish | Daily 07:00 (+on-demand) | Postgres + BQ → static JSON → Cloudflare Pages (Campaign Triage pattern) |
| W7 | Monday sync | On disposition create/close | Postgres → monday-proxy.js → boards 8682614199 / 18409255608 |
| W8 | CTM qualified calls | Daily (Track B) | CTM tables → `ctm_qualified_calls` → snapshot fields |
| W9 | Ad evidence ingest (R2) | Daily 04:45 | Ads API `ad_group_ad` + `ad_group_ad_asset_view` → `analytics.ad_evidence` (likely a NEW API pull — confirm §4.1) |

Notes:
- **W1 runs in backfill mode during Sprint 1** (R8): loop the daily build over the trailing 90–180d per the §4.1 history-depth verification, `source_job = 'snapshot_backfill_v1'`, before switching to the daily schedule.
- **W5 evaluates target AND guardrail metrics** per §7 — one workflow, two check columns.
- **No push notifications in v1 (R13).** The board is pull-only; nothing pings anyone. Cortex OS Google Chat wiring (drafts pending review, broke-open windows) is deferred backlog (§12) — revisit once review volume is known.

---

## 10. Frontend (Córtex, Cloudflare Pages)

- **Primary page: `situation-board.html`** — summary cards (Performing / Being worked / Needs a plan / Review early), account table with columns: Account · Good? · What's the problem · What's being done (action text, verbatim from `dispositions.action_summary`) · Status. Sort: severity → dollar impact → (needs-plan before being-worked). **No owner column, no days column** on the board.
- **Drill-down panel:** funnel stage chips · three-part record (why / doing / expect) · target-metric sparkline with change markers (dashed) + baseline (dotted) **+ guardrail-metric series alongside (R3 — the pair is the story: "waste fell, conversions held")** · **trust chart (R7): platform-reported conversions vs CTM qualified calls, two series, one chart — the core trust display of the system; renders `cant_assess` placeholder until Track B, but the slot exists from day one** · key metric cards · muted metadata line (owner, ticket, window dates) · agent recommendation review UI (accept / edit / decline+reason).
- **Secondary pages** (cortex-shell.js nav): Wasted spend (command center: totals, cause bars incl. unattributable line, under-disposition vs unaddressed split, top-waste table) · Change ledger (windows + outcomes incl. no_effect/worse, **guardrail outcomes, and an `attribution_ambiguous` badge on overlapping windows (R3/R6)**) · Rules registry (live render of kpi_rules **+ active account overrides with reasons (R14)** — the display IS the engine's data, zero drift) · Team (issue lifecycle: open, median time-to-disposition, resolved; touches last, context only) · Compliance (Account Standard automation — deferred backlog but nav slot reserved).
- **Data path:** page loads static board JSON (fast, cacheable); Pages Functions (same pattern as Strategy page / monday-proxy.js) handle writes: create/edit disposition, review actions, manual change annotation, window early-close. Cloudflare Access already protects the site.

---

## 11. Build order (compressed — agent is Sprint 2, not last)

**Sprint 1 — spine + verdicts.** §4.1 verification pass **including history depth (R8)** · W1 snapshot in **backfill mode first (90–180d as data allows), then daily** (API-native fields only; Track B columns NULL) · **W9 ad-evidence ingest (R2 — needed before Sprint 2 packets)** · verdict rules seeded into kpi tables with `[PLACEHOLDER]` thresholds + warn proximity X% (R12) from a Nate working session + computed portfolio medians · `account_rule_overrides` table live (R14, even if empty) · W3 engine · fan-out tests. *Accept: snapshot populated backward and populating daily; verdicts queryable **with real 30d floors met at launch**; two people agree with spot-checked verdicts on 10 accounts.*

**Sprint 2 — agent + review.** Packet assembler **incl. `ads` + `bidding` sections (R2/R9) and the precedence rule in the system prompt (R10)** · W4 · post-generation validators (§8.1, extended to quoted ad text/terms) · `agent_recommendations` + review endpoints · **classifier version stamps + first monthly precision audit scheduled (R4)**. Nate reviews everything this sprint. *Accept: every non-passing account has a draft three-part record; zero validator violations reaching review; declines carry reason codes; at least one draft correctly diagnoses a relevant-nonconverting + weak-ad case citing actual ad text.*

**Sprint 3 — board + loop.** W6 JSON + situation-board.html + drill-down + review UI · dispositions + Monday (W7) · W2 change ingest + manual annotation · W5 guardrails. Retroactive negatives-revamp autopsy as the change-ledger pilot. *Accept: the four questions answerable for all 81 accounts from one page; an applied action visibly opens a window and gets checked.*

**Parallel/after:** Track B CTM (§4.5 → funnel stages 6–7 + verified CPA + upsell packets) · secondary pages · deferred backlog.

---

## 12. Deferred backlog (each unlocks new diagnosis types when it lands)

1. CTM verification layer (Track B) — first deferral to pull forward.
2. Call qualification v2 — transcription scoring (new customer / booked / in area).
3. LP crawler → `lp_health` real values (JS-wall class of failures).
4. Compliance automation — the 41-row Account Standard: API-checkable rows as deterministic checks; judgment rows (typos, geo-mismatch ads à la the DFW-in-Oregon find) as a second LLM task.
5. Geo/hours pooled statistical models (empirical Bayes) replacing v1 pooled-rate gates.
6. Negative-conflict detector + shared-list propagation queue (§4.3.3–4).
7. Statistical driver analysis — pooled portfolio study of which drivers actually predict (verified) CPA; prunes dashboard metrics and hardens thresholds. Needs snapshot history to exist first.
8. Data health map — one page documenting every pipeline, cadence, reliability grade (timebox: documentation only).
9. Upsell headroom view — efficiency-pass/volume-fail ranked by `lost_is_budget × verified_cpa` headroom, **with marginal-auction haircut** (capped accounts' current CVR overstates marginal CVR — smart bidding cherry-picks; never present the naive projection to a client).
10. Budget pacing integration (existing `committed_budget_live` / pacing work) — decide whether it merges into this board or stays its own module.
11. **Portfolio-relative window checks (R5)** — populate `vs_portfolio` on `change_window_checks` once a portfolio movement series exists; upgrades window outcomes from baseline-only to a natural-control-group comparison (seasonality / Google-wide shifts stop masquerading as intervention effects). Schema already carries the column — zero migration.
12. **Cortex OS Chat notifications (R13)** — wire drafts-pending-review and broke-open windows to the existing Google Chat bot; revisit once Sprint 2/3 review volume is known.
13. **Conversion-action-level audit (R7)** — segment `metrics_conversions` by conversion action; catch partial tracking breaks (forms die, calls keep flowing) and verify no account counts untrusted CTM *imports* as primary conversions. Until then, the CTM parallel layer is the trust instrument.
14. **Benchmarking project (R14)** — market-size-adjusted cohorts replacing blended portfolio medians; retires most `account_rule_overrides`. Separate project, explicitly out of scope here.

## 13. Placeholder registry — MUST be set before go-live (Nate working session)

Every `[PLACEHOLDER]` from §4–8, collected: qualified-call duration (60s) · all §6.2 thresholds and floors · **warn proximity X% per rule (R12)** · guardrail tolerance band — **target AND collateral (R3)** · **default guardrail metric per change type — confirm/adjust the §7.1 table (R3)** · baseline window (30d) · default window lengths per change type · verification-ratio trust line (0.8 / 0.6) · answer-rate floor (80%) · **relevant-CTR coverage floor (60%, R10)** · **classifier audit sample size (100, R4)** · **worst-ads packet count (5, R2)**. Method: portfolio distributions (p25/median per campaign type, computed in Sprint 1) + Nate's judgment. Log the chosen values as `kpi_rules` v1 — versioned from the first day.

## 14. Known data caveats (inherited knowledge — do not relearn the hard way)

1. CTM `called_at_ts` is null across all rows — use `called_at` string or `unix_time`.
2. `committed` view is stale — `committed_budget_live` is the source.
3. No analytical view may read Google-Sheets-linked external tables (breaks n8n service-account access — pacing_api incident).
4. `reference.client_mapping` fan-out risk — §4.7 test is mandatory.
5. QS is null on low-volume keywords — always carry coverage %; coverage is a sufficiency gate.
6. IS reports `<10%` as a floor — store `is_floored`.
7. Privacy-masked search terms — material spend is unclassifiable; track as `unattributable`, never assume clean.
8. LSA campaigns (~$42K/15 campaigns) — excluded from funnel v1; revisit.
9. CTM→Google Ads conversion *imports* are NOT used or trusted anywhere in this system (accuracy unknown — separate future project). CTM data is used directly as the parallel measurement layer.
10. Capped accounts: smart bidding + budget caps mean current CVR overstates marginal CVR — haircut all headroom projections.
11. RSA asset performance labels are null/"PENDING" below traffic thresholds — likely most assets in thin franchise accounts. Same discipline as QS: always carry `asset_label_coverage_pct`; never treat an unrated asset as a bad asset.

---

*End of v1.1. Red-lined July 2026 (decisions R1–R14 in the changelog); keep this doc canonical.*

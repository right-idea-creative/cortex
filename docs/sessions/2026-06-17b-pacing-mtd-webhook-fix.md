# Session 2026-06-17b — Pacing dashboard fixes: June gap, webhook MTD, MTD view swap

**Driver:** Sebas (work)
**Outcome:** Closed three separate post-deploy issues surfaced by the dashboard not reflecting Nextdoor / MTD correctly. Also took operational ownership of the pacing webhook in n8n. New LEARNINGS L-019/L-020.

> Follow-up to session `2026-06-17-nextdoor-api-ingestion`. That session deployed the Nextdoor pipeline; this one fixed what the dashboard exposed afterward.

## What was wrong (three distinct layers)

The dashboard showed wrong/zero numbers for Nextdoor and for the SPENT MTD column. It turned out to be three unrelated problems stacked, diagnosed one at a time:

### 1. June data gap in `nextdoor_spend_daily`
- Nextdoor ACTUAL for June was far too low ($140 vs the real ~$788 for Dallas).
- Cause: the backfill ran Jan 1 – May 31; the daily job only pulls `LOOKBACK_DAYS=3`. June 1–13 fell in the gap between the end of the backfill and the trailing window and was never ingested.
- Fix: ran the job locally with `START_DATE=2026-06-01 END_DATE=2026-06-17` for all 26 advertisers. MERGE is idempotent, so re-touching Jun 14–16 didn't duplicate. Dallas Nextdoor ACTUAL went $140 → $798, matching the Nextdoor UI ($788.10 + partial day 17).

### 2. SPENT MTD = $0 for ALL channels (incl Google Ads) — the n8n webhook
- `budget.pacing_api` had the correct `spent_mtd` (Dallas/google_ads/June = 5366.92), but the dashboard showed $0 for every channel.
- Cause: the webhook's BigQuery node (`Query pacing_api` in workflow **ODC Pacing — Data API**) used an explicit column list (`p.client, p.channel, p.year, p.month, p.committed, p.actual` + the `mondayClientId` JOIN) from an older version of `pacing_api`, before `spent_mtd` and the enrichment/day columns existed. Those columns never reached the browser.
- Fix: changed the node's SELECT to `p.*` (plus the existing `mondayClientId` LEFT JOIN to `reference.client_mapping`). Published. Verified the production webhook now returns `spent_mtd`, `account_manager`, `source_group`, `days_*`, `current_month`.
- LEARNINGS L-019.

### 3. SPENT MTD = $0 for Nextdoor only — the MTD view
- After fix #2, Google Ads MTD populated but Nextdoor MTD stayed $0.
- Cause: `budget.actual_spend_mtd` is a **second** view, parallel to `actual_spend_all`, with its own duplicated channel union — and it still read Nextdoor from `other_channels_live` (the Sheet, which has no June). The session-1 swap only touched `actual_spend_all`.
- Fix: applied the same swap to `actual_spend_mtd` — added a `nextdoor` CTE reading `nextdoor_spend_daily` (filtered to MTD), and excluded Nextdoor from the Sheet branch. Verified Dallas now returns `nextdoor spent_mtd = 798.13`.
- LEARNINGS L-020.

## Operational ownership change

The pacing webhook workflow **ODC Pacing — Data API** (n8n id `y6Y8uzQ9lntdFiLp`, instance `naterimc.app.n8n.cloud`) is now administered by us (Cortex/Sebas), not treated as Nate's black box. It is 3 nodes: `Pacing Data Request` (webhook GET) → `Query pacing_api` (BigQuery executeQuery) → `Respond With Rows`. The query is now `SELECT p.*, m.monday_item_id AS mondayClientId FROM budget.pacing_api p LEFT JOIN reference.client_mapping m ON LOWER(TRIM(p.client))=LOWER(TRIM(m.client_name)) ORDER BY ...`.

Note on testing n8n: the webhook trigger does not auto-fire on "Execute workflow" in the editor (it shows "Waiting for you to call the Test URL"). The reliable validation is to Publish, then `curl` the production webhook URL — that's what the dashboard actually calls. The validated SQL was confirmed in BigQuery directly first (schema-first, L-001), so editor execution wasn't needed.

## Learnings recorded

- **L-019** — the n8n webhook projected a stale explicit column list; the dashboard showed $0 silently. Use `p.*`; re-check the webhook when `pacing_api` gains columns.
- **L-020** — channel spend lives in TWO parallel views (`actual_spend_all` + `actual_spend_mtd`) with duplicated unions. A channel-source change must be applied to both, or the dashboard goes half-right (ACTUAL correct, MTD wrong).

## Pending opened

- **P-TECH-12** — refactor `actual_spend_mtd` to derive from the same base as `actual_spend_all` instead of duplicating the channel union (root cause of issue #3).
- **P-TECH-13** — verify `committed = "0.0"` is not appearing for ODC clients that have committed budget (possible bug in the `pacing_api` FULL OUTER JOIN with `committed_budget_live`). Seen on CharterWest (Other group, likely legit) but unconfirmed for ODC.

## Resolved (this session)

- June 1–13 Nextdoor ingestion gap backfilled.
- Webhook SPENT MTD $0 fixed (all channels).
- `actual_spend_mtd` Nextdoor source swapped Sheet → API.

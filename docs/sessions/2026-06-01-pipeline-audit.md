# Session — 2026-06-01 (Monday)

**Driver:** Claude (Sebas, work account)
**Theme:** Pipeline audit after a major undocumented rebuild. Discovered the data layer had been migrated from the documented model to a completely different one (native tables + n8n webhook). Reconciled the docs to reality, killed dead infrastructure, and fixed an incomplete view.

> **Important context for the next instance:** the shared brain was last updated 2026-05-27 (session 4) and had drifted **badly** out of sync. Between 05-27 and today, the entire pacing data layer was rebuilt — new dataset, native tables, scheduled queries, and a live n8n webhook replacing the static-JSON export. None of that was written down. This session is largely about catching the docs up to a system that had already changed underneath them. The lesson is L-013.

## Headline outcome

- **Docs reconciled to the real system.** STATE, PENDING, LEARNINGS, ARCHITECTURE, and state.json rewritten to describe what actually runs in production today, not the 05-27 design.
- **Dead infrastructure removed:** the `refresh-pacing.yml` GitHub Action, `export_pacing_data.py`, and `pacing-data.json` were deleted from the repo. They fed a static-JSON dashboard that production no longer uses (production reads an n8n webhook). The Action was committing a zombie JSON daily that nothing consumed.
- **`actual_spend_mtd` view fixed.** It only summed Google Ads; now unions the other channels too (same shape as `actual_spend_all`). Was producing month-to-date = 0 for Meta/Nextdoor/LSA/Bing/Yelp.
- **New data gap found:** Yelp now exists as a committed-budget channel but has no actual-spend feed. Logged as P-OPS.

## The real architecture, as verified today

This is the flow that actually runs. It differs completely from the 05-27 STATE.

```
committed_budget_long (Google Sheet, id 15Ju5gm9q5lu8RbevwrVlbrLS3sMqcrY-_KW4tldKOR4)
  -> raw_budget.committed_budget_long   (external table on the Sheet)
  -> budget.committed_budget_live       (NATIVE table; daily scheduled query 05:00 UTC)

raw_google_ads.p_ads_CampaignBasicStats_6118198619 (Google Ads DTS, daily)
other_channels Sheet (id 1pJ8GyxepeoO_yddEvVleUaUQ8zAN7_EVckJ_zvg93G4)
  -> raw_budget.other_channels_normalized (external table on the Sheet)
  -> budget.other_channels_live           (NATIVE table; daily scheduled query 05:00 UTC)

budget.actual_spend_all  (VIEW) = Google Ads (de-micro'd) UNION other_channels_live, joined to client_crosswalk on customer_id
budget.actual_spend_mtd  (VIEW) = same union, filtered to current-month-to-date  [FIXED THIS SESSION]

budget.pacing_api (VIEW) = committed_budget_live  FULL OUTER JOIN  actual_spend_all
                            + enrichment (account_manager, source_group) from client_crosswalk (active=TRUE)
                            + spent_mtd from actual_spend_mtd
                            + day-of-month pacing dims (America/Chicago)
                            filtered to current year

n8n webhook  https://naterimc.app.n8n.cloud/webhook/odc-pacing-data
  runs SELECT * FROM budget.pacing_api, enriches each row with mondayClientId, serves JSON

Dashboard  https://cortex-cmv.pages.dev/ad-spend-pacing
  fetches the webhook live (DATA_WEBHOOK_URL), computes status/variance/pacing in JS
```

Key point: **the dashboard reads the webhook live. There is no static JSON, no export script, no GitHub Action in the live path anymore.** All of that was the old (05-27) design and is now removed.

## What happened, in order

### Phase 1: New machine setup (Mac mini)

Switched from the MacBook Air to the Mac mini. Verified the toolchain was already connected: gcloud authed to `rightidea-cortex` as `sebas.guzman@rightideacreative.net`, ADC present, bq working, `cortex-nate` repo cloned on `main` and synced. `actual_spend_all` returned 1265 rows (5 channels) — confirming the prior day's native-table work survived.

### Phase 2: Removed a dead second repo

Found `~/Projects/cortex-budget-pacing` — a local clone of `right-idea-creative/cortex-budget-pacing`, an **empty** repo created 2026-05-27. Its GitHub description was "Cortex OS — Budget Pacing Dashboard (auto-refresh diario via Cloud Run + GCS)" — the abandoned Cloud Run + GCS approach we dropped when we aligned with Nate's n8n + Cloudflare stack. Deleted the local folder. The (empty) remote repo can be deleted by Nate when convenient — logged as a minor pending.

### Phase 3: Verified overnight scheduled queries

Both `committed_budget_live_refresh` and `other_channels_live_refresh` (created the prior session) ran overnight with state SUCCEEDED — first successful unattended run since they were created. Native tables stable: committed_budget_live 1,416 rows / 63 clients; other_channels_live 3,165 rows.

### Phase 4: Investigated an unexpected channel ("yelp")

The webhook returned a `yelp` channel (24 rows) that wasn't there before, plus channel counts that had shifted. Long debugging thread (documented here so nobody repeats it):

- `yelp` is **not** in `other_channels_live` (that feed has only Bing/LSA/Meta/Nextdoor).
- `yelp` **is** in `pacing_api`, on the committed side, sourced from the `committed_budget_long` Sheet.
- Confusion arose because `budget.committed` (a VIEW reading the **old** `committed_budget_seed`) does **not** contain yelp, while `committed_budget_live` (reading the live Sheet) **does**. We were querying the wrong object. See P-TECH on the orphaned `budget.committed`.
- Conclusion: yelp is a legitimate new committed channel. It has committed budget but **zero actual spend** because there is no Yelp actual-spend feed (it's not in the other-channels Sheet). New data gap → P-OPS.

### Phase 5: Investigated `actual_spend_mtd` (unknown view)

`pacing_api` references a view `actual_spend_mtd` that neither Sebas nor Nate recognized on sight. Given the 2026-05-01 unauthorized-access incident, we verified provenance before touching it:

- Created 2026-05-30 22:57, single creation, never edited.
- BigQuery activity on 05-30 (excluding the DTS service account) was: `cortex-bigquery@` (SA), `ctm-pipeline-sa@` (SA), and **`digital@rightideacreative.net`** — the only human account. That is Nate's / the digital team's account. Legitimate internal account, not the 05-01 pattern.
- Conclusion: Nate created it (via `digital@`) during the pacing rebuild and didn't recall it when asked. Mundane, not a security event. The real problem was just that it was undocumented and incomplete.

### Phase 6: Fixed `actual_spend_mtd`

The view only had a `google_ads` CTE — month-to-date for all other channels was silently 0, so the dashboard's current-month pacing was wrong for non-Google channels. Replaced it (CREATE OR REPLACE VIEW) to union the other channels with the same MTD date filter and the channel-normalization CASE used in `actual_spend_all`. Verified the logic against May (returns correct per-client MTD); returns empty for June today only because (a) the Google Ads DTS hasn't loaded June 1 yet — normal ~1-day lag — and (b) the other-channels Sheet updates weekly, so it has no June rows yet. The view is structurally complete and will populate on its own as data lands.

### Phase 7: Killed the old static-JSON pipeline

Verified production reads the webhook, not the JSON:
- `https://cortex-cmv.pages.dev/ad-spend-pacing` (HTTP 200, 38,888 bytes) references `DATA_WEBHOOK_URL` / `odc-pacing-data`, **zero** references to `pacing-data.json`.
- The repo's `ad-spend-pacing.html` (716 lines) is an **old** copy that still reads `pacing-data.json`; it is not what Cloudflare serves. Cloudflare serves a newer HTML that Nate uploads outside this repo's auto-deploy.

Since nothing in the live path uses them, `git rm`'d: `.github/workflows/refresh-pacing.yml`, `export_pacing_data.py`, `pacing-data.json`, `requirements.txt`. The stale repo `ad-spend-pacing.html` is left in place for now (it doesn't affect production) and flagged to be replaced with the production webhook version — see PENDING.

### Phase 8: Doc reconciliation (this commit)

Rewrote STATE.md, state.json, PENDING.md, LEARNINGS.md to the real system. Marked ADR-001 and ADR-003 as superseded and added ADR-008 (native tables for Sheet-backed sources) and ADR-009 (dashboard reads n8n webhook live). Removed all references to Daniel Peña from live docs (he has not contributed code); the historical `sessions/2026-04-foundation.md` is left untouched as a record.

## Issues surfaced (not bugs in our code)

- **Yelp has committed budget but no actual-spend feed.** → P-OPS (new).
- **`budget.committed` is orphaned** — it reads the old `committed_budget_seed` (no yelp), is not used by `pacing_api`, but still exists. Risk: anyone building "a view of budget/committed" (e.g. Nate's planned budget-planning page) would show stale seed data divergent from the live dashboard. → P-TECH (new).
- **`budget.committed` should be repointed to `committed_budget_live` or deleted.** Decision needed from Nate.

## Lessons added to LEARNINGS

- L-013 Docs drift silently when someone else rebuilds the system. Verify the running system (and `git pull`) before trusting the brain.
- L-014 Sheet-backed external tables break the entire view when the Drive credential drops; materialize to native tables.
- L-015 Never delete files from an auto-deploy repo without verifying what production actually serves.
- L-016 A view referencing only one channel/source is the recurring failure mode here — check every UNION slot.

## Architectural decisions formalized

- ADR-001 marked **Superseded by ADR-009** (dashboard no longer reads static JSON).
- ADR-003 marked **Superseded by ADR-008** (Sheet-backed sources are now materialized to native tables).
- ADR-008 Sheet-backed sources materialized to native tables + daily scheduled refresh.
- ADR-009 Dashboard reads the n8n webhook live; no static JSON in the path.

## End-of-session state

- Pipeline: verified healthy. pacing_api unions 6 channels; webhook serves them live.
- `actual_spend_mtd`: fixed (6 channels), waiting on data to populate June.
- Dead infra: removed (Action, export script, JSON, requirements).
- Docs: reconciled to reality.
- Daniel: removed from all live docs.

## Open items for next session

See `docs/PENDING.md`. Highest priority:

- Decide fate of orphaned `budget.committed` (repoint to live or delete). (P-TECH)
- Get a Yelp actual-spend feed, or decide Yelp stays committed-only. (P-OPS)
- Replace the stale repo `ad-spend-pacing.html` with the production (webhook) version so the repo matches what's deployed. (P-TECH)
- Confirm both scheduled queries keep succeeding now that they carry the full channel set.

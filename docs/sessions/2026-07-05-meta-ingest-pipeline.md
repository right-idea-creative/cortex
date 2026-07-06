# Session 2026-07-05 — Meta Ads API → BigQuery ingestion

**Driver:** Sebas (work)
**Outcome:** Meta Ads spend migrated off the manual other-channels Sheet to a fully automated, daily API pipeline. New ADR-011, LEARNINGS L-021. Mirrors the Nextdoor pattern (ADR-010) almost exactly.

## Objective

Connect Meta Ads to BigQuery directly via the Marketing API and retire the "Meta Ads" slot of the manual other-channels Sheet, joining Meta spend into `actual_spend_all` and `actual_spend_mtd` alongside the other channels.

## What we did

### Credentials (Meta Marketing API)
- Business Manager: **Right Idea Media & Creative**, `business_id=10153168996004391`.
- Created a **System User** `cortex-bigquery` (id `61591760422985`), role **Employee** (Admin was blocked — the acting admin had <7 days tenure; Employee is sufficient for read-only reporting anyway).
- Created a Meta Developer App **`cortex-pipeline`** (App ID `4813860152177662`), type **Business**, associated to the Right Idea portfolio. Added the **Marketing API** product. App Secret pulled from Settings → Basic.
- A System User needs **two separate links**: (1) assigned ad-account assets, and (2) being installed on the app with a role. Missing the second yields "No permissions available" when generating the token. Fixed by installing the app on the System User, then generated the token with **`ads_read`**.
- Token validated with `GET /me/adaccounts` — returned the active accounts with `account_status`.

### Data format / endpoint
- Insights endpoint per account: `GET /act_<id>/insights?level=campaign&fields=campaign_name,spend&time_increment=1&time_range={since,until}`.
- `time_increment=1` yields one row per campaign per day (the daily grain `other_channels_live` needs). `date_start` → `date`, `spend` → `cost`.
- Account enumeration is **dynamic**: `/me/adaccounts` filtered to `account_status==1`. New accounts assigned to the System User enter the pull with no code change. (Never hardcode account IDs — same rule as Bing/Nextdoor.)

### Build (`meta-ingest/` in the repo)
- `main.py`: `requests` direct against the Graph API (no SDK — simpler, easier to debug). Paginates via `paging.next` on both `/me/adaccounts` and insights. Backoff on rate-limit codes (4/17/613) and transient HTTP (429/500/503). Maps to the 6-column schema, writes staging (WRITE_TRUNCATE) then a **DELETE + INSERT of the date range in a transaction** (`BEGIN TRANSACTION … COMMIT`). Re-running a range replaces those dates — never duplicates. Credentials from env vars.
- Table `budget.meta_spend_daily`: schema identical to `other_channels_live` (`account_name, customer_id, campaign, date, cost, channel`), **partitioned by `date`**. `channel` literal set by the job.
- `Dockerfile` (python:3.12-slim), `requirements.txt` alongside.

## Validation

- Smoke test (2026-06-01 → 06-03): 6 accounts, 27 rows, staging + swap clean. Verified in BQ: correct dates, `channel="Meta"` (later fixed), real costs.
- **Backfill Jan 1 – Jul 2 2026**: 7 accounts (after Daytona was added mid-session), 1,231 rows, no rate limits.
- **Reconciliation vs the Sheet** (the migration gate): monthly deltas were sub-cent-to-tens-of-dollars (billing-adjustment noise) **except two**: ODC Savannah in March (+$379) and April (+$516). Drill-down showed consecutive days, one real campaign, no duplicates — the **Sheet had under-captured Savannah** (~$895 real spend missing across the two months). The API is the correct, more complete source. See P-OPS-09.

## Label fix — "Meta" → "Meta Ads"

- The job wrote `channel="Meta"` but the pipeline standard (and the CASE in both spend views) is **"Meta Ads"**. Left uncorrected it would miss the downstream filters.
- `UPDATE budget.meta_spend_daily SET channel="Meta Ads" WHERE channel="Meta"` (1,231 rows) + changed `CHANNEL_LABEL` in `main.py`.

## Daytona — three customer_ids, one client (see L-021)

- The account-universe check (Sheet's "Meta Ads" customer_ids vs the API table) flagged `2758529924464379` as present in the Sheet, absent from the API.
- That id turned out to be **ODC Daytona Beach**, a real client — not a Savannah typo. It was **not assigned** to the System User, so the API didn't pull it. Chose **option A** (assign + pull) over a Sheet carve-out exception, to keep the pipeline homogeneous.
- Assigned the Daytona ad account. Its Meta id is **`1414845413594090`** (name "OHD Daytona"), **not** `...379`. `GET /act_1414845413594090/insights` = **$199.97**, matching the Sheet's `...379` figure ($199.95) to two cents → **same client, the Sheet had a bad/incorrect id** (`...379`).
- `client_crosswalk` had Daytona under yet a **third** id `7490097466` — which is Daytona's **LSA** id (181 live LSA rows). Could not `UPDATE` it (would break LSA). Did an **INSERT** of a new crosswalk row for the Meta id, `canonical_client="ODC Daytona Beach"`, so Daytona resolves per-channel (one row per channel id) — the multichannel pattern P-CARRY-04 describes.
- Re-ran the backfill → 7 accounts, Daytona present ($199.97, 24 rows). All 7 Meta ids now match the crosswalk.

## The view swaps (both — L-020)

- `actual_spend_all` (annual): new `meta` CTE reading `meta_spend_daily` (joined to crosswalk, emits channel `'meta'`); removed `WHEN o.channel='Meta Ads' THEN 'meta'` from the other-channels CASE and added `AND o.channel <> 'Meta Ads'` to its filter. Before/after monthly comparison matched predictions (Mar/Apr up from Savannah, Daytona +$200, **July newly present at $139.70** — the Sheet had no July).
- `actual_spend_mtd` (month-to-date): same swap with the MTD date filter. Meta MTD went from **NULL** (Sheet had no July) to **$139.70**. Both views now serve Meta from the API — L-020 satisfied.

## Deployed (now autonomous)

- Secret Manager `meta-access-token` (already existed, v1 from today). SA **`cortex-meta@`** with `bigquery.dataEditor` + `jobUser` + `run.invoker` + `secretmanager.secretAccessor`.
- Cloud Run Job **`cortex-meta-ingest`** (`--source .`, Dockerfile build to Artifact Registry `cloud-run-source-deploy`, same as Nextdoor). No args → 7-day trailing window (incremental); `--since/--until` for backfill.
- Cloud Scheduler **`cortex-meta-daily`**, **08:00 America/New_York** (staggered one hour before Nextdoor's 09:00).
- Manual `gcloud run jobs execute` confirmed a full cloud run: reads secret, authenticates, writes BQ. `MAX(date)=2026-07-02`, 1,231 rows, swap not duplicating.
- Code committed and pushed to `main` (commit `671b824`, after a rebase to sync work from the other Mac).

## Decisions / learnings recorded

- **ADR-011** — Meta Ads ingested via the Marketing API (Cloud Run Job), not the Sheet; supersedes the Meta slot of ADR-008. Second channel after Nextdoor to follow the ADR-010 template.
- **L-021** — verify a channel's ids against `client_crosswalk` **before** carving a view; a client may have different ids per channel and dirty ids in the Sheet.

## Pending opened

- **P-OPS-09** — ODC Savannah under-captured in the Sheet (~$895 across Mar+Apr). Flag to Cole; the manual Meta capture missed real spend.
- **P-OPS-10** — stop entering Meta in the Other Channel Spend Sheet going forward; its "Meta Ads" rows are now dead (excluded downstream). Same class as P-OPS-08 (Nextdoor).
- **P-TECH-14** — **rotate `meta-access-token`**. The token was exposed in this chat session; revoke it in the System User (`cortex-bigquery`) and `gcloud secrets versions add meta-access-token --data-file=-` with the new value. Job reads `:latest`, no redeploy. **Do this next session.**

## Notes for the next instance

- Meta has **no** BigQuery Data Transfer Service connector (that's Google-Ads-only). This Cloud Run Job **is** the "transfer" for Meta — same as Nextdoor.
- Third channel API (Yelp, P-OPS-07) can follow the same `meta-ingest/` / `nextdoor-ingest/` template.
- Daytona is a live example of P-CARRY-04 (per-channel ids that a crosswalk rebuild would wipe): it now has a manually-inserted Meta-id row that a rebuild would drop.
- Token rotation (P-TECH-14) is the only open security item; the pipeline is otherwise complete and autonomous.

## Follow-up: Other Channel Spend Sheet cleaned to Bing-only

After the view swaps, the Other Channel Spend Sheet was cleaned: Nextdoor, Meta Ads, and LSA rows all deleted (a backup copy of the Sheet was kept). Verified before deleting that none feed the live views — Nextdoor from `nextdoor_spend_daily`, Meta from `meta_spend_daily`, and LSA from Google Ads (`LOCAL_SERVICES` CTE; the reporting total $54,305 vs the Sheet's $28,913 confirmed the Sheet's LSA rows were already ignored). **The Sheet now carries Bing only** — Bing stays Sheet-fed because the Microsoft Ads API is still blocked on account authentication (no pipeline yet). Closes P-OPS-08 (Nextdoor rows) and P-OPS-10 (Meta rows). Change reflects in `other_channels_live` on the next 05:00 UTC scheduled refresh.

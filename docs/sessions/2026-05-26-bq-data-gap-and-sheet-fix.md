# Session — 2026-05-26 (Tuesday)

**Driver:** Claude (Sebas, work account)
**Theme:** Root-cause analysis of Capture Mismatch buckets; introduction of BQ Data Gap status; major upstream fix in Other Channels sheet.

## Context

At end of session 2026-05-25, the pacing pipeline showed **157 accounts in `Captured Mismatch (AM Over-reported)` representing $222K** of spend reported by AMs but $0 in BigQuery. Initial hypothesis: AMs over-reporting.

## Discovery: it was not AM mis-reporting; it was a BQ coverage gap

Sebas manually verified the top discrepancies against the Google Ads console — the AM-reported numbers were correct. This forced re-examination of the BQ side.

Investigation revealed:

- **Sioux Falls, Dallas Fort Worth, Knoxville, Bowling Green, Cook Inlet** (all Google Ads) had a specific gap pattern:
  - Data complete through March 2025
  - Total gap **April 2025 → February 2026** (11 months)
  - Data resumed exactly on 2026-03-24, with only 8 days of March captured
  - April–May 2026 normal
- The "8 days starting March 24" pattern indicates these CIDs were **unlinked from the MCC** during the gap and **relinked on 2026-03-24**.
- ~49 account×platform combos affected by partial or full gaps.

This is data that BQ cannot retroactively recover from Google in the general case — once a CID is unlinked, transfer history for the gap period is lost.

## Chunk B v3 — `pacing_calculations` updated with BQ Data Gap detection

New status `BQ Data Gap` (severity `Neutral`) classifies months where BQ has no data for an account×platform combo, separating them from real capture mismatches. See ADR-006.

Validation before/after the change:

| Status | v2 (before) | v3 (after) |
| --- | --- | --- |
| Historical Match | 47 | 47 |
| Captured Mismatch (AM Over-reported) | 157 / $222k | 71 / $112k |
| BQ Data Gap (NEW) | — | 151 / $110k |
| Captured Mismatch (>10% diff) | 76 | 76 |
| Paused (Historical) | 72 | 7 |

86 false positives were correctly reclassified out of AM Over-reported.

## Chunk C v2 — `pacing_dashboard_view` rewritten

- Removed `client_mapping` JOIN definitively.
- Added columns `bq_data_available`, `source_group`, `annual_status`, `capture_accuracy_ratio`, `capture_discrepancy`, `leftover_anual`, `total_approved`.
- 7-month rolling window (Feb–Aug 2026).
- Timezone fixed to `America/Chicago` (was incorrectly `America/Bogota`).
- Used `spend_date` correctly (had bugs earlier with `date`).

## Google Ads transfer backfill triggered

- Schedule backfill in Data Transfer Service for range `2026-01-01` → `2026-03-31` against the MCC.
- Partial progress observed before session end: March extended from 8 to 10 days for affected accounts.
- Hypothesis confirmed at session close: Google will not backfill data for periods when the CID was outside the MCC.

## Critical upstream bug discovered: Date NULL in Other Channels sheet

While verifying data freshness for the dashboard, the `Bing` platform showed `platform_last_spend_date = NULL`. Investigation revealed `raw_budget.other_channels_normalized` was silently filtering all 124 Bing rows because of `WHERE Date IS NOT NULL`.

Root cause traced to the underlying Sheet `Other Channel Spend [OFFICIAL]`. Counts:

| Channel | Total rows | Date NULL | Percent NULL |
| --- | --- | --- | --- |
| Bing | 124 | 124 | 100% |
| Meta Ads | 834 | 641 | 76.9% |
| Nextdoor | 1502 | 1221 | 81.3% |
| LSA | 717 | 362 | 50.5% |

The Bing rows were 124 identical entries (same Customer_ID, same `$59.04` cost, no date) — clearly a copy-paste / export error in the manual capture process.

Sebas manually corrected the Sheet, repopulating dates for all 2,348 affected rows. **~$116k of spend data became visible** that had been silently filtered.

## State at session close

| Status | Count after all fixes |
| --- | --- |
| Historical Match | 111 |
| Captured Mismatch (>10% diff) | 107 |
| BQ Data Gap | 72 |
| Captured Mismatch (AM Over-reported) | 34 |
| Captured Mismatch (AM Under-reported) | 24 |
| Paused (Historical) | 8 |

Pipeline is sound. AM Over-reported is now small enough to be legitimately reviewed case-by-case.

## Pending at session close (resolved or carried forward by 2026-05-27)

- Connect dashboard (status: Looker was rejected, deferred to next session — eventually resolved via Cloudflare Pages on 2026-05-27).
- Reconcile 34 real AM Over-reported cases with Cole → still pending (P-OPS-05).
- Identify 6 source-NULL orphan CIDs → still pending (P-OPS-03).
- Investigate Date NULL root cause in capture process → still pending (P-OPS-04).

## Lessons added to LEARNINGS.md

- L-001 Schema first.
- L-005 Filtered VIEWs hide upstream data quality issues.
- L-006 AM Over-reported is not always real mis-reporting.

---

**Note:** This session log is reconstructed from Monday bitácora entry session 3 on 2026-05-27.

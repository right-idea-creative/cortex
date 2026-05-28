# Session — 2026-05-25 (Sunday)

**Driver:** Claude (Sebas, work account)
**Theme:** Full pipeline rebuild after migration to new ODC Planner.

## Context entering the session

The old AM Planner Google Sheet had been replaced by a new sheet (`ODC Forecast - 2026 LIVE`, ID `1uk_4iYe_...`). The structural differences required rebuilding all downstream views.

## What was done

- Rewrote `raw_budget.planner_sheet` external table to point at the new Sheet.
- Updated `raw_budget.budgets_normalized` to handle the new column layout, including the new `total_approved` and `leftover_anual` columns.
- Cleaned legacy LSA `1`-suffix workaround that had accumulated in the spend join logic.
- Verified pipeline end-to-end with sample queries.

## Key decisions

- The new planner's `leftover_anual` (column R) replaces the previously synthesized monthly rollover. See ADR-005.
- `client_mapping` JOIN was confirmed removed; `source_group` is now derived from the prefix of `account_name` (`Other -` vs `ODC `).

## Issues found and resolved

- Phantom-table issue in `reference.client_mapping` (atomic staging-swap pattern). Resolved.
- Two consecutive validation runs both returned 78 rows (62 ODC + 16 Other).

## Issues found and left open (became next session's work)

- Many accounts ended up in `Captured Mismatch (AM Over-reported)` bucket — flagged as suspicious; followed up on 2026-05-26.

---

**Note:** This session log is reconstructed from Monday bitácora entries on 2026-05-27.

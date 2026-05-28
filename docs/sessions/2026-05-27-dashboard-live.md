# Session — 2026-05-27 (Wednesday)

**Driver:** Claude (Sebas, work account)
**Theme:** Ad Spend Pacing dashboard deployed to production on Cloudflare Pages. Architectural pivot mid-session.

## Headline outcome

**Cortex OS Ad Spend Pacing module is LIVE in production:**

- URL: https://cortex-cmv.pages.dev/ad-spend-pacing
- Auto-refresh: daily at 08:00 America/Chicago (14:00 UTC) via GitHub Actions
- Integrated natively into the Cortex OS suite (shares header, nav, color palette with Nate's modules)
- Showing 108 active combos, 23 Critical, 17 Review, $124.5k spend MTD vs $151.5k budget (82% pacing)

## What happened, in order

### Phase 1: Validated previous day's pipeline work

Re-ran chunk B v3 / chunk C v2 validations after partial backfill completion. Final state of the data model:

| Status | Severity | Rows | Combos | BQ Spend | Planner Spend |
| --- | --- | --- | --- | --- | --- |
| Historical Match | Healthy | 111 | 62 | $238,347 | $243,437 |
| Captured Mismatch (>10% diff) | Review | 107 | 72 | $101,963 | $138,318 |
| BQ Data Gap | Neutral | 72 | 35 | $0 | $32,003 |
| Captured Mismatch (AM Over-reported) | Review | 34 | 34 | $0 | $54,162 |
| Captured Mismatch (AM Under-reported) | Critical | 24 | 15 | $24,460 | $0 |
| Paused (Historical) | Healthy | 8 | 8 | $0 | $0 |

Historical Match more than doubled (47 → 111). Pipeline is healthy.

### Phase 2: Wrong architectural path (Cloud Run + GCS)

Started building a Python + Flask + Docker + Cloud Run + Cloud Storage stack to serve the dashboard. Got as far as `gcloud auth` setup before realizing this was the wrong choice.

Time lost: ~3 hours.

Root cause: did not look at what Nate had already built before designing infrastructure. See LEARNINGS L-004.

### Phase 3: Pivot to Cloudflare Pages + GitHub Actions

Inspected Nate's existing repo `right-idea-creative/cortex`:
- Static HTML site (no build, no framework)
- 5 files: index, call-tracking, ad-spend-pacing (placeholder "Coming Soon"), tickets, data.json
- Auto-deployed via Cloudflare Pages connected to the GitHub repo
- Tech stack: vanilla JS + Chart.js + n8n chat embed

Decision: integrate our pacing work as `ad-spend-pacing.html` in this same repo, mimicking Nate's visual patterns and data-loading approach. See ADR-001 and ADR-002.

### Phase 4: Built and shipped the dashboard

Files added to `right-idea-creative/cortex`:

| File | Purpose | Size |
| --- | --- | --- |
| `ad-spend-pacing.html` | Replaces Nate's placeholder. Full dashboard with filters, 5 metric cards, status distribution, trend chart, platform donut, attention table, capture table, all-accounts table, freshness footer | 30 KB |
| `export_pacing_data.py` | Reads `pacing_dashboard_view` and writes `pacing-data.json`. Includes explicit Drive scope handling | 5 KB |
| `pacing-data.json` | Generated snapshot: 764 rows, 85 accounts, 5 platforms | 550 KB |
| `.github/workflows/refresh-pacing.yml` | Daily cron + manual dispatch | 2 KB |
| `requirements.txt` | `google-cloud-bigquery==3.27.0` | — |
| `.gitignore` | Excludes `venv/`, `*-sa-key.json` | — |
| `README.md` | Module docs | — |

Commit `2a8ba1c` on `main`.

### Phase 5: Authentication and permissions setup

Service account configuration was the longest technical hurdle:

- Workspace OAuth blocking prevented authenticating Sebas's user account with Drive scopes. See L-003.
- New SA `cortex-pacing-gha` creation hit propagation lag. Pivoted to re-using existing `cortex-bigquery` SA. See L-007.
- Default Python BQ client failed with `403 Permission denied while getting Drive credentials` even though SA was shared as Viewer on both Sheets. Required explicit OAuth scope handling in code. See L-002 and ADR-004.
- Both source Sheets (`ODC Forecast 2026 LIVE` and `Other Channel Spend OFFICIAL`) shared as Viewer with the SA.

After scope fix, export ran in ~5 sec and produced valid `pacing-data.json`.

### Phase 6: GitHub Actions configuration

- GCP SA key saved as GitHub Secret `GCP_SA_KEY` in repo settings.
- Workflow tested manually via `workflow_dispatch`. Ran green in 26 seconds (refresh step 18s).
- Local SA key file deleted from Mac (security hygiene — credential is now only in GitHub Secrets).

### Phase 7: Shared brain creation

Decision to create `/docs/` folder in the same repo to serve as cross-instance memory. See ADR-007. This file is part of that effort.

## Issues surfaced in the dashboard (not bugs in code)

- **~14 accounts "Spending Without Budget" Critical** in current month — likely accounts not yet added to new planner. → P-OPS-02.
- 34 AM Over-reported, 24 AM Under-reported still need operational reconciliation → P-OPS-05, P-OPS-06.
- The 6 NULL-source-group CIDs from previous day still pending → P-OPS-03.

## Lessons added to LEARNINGS

- L-002 External tables on Google Sheets need explicit Drive scope.
- L-003 Workspace OAuth blocks user-account access to Drive scopes.
- L-004 Check what teammates already built before designing infrastructure.
- L-007 Re-use existing service accounts before creating new ones.
- L-008 Don't paste blocks with shell-illegal characters into Terminal.
- L-009 macOS Finder shows localized folder names but the filesystem uses English.
- L-010 Bitácora discipline matters more than tooling.

## Architectural decisions formalized

- ADR-001 Static site on Cloudflare Pages, not Cloud Run.
- ADR-002 GitHub Actions for daily refresh, not Cloud Scheduler.
- ADR-007 Shared brain in `/docs/` inside the same repo.

## End-of-session state

- Pipeline: clean and validated.
- Dashboard: live in production.
- Auto-refresh: configured and tested.
- Bitácora migrated to `/docs/`.
- Old Monday bitácoras (`39619258`, `42308796`) noted as superseded — to be archived next session.

## Open items for next session

See `docs/PENDING.md`. Highest priority:

- Notify Nate about the live module and walk through it. (P-TECH-03)
- Verify first automatic refresh run tomorrow morning. (no item; just observation)
- Follow up with Cole on operational reconciliation items.

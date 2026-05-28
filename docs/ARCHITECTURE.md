# Cortex OS — Architecture Decisions

> **Purpose:** explain *why* the system is built the way it is. This file changes rarely. Only add to it when an explicit architectural decision is made — not on every bug fix.

> **For new instances:** if you're tempted to propose a different architecture, **read the relevant section here first**. Most "obvious improvements" were already considered and rejected for reasons documented below.

---

## ADR-001: Static site on Cloudflare Pages, not Cloud Run

**Date:** 2026-05-27
**Decision:** Cortex OS is a static HTML site hosted on Cloudflare Pages, with data pre-generated as JSON files committed to the repo. No server runtime.

**Alternatives considered:**
- Cloud Run with Python/Flask serving HTML on request (initially proposed and partially built)
- Looker Studio (explicitly rejected by Nate in March 2026)
- Self-hosted dashboard server

**Why Cloudflare Pages won:**
- Nate had already established this pattern for Call Tracking and Tickets modules. Coexistence > parallel infrastructure.
- Zero server cost. Free tier covers our traffic indefinitely.
- Refresh latency (1-2 min from data update to live) is acceptable for daily-cadence data.
- No Docker, no container build, no service account on the request path. Simpler security surface.
- Sebas and Nate can deploy independently by pushing to the same repo.

**Consequences:**
- All data must be pre-computed and stored as static JSON. No runtime queries.
- Refresh frequency is bounded by GitHub Actions cron + Cloudflare deploy latency, currently ~daily.
- For sub-daily freshness, we would need to add a different pattern (live-fetch from BQ via authenticated proxy). Not needed today.

---

## ADR-002: GitHub Actions for daily refresh, not Cloud Scheduler

**Date:** 2026-05-27
**Decision:** The daily data refresh runs as a GitHub Actions workflow, not a Cloud Scheduler job hitting a Cloud Run endpoint.

**Why GHA won:**
- Already triggers Cloudflare's auto-deploy (single push handles both data refresh and site re-render).
- Visible to anyone with repo access. No need to log into GCP console to debug.
- Free under public-repo quotas.
- Lives next to the code it runs.

**Consequences:**
- The SA key must be stored as a GitHub Secret (`GCP_SA_KEY`). Treat the secret as sensitive: any developer with admin access to the repo can read/exfiltrate it.
- If GitHub is down, the refresh is delayed. Acceptable for daily cadence.
- Workflow uses Workload Identity Federation as a future improvement (cleaner than long-lived JSON key) but is not implemented yet.

---

## ADR-003: Data layer in BigQuery views, not materialized tables

**Date:** 2026-05-26
**Decision:** All pacing logic is implemented as BigQuery views that compose on top of source tables. No materialized tables, no scheduled queries to "refresh" derived data.

**Why views won:**
- Source data freshness is bounded by Google Ads transfer (daily) and manual Sheet edits (weekly-ish). A materialized layer would add another lag without reducing source lag.
- Views recompose automatically when source data updates. No orchestration of "did X refresh before Y queried it?".
- Cost is negligible at our query volume (single daily export query).

**Consequences:**
- The export script's BQ query is heavier than it would be against a materialized table. Currently ~5 sec; fine.
- Schema changes in source tables can cascade silently through views. **Mitigation:** always run `INFORMATION_SCHEMA.COLUMNS` checks before assuming a column exists (see LEARNINGS).

---

## ADR-004: Service accounts must use explicit OAuth scopes when reading Sheet-backed BigQuery tables

**Date:** 2026-05-27
**Decision:** When authenticating with a service account JSON key to query a BigQuery view that transitively reads a Google Sheet via an external table, the client must request the Drive OAuth scope **in addition to** the default Cloud Platform / BigQuery scopes.

**Why this matters:**
- BigQuery external tables on Google Sheets are "delegated" by default: BQ uses the *caller's* credentials to read the underlying Sheet, not the table creator's.
- The default Python BigQuery client only requests `cloud-platform` scope when authenticating from a JSON key. The Drive token piece is not granted, so the Sheet read fails with `403 Permission denied while getting Drive credentials` even when the SA is shared as Viewer on the Sheet.

**Implementation:**
- `export_pacing_data.py` builds credentials with `service_account.Credentials.from_service_account_file(path, scopes=[bigquery, drive, cloud-platform])` explicitly.

**Consequences:**
- Any new script that queries pacing views (or any view backed by Sheet external tables) must do the same. Default `bigquery.Client()` will fail.
- Sharing the Sheet with the SA is also required; the scope alone isn't enough.

---

## ADR-005: Pacing data model uses annual leftover, not synthetic monthly rollover

**Date:** 2026-05-26
**Decision:** The pacing pipeline does **not** synthesize a "monthly rollover" budget concept. Instead, the new ODC Planner provides an annual `leftover_anual` column that captures the true cumulative variance from approved annual budget.

**Why:**
- The previous (old planner) approach computed `effective_budget = base_budget + rolling_carry` per month. This inflated current-month budgets when prior months under-spent, making accounts look healthy when they were actually behind.
- The new planner (`ODC Forecast - 2026 LIVE`) tracks annual capacity as a single number (`total_approved`) and reports remaining capacity as `leftover_anual`. This is the source of truth.

**Consequences:**
- `pacing_calculations` exposes `annual_status` (`On Track Annual` / `Warning (Slight overspending)` / `Critical (Overspending annual)` / etc.) as a separate dimension from monthly status.
- Dashboards should show annual_status alongside monthly status. The two answer different questions.

---

## ADR-006: BQ Data Gap is a first-class status, not a missing-data error

**Date:** 2026-05-27
**Decision:** Months where BigQuery has no data for a given account×platform combo (because of pre-MCC-link history) are explicitly labeled `BQ Data Gap` with severity `Neutral`. They are not treated as "AM Over-reported" or other discrepancy types.

**Why:**
- Without this, accounts whose CIDs were not linked to the MCC during a historical month appear as "$0 in BQ vs $X reported by AM," which is a false alarm. It's not that the AM mis-reported; we genuinely don't have the data.
- Mixing real discrepancies with coverage gaps destroys the trustworthiness of the discrepancy bucket. Operators stop reading the alerts.

**Implementation:**
- `pacing_calculations` has a CTE `bq_coverage` that computes the earliest BQ month per CID×platform. Any row whose `month_date < first_bq_month` gets `bq_data_available = FALSE` and is labeled `BQ Data Gap`.

**Consequences:**
- The dashboard distinguishes between three orthogonal axes: data presence (BQ Data Gap or not), pacing health (Critical/Review/Healthy), and capture accuracy (AM Over/Under/Match). All three must be considered.

---

## ADR-007: Shared brain lives in `/docs/` inside the same repo, not in Notion or a separate wiki

**Date:** 2026-05-27
**Decision:** Cross-instance documentation lives in `right-idea-creative/cortex/docs/` as a folder of Markdown files plus a `state.json` for programmatic agents.

**Why:**
- Documentation that lives in the same repo as the code is much harder to drift out of sync.
- Multiple Claude instances and programmatic agents (n8n) need to read it. Raw GitHub URLs work for both.
- Git provides versioning, diffs, and conflict resolution for free.
- Notion's API has rate limits, auth complexity, and weak diff/version semantics for our use case.

**Trade-offs:**
- Non-technical readers (Cole, Dan) can't edit freely the way they could in Notion. Mitigation: they don't need to write here; they read the live dashboards. Operational data lives in Monday.com.
- Rich embeds (videos, file uploads) aren't natively supported. Mitigation: link out to Drive / Loom when needed.

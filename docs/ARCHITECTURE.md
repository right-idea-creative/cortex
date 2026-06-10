# Cortex OS — Architecture Decisions

> **Purpose:** explain *why* the system is built the way it is. This file changes rarely. Only add to it when an explicit architectural decision is made — not on every bug fix.

> **For new instances:** if you're tempted to propose a different architecture, **read the relevant section here first**. Most "obvious improvements" were already considered and rejected for reasons documented below. Note which ADRs are marked **Superseded** — those describe how the system *used* to work.

---

## ADR-001: Static site on Cloudflare Pages, not Cloud Run

**Date:** 2026-05-27
**Status:** Active (hosting) / partially **Superseded by ADR-009** (data delivery)

**Decision:** Cortex OS is a static HTML site hosted on Cloudflare Pages. *Originally*, data was pre-generated as JSON files committed to the repo.

**Still true:** static hosting on Cloudflare Pages, no server runtime, zero hosting cost, independent deploys.

**No longer true:** the "data pre-generated as JSON committed to the repo" part. The pacing module now fetches its data live from an n8n webhook (see ADR-009). Other modules' data delivery is unchanged.

**Why Cloudflare Pages still wins for hosting:**
- Nate established this pattern for Call Tracking and Tickets. Coexistence > parallel infrastructure.
- Zero server cost; no Docker, no container build, no SA on the request path for static assets.

---

## ADR-002: GitHub Actions for daily refresh, not Cloud Scheduler

**Date:** 2026-05-27
**Status:** **Superseded by ADR-008/ADR-009** for pacing. Historical.

**Decision (historical):** the daily pacing data refresh ran as a GitHub Actions workflow that executed `export_pacing_data.py` and committed `pacing-data.json`.

**Why it's gone:** the pacing dashboard no longer reads a static JSON, so there's nothing for the Action to generate. Data freshness is now handled by (a) BigQuery scheduled queries refreshing native tables (ADR-008) and (b) the dashboard reading `pacing_api` live via webhook (ADR-009). The Action, the export script, and the JSON were removed 2026-06-01.

**Residual:** the GitHub secret `GCP_SA_KEY` may still exist; audit whether anything uses it before removing (PENDING P-TECH-04).

---

## ADR-003: Data layer in BigQuery views, not materialized tables

**Date:** 2026-05-26
**Status:** **Superseded by ADR-008**

**Decision (historical):** all pacing logic was implemented as BigQuery views composing on source tables, with no materialized tables and no scheduled queries to refresh derived data.

**Why it was superseded:** the assumption was that views recompose automatically and add no lag. That held until a source was a Google Sheet external table whose Drive credential dropped — which fails the *entire* view, not just the Sheet-backed rows, taking the dashboard down. Materializing the Sheet-backed sources to native tables (ADR-008) isolates that failure. The analytical layer (`actual_spend_all`, `pacing_api`, `actual_spend_mtd`) is still views; only the Sheet-backed *sources* are now materialized.

---

## ADR-004: Service accounts must use explicit OAuth scopes when reading Sheet-backed BigQuery tables

**Date:** 2026-05-27
**Status:** Active

**Decision:** When authenticating with a service account JSON key to query a BigQuery view that transitively reads a Google Sheet via an external table, the client must request the Drive OAuth scope in addition to the default BigQuery / Cloud Platform scopes.

**Why:** BigQuery external tables on Sheets use the *caller's* credentials to read the underlying Sheet. The default Python BigQuery client only requests `cloud-platform`, so the Sheet read fails with `403 Permission denied while getting Drive credentials` even when the SA is shared as Viewer.

**Still relevant:** the scheduled queries that refresh `committed_budget_live` and `other_channels_live` read Sheets, so whatever identity runs them needs Drive access. This is also *why* we materialize (ADR-008) — to keep that Drive dependency off the dashboard's critical path.

---

## ADR-005: Pacing data model uses annual leftover, not synthetic monthly rollover

**Date:** 2026-05-26
**Status:** Active (concept) — note the implementation moved to the `budget` dataset

**Decision:** The pacing pipeline does not synthesize a "monthly rollover" budget. Annual capacity is tracked as a single approved figure; remaining capacity is reported as an annual leftover, separate from monthly status.

**Why:** the old `base_budget + rolling_carry` approach inflated current-month budgets when prior months under-spent, making behind-pace accounts look healthy.

**Note:** the live committed-budget model now lives in `committed_budget_long` → `committed_budget_live`, joined in `pacing_api`. The annual-vs-monthly distinction still applies conceptually.

---

## ADR-006: BQ Data Gap is a first-class status, not a missing-data error

**Date:** 2026-05-27
**Status:** Active (concept)

**Decision:** Months where BigQuery has no data for an account×platform combo (pre-MCC-link history) are explicitly labeled as a data gap, not as a discrepancy / AM mis-report.

**Why:** mixing genuine coverage gaps with real discrepancies destroys trust in the discrepancy alerts; operators stop reading them.

**Principle to preserve:** keep three orthogonal axes distinct — data presence, pacing health, capture accuracy. (See LEARNINGS L-006.)

---

## ADR-007: Shared brain lives in `/docs/` inside the same repo

**Date:** 2026-05-27
**Status:** Active

**Decision:** Cross-instance documentation lives in `right-idea-creative/cortex/docs/` as Markdown plus `state.json` for programmatic agents.

**Why:** docs next to code drift less; multiple Claude instances and agents can read raw GitHub URLs; git gives versioning and diffs for free.

**Caveat learned (session 5):** "drift less" is not "drift never." The brain still went badly stale when the system was rebuilt without a matching doc update. The folder is necessary but not sufficient — the end-of-session discipline (L-010) and verify-before-trust (L-011) are what actually keep it honest.

---

## ADR-008: Sheet-backed sources are materialized to native tables + daily scheduled refresh

**Date:** 2026-05-31 (formalized 2026-06-01)
**Status:** Active. Supersedes ADR-003 for Sheet-backed sources.

**Decision:** Any Google Sheet feeding the pacing pipeline is materialized into a **native** BigQuery table by a daily scheduled query. Production views read the native table, never the Sheet-backed external table directly.

Current instances:
- `committed_budget_long` (Sheet) → `raw_budget.committed_budget_long` (external) → `budget.committed_budget_live` (native, `committed_budget_live_refresh`, daily 05:00 UTC).
- other-channels Sheet → `raw_budget.other_channels_normalized` (external) → `budget.other_channels_live` (native, `other_channels_live_refresh`, daily 05:00 UTC).

**Why this beats reading the Sheet directly:**
- A Sheet external table fails the **entire** view when its Drive credential drops (`Permission denied while getting Drive credentials`). That took the whole dashboard down once (Google Ads included), and forced an emergency edit to comment out the other-channels slot. (LEARNINGS L-012.)
- With materialization, a failed refresh leaves the last good native table in place. The dashboard stays up on slightly stale data instead of going down.
- Sheet data only changes daily (committed) / weekly (other channels) anyway, so a daily materialized snapshot loses no meaningful freshness.

**Consequences:**
- Two scheduled queries now exist and must keep succeeding; monitor their state. They run as `CREATE OR REPLACE TABLE ... AS SELECT ...` with no destination table set (the DDL defines it).
- The identity running each scheduled query needs Drive access to its Sheet. If a refresh starts failing, check Drive sharing first.
- A native snapshot can silently go stale if the scheduled query breaks. Mitigation: the refresh state is checkable (`bq ls --transfer_config`), and stale data is safer than a down dashboard.

---

## ADR-009: The dashboard reads the n8n webhook live; no static JSON in the path

**Date:** ~2026-05-30 (formalized 2026-06-01)
**Status:** Active. Supersedes the data-delivery half of ADR-001 and all of ADR-002.

**Decision:** The Ad Spend Pacing dashboard fetches its data at page load from an n8n webhook (`https://naterimc.app.n8n.cloud/webhook/odc-pacing-data`), which runs `SELECT * FROM budget.pacing_api`, enriches each row with `mondayClientId`, and returns JSON. The browser computes status / variance / pacing in JS. There is no pre-generated JSON file, no export script, and no GitHub Action in the live path.

**Why:**
- Live read means the dashboard reflects the current state of `pacing_api` (and thus the latest scheduled-query refresh) without a separate export/commit/deploy cycle.
- It removes the static-JSON maintenance burden and the daily zombie commit the old Action produced.
- n8n already hosts the Tickets webhook, so the pattern and infra already existed.

**Consequences / risks:**
- The dashboard now depends on Nate's n8n cloud instance (`naterimc.app.n8n.cloud`) being up and not serving cached data. This is a single point of failure outside our GCP project. (PENDING P-CARRY-01 tracks moving n8n.)
- The webhook does a bit more than a raw `SELECT *` — it joins/enriches `mondayClientId`. That logic lives in n8n, not in BigQuery, so it's not visible in the repo. Anyone debugging "why does the dashboard show X" must check both `pacing_api` **and** the n8n flow.
- The production HTML is uploaded by Nate outside the repo's auto-deploy, so the repo copy can (and did) go stale. Reconcile per PENDING P-TECH-02. This is the same "source not in git" hazard that caused pain on 05-01 — worth closing.

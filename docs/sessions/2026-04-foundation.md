# Session — Foundation (March–April 2026)

> **Note:** This is a condensed migration of pre-May work from the legacy Monday.com bitácora. Not a literal day-by-day log. Detailed history (in Spanish) is in Monday doc IDs `39619258` and `42308796`.

## Project genesis

- **March 2026:** CEO Dan Rutledge approved the Cortex OS project.
- Sebas (Technical Lead) and Daniel Peña (Data Engineer, freelance) staffed.
- Nate Rutledge identified as primary stakeholder and product owner.

## Initial vision

Cortex OS started as a "data intelligence tool" for the marketing operations team. By April it had been re-scoped (pivot driven by Nate) into a broader operating system with four modules:

1. **Cortex Intelligence** — BigQuery pipelines + dashboards for AMs and leadership.
2. **Cortex Ops** — chatbots and internal process automation.
3. **Cortex Automation** — Google Ads API + n8n workflows replacing legacy scripts.
4. **Cortex Client** — future customer portal (Phase 5).

The Ad Spend Pacing module that went live on 2026-05-27 falls under Cortex Intelligence.

## Infrastructure foundations established

- GCP project `rightidea-cortex` created (number `427224510681`).
- BigQuery datasets defined: `raw_google_ads`, `raw_budget`, `reference`, `transformed`.
- Master MCC `611-819-8619` linked to a daily Data Transfer Service job, writing to `raw_google_ads`.
- Initial `client_mapping` table built in `reference` with ~70 ODC accounts.
- n8n self-hosted instance set up at `naterimc.app.n8n.cloud`.

## Key architectural correction (Nate, April)

The pacing pipeline initially merged static reference data (client identity, vertical, market) and dynamic budget data (monthly forecasts) into a single source. Nate explicitly separated these:

- Static reference → `reference.client_mapping`.
- Dynamic budgets → `raw_budget.planner_sheet` (external table on an AM Planner Google Sheet).

The budget pacing view was rewritten as a three-way JOIN. This separation is permanent design.

## Scripts and pipelines built in this period

- Google Apps Script + Looker Studio pipeline for normalizing advertising spend across channels.
- Multiple bug fixes around date parsing (Spanish month abbreviations, `new Date(string)` unreliability), and pacing logic with negative rollover.
- Sebas's working preference established: deliver fully-corrected scripts rather than incremental patches.

## What was wrong with the early design (later corrected)

- A "monthly rollover" budget was synthesized to make under-spending months affect next-month budget. This inflated current-month budgets and produced false-positive on-track classifications.
  - **Corrected in May 2026** when the new `ODC Forecast - 2026 LIVE` planner introduced an annual `leftover_anual` column. See [ARCHITECTURE.md ADR-005](../ARCHITECTURE.md#adr-005).
- The `client_mapping` JOIN was used in the pacing pipeline. Nate later rejected this as architectural overreach.
  - **Corrected in May 2026** by removing the JOIN. `client_mapping` is now only used outside pacing.

## Open work at end of April

- Looker Studio dashboard was the initial dashboard target.
- Nate later (May) rejected Looker in favor of custom HTML on a dedicated domain — which became the Cloudflare Pages pattern Nate later built and we joined in May 2026.

---

**Driver of this session log:** Claude (Sebas's work account), migrating from Monday on 2026-05-27.

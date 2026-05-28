# Cortex OS — Learnings

> **Purpose:** mistakes we already made, so no future instance burns hours making them again. Each entry should be short (1-3 sentences) plus a "what to do instead" line.

> **When to add:** append to this file whenever a session ends with a "we should have known this" realization. If it's just a normal bug fix with no transferable lesson, it goes in the session log, not here.

---

## L-001: Schema-first. Always.

**Mistake:** Wrote queries assuming column names from memory or pattern-matching from other tables. Wasted multiple iterations on `date` vs `spend_date`, `year` not existing in `budgets_normalized`, etc.

**Rule:** Before writing any SQL that touches a table or view not verified in the current session, run `INFORMATION_SCHEMA.COLUMNS` first. No exceptions.

---

## L-002: External tables on Google Sheets need explicit Drive scope

**Mistake:** Service account had BigQuery admin and was shared as Viewer on the Sheet, but the export script still got `403 Permission denied while getting Drive credentials`.

**Why:** The default Python BigQuery client only requests `cloud-platform` OAuth scope. To read a Sheet-backed external table, the client must explicitly request the `drive` scope at credential construction time.

**Rule:** When authenticating via SA JSON key for a query that touches Sheet-backed external tables:

```python
credentials = service_account.Credentials.from_service_account_file(
    path,
    scopes=[
        "https://www.googleapis.com/auth/bigquery",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/cloud-platform",
    ],
)
client = bigquery.Client(credentials=credentials, project=...)
```

See `export_pacing_data.py` for the canonical implementation.

---

## L-003: Workspace OAuth blocks user-account access to Drive scopes

**Mistake:** Tried `gcloud auth application-default login --scopes=...drive...` from a `@rightideacreative.net` user account. Google blocked the app with "This app is blocked".

**Why:** The Workspace admin has restrictions on third-party apps requesting sensitive scopes. gcloud CLI is treated as a third-party app.

**Rule:** Never authenticate user accounts for Drive-scoped operations. Use a service account instead. SAs are not subject to Workspace OAuth restrictions.

---

## L-004: Check what teammates already built before designing infrastructure

**Mistake:** Spent ~3 hours building Cloud Run + Flask + Docker for a dashboard that ultimately deployed to Cloudflare Pages. Nate had already established the static-site pattern. We didn't look.

**Rule:** Before proposing infrastructure for a feature that connects to another module, **clone the existing module's repo and read it.** Match patterns where possible. Diverge only with explicit justification.

---

## L-005: Filtered VIEWs hide upstream data quality issues

**Mistake:** `other_channels_normalized` filters `WHERE Date IS NOT NULL`, which silently dropped ~2,348 rows of malformed sheet data. The downstream dashboard showed "Bing has no data" instead of "Bing has 124 broken rows."

**Rule:** Any defensive WHERE in a view that filters out source rows should be accompanied by a visible metric (a count, a freshness check, or a separate "QA" view) that surfaces the suppressed rows. Otherwise the filter quietly papers over real problems.

---

## L-006: AM Over-reported is not always real mis-reporting

**Mistake:** Treated 157 rows of "BQ shows $0 but AM reported $X" as proof that AMs were inflating numbers. Verified manually: the AM data was correct; BQ had a coverage gap from MCC unlink/relink history.

**Rule:** Before raising "discrepancy" alarms, separate three orthogonal axes:
1. **Data presence** — does BQ even have data for this period × account?
2. **Pacing** — assuming data is present, is spend tracking budget?
3. **Capture accuracy** — assuming data is present, does AM-reported match BQ?

The pacing pipeline now expresses these as `bq_data_available`, `status`, and `capture_accuracy_ratio` independently.

---

## L-007: Re-use existing service accounts before creating new ones

**Mistake:** Created `cortex-pacing-gha` SA, hit a propagation lag, got "Invalid service account" errors trying to grant roles. Lost 15 minutes. Eventually reused `cortex-bigquery` which already had the needed permissions.

**Rule:** Before creating a new SA, list existing SAs with `gcloud iam service-accounts list` and check whether one already has the required roles. Re-use when reasonable; create new only when isolation matters.

---

## L-008: Don't paste blocks with shell-illegal characters into Terminal

**Mistake:** Pasted instructions including `# Commented lines (in parentheses with `(reemplaza)`)` directly into zsh. Parens broke parsing.

**Rule:** When providing multi-line instructions, separate the *commentary* (instructions for the human) from the *commands* (lines safe to paste). Or use heredocs / `cat > file <<EOF`.

---

## L-009: macOS Finder shows localized folder names but the filesystem uses English

**Mistake:** Tried `ls ~/Descargas/` because Finder showed "Descargas". Failed because the real directory is `~/Downloads/`.

**Rule:** Always use English directory names in shell paths on macOS regardless of Finder's display language: `Downloads`, `Desktop`, `Documents`, `Pictures`, `Movies`, `Music`, `Public`, `Library`.

---

## L-010: Bitácora discipline matters more than tooling

**Observation, not a single mistake:** The Monday.com doc that served as a bitácora for 3 months worked because someone wrote in it. The shared-brain folder in this repo will work only if every session commits an update. The format is secondary; the discipline is primary.

**Rule:** At end of every session, **before closing**, complete the end-of-session protocol from `README.md`. If it's not committed, it didn't happen.

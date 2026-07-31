# Session 2026-07-30 — Pacing dashboard fixes (analyst report) + Norfolk split + structural findings

> Long session. Two things happened: (1) fixed 10 pacing-dashboard issues reported by
> the analysts, shipped to production; (2) fixing Norfolk (issue 5) opened a much bigger
> door — the committed-budget migration from Sheet to the Budget Editor is only ~23%
> done, and committed vs actual use two different client-identity mechanisms. Those two
> structural findings are the real headline; the dashboard fixes are the visible work.

## Context

The analysts had been using the pacing dashboard (`/ad-spend-pacing`) in production and
reported 10 issues. Method agreed: fix one at a time with verification, deliver the full
HTML file to download+replace (not patches — heredocs bit us in prior sessions), push
once at the end (Option B — never touch production mid-session while analysts are using
it), then register everything here.

Also carried in from the prior session: the Identity Phase 3 Share Brain update
(ADR-013, ADR-014, L-024) had been prepared but **never applied**. This session's
registration applies that too (Commit 1 below).

## The 10 issues and how they were resolved

All frontend work is in `ad-spend-pacing.html`. The key architectural fact: `pacing_api`
(the view) does NOT compute status or the correction-adjusted target — both are computed
in the frontend JS. So most of the report was fixed in the HTML, not in BigQuery.

1. **[CORE] Status measured against committed, not the correction-adjusted target.** The
   status pill used raw `m.committed`. Buffalo showed "Overspending" ($2,710 vs committed
   $2,750) when its real target with catch-up was $3,765 — actually *under*spending. Fixed
   with a new `accountStatus(client)` helper that measures against `committed + catchup`
   (the target). Applied at all four call sites: on-track count, overview pill, pacing
   filter, detail pill. Bonus coherence fix: the overview's Variance and Pacing columns
   now also measure against the target, so the whole row tells one story (before, Pacing
   said 99% while Status said something else).

2. **[CORE] New Target column.** Added `Catch-up` and `Target` columns to the per-channel
   table. Narrative order: Committed → Catch-up → Target → Actual → Variance → Pacing.
   Per-channel target = committed + that channel's share of the catch-up (split by
   committed weight via existing `shareCatchup()`). Committed stays as the reference
   figure; Target is the new rollover-adjusted number the analysts asked for. (Note: this
   is a *new column alongside* committed, not a replacement — Sebas initially read it as
   "committed should show the adjusted number"; clarified.)

3. **Month-switch inside a client returned to overview.** `asofSel.onchange` always called
   `renderOverview()`. Added `CURRENT_CLIENT` state (null = overview, string = client);
   the month selector now re-renders the view you're actually in. Set at both entry points
   (`renderOverview` → null, `renderClient` → client).

4. **Color scale — "Moderate Overspending" was green.** `.p-dang-mod`/`.c-dang-mod` were
   green (copied from the on-track style). Fixed to light red. Also refined the whole
   scale for coherence: over = red family (full > moderate intensity), under = amber/
   orange family, on-track = green. So color encodes direction (over/under) and severity
   (full/moderate) at a glance.

5. **[DATA] Norfolk pulling both Norfolks' budget.** See the dedicated Norfolk section
   below — this is where the session went deep.

6. **[CORE] Per-channel status removed.** A per-channel status verdict is noise (channel
   committed isn't a real per-platform budget; a channel spending with no budget marked
   "Overspending" while the account was fine). Removed the Status column from the
   per-channel table; the status now lives only at the account level (the pill in the
   detail head). Channel chips in the *overview* stay colored (diagnostic, not alerts),
   with tooltips + a fixed note explaining the distinction: **status = account verdict,
   chips = per-channel diagnostic. Budget is fungible across channels, so a channel can
   run hot/cold without the account being off track.**

7. **Actual = Spent MTD.** Not a bug — for the current month they're the same number by
   definition (both are the month's spend). Tied to issue 9. No code change.

8. **Rec. $/day didn't count today.** `dailyRec()` divided by `DIMS.days_remaining`
   (= `days_in_month - days_elapsed`, which excludes today). Today is still a spendable
   day; added `+1` to the divisor. Also fixes the last-day-of-month case. NOTE: if actual/
   spent_mtd ever migrates to "through yesterday" (issue 9), this needs revisiting.

9. **[DECISION — DEFERRED] Actual real-time vs through-yesterday.** The analysts want
   spend-through-yesterday for pacing (today is incomplete, distorts the number). This is
   a metric-definition change that touches the BQ view AND has chain effects (days_elapsed
   consistency, spent_mtd, and it interacts with the issue-8 `+1`). **Deferred to a
   decision with Nate + the analysts** — not shipped. Tracked as P-DESIGN-01.

10. **Multi-platform rec/day split criterion.** Not a bug — already splits by committed
    weight (`shareCatchup()`). Added a tooltip on the per-channel Rec/day header explaining
    it. Shipped.

**Tooltips:** added a reusable `.info` tooltip (info icon + `data-tip`). First cut clipped
inside the sticky table header (low z-index + `overflow:hidden` on `.panel`). Fixed to a
robust version: drops downward from the icon (headers sit near the top), `z-index:9999`
(clears sticky header + cells), right-aligned in `th.num` columns so it doesn't overflow
the right edge. All 6 tooltips (Channels, Status ×2, Target, Pacing, Rec/day) verified in
the browser before push.

**Shipped:** commits `aeb7b5b` (initial) and `fa5d8ef` (robust tooltips) on `main`.
Verified in production.

## Norfolk (issue 5) — the deep dive

**Symptom:** "ODC Norfolk" and "ODC Norfolk, VA" were mixing budget — one client's spend
falling under the other. Analysts' decision: rename to "ODC Norfolk, Virginia" (Google +
LSA) and "ODC Norfolk, Nebraska" (Meta only), and they said the platform names were
already changed.

**Root cause — the client name comes from the CROSSWALK, not the platforms.** Tracing
`actual_spend_all` → `spend_daily_unified` showed every channel block resolves the client
name as `COALESCE(x.canonical_client, "UNMAPPED...")` joined on `customer_id` against
`client_crosswalk`. So renaming the accounts in Google/Meta did nothing — the pipeline
reads the name from the crosswalk by `customer_id`, and both Norfolk `customer_id`s
(`6121123095` Google+LSA, `2303851373274229` Meta) mapped to the same "ODC Norfolk".
LSA shares Google's `customer_id`, so renaming Google's row carried LSA along
automatically — exactly the desired Virginia = Google+LSA split.

**Fix — two `UPDATE`s on the crosswalk** (all views, so it reflected instantly, no
pipeline to force):
```sql
UPDATE budget.client_crosswalk SET canonical_client="ODC Norfolk, Virginia" WHERE customer_id="6121123095";
UPDATE budget.client_crosswalk SET canonical_client="ODC Norfolk, Nebraska" WHERE customer_id="2303851373274229";
```
Actual spend separated immediately: Virginia = google_ads + lsa, Nebraska = meta.

**But the committed side did NOT follow** — because committed joins by client *name*, not
`customer_id`. And its two halves came from two different sources: Virginia's committed
was in `budget_events` (the editor) as "ODC Norfolk, VA" (Aug–Dec, $2,750); Nebraska's
committed was in the Sheet (`committed_budget_live`) as "ODC Norfolk" (Meta, $413/$813 by
month). The editor has no rename/tombstone function, so the fix was to **Add budget line**
in the Budget Editor with the correct new names:
- ODC Norfolk, Virginia / google_ads / Aug–Dec / $2,750
- ODC Norfolk, Nebraska / meta / three tranches ($413 Jan–Feb, $813 Mar–Jun, $413 Jul–Dec)

Verified via `pacing_api`: Virginia and Nebraska now carry committed AND actual under the
same name. **Norfolk functionally closed.**

**Residue (documented as P-OPS-10):** two ghosts remain — "ODC Norfolk" (Sheet) and
"ODC Norfolk, VA" (old event) still show committed with $0 actual (old names the crosswalk
no longer produces). Harmless but visible; cleanup needs a tombstone on the old event +
removing the Sheet row. Also, Virginia's LSA has actual but no committed (P-OPS-03 family).

## The two structural findings (the real headline)

Fixing Norfolk forced tracing the committed pipeline end to end, which surfaced two things
bigger than Norfolk:

### Finding 1 — the Sheet→Editor migration is only ~23% done, and the Sheet is still live
`budget_base_current` = `COALESCE(latest_events, committed_budget_live)` — the Budget
Editor (`budget_events`) has priority, the Sheet is the fallback. A `COUNT` by `source`:
- **event** (editor): 20 clients, 142 rows
- **sheet** (Google Sheet): **67 clients, 1075 rows**

So 77% of clients still get their committed budget from the old Sheet, which is very much
alive (refreshed daily 05:00 by `committed_budget_live_refresh` from `raw_budget.committed_budget_long`).
Sebas's mental model was "the Sheet is obsolete, AMs edit in Cortex" — the data says the
opposite. Acting on that premise (e.g. dropping the Sheet from the `COALESCE`) would have
broken 67 clients' committed budget. **Measuring first (one COUNT query) completely changed
the correct response.** Tracked as P-TECH-19.

### Finding 2 — committed and actual use different client-identity mechanisms
- **Actual** joins by `customer_id` → crosswalk → name. Robust; renaming is one crosswalk row.
- **Committed** carries the client *name* as free text (written in the Sheet or in an event).
  Fragile; renaming means touching the Sheet + events + tombstones, in multiple places.

This dual identity is the root cause of Norfolk desyncing, and it will recur with the next
client that shares a name. The fix of record: resolve committed by `customer_id` against the
crosswalk too, so there's a single source of client identity. Tracked as P-TECH-20 (related
to the pre-existing P-CARRY-04). **These two (P-TECH-19, P-TECH-20) are the #1 structural
priority for Cortex now — their own dedicated session, not a mid-session patch.**

## Method notes for future sessions
- **Measure before reacting.** "This is a huge problem, fix it now" on an un-measured
  premise is the dangerous move — see Finding 1. One COUNT query saved 67 clients. (L-026.)
- **The file-download flow bit us again:** a stale cached download in `~/Downloads` got
  moved to the repo instead of the fixed file (grep showed 744 lines / no fixes). Fixed by
  `rm`-ing Downloads first, then verifying the **md5** of the downloaded file against the
  generated one before `mv`. Adopt md5-verify-before-move as standard.
- Don't assume where a value comes from — trace the DDL. Norfolk was solved only by reading
  `spend_daily_unified` and `budget_base_current` DDLs instead of assuming the "Planner
  sheet" was the source.

## Deferred / follow-up
- P-DESIGN-01: issue 9 (actual real-time vs yesterday) — decision with Nate + analysts.
- P-OPS-10: clean up the two Norfolk ghosts.
- P-TECH-19: complete Sheet→Editor committed migration (67 clients).
- P-TECH-20: unify client identity (committed by customer_id).
- LSA-for-Virginia has no committed budget (P-OPS-03 family) — decide whether to assign one.

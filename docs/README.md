# Cortex OS — Shared Brain

> **For any AI assistant (Claude, agent, or otherwise) reading this for the first time: start here.**

This folder is the persistent memory of Cortex OS, the internal operations platform of Right Idea Media & Creative. It is read and written by multiple Claude instances (Sebas's personal and work accounts, Nate's personal and work accounts) plus programmatic agents (n8n flows, MCP servers, scripts). It exists so that anyone — human or AI — picking up work mid-stream has full context in under 5 minutes.

## Language policy

**All documentation, code, comments, commits, and files in this repo are in English.** Humans on the team communicate in Spanish, English, or both — but written artifacts are always English so any agent or future teammate can read them.

## How to use this folder

If you are a Claude instance or an agent **starting a new session on Cortex OS**, read these in this order:

1. **[STATE.md](./STATE.md)** — what exists right now, where it lives, what's working. The "map" of the system. ~5 min read.
2. **[PENDING.md](./PENDING.md)** — what's open, blocked, or waiting. Don't propose things already on this list. ~2 min.
3. **[LEARNINGS.md](./LEARNINGS.md)** — mistakes already made and how to avoid them. Saves hours. ~5 min.
4. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — design decisions and why. Read sections relevant to what you're about to touch. ~10 min selective.
5. **[sessions/](./sessions/)** — chronological log. Read only the **last 2-3 sessions** to know what happened recently. Older sessions are reference only.

Total bootstrap time: ~15 minutes for full context, ~5 minutes for "what's the state and what's pending" only.

## How to update this folder

**Every session that produces a meaningful change must update the brain at the end.** This is non-negotiable — if it isn't written, it doesn't exist, and the next instance will repeat your work.

End-of-session protocol (in order):

1. Create `sessions/YYYY-MM-DD-slug.md` with what happened. Slug should be a short kebab-case description (e.g. `2026-05-27-dashboard-live.md`).
2. Update `STATE.md` if anything about the current state changed (new module, new URL, new SA, new VIEW, etc.). STATE is a snapshot of *now*, not a log — rewrite affected sections, don't append.
3. Update `PENDING.md`: add new pending items, **delete** resolved ones. Resolved items live in the session log, not in PENDING.
4. If the session produced a new lesson (something that future instances should never get wrong again), append to `LEARNINGS.md`.
5. Update `state.json` if STATE.md changed (mirror in machine-readable form).
6. Commit: `docs: session YYYY-MM-DD — <one-line summary>`.

**`ARCHITECTURE.md` is rarely updated.** Only when an explicit architectural decision is made (e.g. "we are migrating from X to Y"). Bug fixes and small features don't go there.

## Repo conventions for human collaborators

- Branch strategy: **direct push to `main`** for now. We're a tiny team; rebasing on pull keeps history clean. If we grow, we add branch protection.
- Commit prefix conventions:
  - `feat(<module>):` new functionality
  - `fix(<module>):` bug fix
  - `docs:` changes to `/docs/` only
  - `chore:` infra, deploy config, dependencies
- Module names in commits: `pacing`, `call-tracking`, `tickets`, `home`, `infra`, `docs`.

## Who works on this

| Name | Role | Primary instance | Secondary instance |
| --- | --- | --- | --- |
| Sebas Guzmán | Technical Lead | Claude work account (`sebas.guzman@`) | Claude personal |
| Nate Rutledge | Product / Stakeholder | Claude work | Claude personal |
| Dan Rutledge | CEO / Sponsor | — | — |

All four Claude instances above may read/write this folder. Sessions should be tagged with who was driving (e.g. "Driver: Sebas (work)"). Agents (n8n, scripts) write to `state.json` programmatically when they need to publish status.

## Quick links

- Live dashboard: https://cortex-cmv.pages.dev
- GitHub repo: https://github.com/right-idea-creative/cortex
- GitHub Actions: https://github.com/right-idea-creative/cortex/actions
- GCP project: `rightidea-cortex` (`427224510681`)
- BigQuery dataset map: see [STATE.md](./STATE.md#bigquery)

## For programmatic agents

If you are an n8n flow, MCP server, or other script that needs to know the current state of Cortex OS without parsing prose:

```bash
curl https://raw.githubusercontent.com/right-idea-creative/cortex/main/docs/state.json
```

That file is structured JSON and is updated whenever STATE.md changes. Treat it as the source of truth for system state at refresh-cadence (currently daily).

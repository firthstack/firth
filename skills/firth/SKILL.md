---
name: firth
description: Use when working in a Firth-managed project (a `.firth/` dir or the `firth` CLI) — creating/switching/promoting branches, deploying to a branch's URL, wiring `firth secrets`, running multiple agents each in their own isolated branch/env, or merging a branch to main.
---

# Firth

Firth provisions and governs a project's cloud resources behind one CLI and one credential seam — the CLI talks **only** to the Firth control plane; you never configure a cloud backend directly. Every project gets three resources you build **directly** against:
- **Postgres** (Neon) — relational DB.
- **S3-compatible storage** (Tigris) — object/blob storage.
- **Compute** (Fly.io) — your container at `https://<app>.fly.dev`.

**Setup:** `firth login --email <e> --password <p>` → `firth project create <name>` (provisions all three) or `firth project link <id>`. You land linked (`./.firth/project.json`) on branch `main`. `firth status` shows login + linked project + current branch. `firth secrets` writes all three resources' credentials into `./.env` for local dev.

## Core principle
**One unit of work = one branch = one isolated env.** `firth branch create` gives each feature, experiment, or agent task its own Neon DB branch + its own copy-on-write storage bucket (both copy-on-write forks of the parent's data); its own compute + URL spin up on its first `firth deploy`. All run in parallel. **Don't develop on `main`; don't pile multiple features on one branch.**

**Multiple independent features (or agent tasks) at once?** Give each its own branch **and its own subagent** — with an isolated DB + compute + URL per branch, they build, deploy, and test fully in parallel with zero collision. This is the recommended way to parallelize agent work — see **workflow.md → Running multiple agents in parallel**.

## Where to go
- **Doing the work** → read **workflow.md**: the branch loop, running parallel agents (a worktree + firth branch each), promoting a branch to main (merge → migrate → validate), and the deploy gotchas that bite (e.g. never gate container boot on migrations; the transient first-deploy 500).
- **Command lookup** → read **cli-reference.md**: the full CLI command catalog, the two deploy modes, Dockerfile templates, and the govern/observe commands.

## Two non-negotiables (wherever you are)
- Treat `./.env` (from `firth secrets`) as the **only** credential source — never hardcode or print secret values. `DATABASE_URL` + compute + storage (`AWS_*`/`BUCKET_NAME`) are all **per-branch**: each branch gets a copy-on-write fork of its parent's bucket, so writes/deletes on a branch never touch the parent. (Projects created before storage forking keep one **shared** bucket — no isolation.)
- Track **every** schema change as a file under `migrations/` so it replays on a branch DB and again on `main` after a merge (Firth never merges databases — only migration files carry schema forward).

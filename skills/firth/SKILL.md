---
name: firth
description: Use when working in a project managed by Firth — provisioning DB/storage/compute, creating/switching/merging branches, deploying, checking status, or wiring app secrets via the firth CLI.
---

# Firth

Firth provisions and governs a project's cloud resources behind one CLI and one credential seam. The CLI talks **only** to the Firth control plane; you never configure a cloud backend directly.

## Resources Firth provisions
Every project automatically gets three base resources — build your app directly against them:
- **Postgres database** (Neon) — your app's relational DB.
- **S3-compatible storage** (Tigris) — object/blob storage.
- **Compute** (Fly.io) — where your container runs.

`firth secrets` writes the connection credentials for all three into `./.env`.

## Setup
- `firth login --email <e> --password <p>` — sign in. Add `--api-url <url>` to target a non-local control plane; it persists for later commands.
- `firth status` — login state, linked project, current branch.
- `firth --version`.

## Workflow
1. **Create or link a project** — you end up linked (`./.firth/project.json`) and on the default branch `main`:
   - `firth project create <name>` — provisions DB + storage + compute.
   - `firth project link <id>` — link an existing project.
2. `firth secrets` — write the current branch's credentials into `./.env`. **This is how an agent gets DB/storage access.** (`--branch <id>` targets a specific branch.)
3. `firth deploy --image <url>` — deploy a container image to the project's compute (`--port`, `--from`).
4. `firth events` — the action ↔ resource-side-effect timeline (`--branch`, `--limit`).

## Database & migrations
You connect **directly** to the Postgres database (the `DATABASE_URL` from `firth secrets` — there is no ORM/abstraction in front of it). Keep a **`migrations/` directory at the project root** to store and track your database migration files, so schema changes are versioned and reproducible — this is essential for applying the same schema to a branch DB and re-applying it on `main` after a merge.

## Branching — isolate risky changes
Before a high-risk change (schema migration, data backfill, risky refactor), do the work on a **branch**, verify it, then merge back to `main`.

- `firth branch create <name>` creates an **isolated Neon DB branch** — a full copy of the parent's data, isolated from `main` — and gives it its own `DATABASE_URL`.
  - **Storage and compute are NOT branched.** The storage bucket is **shared** across branches. Compute is the project's **single shared app** (redeploy-to-restore) — to bring up the branch's environment, **redeploy your branch's code** to it (`firth deploy`). Because the compute is shared, deploying a branch redeploys that one app to the branch's code, so only one branch's app runs at a time.
- `firth branch switch <name>` then `firth secrets` → `./.env` now has the branch's `DATABASE_URL`. Run your migrations against the branch DB and deploy → an isolated branch environment to validate the change.

### Merging a branch back to main
Firth does **not** auto-merge — you do it in your local code repo:
1. Merge the branch's frontend + backend **code** into `main`.
2. Merge the branch's **migration files** into `main`'s `migrations/`.
3. Switch to main: `firth branch switch main` → `firth secrets`.
4. Re-run the DB **migrations** against `main`'s database, then **re-deploy** compute: `firth deploy`.

## Delete (destructive — require `--yes`)
- `firth project delete --yes` — tears down ALL resources (Neon DB, Fly app, Tigris bucket) and unlinks the directory.
- `firth branch delete <name> --yes` — tears down the branch's Neon branch. The default branch can't be deleted.

## Rules for agents
- Treat `./.env` as the **only** source of resource credentials — run `firth secrets` to populate it; never hardcode credential values or print them.
- `DATABASE_URL` is isolated **per branch**; storage credentials (`AWS_*` / `BUCKET_NAME`) are **shared** across branches.
- Track all DB schema changes as files under `migrations/` so they can be replayed on a branch DB and on `main` after merge.
- The CLI auto-installs `flyctl` (via Homebrew) when missing during project/branch commands, so the Fly app is manageable directly if needed.

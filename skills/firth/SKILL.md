---
name: firth
description: Use when working in a Firth-managed project (a `.firth/` dir or the `firth` CLI) — creating/switching/promoting branches, deploying to a branch's URL, wiring `firth secrets`, running multiple agents each in their own isolated branch/env, or merging a branch to main.
---

# Firth

Firth provisions and governs a project's cloud resources behind one CLI and one credential seam. The CLI talks **only** to the Firth control plane; you never configure a cloud backend directly.

## Resources Firth provisions
Every project automatically gets three base resources — build your app directly against them:
- **Postgres database** (Neon) — your app's relational DB.
- **S3-compatible storage** (Tigris) — object/blob storage.
- **Compute** (Fly.io) — where your container runs, at `https://<app>.fly.dev`.

`firth secrets` writes the connection credentials for all three into `./.env`.

## Setup
- `firth login --email <e> --password <p>` — sign in (`--api-url <url>` targets a non-local control plane; persists).
- `firth status` — login state, linked project, current branch.

## Workflow
1. **Create or link a project** (you end up linked in `./.firth/project.json`, on branch `main`):
   - `firth project create <name>` — provisions DB + storage + compute.
   - `firth project link <id>` — link an existing project.
2. `firth secrets` — write the current branch's credentials into `./.env`. **This is how an agent gets DB/storage access.**
3. `firth deploy <dir> --port <n>` — build the `Dockerfile` in `<dir>` on Fly's remote builder (no local Docker) and run it on the **current branch's** compute. Prints the branch URL on success.
4. `firth events` — the action ↔ resource-side-effect timeline.

## Database & migrations
You connect **directly** to Postgres (the `DATABASE_URL` from `firth secrets` — no ORM in front of it). Keep a **`migrations/` directory** at the project root with versioned migration files. This is non-negotiable for the branch workflow: the same files are replayed on a branch DB and again on `main` after a merge (Firth never merges databases — see **Promote**). A small idempotent runner that applies pending `migrations/*.sql` (tracked in a ledger table) and runs on startup works well — but see Gotchas about **not blocking boot**.

## Deploying your app
Firth compute is a **container** on Fly.io — **one container per branch**, one port, at `https://<app>.fly.dev`.

```
firth deploy <dir> --port <n>          # SOURCE (preferred): Firth builds the Dockerfile in <dir> remotely
firth deploy --image <url> --port <n>  # IMAGE: deploy a pre-built / already-pushed image
# both target the CURRENT branch's compute; --from <branch> targets another; the URL prints on success
```

**Secrets are injected for you.** At deploy time Firth decrypts the branch's creds (`DATABASE_URL`, `AWS_*`, `BUCKET_NAME`, …) into the container as **environment variables**. Read them from the environment in production — `./.env` (from `firth secrets`) is for *local* dev only; never bake it into the image.

A minimal backend Dockerfile (reads creds from env, listens on `--port`):
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```
`firth deploy . --port 8080`. For full-stack, ship frontend + backend as **one container, one port** (backend serves the built frontend) — a branch serves one app on one port.

## Branching — the default unit of work
A Firth branch is a complete **isolated environment**: `firth branch create <name>` provisions a new **Neon DB branch** (copy-on-write copy of the parent's data, own `DATABASE_URL`) **and its own dedicated compute** (own Fly app + URL). Only the storage bucket is shared. Branches run **fully in parallel** — nothing one does touches another.

**Branch per unit of work — not only for "risky" changes.** Every feature, experiment, fix, or agent task should get its own branch + env. Cheap, instant, isolated environments are the whole point of Firth — don't pile multiple features onto one branch, and don't develop directly on `main`.

Per-branch loop:
1. `firth branch create feat-x` — isolated DB + compute. (Does **not** auto-switch you.)
2. `firth branch switch feat-x` — sets the current branch (per-directory, in `./.firth/project.json`).
3. `firth secrets` — writes feat-x's `DATABASE_URL` etc. into `./.env`. (DB + compute are per-branch; storage is shared.)
4. Build, then `firth deploy . --port <n>` — deploys to feat-x's own compute; **the command prints feat-x's URL**.
5. **Test against that URL directly** — it's public HTTPS, no tunnel. Exercise the real endpoints (sign up, hit the feature, check auth gates) against the live branch.

### Running multiple agents in parallel (encouraged)
Firth's per-branch isolation makes parallel agent development the natural mode: give **each agent its own git worktree + its own firth branch**, and they build, deploy, and test concurrently with zero collision — each gets its own code copy, its own DB, and its own URL.

**REQUIRED SUB-SKILLS:** use superpowers:using-git-worktrees to make a worktree per task, and superpowers:dispatching-parallel-agents to run them at once.

Bind each worktree to a firth branch **before** dispatching the agent:
```
git worktree add -b feat-x ../proj-feat-x main      # isolated CODE copy on its own git branch
cd ../proj-feat-x
firth branch create feat-x && firth branch switch feat-x && firth secrets   # isolated DB + compute + creds
```
Then dispatch one subagent per worktree. Tell each agent to: work only in its worktree dir, implement its feature, `firth deploy`, **capture the printed URL and test against it**, then open a PR. The mapping is **1:1:1 — task ↔ git worktree ↔ firth branch (env)**. The worktree isolates code; the firth branch isolates data + compute. They are separate layers — create both.

## Promote a branch to main (merge → migrate → redeploy → validate)
Firth does **not** merge databases — there is no DB-level merge, by design (diverged Postgres state can't be safely 3-way merged). Promotion happens in **git + migration replay**:

1. **Merge the code in git.** Merge the branch into `main`. **Expect conflicts** when parallel branches edited the same files (shared route handlers, types, UI) — resolve by **combining** the changes; parallel features are usually additive. Migration *files* merge cleanly **if each has a unique name** (see Gotchas about numbering).
2. **Verify the merged code builds** before deploying — a broken merge wastes a slow remote build.
3. **Switch + redeploy main:** `firth branch switch main` → `firth secrets` → `firth deploy`. On boot your migration runner replays the **new** migration files against **main's** database. The branch DBs are never touched — the migration *files* carry the schema to main.
4. **Validate on main's URL.** Hit the main URL and confirm every merged feature works against main's data — promotion isn't done until you've checked the live result.
5. `firth branch delete <name> --yes` — tear down the promoted branch's env (its Neon branch + Fly app) once merged.

## Gotchas (learned from real deploys — read before deploying)
- **Never gate container startup on migrations.** A `CMD` of `migrate && server` means a hung or failing migrate **prevents the server from ever starting** — the deploy "succeeds" but the URL just times out, with no error in the logs. Run migrations **non-blocking**: `timeout 30 <migrate> || echo skipped; <start-server>`, or as a separate step.
- **`firth deploy`'s first attempt often returns `500 internal error`** at the launch step — *after* the image builds + pushes successfully. It's a transient control-plane error and is **worse under parallel deploys**. No machine is created on failure (safe to retry). Retry with the printed image ref: `firth deploy --image registry.fly.io/<app>:<tag> --port <n>` (repeat a few times if needed).
- **Capture and use the deploy URL.** `firth deploy` prints `→ https://<app>.fly.dev` — grab it and test against it directly. If your app needs to know its own URL (e.g. an auth base URL), derive it at runtime from Fly's `FLY_APP_NAME` env var so the **same image works on every branch**.
- **Migration filenames must be unique across branches.** Two parallel branches both adding `003_*.sql` both apply on main (different filenames) but the duplicate ordinal is confusing — prefer timestamped or coordinated names.
- **`branch create` does not switch you;** run `firth branch switch <name>` then `firth secrets` to actually point at the new env.

## Govern & observe
Controls for autonomous/parallel agents:
- `firth policy [set <action> <allow|deny|approve>]` — gate sensitive actions: `deploy`, `branch.delete`, `project.delete`, `secrets.read`. `approve` = **require a human**: the action returns `approval_required`; a human runs `firth approve <id>`, then you **re-run** it (one-shot). `project.delete` is gated by default.
- `firth approvals` · `firth approve <id>` · `firth deny <id>` — manage pending gates.
- `firth events [--branch <id>] [--limit <n>]` — timeline of agent actions ↔ resource side-effects (branch creates, deploys + URLs). `firth observe sync` uploads local agent-action audit logs (`.firth/audit.jsonl`) into the same timeline.

## Delete (destructive — require `--yes`)
- `firth project delete --yes` — tears down ALL resources and unlinks the directory (gated by policy by default).
- `firth branch delete <name> --yes` — tears down the branch's Neon branch **and** its Fly app. The default branch can't be deleted.

## Rules for agents
- Treat `./.env` as the **only** source of resource credentials — run `firth secrets` to populate it; never hardcode or print credential values.
- `DATABASE_URL` **and compute** are isolated **per branch**; storage (`AWS_*` / `BUCKET_NAME`) is **shared** across branches.
- Track every schema change as a file under `migrations/` so it replays on a branch DB and on `main` after merge.
- One unit of work = one branch = one env. Prefer a branch (and, for parallel work, a subagent in its own worktree) over working on `main`.

# Firth workflow: branch → build → deploy → test → promote

Read this when developing in a Firth project. For command syntax/flags and Dockerfile templates, see `cli-reference.md`.

## Branching is the default unit of work
`firth branch create <name>` provisions a complete **isolated environment**: its own Neon DB branch (copy-on-write copy of the parent's data, own `DATABASE_URL`) + its own dedicated compute (own Fly app + URL) **provisioned on its first `firth deploy`** (a branch is DB-only until then). Only the storage bucket is shared. Branches run **fully in parallel** — nothing one does touches another.

Per-branch loop:
1. `firth branch create feat-x` — isolated DB env (compute spins up on first deploy). **Does NOT auto-switch you.**
2. `firth branch switch feat-x` — sets the current branch (per-directory, in `./.firth/project.json`).
3. `firth secrets` — writes feat-x's `DATABASE_URL` etc. into `./.env`. (DB + compute are per-branch; storage is shared.)
4. Build, then `firth deploy . --port <n>` — deploys to feat-x's own compute; **the command prints feat-x's URL**.
5. **Test against that URL directly** — it's public HTTPS, no tunnel. Sign up, hit the feature, check auth gates against the live branch.

## Running multiple agents in parallel (encouraged)
Per-branch isolation makes parallel agent development the natural mode: each agent gets its **own git worktree + its own firth branch**, so they build, deploy, and test concurrently with zero collision.

The commands below are self-contained — no extra tooling required. *(Optional: if your coding agent has the **superpowers** skills, `superpowers:using-git-worktrees` and `superpowers:dispatching-parallel-agents` go deeper on the worktree/subagent mechanics — an enhancement, not a dependency.)*

Bind each worktree to a firth branch **before** dispatching the agent:
```
git worktree add -b feat-x ../proj-feat-x main      # isolated CODE copy on its own git branch
cd ../proj-feat-x
firth branch create feat-x && firth branch switch feat-x && firth secrets   # isolated DB + compute + creds
npm install                                                                 # fresh worktree has NO node_modules — install before the first build
```
> **Fresh-worktree gotcha:** `git worktree add` creates a clean checkout with **no `node_modules`** (it isn't shared from the main checkout). The first `npm run build`/`firth deploy` build step fails with `Module not found` until you `npm install` in the new worktree. Do it as part of worktree setup.
Then dispatch one subagent per worktree: work only in its dir, implement, `firth deploy`, **capture the printed URL and test against it**, open a PR. Mapping = **1:1:1 — task ↔ git worktree (code) ↔ firth branch (data + compute)**. Create both layers.

## Promote a branch to main (merge → migrate → redeploy → validate)
Firth does **not** merge databases — there is no DB-level merge (diverged Postgres can't be safely 3-way merged). Promotion happens in **git + migration replay**:
1. **Merge the code in git.** Expect **conflicts** when parallel branches edited the same files (shared routes, types, UI) → resolve by **combining** (parallel features are usually additive). Migration *files* merge cleanly if uniquely named.
2. **Verify the merged code builds** before the slow remote deploy.
3. **Switch + redeploy main:** `firth branch switch main` → `firth secrets` → `firth deploy`. On boot the migration runner replays the **new** migration files against **main's** DB. Branch DBs are never merged — the migration **files** carry the schema.
4. **Validate on main's URL** — promotion isn't done until the live result checks out.
5. `firth branch delete <name> --yes` — tear down the promoted branch's env (Neon branch + Fly app).

## Gotchas (read before deploying)
- **Never gate container startup on migrations.** A `CMD` of `migrate && server` lets a hung or failed migrate stop the server from ever starting — the deploy "succeeds" but the URL just times out, with nothing in the logs. Run migrations **non-blocking**: `timeout 30 <migrate> || echo skipped; <start-server>`.
- **If your app needs its own URL** (e.g. an auth base URL), derive it at runtime from Fly's `FLY_APP_NAME` so the same image works on every branch.
- **`--port` MUST equal the port your container actually listens on.** Fly routes external traffic to that internal port; if your server binds elsewhere the machine boots fine but every request fails with **`instance refused connection. is your app listening on 0.0.0.0:<port>?`** and the URL times out. Read the port from the image (`ENV PORT` / `EXPOSE` / your server's bind) and pass the **same** number — e.g. image has `ENV PORT=8080` → deploy with `--port 8080`. Also bind to `0.0.0.0`, never `127.0.0.1` (set `HOSTNAME=0.0.0.0` for Next.js standalone).

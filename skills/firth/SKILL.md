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
3. `firth deploy <dir>` — build the `Dockerfile` in `<dir>` on Fly's remote builder (no local Docker) and run it on the **current branch's** compute (`--port`; `--from <branch>` for another branch). `firth deploy --image <url>` deploys a pre-built image instead. See **Deploying your app**.
4. `firth events` — the action ↔ resource-side-effect timeline (`--branch`, `--limit`).

## Database & migrations
You connect **directly** to the Postgres database (the `DATABASE_URL` from `firth secrets` — there is no ORM/abstraction in front of it). Keep a **`migrations/` directory at the project root** to store and track your database migration files, so schema changes are versioned and reproducible — this is essential for applying the same schema to a branch DB and re-applying it on `main` after a merge.

## Deploying your app (frontend & backend)
Firth compute is a **container** running on Fly.io — **one container per branch**, exposed over HTTPS at `https://<app>.fly.dev` on the single port you choose. Two deploy modes:

```
firth deploy <dir> --port <n>          # SOURCE (preferred): Firth builds the Dockerfile in <dir>
                                        #   on Fly's remote builder — no local Docker, no registry
firth deploy --image <url> --port <n>  # IMAGE: deploy a pre-built image you pushed yourself
# both run on the CURRENT branch's compute; --from <branch> targets another; the URL prints on success
```

**Prefer source mode**: write a `Dockerfile`, point `firth deploy` at its directory, and Firth builds + launches it for you (the CLI auto-installs `flyctl`, which drives the remote build).

**Secrets are injected for you.** At deploy time Firth decrypts the branch's credentials (`DATABASE_URL`, `AWS_*`, `BUCKET_NAME`, …) and passes them into the container as **environment variables**. Read them from the process environment in production — do **not** bake `./.env` into the image (that file, from `firth secrets`, is for *local* development only).

### Backend
Containerize your server so it listens on the port you pass to `--port` and reads credentials from the environment:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]   # reads process.env.DATABASE_URL etc.
```
`firth deploy . --port 8080`  — Firth builds this Dockerfile and runs it on the branch's compute.

### Frontend (SPA)
Build the static assets, then serve them from a tiny static-server container. Rewrite unknown paths to `index.html` so client-side routing works:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build                 # produces ./dist

FROM caddy:alpine
COPY --from=build /app/dist /srv
# Caddyfile: `:80 { root * /srv; try_files {path} /index.html; file_server }`
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
```
`firth deploy . --port 80`

### Full-stack — one branch = one container + one port
A branch's compute serves **one app on one port**, so ship frontend + backend as a **single container** (one `Dockerfile`): have your backend serve the built frontend's static files (framework SSR, or copy the SPA's `dist/` into the server's static directory). One `firth deploy <dir>`, one URL, and the frontend can call the backend at the same origin. If you genuinely need separate frontend and backend services, host the static frontend on a dedicated static/CDN host and deploy only the backend container to Firth compute.

## Branching — isolate risky changes
Before a high-risk change (schema migration, data backfill, risky refactor), do the work on a **branch**, verify it, then merge back to `main`.

- `firth branch create <name>` provisions an **isolated environment** for the branch: a new **Neon DB branch** (a full copy of the parent's data, isolated from `main`, with its own `DATABASE_URL`) **and a new dedicated compute** (its own Fly app). **Only the storage bucket is shared** across branches.
  - Each branch has its own compute app, so multiple branches' environments run **in parallel** — working on one branch never disturbs another's. To rebuild the branch's running environment, **redeploy your branch's code** to its app (`firth deploy` targets the current branch's compute).
- `firth branch switch <name>` then `firth secrets` → `./.env` now has the branch's `DATABASE_URL`. Run your migrations against the branch DB, then `firth deploy` → the branch's isolated compute runs your branch code, an environment to validate the change.

### Merging a branch back to main
Firth does **not** auto-merge — you do it in your local code repo:
1. Merge the branch's frontend + backend **code** into `main`.
2. Merge the branch's **migration files** into `main`'s `migrations/`.
3. Switch to main: `firth branch switch main` → `firth secrets`.
4. Re-run the DB **migrations** against `main`'s database, then **re-deploy** compute: `firth deploy`.

## Delete (destructive — require `--yes`)
- `firth project delete --yes` — tears down ALL resources (Neon DB, Fly app, Tigris bucket) and unlinks the directory.
- `firth branch delete <name> --yes` — tears down the branch's Neon branch **and its Fly app**. The default branch can't be deleted.

## Rules for agents
- Treat `./.env` as the **only** source of resource credentials — run `firth secrets` to populate it; never hardcode credential values or print them.
- `DATABASE_URL` **and compute** are isolated **per branch**; storage credentials (`AWS_*` / `BUCKET_NAME`) are **shared** across branches.
- Track all DB schema changes as files under `migrations/` so they can be replayed on a branch DB and on `main` after merge.
- The CLI auto-installs `flyctl` (via Homebrew) when missing during project/branch commands, so the Fly app is manageable directly if needed.

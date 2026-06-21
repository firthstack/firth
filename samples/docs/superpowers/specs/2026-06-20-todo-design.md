# Firth Todo Sample App — Design

**Date:** 2026-06-20
**Status:** Approved (pending spec review)

## Goal

A **single-user, full-stack todo web app** that demonstrates building against Firth-provisioned
resources. One Node + Express process serves a vanilla HTML/CSS/JS frontend **and** a REST API,
connecting **directly** to the project's Neon Postgres via `DATABASE_URL`. The whole thing ships as
**one Docker image** to the current branch's Firth compute (a Fly container), exposed over HTTPS on a
single port — matching Firth's "one branch = one container = one port" model.

This is a **sample app** living under `samples/`, not a Firth-product feature. Its spec is kept here,
co-located with the sample, rather than in the repo-root product spec history.

## Non-Goals

- **No authentication / multi-user isolation.** Everyone who has the URL sees and edits the same
  shared todo list. This is the chosen scope; the consequence (anyone with the URL can edit) is
  knowingly accepted.
- No due dates, priorities, tags, or reminders (those were the "rich" tier; we build the "standard" tier).
- No client-side framework / build step (vanilla frontend, no React/Vite/Next).
- No separate frontend and backend services — single image, single origin.
- No Firth branch for this work — it's a fresh project's first table, zero risk, so we build on `main`.

## Architecture

```
Browser ──HTTPS──> Fly container (https://<app>.fly.dev)
                     └─ Express :8080
                          ├─ GET /            → public/index.html, app.js, style.css (static)
                          └─ /api/todos/*     → pg Pool ──> Neon Postgres (DATABASE_URL)
```

A single Express server (1) serves the static frontend from `public/`, and (2) exposes a JSON REST API
under `/api/todos`. It reads `DATABASE_URL` from the process environment. At **deploy** time Firth
decrypts and injects the branch's credentials as env vars; for **local** development the credentials
come from the `.env` that `firth secrets` writes. The container listens on `PORT` (default `8080`);
Fly maps public `443`/`80` to that internal port.

## Directory structure

`samples/` is this Firth project's root (`.firth/project.json` lives here), so migrations go in the
project root's `migrations/` per Firth convention (so schema changes can be replayed on a branch DB and
re-applied on `main` after a merge).

```
samples/
├── .firth/project.json          (exists)
├── migrations/
│   └── 001_create_todos.sql
└── todo/                         ← the app; Docker build context
    ├── server.js                ← Express: API + static hosting + pg Pool
    ├── package.json             ← deps: express, pg
    ├── public/
    │   ├── index.html
    │   ├── app.js
    │   └── style.css
    ├── Dockerfile
    └── .dockerignore
```

The migration files are **not** baked into the image — they are applied locally against `DATABASE_URL`.
The image carries only the app.

## Data model — `migrations/001_create_todos.sql`

Single-user, so no `owner` column and **no RLS** (this is the user's own Neon database, accessed with a
full-privilege `DATABASE_URL` direct connection — RLS is Firth's metadata-DB concern, not this app's).

```sql
create table if not exists todos (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 500),
  completed  boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists todos_created_at_idx on todos (created_at);
```

`gen_random_uuid()` is built into Postgres 13+ (Neon supports it natively). The timestamp defaults use
`clock_timestamp()` (not `now()`) so rows inserted within the same transaction get distinct,
monotonically increasing timestamps — this keeps `order by created_at` stable and makes the
transaction-isolated data-layer tests deterministic.

## API

All queries are **parameterized** (`pg` placeholders) — no string interpolation into SQL.

| Method & path | Behavior | Status codes |
|---|---|---|
| `GET /healthz` | Liveness check (post-deploy probe) | `200` |
| `GET /api/todos` | List all, ordered by `created_at` | `200` |
| `POST /api/todos` `{title}` | Create one | `201`, `400` (empty/too-long title) |
| `PATCH /api/todos/:id` `{title?, completed?}` | Edit text and/or toggle complete; bumps `updated_at` | `200`, `400`, `404` |
| `DELETE /api/todos/:id` | Delete one | `204`, `404` |
| `DELETE /api/todos?completed=true` | Clear all completed | `200` (returns count deleted) |

Responses are JSON. A todo serializes as `{id, title, completed, created_at, updated_at}`.

## Frontend (single page, vanilla)

- **Add:** text input + add button (Enter submits).
- **List item:** checkbox (toggle complete), title (double-click to edit inline, blur/Enter saves),
  delete button.
- **Footer:** remaining-count, filter tabs (All / Active / Completed), "Clear completed" button.
- **Filtering is client-side** — fetch the full list once, filter in JS. Standard for a todo of this size.
- **XSS safety:** todo titles are rendered with `textContent`, never `innerHTML`.

## Error handling

- **Server:** empty/over-length title → `400`; unknown id → `404`; DB failure → `500` with a JSON
  message (never leak stack traces or the connection string). Neon requires SSL — the `pg` Pool honors
  the connection string's `sslmode=require`.
- **Frontend:** any `fetch` failure surfaces a dismissible red banner at the top; failures are never
  silently swallowed.

## Testing

- **Data-layer integration tests** against the API endpoints, each running inside a transaction that is
  rolled back at the end so test data never persists. Written test-first (TDD) during implementation.
- **Smoke script** run after deploy: `curl` the `/healthz` probe, then create → list → delete one todo
  against the live `https://<app>.fly.dev` URL to confirm the end-to-end path (browser → Fly → Neon).

## Deployment (GHCR public image + Fly)

> ⚠️ **Fly machines are amd64**; the build host is Apple Silicon (arm64). The image **must** be built
> `--platform linux/amd64`, or the container won't start.
>
> The Firth control plane passes the image URL to Fly's Machines API **without registry credentials**,
> so the image **must be publicly pullable** — hence a **public** GHCR package.

1. `firth secrets` → writes `samples/.env` (provides `DATABASE_URL`).
2. `psql "$DATABASE_URL" -f migrations/001_create_todos.sql` — create the table.
3. `node server.js` locally against `.env`; verify add/toggle/edit/delete/filter in the browser.
4. `gh auth token | docker login ghcr.io -u jwfing --password-stdin`.
5. `docker build --platform linux/amd64 -t ghcr.io/jwfing/firth-todo:1 todo`.
6. `docker push ghcr.io/jwfing/firth-todo:1`; set the GHCR package visibility to **public**
   (via `gh` API) so Fly can pull it anonymously.
7. `firth deploy --image ghcr.io/jwfing/firth-todo:1 --port 8080`.
8. Open the printed `https://<app>.fly.dev` and run the smoke script to confirm the live path.

## Security notes

- No auth by design (see Non-Goals) — accepted for this single-user sample.
- SQL injection: prevented by parameterized queries throughout.
- XSS: prevented by `textContent` rendering of user-supplied titles.
- Secrets: `DATABASE_URL` and other credentials come only from the environment (`.env` locally, injected
  env vars in production). The `.env` file is for local dev only and is never baked into the image.

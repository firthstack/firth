# Firth Web Dashboard — Design

**Date:** 2026-06-18
**Status:** Approved (pending spec review)

## Goal

A terminal-themed web dashboard for Firth: users sign up / sign in (email-password +
Google/GitHub OAuth), create projects and branches, view project/branch metadata and
the provisioned resource handles, and delete projects/branches (hard teardown of the
underlying cloud resources, with the metadata row kept as an archived tombstone).

## Non-Goals (v1)

- Pagination, infinite scroll, or search over projects/branches/events.
- Real-time / live-updating views (the dashboard fetches on action + on load).
- The Firth marketing site (this is the authenticated app, not the landing page).
- Billing / usage / metering display.
- Deploy / secrets / events UI (the CLI covers these; the dashboard is auth + project/branch CRUD only).

## Architecture (Approach A — pure control-plane client)

The dashboard is a static single-page app that authenticates with the InsForge SDK in
the browser, then makes **every** project/branch call to the Firth **control-plane API**
with `Authorization: Bearer <accessToken>` — the same API surface `firth-cli` uses. The
control plane stays the single authority over project/branch state, master provider keys,
and all invariants (RLS-bound queries, "can't delete the default branch", resource teardown).

```
┌─────────────────┐   signUp/signIn/OAuth    ┌──────────────────┐
│  dashboard/     │ ───────────────────────▶ │ InsForge Auth    │
│  (Vite+React)   │ ◀─── accessToken ──────── │ (@insforge/sdk)  │
│                 │                           └──────────────────┘
│                 │   Bearer <token>          ┌──────────────────┐   master keys   ┌──────────┐
│                 │ ───────────────────────▶  │ control-plane    │ ──────────────▶ │ Neon/Fly │
│                 │ ◀─── projects/branches ─── │ (Fastify + RLS)  │                 │ /Tigris  │
└─────────────────┘                           └──────────────────┘                 └──────────┘
                                                       │ RLS-bound queries
                                                       ▼
                                              InsForge Postgres
```

**Why A over a hybrid (reads direct from InsForge, writes via the API):** one data path,
one row shape, and soft-delete/teardown invariants stay server-side. The only cost is that
the control plane must be reachable — until it is deployed, the dashboard points at a
locally-running control plane (`localhost`). This is the same "not deployed yet" wrinkle
the CLI already has.

## Repository Layout

- `dashboard/` — new package: Vite + React + TypeScript static SPA. Builds to `dashboard/dist`,
  deployed to InsForge sites via `npx @insforge/cli deployments deploy`.
- `control-plane/` — backend additions (migration, repos, services, routes, CORS).

## Backend Additions (`control-plane/`)

### Migration: soft-delete marker

Add a nullable `archived_at TIMESTAMPTZ` column to `public.projects` and `public.branches`.
The existing owner-only RLS (`FOR ALL ... USING/ WITH CHECK owner = auth.uid()`) and the
`GRANT ... UPDATE` already permit the owner to set it — no policy/grant change needed.
`status` is also moved to `'deleted'` on teardown for human readability; `archived_at`
is the authoritative "hidden from lists" signal.

### Repositories (`src/db/repos.ts`)

- `ProjectsRepo.findById(uid, id)` — owner-scoped single fetch (or null).
- `ProjectsRepo.archive(uid, id)` — set `archived_at = now`, `status = 'deleted'`.
- `ProjectsRepo.listByOwner` — **filter `archived_at IS NULL`** (uses `.is('archived_at', null)`,
  matching the PostgREST-faithful null semantics already established for the secret seam).
- `BranchesRepo.findById(uid, id)`, `BranchesRepo.archive(uid, id)`,
  `BranchesRepo.listByProject` — same archived filter.
- `ResourcesRepo.listByProject(uid, projectId)` — all resource rows for the project.
- `ResourcesRepo.markStatus(uid, id, status)` — set `status` ('destroyed' | 'destroy_failed').

### `TeardownService` (`src/services/teardown.ts`)

Owns the delete invariants and the adapter teardown sequence.

- `deleteProject(uid, projectId)`:
  1. `findById` → 404-equivalent if missing/not owned.
  2. `ResourcesRepo.listByProject`; for each resource, select the adapter by `kind`
     (`neon`/`s3`/`fly`) and call `adapter.destroy(resource.provider_ref)`.
     Per-resource best-effort: on success `markStatus('destroyed')`; on failure
     `markStatus('destroy_failed')` and collect the failure (kind + message) — a failed
     destroy never stops the remaining destroys or the archive.
  3. `ProjectsRepo.archive`. (Branches/secrets rows remain via the project tombstone;
     they are not separately torn down — their backing data lived in the Neon project,
     which is now destroyed.)
  4. Return `{ project, teardown: { destroyed: kind[], failed: {kind,message}[] } }`.
- `deleteBranch(uid, projectId, branchId)`:
  1. `BranchesRepo.findById`; 404-equivalent if missing/not owned.
  2. **Guard:** if `is_default` → reject (`409`-equivalent, "cannot delete the default branch").
  3. Resolve the project's Neon resource handle; `neonAdapter.deleteBranch(handle, branch.neon_branch_ref)`
     (best-effort: a failed Neon delete is reported but still archives the row, so the
     dashboard is never wedged).
  4. `BranchesRepo.archive`.
  5. Return `{ branch, teardown: {...} }`.

`destroy()` / `deleteBranch()` already exist on the adapters and were live-verified
(Neon project + branch, Fly app, Tigris bucket). This is wiring, not new provider work.

### Routes (`src/server.ts`)

- `GET /projects/:id` → `{ project, branches, resources }`. `branches` from
  `BranchesRepo.listByProject` (archived filtered out); `resources` = `kind`, `status`,
  and a **whitelisted projection of `provider_ref`** per kind, listing only non-credential
  handle keys (neon: `neonProjectId`, `defaultBranchId`, `dbName`, `roleName`, `host`,
  `database`, `region`; fly: `app`, `appName`, `machineId`, `region`; s3: `bucket`,
  `bucketName`, `endpoint`, `region`). Credential-shaped keys (password/secret/key/token/uri/url)
  are never listed.
  Credentials (connection URIs with passwords, access keys) live encrypted in the
  `secrets` table and are returned by no endpoint; the whitelist makes the no-secret
  guarantee hold **by construction**, independent of whatever provisioning happened to
  stash in `provider_ref`. Unknown keys are dropped, not passed through.
- `DELETE /projects/:id` → `TeardownService.deleteProject`; best-effort `emit('project.delete', { teardown })`.
- `DELETE /projects/:id/branches/:bid` → `TeardownService.deleteBranch`; best-effort
  `emit('branch.delete', { name, teardown })`.

All four reuse the existing `auth(req)` → `{ uid, token, db }` helper and the
`adaptersForToken(token)` factory. Errors map to status codes via the existing static-string
error handler (extended with a `NotFoundError` → 404 and a `ConflictError` → 409, both
carrying only static messages — never echoing provider error text).

### CORS

Add `@fastify/cors`, registered before routes. Allowed origins come from config/env
(`FIRTH_CORS_ORIGINS`, comma-separated; default `http://localhost:5173` for Vite dev).
Allow `GET, POST, DELETE, OPTIONS`, the `Authorization` + `Content-Type` headers. Preflight
(`OPTIONS`) is handled by the plugin.

## Frontend (`dashboard/`)

### Stack & theme

Vite + React + TypeScript. Terminal aesthetic via CSS: monospace stack, dark background,
box-drawing borders, an ANSI-ish palette (green/amber/red on near-black). No component
library — small hand-rolled terminal-styled primitives (panel, row, button, input, confirm).

### Auth (`src/auth/`)

- `insforge` client = `createClient({ baseUrl: VITE_INSFORGE_URL, anonKey: VITE_INSFORGE_ANON_KEY })`.
- **Sign-up:** `auth.signUp({ email, password, name })`. If `data.requireEmailVerification`,
  show a "check your email to verify, then sign in" message (link-method) or a 6-digit
  code input (code-method) — the dashboard reads which from the sign-up response and
  handles both. Otherwise the returned `accessToken` signs the user straight in.
- **Sign-in:** `auth.signInWithPassword({ email, password })`.
- **OAuth:** Google/GitHub buttons → `auth.signInWithOAuth({ provider, redirectTo })`
  (redirect flow; on return the SDK session is restored). *Requires the provider to be
  enabled with client credentials + redirect URLs in the InsForge backend — a one-time
  operator setup step. Email/password works with no extra config.*
- **Session:** restore on load from the SDK session; expose `accessToken` to the api client;
  `signOut()` clears it. A 401 from the control plane drops the user back to the auth screen.

### API client (`src/api/client.ts`)

Thin wrapper around `fetch` against `VITE_FIRTH_API_URL`, attaching `Authorization: Bearer <token>`
and `Content-Type: application/json`. Methods: `listProjects`, `getProject(id)`,
`createProject(name)`, `deleteProject(id)`, `createBranch(projectId, name, from)`,
`deleteBranch(projectId, branchId)`. Non-2xx → throws with the server's static `error` string.
Mirrors the CLI's `FirthApi` shape so behavior is consistent across clients.

### Views (`src/views/`)

- **Auth screen** — sign-up / sign-in toggle + OAuth buttons, terminal-framed.
- **Projects** — list (name, status, created — no branch count, to avoid N+1 detail calls),
  `[+ create]` (prompts for name; shows provisioning in progress; refreshes on done),
  `[delete]` per row → confirm dialog that states the teardown is irreversible and which
  resources will be destroyed → calls `deleteProject` → refreshes.
- **Project detail / branches** — project metadata + a resources panel (Neon project/branch
  ref, Fly app, Tigris bucket, each with status), branch list (name, `default` tag,
  `neon_branch_ref`, status), `[+ create branch]` (name + parent), `[delete branch]`
  (hidden/disabled on the default branch) → confirm → `deleteBranch` → refresh.

### Config

`.env` (Vite): `VITE_FIRTH_API_URL`, `VITE_INSFORGE_URL`, `VITE_INSFORGE_ANON_KEY`.
A `dashboard/README.md` documents local dev (run the control plane locally, set the three
vars, `npm run dev`) and the InsForge-sites deploy path.

## Data Flow Summary

1. Browser auth (SDK) → `accessToken` (held in app state; SDK persists the session).
2. Every project/branch call → control-plane API with the Bearer token.
3. Control plane verifies the token → RLS-bound `DataClient` → InsForge Postgres.
4. Create/delete additionally drive the provider adapters under the control plane's master keys.

## Error Handling

- **Backend:** static-string errors only (never echo provider/DB error text — it can carry
  tokens). New `NotFoundError` (404) and `ConflictError` (409, default-branch guard) join
  the existing `UnauthorizedError` (401) in the error handler. Teardown failures are
  *reported in the success body* (`teardown.failed`), not thrown — the row is archived and
  the user is told which resources need a manual retry.
- **Frontend:** every api call wrapped; failures render as a terminal error line. A 401
  routes to the auth screen. Destructive actions require an explicit confirm.

## Testing

- **Backend:** TDD with the existing in-memory `DataClient`/adapter fakes (PostgREST-faithful
  `is`/`eq`). New tests cover: archived rows excluded from lists; `GET /projects/:id` shape +
  the `provider_ref` whitelist (only whitelisted keys returned; a credential-shaped key
  planted in `provider_ref` is dropped); project teardown calls each adapter's `destroy` and archives the row;
  partial teardown failure is reported, not thrown; branch teardown + default-branch guard;
  CORS headers present. Suite stays fully local/offline.
- **Frontend:** Vitest + Testing Library against a faked api client and a faked InsForge auth —
  sign-up/sign-in/OAuth-button flows, project list/create/delete, branch list/create/delete,
  default-branch delete disabled, 401 → auth screen. No network.

## Build Order (informs the implementation plan)

1. Migration + repo archive/find/list-filter methods.
2. `GET /projects/:id` detail endpoint (+ `ResourcesRepo.listByProject`).
3. `TeardownService` + `DELETE` endpoints + `NotFoundError`/`ConflictError` + delete events.
4. CORS.
5. `dashboard/` scaffold + terminal theme + config.
6. Auth (sign-up/sign-in/OAuth/session/sign-out).
7. API client.
8. Projects view (list/create/delete).
9. Project detail / branches view (metadata/resources/create/delete).
10. `dashboard/README.md` + deploy notes.

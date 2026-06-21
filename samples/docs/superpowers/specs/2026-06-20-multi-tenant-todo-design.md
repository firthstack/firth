# Multi-Tenant Todo — Design

**Date:** 2026-06-20
**Status:** Approved (pending spec review)

## Goal

Add accounts and per-user data isolation to the existing single-user todo app (`samples/todo/`).
Users must log in (email + password) to use the app, and can only see and operate on their **own**
todos. Same single container (Express + vanilla frontend + direct Neon Postgres); we add a users
table, a sessions table, a `user_id` owner on `todos`, auth routes + middleware, and scope every todo
query by the authenticated user. Delivered on a **Firth branch** (isolated DB + compute) paired with a
**git branch**, validated in isolation, then merged back to `main`.

This extends the [single-user todo](./2026-06-20-todo-design.md). Its spec/plan are the baseline.

## Non-Goals

- No OAuth / social login / SSO — email + password only.
- No password reset, email verification, or account management UI (out of scope; keep it simple).
- No roles/permissions/sharing — a todo belongs to exactly one user; no cross-user access at all.
- No JWT / stateless tokens — we use server-side sessions (decision below).
- No httpOnly-cookie auth — the SPA stores the token in `localStorage` and sends it as a Bearer header
  (decision below; trade-off noted under Security).

## Decisions (locked)

- **Session mechanism:** server-side sessions. Login mints an opaque random token; the server stores
  only its SHA-256 hash in a `sessions` table and returns the raw token to the client. Every request
  is authenticated by hashing the bearer token and looking up an unexpired session. Simple, revocable
  (logout deletes the row), needs no signing secret or JWT library, and uses the Postgres we already have.
- **Password hashing:** Node's built-in `crypto.scrypt` with a per-password random salt — **no new
  dependencies**. Stored as an encoded string `scrypt$<saltB64>$<hashB64>`.
- **Registration:** open self-service — anyone can register with email + password.
- **Token transport/storage:** `Authorization: Bearer <token>` header; client keeps the token in
  `localStorage`.
- **Isolation enforcement:** application layer — every todo query includes `where user_id = $1`; updates
  and deletes match on `id AND user_id` so a user cannot touch another user's todos. (RLS is Firth's
  metadata-DB concern, not this app's; the app connects with a full-privilege `DATABASE_URL`.)

## Architecture

```
Browser ──Authorization: Bearer <token>──> Express
   ├─ unauthenticated → /api/auth/register, /api/auth/login, and the static login page only
   └─ authenticated   → authMiddleware verifies the session → req.userId
                         → /api/todos/*  (every query scoped: where user_id = req.userId)
```

## Schema — `migrations/002_multi_tenant.sql`

```sql
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default clock_timestamp()
);

create table if not exists sessions (
  token_hash text primary key,                 -- sha256(raw token); the raw token is only ever sent to the client
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id_idx on sessions(user_id);

-- Give todos an owner. Pre-existing ownerless rows are early test data with no place in a
-- multi-tenant model and cannot be backfilled to a NOT NULL owner, so they are removed.
delete from todos;
alter table todos add column user_id uuid not null references users(id) on delete cascade;
create index if not exists todos_user_id_idx on todos(user_id);
```

**Data-loss note (approved):** this migration deletes all pre-existing ownerless todos (currently the
single `'improve firth cli'` row). It runs first against the Firth branch's DB copy, then again against
`main`'s DB after merge.

## Module layout

- **`todo/auth.js` (new)** — pure crypto, no DB, unit-testable in isolation:
  - `hashPassword(password) → string` — scrypt with random salt, encoded `scrypt$<saltB64>$<hashB64>`.
  - `verifyPassword(password, encoded) → boolean` — constant-time compare (`crypto.timingSafeEqual`).
  - `newSessionToken() → { token, tokenHash }` — 32 random bytes hex + its sha256.
  - `hashToken(token) → string` — sha256 hex (for looking up a presented token).
- **`todo/db.js` (modified)** — todo functions gain a `userId` first-data argument and filter by owner;
  new user/session functions added.
- **`todo/server.js` (modified)** — `authMiddleware`, auth routes, and all `/api/todos/*` behind auth.

## Data layer (`db.js`) interface

Todo functions (now owner-scoped):
- `listTodos(db, userId)` — `where user_id = $1 order by created_at`.
- `createTodo(db, userId, title)` — inserts `user_id`.
- `updateTodo(db, userId, id, fields)` — `where id = $? and user_id = $?`; returns `null` if not the
  user's row.
- `deleteTodo(db, userId, id)` — `where id and user_id`; returns `false` if not theirs.
- `clearCompleted(db, userId)` — `where user_id and completed`.

User/session functions:
- `createUser(db, email, password) → {id, email}` — validates email/password, hashes via `auth.js`;
  throws `ValidationError` on bad input; surfaces a distinct `EmailTakenError` on unique-violation (23505).
- `findUserByEmail(db, email) → {id, email, password_hash} | null`.
- `createSession(db, userId, ttlDays) → token` — stores the token hash + `expires_at`, returns the raw token.
- `findUserBySessionToken(db, token) → {id, email} | null` — joins sessions→users where not expired.
- `deleteSession(db, token) → void` — logout.

## API

| Method & path | Auth | Behavior | Status |
|---|---|---|---|
| `POST /api/auth/register` `{email,password}` | no | Create user + session; returns `{token, user:{id,email}}` (auto-login) | `201`, `400` bad input, `409` email taken |
| `POST /api/auth/login` `{email,password}` | no | Verify creds + create session; returns `{token, user}` | `200`, `400`, `401` bad creds |
| `POST /api/auth/logout` | yes | Delete the current session | `204` |
| `GET /api/auth/me` | yes | Return `{id, email}` of the current user | `200`, `401` |
| `GET /api/todos` | yes | List the user's todos | `200` |
| `POST /api/todos` `{title}` | yes | Create a todo owned by the user | `201`, `400` |
| `PATCH /api/todos/:id` `{title?,completed?}` | yes | Update the user's todo | `200`, `400`, `404` |
| `DELETE /api/todos/:id` | yes | Delete the user's todo | `204`, `404` |
| `DELETE /api/todos?completed=true` | yes | Clear the user's completed todos | `200` |

Validation: email lowercased + basic format check; password ≥ 8 chars. A todo of another user is
indistinguishable from a missing one → `404` (never `403`), so existence isn't leaked.

## Auth middleware

Reads `Authorization: Bearer <token>`; if absent/malformed → `401`. Otherwise looks up the user via
`findUserBySessionToken`; if none (unknown or expired) → `401`. On success sets `req.userId` and
`req.user` and continues. Applied to `/api/auth/logout`, `/api/auth/me`, and all `/api/todos/*`.

## Frontend (vanilla, extends the existing single page)

- `index.html`: an **auth view** (email + password inputs, a Login/Register toggle, an error line) and
  the existing **todo view**, shown mutually exclusively. A "Log out" control in the todo view.
- `app.js`: on load, if `localStorage` has a token → `GET /api/auth/me`; success shows the todo view,
  failure shows the auth view. Register/login store the returned token and switch to the todo view.
  Log out calls `/api/auth/logout`, clears the token, shows the auth view. The `api()` helper attaches
  the `Authorization` header; any `401` clears the token and returns to the auth view. Titles still
  render with `textContent` (XSS-safe).

## Error handling

Server: `ValidationError` → `400`; `EmailTakenError` → `409`; bad credentials → `401`; missing/expired
session → `401`; another user's or unknown todo → `404`; other errors → `500` with a generic JSON
message (no stack traces, no connection string, never the password hash or token). Frontend: auth and
fetch failures surface a dismissible error line; `401` transparently returns the user to the login view.

## Testing

- **`auth.js` unit tests** (no DB): `hashPassword`/`verifyPassword` round-trip; wrong password fails;
  two hashes of the same password differ (random salt); `newSessionToken` + `hashToken` agree.
- **`db.js` integration tests** (transaction-rollback, clean slate per test): user creation; duplicate
  email rejected; session create/lookup/expiry; and **isolation** — user A cannot list, read, update,
  or delete user B's todos (cross-user `update`/`delete` return null/false; `list` shows only own).
- **Live smoke** after deploy: register two accounts; each sees only its own todos; logout returns 401
  on a protected route.

## Delivery — Firth branch + git branch

1. `git checkout -b feat/multi-tenant` (code; already created for this spec).
2. `firth branch create multi-tenant` → isolated Neon DB branch (a copy of `main`'s data) + its own Fly
   app; `firth branch switch multi-tenant` then `firth secrets` → `./.env` now has the branch DB creds.
3. Apply `migrations/002_multi_tenant.sql` to the **branch** DB; build the new image, push to public
   GHCR (a new tag), `firth deploy` → the branch's own URL; validate login + isolation there.
4. Merge back to `main`: merge the `feat/multi-tenant` code into `main`; merge the migration into
   `main`'s `migrations/`; `firth branch switch main` then `firth secrets`; re-run
   `migrations/002_multi_tenant.sql` against **main**'s DB; rebuild + `firth deploy` to main's compute.
5. **Clean up (approved):** `firth branch delete multi-tenant --yes` and delete the git branch after the
   merge is validated on `main`.

## Security notes

- Passwords: scrypt with a random salt; never stored in plaintext or a reversible form; `verifyPassword`
  uses `timingSafeEqual`.
- Sessions: the table stores only `sha256(token)`, so a DB leak does not expose usable tokens; logout
  deletes the row; sessions carry an `expires_at`.
- Authorization: updates/deletes match `id AND user_id`, preventing cross-tenant access (IDOR); a
  non-owned todo returns `404`, not `403`, so ownership isn't leaked.
- SQL injection: all queries parameterized. XSS: user text rendered via `textContent`.
- Token storage trade-off: `localStorage` + Bearer header is simple and standard for SPAs but more
  exposed to XSS than an httpOnly cookie; acceptable here because the frontend has no HTML-injection
  sink (titles use `textContent`).

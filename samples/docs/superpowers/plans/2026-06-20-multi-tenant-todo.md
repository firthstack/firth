# Multi-Tenant Todo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email+password accounts and per-user data isolation to the todo app, built and validated on an isolated Firth branch (DB + compute), then promoted to `main`.

**Architecture:** A new pure-crypto `auth.js` (Node `scrypt` + token hashing, no deps). `db.js` gains `users`/`sessions` functions and scopes every todo query by `user_id`. `server.js` adds an auth middleware (verifies a server-side session token from the `Authorization: Bearer` header), auth routes (register/login/logout/me), and puts all `/api/todos/*` behind auth. The vanilla frontend gains a login/register view gated in front of the todo view. Server-side sessions: the DB stores only `sha256(token)`.

**Tech Stack:** Node 20 (container) / 24 (local), ESM, Express 4, `pg` 8, Node built-in `crypto` (scrypt/sha256), `node:test`, Docker, public GHCR, `firth` CLI (branch + deploy).

## Global Constraints

- **Git branch:** `feat/multi-tenant` (already created; the spec is committed there). **Firth branch:** `multi-tenant`.
- **Working/project root:** `/Users/junwen/Work/Personal/firth` (repo root for git); `/Users/junwen/Work/Personal/firth/samples` is the Firth project root (holds `.firth/`); the app is in `samples/todo/`; migrations in `samples/migrations/`.
- **No new dependencies** — password hashing uses Node's built-in `crypto.scryptSync`; tokens use `crypto.randomBytes` + `createHash('sha256')`.
- **Session mechanism:** server-side sessions; `sessions` table stores `sha256(token)`; TTL **30 days**; logout deletes the row.
- **Auth transport:** `Authorization: Bearer <token>`; the frontend stores the token in `localStorage` under key `todo_token`.
- **Validation:** email is lowercased + trimmed and must match `^[^@\s]+@[^@\s]+\.[^@\s]+$`; password must be **≥ 8 chars**.
- **Isolation:** every todo query filters `where user_id = $1`; `update`/`delete` match `id AND user_id`; a non-owned or missing todo returns **404** (never 403).
- **Errors:** `ValidationError` → 400; `EmailTakenError` → 409; bad creds / missing/expired session → 401; 500 carries a generic message only (never the password hash, token, stack, or connection string).
- **SQL** fully parameterized; user text rendered via `textContent` (XSS-safe).
- **Image:** `ghcr.io/jwfing/firth-todo:2`, built `--platform linux/amd64`, public.
- **Firth token TTL is ~15 min** — `firth secrets`/`branch`/`deploy` may require a fresh `firth login` right before; if a firth command returns `500 internal error`, re-login and retry.

---

### Task 1: Provision the isolated Firth branch (DB + compute)

**Files:** none (operational).

**Interfaces:**
- Consumes: a logged-in, linked Firth project on the default branch.
- Produces: a Firth `multi-tenant` branch (its own Neon DB copy + own Fly app), with the working dir switched to it and `samples/.env` holding the **branch** DB credentials.

- [ ] **Step 1: Confirm git branch and Firth login**

Run:
```bash
cd /Users/junwen/Work/Personal/firth && git branch --show-current     # expect: feat/multi-tenant
cd /Users/junwen/Work/Personal/firth/samples && firth status          # expect: signed in, project linked
```
Expected: git on `feat/multi-tenant`; firth signed in with a linked project. If `firth status` shows signed in but later commands 500, run `firth login --email jwfing@gmail.com --password <pw>`.

- [ ] **Step 2: Create and switch to the Firth branch**

Run:
```bash
cd /Users/junwen/Work/Personal/firth/samples
firth branch create multi-tenant
firth branch switch multi-tenant
firth status
```
Expected: branch created (own DB + Fly app); `firth status` shows branch `multi-tenant`. If `branch create` 500s, re-login and retry.

- [ ] **Step 3: Write the branch's credentials to `.env`**

Run: `cd /Users/junwen/Work/Personal/firth/samples && firth secrets`
Expected: writes `./.env`; it now holds the **branch** DB's `DATABASE_URL` (isolated from main). Do not print it.

- [ ] **Step 4: No commit** — this task changes no tracked files. Report the branch name and that `.env` now targets the branch DB.

---

### Task 2: Schema migration + apply to the branch DB

**Files:**
- Create: `migrations/002_multi_tenant.sql`

**Interfaces:**
- Consumes: the branch DB credentials in `samples/.env` (Task 1).
- Produces: `users`, `sessions` tables and a `user_id` owner column + index on `todos`, in the **branch** DB.

- [ ] **Step 1: Create `migrations/002_multi_tenant.sql`**

```sql
-- 002_multi_tenant.sql — accounts + per-user ownership.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default clock_timestamp()
);

create table if not exists sessions (
  token_hash text primary key,                 -- sha256(raw token); raw token is only ever sent to the client
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id_idx on sessions(user_id);

-- Give todos an owner. Pre-existing ownerless rows are early test data that can't be backfilled to a
-- NOT NULL owner, so they are removed (approved) — but ONLY on first apply (when user_id doesn't exist
-- yet), so a re-run of this migration can never wipe owned todos.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'todos' and column_name = 'user_id'
  ) then
    delete from todos;
  end if;
end $$;
alter table todos add column if not exists user_id uuid not null references users(id) on delete cascade;
create index if not exists todos_user_id_idx on todos(user_id);
```

- [ ] **Step 2: Apply the migration to the branch DB**

Run:
```bash
cd /Users/junwen/Work/Personal/firth/samples
export DATABASE_URL="$(grep '^DATABASE_URL=' ./.env | cut -d= -f2-)"
psql "$DATABASE_URL" -f migrations/002_multi_tenant.sql
```
Expected: `CREATE TABLE` / `CREATE INDEX` / `DELETE n` / `ALTER TABLE` with no error.

- [ ] **Step 3: Verify the schema**

Run: `psql "$DATABASE_URL" -c '\d users' -c '\d sessions' -c '\d todos'`
Expected: `users(id,email,password_hash,created_at)` with a unique index on `email`; `sessions(token_hash pk, user_id, created_at, expires_at)`; `todos` now has a `user_id` column (not null) + `todos_user_id_idx`.

- [ ] **Step 4: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add samples/migrations/002_multi_tenant.sql
git commit -m "feat(todo): multi-tenant schema migration (users, sessions, todo owner)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `auth.js` — password hashing + session tokens (TDD)

**Files:**
- Create: `todo/auth.js`
- Test: `todo/test/auth.test.js`

**Interfaces:**
- Consumes: Node built-in `crypto` only.
- Produces (used by Tasks 4 & 5):
  - `hashPassword(password: string) → string` — encoded `scrypt$<saltB64>$<hashB64>`.
  - `verifyPassword(password: string, encoded: string) → boolean` — constant-time; `false` on malformed input.
  - `newSessionToken() → { token: string, tokenHash: string }` — 32 random bytes hex + its sha256-hex.
  - `hashToken(token: string) → string` — sha256-hex (to look up a presented token).

- [ ] **Step 1: Write the failing tests — `todo/test/auth.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, newSessionToken, hashToken } from '../auth.js'

test('hashPassword + verifyPassword round-trip', () => {
  const h = hashPassword('correct horse battery')
  assert.equal(verifyPassword('correct horse battery', h), true)
})

test('verifyPassword rejects the wrong password', () => {
  const h = hashPassword('correct horse battery')
  assert.equal(verifyPassword('wrong', h), false)
})

test('the same password hashes differently each time (random salt)', () => {
  assert.notEqual(hashPassword('same-password'), hashPassword('same-password'))
})

test('verifyPassword returns false on a malformed hash', () => {
  assert.equal(verifyPassword('x', 'not-a-valid-encoded-hash'), false)
  assert.equal(verifyPassword('x', ''), false)
})

test('newSessionToken: hashToken(token) equals tokenHash, token is 64 hex chars', () => {
  const { token, tokenHash } = newSessionToken()
  assert.equal(token.length, 64)
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(hashToken(token), tokenHash)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/junwen/Work/Personal/firth/samples/todo && npm test`
Expected: FAIL — `Cannot find module '../auth.js'`.

- [ ] **Step 3: Implement `todo/auth.js`**

```js
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

const KEYLEN = 32

export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, KEYLEN)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password, encoded) {
  const parts = String(encoded).split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let salt, expected
  try {
    salt = Buffer.from(parts[1], 'base64')
    expected = Buffer.from(parts[2], 'base64')
  } catch { return false }
  if (expected.length === 0) return false
  const actual = scryptSync(String(password), salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function newSessionToken() {
  const token = randomBytes(32).toString('hex')
  return { token, tokenHash: hashToken(token) }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/junwen/Work/Personal/firth/samples/todo && npm test`
Expected: PASS — the 5 auth tests pass (the existing `todos.test.js` will fail here because `db.js` hasn't been updated yet; that's expected and fixed in Task 4. To run only auth tests now: `node --env-file=../.env --test test/auth.test.js` → 5 pass).

- [ ] **Step 5: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add samples/todo/auth.js samples/todo/test/auth.test.js
git commit -m "feat(todo): auth.js — scrypt password hashing + session tokens

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `db.js` — users, sessions, owner-scoped todos (TDD)

**Files:**
- Modify: `todo/db.js` (full new contents below)
- Test: `todo/test/todos.test.js` (full new contents below)

**Interfaces:**
- Consumes: `auth.js` (Task 3); the schema (Task 2); branch `DATABASE_URL`.
- Produces (used by Task 5):
  - `class EmailTakenError extends Error`
  - `createUser(db, email, password) → {id, email}` (throws `ValidationError` / `EmailTakenError`)
  - `findUserByEmail(db, email) → {id, email, password_hash} | null`
  - `createSession(db, userId, ttlDays=30) → token`
  - `findUserBySessionToken(db, token) → {id, email} | null`
  - `deleteSession(db, token) → void`
  - `listTodos(db, userId)`, `createTodo(db, userId, title)`, `updateTodo(db, userId, id, fields) → todo|null`, `deleteTodo(db, userId, id) → boolean`, `clearCompleted(db, userId) → number`
  - `makePool`, `ValidationError` (unchanged signatures)

- [ ] **Step 1: Replace `todo/test/todos.test.js` with the new failing tests**

```js
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted,
  createUser, findUserByEmail, createSession, findUserBySessionToken, deleteSession,
  ValidationError, EmailTakenError,
} from '../db.js'

const MISSING_ID = '00000000-0000-0000-0000-000000000000'
let pool, client, userA, userB

before(() => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set — run `firth secrets` first')
  pool = makePool()
})
after(async () => { await pool.end() })

// Clean slate within a rolled-back transaction; deleting users cascades to their todos + sessions.
beforeEach(async () => {
  client = await pool.connect()
  await client.query('begin')
  await client.query('delete from users')
  userA = await createUser(client, 'a@example.com', 'password-a')
  userB = await createUser(client, 'b@example.com', 'password-b')
})
afterEach(async () => { await client.query('rollback'); client.release() })

// --- users ---
test('createUser returns id + email and lowercases the email', async () => {
  const u = await createUser(client, 'Mixed@Case.COM', 'password1')
  assert.equal(u.email, 'mixed@case.com')
  assert.ok(u.id)
})

test('createUser rejects a duplicate email', async () => {
  await assert.rejects(() => createUser(client, 'a@example.com', 'password1'), EmailTakenError)
})

test('createUser rejects a bad email or short password', async () => {
  await assert.rejects(() => createUser(client, 'notanemail', 'password1'), ValidationError)
  await assert.rejects(() => createUser(client, 'c@example.com', 'short'), ValidationError)
})

test('findUserByEmail normalizes case and returns the hash', async () => {
  const u = await findUserByEmail(client, 'A@EXAMPLE.COM')
  assert.equal(u.id, userA.id)
  assert.ok(u.password_hash)
})

test('findUserByEmail returns null for an unknown email', async () => {
  assert.equal(await findUserByEmail(client, 'nobody@example.com'), null)
})

// --- sessions ---
test('createSession → findUserBySessionToken → deleteSession', async () => {
  const token = await createSession(client, userA.id)
  const u = await findUserBySessionToken(client, token)
  assert.equal(u.id, userA.id)
  await deleteSession(client, token)
  assert.equal(await findUserBySessionToken(client, token), null)
})

test('findUserBySessionToken returns null for an unknown or empty token', async () => {
  assert.equal(await findUserBySessionToken(client, 'bogus'), null)
  assert.equal(await findUserBySessionToken(client, ''), null)
})

test('findUserBySessionToken returns null for an expired session', async () => {
  const token = await createSession(client, userA.id, -1) // already expired
  assert.equal(await findUserBySessionToken(client, token), null)
})

// --- todos: ownership ---
test('createTodo inserts under the owner; listTodos returns only that owner', async () => {
  await createTodo(client, userA.id, 'a-todo')
  await createTodo(client, userB.id, 'b-todo')
  assert.deepEqual((await listTodos(client, userA.id)).map((r) => r.title), ['a-todo'])
  assert.deepEqual((await listTodos(client, userB.id)).map((r) => r.title), ['b-todo'])
})

test('createTodo trims and rejects empty / over-long titles', async () => {
  assert.equal((await createTodo(client, userA.id, '  spaced  ')).title, 'spaced')
  await assert.rejects(() => createTodo(client, userA.id, '   '), ValidationError)
  await assert.rejects(() => createTodo(client, userA.id, 'x'.repeat(501)), ValidationError)
})

test('updateTodo edits / toggles the owner\'s todo', async () => {
  const t = await createTodo(client, userA.id, 'task')
  assert.equal((await updateTodo(client, userA.id, t.id, { completed: true })).completed, true)
  assert.equal((await updateTodo(client, userA.id, t.id, { title: 'renamed' })).title, 'renamed')
})

// --- todos: isolation (the core multi-tenant requirement) ---
test('updateTodo returns null for another user\'s todo and leaves it unchanged', async () => {
  const t = await createTodo(client, userB.id, 'b-secret')
  assert.equal(await updateTodo(client, userA.id, t.id, { completed: true }), null)
  assert.equal((await listTodos(client, userB.id))[0].completed, false)
})

test('deleteTodo returns false for another user\'s todo and leaves it intact', async () => {
  const t = await createTodo(client, userB.id, 'b-secret')
  assert.equal(await deleteTodo(client, userA.id, t.id), false)
  assert.equal((await listTodos(client, userB.id)).length, 1)
})

test('updateTodo / deleteTodo return null/false for a missing id', async () => {
  assert.equal(await updateTodo(client, userA.id, MISSING_ID, { completed: true }), null)
  assert.equal(await deleteTodo(client, userA.id, MISSING_ID), false)
})

test('clearCompleted clears only the caller\'s completed todos', async () => {
  const a1 = await createTodo(client, userA.id, 'a-done')
  await updateTodo(client, userA.id, a1.id, { completed: true })
  const b1 = await createTodo(client, userB.id, 'b-done')
  await updateTodo(client, userB.id, b1.id, { completed: true })
  assert.equal(await clearCompleted(client, userA.id), 1)
  assert.equal((await listTodos(client, userB.id)).length, 1) // B untouched
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/junwen/Work/Personal/firth/samples/todo && npm test`
Expected: FAIL — `db.js` doesn't export `createUser`/`EmailTakenError`/etc., and todo functions don't take `userId`.

- [ ] **Step 3: Replace `todo/db.js` with the new contents**

```js
import pg from 'pg'
import { hashPassword, verifyPassword, newSessionToken, hashToken } from './auth.js'

const COLS = 'id, title, completed, created_at, updated_at'
const SESSION_TTL_DAYS = 30

export class ValidationError extends Error {}
export class EmailTakenError extends Error {}

export function makePool(connectionString = process.env.DATABASE_URL) {
  const cs = connectionString ?? ''
  const needsSsl = /\bsslmode=require\b/.test(cs)
  // Strip sslmode so pg-connection-string doesn't emit SSL deprecation warnings; we pass ssl directly.
  // Remove the param with one adjacent separator (trailing if present, else leading) so the query stays valid.
  const cleanCs = cs
    .replace(/([?&])sslmode=[^&]*(&)?/, (_m, lead, trail) => (trail ? lead : ''))
    .replace(/[?&]$/, '')
  return new pg.Pool({
    connectionString: cleanCs,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  })
}

function cleanTitle(title) {
  if (typeof title !== 'string') throw new ValidationError('title must be a string')
  const t = title.trim()
  if (t.length < 1) throw new ValidationError('title must not be empty')
  if (t.length > 500) throw new ValidationError('title must be at most 500 characters')
  return t
}

function cleanEmail(email) {
  if (typeof email !== 'string') throw new ValidationError('email must be a string')
  const e = email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new ValidationError('invalid email')
  return e
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('password must be at least 8 characters')
  }
}

// --- users ---
export async function createUser(db, email, password) {
  const e = cleanEmail(email)
  checkPassword(password)
  const passwordHash = hashPassword(password)
  try {
    const { rows } = await db.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email',
      [e, passwordHash],
    )
    return rows[0]
  } catch (err) {
    if (err && err.code === '23505') throw new EmailTakenError('email already registered')
    throw err
  }
}

export async function findUserByEmail(db, email) {
  const e = String(email ?? '').trim().toLowerCase()
  const { rows } = await db.query(
    'select id, email, password_hash from users where email = $1',
    [e],
  )
  return rows[0] ?? null
}

// --- sessions ---
export async function createSession(db, userId, ttlDays = SESSION_TTL_DAYS) {
  const { token, tokenHash } = newSessionToken()
  await db.query(
    `insert into sessions (token_hash, user_id, expires_at)
     values ($1, $2, clock_timestamp() + make_interval(days => $3))`,
    [tokenHash, userId, ttlDays],
  )
  return token
}

export async function findUserBySessionToken(db, token) {
  if (!token) return null
  const { rows } = await db.query(
    `select u.id, u.email
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > clock_timestamp()`,
    [hashToken(token)],
  )
  return rows[0] ?? null
}

export async function deleteSession(db, token) {
  if (!token) return
  await db.query('delete from sessions where token_hash = $1', [hashToken(token)])
}

// --- todos (owner-scoped) ---
export async function listTodos(db, userId) {
  const { rows } = await db.query(
    `select ${COLS} from todos where user_id = $1 order by created_at`,
    [userId],
  )
  return rows
}

export async function createTodo(db, userId, title) {
  const t = cleanTitle(title)
  const { rows } = await db.query(
    `insert into todos (user_id, title) values ($1, $2) returning ${COLS}`,
    [userId, t],
  )
  return rows[0]
}

export async function updateTodo(db, userId, id, fields) {
  const sets = []
  const vals = []
  let i = 1
  if (fields.title !== undefined) { sets.push(`title = $${i++}`); vals.push(cleanTitle(fields.title)) }
  if (fields.completed !== undefined) {
    if (typeof fields.completed !== 'boolean') throw new ValidationError('completed must be a boolean')
    sets.push(`completed = $${i++}`); vals.push(fields.completed)
  }
  if (sets.length === 0) throw new ValidationError('no fields to update')
  sets.push('updated_at = clock_timestamp()')
  vals.push(id, userId)
  const { rows } = await db.query(
    `update todos set ${sets.join(', ')} where id = $${i} and user_id = $${i + 1} returning ${COLS}`,
    vals,
  )
  return rows[0] ?? null
}

export async function deleteTodo(db, userId, id) {
  const { rowCount } = await db.query(
    'delete from todos where id = $1 and user_id = $2',
    [id, userId],
  )
  return rowCount > 0
}

export async function clearCompleted(db, userId) {
  const { rowCount } = await db.query(
    'delete from todos where user_id = $1 and completed = true',
    [userId],
  )
  return rowCount
}

export { verifyPassword }
```

Note: `verifyPassword` is re-exported from `db.js` so `server.js` imports auth helpers and data functions from one module; `createUser`/`findUserByEmail` already use `hashPassword` internally.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/junwen/Work/Personal/firth/samples/todo && npm test`
Expected: PASS — all `auth.test.js` (5) + `todos.test.js` (~16) tests pass, output pristine.

- [ ] **Step 5: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add samples/todo/db.js samples/todo/test/todos.test.js
git commit -m "feat(todo): user/session data layer + owner-scoped todos with isolation tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `server.js` — auth middleware, auth routes, scoped todo routes

**Files:**
- Modify: `todo/server.js` (full new contents below)

**Interfaces:**
- Consumes: everything `db.js` produces (Task 4).
- Produces: `makeApp(pool)` with auth + scoped routes (see API table in the spec).

- [ ] **Step 1: Replace `todo/server.js` with the new contents**

```js
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted,
  createUser, findUserByEmail, createSession, findUserBySessionToken, deleteSession,
  verifyPassword, ValidationError, EmailTakenError,
} from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function bearerToken(req) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '')
  return m ? m[1] : null
}

export function makeApp(pool) {
  const app = express()
  app.use(express.json())

  const requireAuth = async (req, res, next) => {
    try {
      const user = await findUserBySessionToken(pool, bearerToken(req))
      if (!user) return res.status(401).json({ error: 'unauthorized' })
      req.userId = user.id
      req.user = user
      next()
    } catch (e) { next(e) }
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  // --- auth ---
  app.post('/api/auth/register', async (req, res, next) => {
    try {
      const user = await createUser(pool, req.body?.email, req.body?.password)
      const token = await createSession(pool, user.id)
      res.status(201).json({ token, user })
    } catch (e) { next(e) }
  })

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const u = await findUserByEmail(pool, req.body?.email)
      if (!u || !verifyPassword(String(req.body?.password ?? ''), u.password_hash)) {
        return res.status(401).json({ error: 'invalid email or password' })
      }
      const token = await createSession(pool, u.id)
      res.json({ token, user: { id: u.id, email: u.email } })
    } catch (e) { next(e) }
  })

  app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
    try { await deleteSession(pool, bearerToken(req)); res.status(204).end() } catch (e) { next(e) }
  })

  app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user))

  // --- todos (all owner-scoped, behind auth) ---
  app.get('/api/todos', requireAuth, async (req, res, next) => {
    try { res.json(await listTodos(pool, req.userId)) } catch (e) { next(e) }
  })

  app.post('/api/todos', requireAuth, async (req, res, next) => {
    try { res.status(201).json(await createTodo(pool, req.userId, req.body?.title)) } catch (e) { next(e) }
  })

  app.patch('/api/todos/:id', requireAuth, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      const row = await updateTodo(pool, req.userId, req.params.id, {
        title: req.body?.title,
        completed: req.body?.completed,
      })
      if (!row) return res.status(404).json({ error: 'not found' })
      res.json(row)
    } catch (e) { next(e) }
  })

  app.delete('/api/todos', requireAuth, async (req, res, next) => {
    try {
      if (req.query.completed === 'true') return res.json({ deleted: await clearCompleted(pool, req.userId) })
      res.status(400).json({ error: 'specify ?completed=true to clear completed todos' })
    } catch (e) { next(e) }
  })

  app.delete('/api/todos/:id', requireAuth, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      if (await deleteTodo(pool, req.userId, req.params.id)) return res.status(204).end()
      res.status(404).json({ error: 'not found' })
    } catch (e) { next(e) }
  })

  app.use(express.static(path.join(__dirname, 'public')))

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message })
    if (err instanceof EmailTakenError) return res.status(409).json({ error: err.message })
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })

  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = makeApp(makePool())
  const port = Number(process.env.PORT) || 8080
  app.listen(port, () => console.log(`todo app listening on :${port}`))
}
```

- [ ] **Step 2: Start the server and verify auth + isolation via curl**

Run the server (background) against the branch DB, then exercise it:
```bash
cd /Users/junwen/Work/Personal/firth/samples/todo
node --env-file=../.env server.js & SERVER_PID=$!
sleep 2
B="localhost:8080"
# no token → 401
curl -s -o /dev/null -w 'no-token GET todos -> %{http_code}\n' $B/api/todos
# register two users
TA=$(curl -s -X POST $B/api/auth/register -H 'content-type: application/json' -d '{"email":"alice@example.com","password":"password1"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
TB=$(curl -s -X POST $B/api/auth/register -H 'content-type: application/json' -d '{"email":"bob@example.com","password":"password2"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
# duplicate email → 409
curl -s -o /dev/null -w 'dup email -> %{http_code}\n' -X POST $B/api/auth/register -H 'content-type: application/json' -d '{"email":"alice@example.com","password":"password1"}'
# alice creates a todo
AID=$(curl -s -X POST $B/api/todos -H "authorization: Bearer $TA" -H 'content-type: application/json' -d '{"title":"alice-todo"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
# bob sees none of alice's
echo "bob list: $(curl -s $B/api/todos -H "authorization: Bearer $TB")"   # expect []
echo "alice list: $(curl -s $B/api/todos -H "authorization: Bearer $TA")" # expect alice-todo
# bob cannot patch alice's todo → 404
curl -s -o /dev/null -w 'bob patch alice -> %{http_code}\n' -X PATCH $B/api/todos/$AID -H "authorization: Bearer $TB" -H 'content-type: application/json' -d '{"completed":true}'
# me + logout
curl -s $B/api/auth/me -H "authorization: Bearer $TA"; echo
curl -s -o /dev/null -w 'logout -> %{http_code}\n' -X POST $B/api/auth/logout -H "authorization: Bearer $TA"
curl -s -o /dev/null -w 'after logout -> %{http_code}\n' $B/api/todos -H "authorization: Bearer $TA"  # 401
kill $SERVER_PID
# Clean up the users this check created so Task 7's live smoke can reuse these emails:
psql "$(grep '^DATABASE_URL=' ../.env | cut -d= -f2-)" -c "delete from users where email in ('alice@example.com','bob@example.com');"
```
Expected: no-token→401; two registers return tokens; dup email→409; bob list `[]`; alice list contains `alice-todo`; bob patch alice→404; `/me` returns alice; logout→204; after logout→401; cleanup `DELETE 2`.

- [ ] **Step 3: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add samples/todo/server.js
git commit -m "feat(todo): auth middleware, auth routes, owner-scoped todo routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend — auth view + gated todo UI

**Files:**
- Modify: `todo/public/index.html`
- Modify: `todo/public/app.js`
- Modify: `todo/public/style.css`

**Interfaces:**
- Consumes: the auth + todo API (Task 5).
- Produces: a login/register view gated in front of the todo view; token in `localStorage`; `Authorization` header on every request; transparent return to login on 401.

- [ ] **Step 1: Replace `todo/public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Firth Todo</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="app">
    <h1>Todo</h1>
    <div id="error" class="error" role="alert" hidden title="Click to dismiss"></div>

    <section id="auth-view" hidden>
      <form id="auth-form" class="new">
        <input id="auth-email" type="email" placeholder="email" autocomplete="username" />
        <input id="auth-password" type="password" placeholder="password (8+ chars)" autocomplete="current-password" />
        <button type="submit" id="auth-submit">Log in</button>
      </form>
      <p class="auth-toggle">
        <span id="auth-mode-label">No account?</span>
        <a href="#" id="auth-toggle">Register</a>
      </p>
    </section>

    <section id="todo-view" hidden>
      <div class="topbar">
        <span id="who" class="who"></span>
        <button type="button" id="logout" class="link-btn">Log out</button>
      </div>
      <form id="new-form" class="new">
        <input id="new-input" type="text" placeholder="What needs doing?" autocomplete="off" maxlength="500" />
        <button type="submit">Add</button>
      </form>
      <ul id="list" class="list"></ul>
      <footer class="footer">
        <span id="count" class="count"></span>
        <div class="filters">
          <button type="button" data-filter="all" class="active">All</button>
          <button type="button" data-filter="active">Active</button>
          <button type="button" data-filter="completed">Completed</button>
        </div>
        <button type="button" id="clear-completed" class="link-btn">Clear completed</button>
      </footer>
    </section>
  </main>
  <script src="/app.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Replace `todo/public/app.js`**

```js
const $ = (id) => document.getElementById(id)
const errorEl = $('error')
const authView = $('auth-view'), todoView = $('todo-view')
const authForm = $('auth-form'), authEmail = $('auth-email'), authPassword = $('auth-password')
const authSubmit = $('auth-submit'), authToggle = $('auth-toggle'), authModeLabel = $('auth-mode-label')
const whoEl = $('who'), logoutBtn = $('logout')
const listEl = $('list'), countEl = $('count'), form = $('new-form'), input = $('new-input')
const clearBtn = $('clear-completed'), filterBtns = [...document.querySelectorAll('.filters button')]

let todos = []
let filter = 'all'
let mode = 'login'
let token = localStorage.getItem('todo_token')

const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false }
const clearError = () => { errorEl.hidden = true }

async function api(method, pathName, body) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(pathName, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (res.status === 401) {
    token = null
    localStorage.removeItem('todo_token')
    showAuth()
    throw new Error('Please log in')
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try { const j = await res.json(); if (j.error) msg = j.error } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.status === 204 ? null : res.json()
}

function showAuth() { authView.hidden = false; todoView.hidden = true }
function showTodos(email) { authView.hidden = true; todoView.hidden = false; whoEl.textContent = email }

// --- auth ---
authToggle.addEventListener('click', (e) => {
  e.preventDefault()
  mode = mode === 'login' ? 'register' : 'login'
  authSubmit.textContent = mode === 'login' ? 'Log in' : 'Register'
  authModeLabel.textContent = mode === 'login' ? 'No account?' : 'Have an account?'
  authToggle.textContent = mode === 'login' ? 'Register' : 'Log in'
  clearError()
})

authForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = authEmail.value.trim()
  const password = authPassword.value
  if (!email || !password) return
  try {
    const out = await api('POST', `/api/auth/${mode}`, { email, password })
    token = out.token
    localStorage.setItem('todo_token', token)
    authPassword.value = ''
    clearError()
    showTodos(out.user.email)
    await load()
  } catch (err) { showError(err.message) }
})

logoutBtn.addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout') } catch { /* ignore */ }
  token = null
  localStorage.removeItem('todo_token')
  todos = []
  showAuth()
})

// --- todos ---
function visible() {
  if (filter === 'active') return todos.filter((t) => !t.completed)
  if (filter === 'completed') return todos.filter((t) => t.completed)
  return todos
}

function render() {
  listEl.replaceChildren(...visible().map(renderItem))
  const remaining = todos.filter((t) => !t.completed).length
  countEl.textContent = `${remaining} item${remaining === 1 ? '' : 's'} left`
  for (const b of filterBtns) b.classList.toggle('active', b.dataset.filter === filter)
}

function renderItem(t) {
  const li = document.createElement('li')
  li.className = 'item' + (t.completed ? ' done' : '')

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = t.completed
  cb.addEventListener('change', () => toggle(t, cb.checked))

  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = t.title // textContent → XSS-safe
  title.title = 'Double-click to edit'
  title.addEventListener('dblclick', () => beginEdit(t, li, title))

  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'del'
  del.textContent = '×'
  del.setAttribute('aria-label', 'Delete')
  del.addEventListener('click', () => remove(t))

  li.append(cb, title, del)
  return li
}

function beginEdit(t, li, title) {
  const edit = document.createElement('input')
  edit.type = 'text'
  edit.className = 'edit'
  edit.value = t.title
  edit.maxLength = 500
  li.replaceChild(edit, title)
  edit.focus()
  let finished = false
  const commit = async () => {
    if (finished) return
    finished = true
    const v = edit.value.trim()
    if (v && v !== t.title) {
      try { Object.assign(t, await api('PATCH', `/api/todos/${t.id}`, { title: v })) }
      catch (e) { showError(e.message) }
    }
    render()
  }
  edit.addEventListener('blur', commit)
  edit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') edit.blur()
    if (e.key === 'Escape') { finished = true; render() }
  })
}

async function toggle(t, completed) {
  try { Object.assign(t, await api('PATCH', `/api/todos/${t.id}`, { completed })) }
  catch (e) { showError(e.message) }
  render()
}

async function remove(t) {
  try { await api('DELETE', `/api/todos/${t.id}`); todos = todos.filter((x) => x.id !== t.id); render() }
  catch (e) { showError(e.message) }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const v = input.value.trim()
  if (!v) return
  try {
    todos.push(await api('POST', '/api/todos', { title: v }))
    input.value = ''
    clearError()
    render()
  } catch (err) { showError(err.message) }
})

clearBtn.addEventListener('click', async () => {
  try { await api('DELETE', '/api/todos?completed=true'); todos = todos.filter((t) => !t.completed); render() }
  catch (e) { showError(e.message) }
})

for (const b of filterBtns) b.addEventListener('click', () => { filter = b.dataset.filter; render() })
errorEl.addEventListener('click', clearError)

async function load() {
  try { todos = await api('GET', '/api/todos'); clearError(); render() }
  catch (e) { if (token) showError(e.message) } // a 401 already cleared the token + showed auth
}

// --- bootstrap: validate any stored token, else show the auth view ---
;(async () => {
  if (!token) { showAuth(); return }
  try {
    const me = await api('GET', '/api/auth/me')
    showTodos(me.email)
    await load()
  } catch { /* 401 already cleared token + showed auth */ }
})()
```

- [ ] **Step 3: Add auth/topbar styles to `todo/public/style.css`**

Append these rules to the end of the existing `todo/public/style.css` (leave existing rules unchanged):

```css
.topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.who { flex: 1; color: var(--muted); font-size: 14px; }
.link-btn { background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px 8px; font-size: 14px; }
.link-btn:hover { color: var(--danger); }
.auth-toggle { color: var(--muted); font-size: 14px; margin: 8px 2px 0; }
.auth-toggle a { color: var(--accent); }
#auth-password { font-family: inherit; }
```

- [ ] **Step 4: Verify static serving + markers**

Run the server (background) against the branch DB and check the static assets:
```bash
cd /Users/junwen/Work/Personal/firth/samples/todo
node --env-file=../.env server.js & SERVER_PID=$!
sleep 2
curl -s -o /dev/null -w '/          -> %{http_code} %{content_type}\n' localhost:8080/
curl -s localhost:8080/ | grep -c -e 'id="auth-view"' -e 'id="todo-view"' -e 'id="auth-form"' -e 'id="logout"'  # expect 4
curl -s -o /dev/null -w '/app.js     -> %{http_code}\n' localhost:8080/app.js
curl -s localhost:8080/app.js | grep -c "localStorage.getItem('todo_token')"   # expect >=1
curl -s -o /dev/null -w '/style.css  -> %{http_code}\n' localhost:8080/style.css
kill $SERVER_PID
```
Expected: `/`→200 text/html with all 4 markers; `/app.js`→200 and references the token storage; `/style.css`→200. (Full interactive UI is validated live in Task 7.)

- [ ] **Step 5: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add samples/todo/public
git commit -m "feat(todo): login/register view gating the todo UI; bearer-token auth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Containerize, deploy to the Firth branch, validate isolation live

**Files:**
- Modify: `todo/Dockerfile` (add `auth.js` to the COPY)

**Interfaces:**
- Consumes: the app (Tasks 3–6); the Firth `multi-tenant` branch's compute.
- Produces: image `ghcr.io/jwfing/firth-todo:2` (public) running on the branch's Fly app, validated for auth + isolation.

- [ ] **Step 1: Update `todo/Dockerfile` to copy `auth.js`**

Change the source-copy line so `auth.js` is included. The file becomes:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js db.js auth.js ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
```

- [ ] **Step 2: Build the image for amd64**

Run:
```bash
cd /Users/junwen/Work/Personal/firth/samples/todo
docker build --platform linux/amd64 -t ghcr.io/jwfing/firth-todo:2 .
```
Expected: build succeeds, tagging `ghcr.io/jwfing/firth-todo:2`.

- [ ] **Step 3: Push to GHCR (already a public package from tag :1)**

Run:
```bash
gh auth token | docker login ghcr.io -u jwfing --password-stdin
docker push ghcr.io/jwfing/firth-todo:2
```
Expected: `Login Succeeded`; layers push with a final `digest:` line. (If push is denied, `gh auth refresh -h github.com -s write:packages` then retry.) The `firth-todo` package is already public, so tag `:2` is publicly pullable.

- [ ] **Step 4: Deploy to the branch's compute**

Ensure you are on the Firth `multi-tenant` branch, then deploy:
```bash
cd /Users/junwen/Work/Personal/firth/samples
firth status                      # expect branch: multi-tenant (re-login if a later cmd 500s)
firth deploy --image ghcr.io/jwfing/firth-todo:2 --port 8080
```
Expected: `deployed machine <id> → https://<branch-app>.fly.dev`. Capture that URL. (The fixed Fly adapter allocates the public IP on deploy.)

- [ ] **Step 5: Live smoke — auth + isolation**

Substitute the branch URL; allow boot + IP propagation:
```bash
URL=https://<branch-app>.fly.dev
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL/healthz")" = "200" ] && break; sleep 3; done
echo "health: $(curl -s "$URL/healthz")"
TA=$(curl -s -X POST "$URL/api/auth/register" -H 'content-type: application/json' -d '{"email":"alice@example.com","password":"password1"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
TB=$(curl -s -X POST "$URL/api/auth/register" -H 'content-type: application/json' -d '{"email":"bob@example.com","password":"password2"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
AID=$(curl -s -X POST "$URL/api/todos" -H "authorization: Bearer $TA" -H 'content-type: application/json' -d '{"title":"alice-todo"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "bob sees: $(curl -s "$URL/api/todos" -H "authorization: Bearer $TB")"          # expect []
echo "alice sees: $(curl -s "$URL/api/todos" -H "authorization: Bearer $TA")"        # expect alice-todo
curl -s -o /dev/null -w 'bob patch alice -> %{http_code} (expect 404)\n' -X PATCH "$URL/api/todos/$AID" -H "authorization: Bearer $TB" -H 'content-type: application/json' -d '{"completed":true}'
curl -s -o /dev/null -w 'no-token -> %{http_code} (expect 401)\n' "$URL/api/todos"
```
Expected: health ok; two tokens; bob sees `[]`; alice sees `alice-todo`; bob→alice patch 404; no-token 401. Also open `$URL` in a browser: register, add todos, log out, log in as a second account, confirm separate lists.

- [ ] **Step 6: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add samples/todo/Dockerfile
git commit -m "feat(todo): include auth.js in the image

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Promote to `main` and tear down the branch — RUN ONLY AFTER THE FINAL WHOLE-BRANCH REVIEW PASSES

**Files:** none beyond the git merge (operational).

**Interfaces:**
- Consumes: the validated `feat/multi-tenant` git branch + the `:2` image.
- Produces: multi-tenant todo live on `main`'s compute; Firth `multi-tenant` branch and the git branch deleted.

- [ ] **Step 1: Merge the code into `main`**

```bash
cd /Users/junwen/Work/Personal/firth
git checkout main
git merge --no-ff feat/multi-tenant -m "Merge feat/multi-tenant: accounts + per-user todo isolation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: clean merge (no conflicts — the branch only adds/edits `samples/todo/*`, `samples/migrations/002_*`, and docs).

- [ ] **Step 2: Switch the Firth branch back to main and refresh creds**

```bash
cd /Users/junwen/Work/Personal/firth/samples
firth branch switch main
firth secrets            # ./.env now targets MAIN's DB (re-login if it 500s)
firth status             # expect branch: (default)/main
```

- [ ] **Step 3: Run the migration against MAIN's DB**

```bash
cd /Users/junwen/Work/Personal/firth/samples
export DATABASE_URL="$(grep '^DATABASE_URL=' ./.env | cut -d= -f2-)"
psql "$DATABASE_URL" -f migrations/002_multi_tenant.sql
psql "$DATABASE_URL" -c '\d users' -c '\d todos'   # verify users table + todos.user_id exist on main
```
Expected: migration applies to main's DB (this deletes main's pre-existing ownerless todo — approved).

- [ ] **Step 4: Deploy the `:2` image to main's compute**

```bash
cd /Users/junwen/Work/Personal/firth/samples
firth deploy --image ghcr.io/jwfing/firth-todo:2 --port 8080
```
Expected: `deployed machine <id> → https://firth-first-94ad5009.fly.dev` (main's app). The image is the same `:2`; only the injected `DATABASE_URL` differs (main's DB).

- [ ] **Step 5: Smoke-test main**

```bash
URL=https://firth-first-94ad5009.fly.dev
for i in $(seq 1 20); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL/healthz")" = "200" ] && break; sleep 3; done
echo "health: $(curl -s "$URL/healthz")"
curl -s -o /dev/null -w 'no-token todos -> %{http_code} (expect 401)\n' "$URL/api/todos"
T=$(curl -s -X POST "$URL/api/auth/register" -H 'content-type: application/json' -d '{"email":"demo@example.com","password":"password1"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -X POST "$URL/api/todos" -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"title":"hello multi-tenant"}' >/dev/null
echo "list: $(curl -s "$URL/api/todos" -H "authorization: Bearer $T")"   # expect the new todo
```
Expected: health ok; no-token 401; register works; the user sees their todo.

- [ ] **Step 6: Tear down the Firth branch and delete the git branch (approved)**

```bash
cd /Users/junwen/Work/Personal/firth/samples
firth branch delete multi-tenant --yes     # destroys the branch's Neon DB branch + its Fly app
cd /Users/junwen/Work/Personal/firth
git branch -d feat/multi-tenant
```
Expected: Firth branch torn down; git branch deleted (all commits are now on `main`).

- [ ] **Step 7: (Optional) push main**

```bash
git push origin main
```

---

## Notes for the implementer

- **Don't commit `samples/.env` or `node_modules/`** — both are git-ignored.
- **One image tag `:2` serves both** the branch (Task 7) and main (Task 8); the app reads `DATABASE_URL` from the injected env, so the same image talks to whichever DB its compute was given.
- **Firth token (~15-min TTL):** if any `firth` command returns `500 internal error`, run `firth login --email jwfing@gmail.com --password <pw>` and retry. This is most likely during Tasks 1, 2, 7, 8.
- **The data-layer tests are safe to run anytime** — each runs inside a transaction that is rolled back, so they never persist data even against a live branch DB.
- **Task 8 is the promotion/merge** — do it only after the final whole-branch review of `feat/multi-tenant` passes, and migrate main's DB (Step 3) *before* deploying the new image to main (Step 4) so the live app never hits a schema it expects but doesn't have.

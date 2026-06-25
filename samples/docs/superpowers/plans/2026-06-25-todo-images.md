# Todo Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach one optional image to a todo at creation time; the image is stored in the public InsForge S3 bucket and shown as a thumbnail.

**Architecture:** The Express backend receives the new todo as `multipart/form-data` (title + optional image), uploads the image to the public bucket through the S3 gateway (`@aws-sdk/client-s3`), and stores `image_url` + `image_key` on the `todos` row. The frontend renders `t.image_url` with a plain `<img>`. Deleting a todo best-effort deletes its storage object.

**Tech Stack:** Node ESM, Express 4, `pg`, `@aws-sdk/client-s3`, `multer`, `supertest` (dev), vanilla JS frontend, `node:test`.

**Spec:** [`docs/superpowers/specs/2026-06-25-todo-images-design.md`](../specs/2026-06-25-todo-images-design.md)

## Global Constraints

- **One optional image per todo, set only at creation** (`POST /api/todos`). Never edited/replaced after; deleting the todo deletes its image.
- **Approach B — public bucket + public URL.** Store `image_url` (display) + `image_key` (delete). `image_key` is server-internal and never returned to clients.
- **Upload to storage via the S3 gateway** using the app's existing `.env` vars (`AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BUCKET_NAME`). **`forcePathStyle: true` is required.** No new secrets.
- **Object key:** `todos/{uuid}.{ext}` (random UUID; `{ext}` from validated content type).
- **Allowed content types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`. **Max size: 5 MB** (5 * 1024 * 1024 bytes).
- **Delete is best-effort:** DB row removed first; a storage-delete failure is logged, not surfaced (orphaned objects acceptable).
- **Data-layer return shapes (changed):** `deleteTodo → { deleted: boolean, imageKey: string | null }`; `clearCompleted → { count: number, imageKeys: string[] }` (only non-null keys).
- **Migration `003` is purely additive** (two nullable columns) and idempotent (`if not exists`) — safe to run on any DB.
- **Unchanged guarantees:** titles render via `textContent` (XSS-safe); all SQL parameterized; todo rows stay owner-scoped.
- **Test command:** from `samples/todo/`, `node --env-file=../.env --test` (a single file: `node --env-file=../.env --test test/<file>.test.js`). `DATABASE_URL` and the `AWS_*` vars come from `samples/.env`.

---

## File Structure

- **Create** `todo/storage.js` — S3 wrapper: upload/delete + pure helpers (key gen, public-URL build, content-type→ext). Single responsibility, client injectable for tests.
- **Create** `todo/test/storage.test.js` — unit tests for `storage.js` (injected fake S3 client; no network).
- **Create** `migrations/003_todo_images.sql` — adds `image_url`, `image_key` to `todos`.
- **Create** `todo/test/routes.test.js` — HTTP route tests via `supertest` + a fake storage (real DB, rolled-back tx).
- **Modify** `todo/db.js` — `COLS`, `createTodo`, `deleteTodo`, `clearCompleted`; export `cleanTitle`.
- **Modify** `todo/server.js` — `multer`, `makeApp(pool, storage)`, create/delete route wiring, multer error mapping.
- **Modify** `todo/test/todos.test.js` — add image-column tests; update the changed `deleteTodo`/`clearCompleted` assertions.
- **Modify** `todo/public/index.html` — file input in the new-todo form.
- **Modify** `todo/public/app.js` — `FormData` support in `api()`; image in create submit; thumbnail in `renderItem`.
- **Modify** `todo/public/style.css` — `.thumb` + file-input styling.
- **Modify** `todo/package.json` — add `@aws-sdk/client-s3`, `multer`, `supertest`.

---

## Task 1: Storage module (`todo/storage.js`)

**Files:**
- Create: `todo/storage.js`
- Create: `todo/test/storage.test.js`
- Modify: `todo/package.json` (add `@aws-sdk/client-s3`)

**Interfaces:**
- Produces:
  - `makeStorage(env = process.env, client?) → { uploadImage(buffer, contentType) → Promise<{key,url}>, deleteImage(key) → Promise<void>, deleteImages(keys) → Promise<void>, publicUrl(key) → string }`
  - `contentTypeToExt(type) → string` (throws on unsupported)
  - `publicBaseFromEndpoint(endpoint) → string`
  - `ALLOWED_IMAGE_TYPES: Set<string>`, `MAX_IMAGE_BYTES: number`
- Consumes: nothing from other tasks.

- [ ] **Step 1: Install the AWS S3 client**

Run from `samples/todo/`:
```bash
cd /Users/junwen/Work/Personal/firth/samples/todo
npm install @aws-sdk/client-s3
```
Expected: `package.json` gains `@aws-sdk/client-s3` under dependencies; `npm` exits 0.

- [ ] **Step 2: Write the failing tests** — create `todo/test/storage.test.js`

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeStorage, contentTypeToExt, publicBaseFromEndpoint,
  ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES,
} from '../storage.js'

const ENV = {
  AWS_ENDPOINT_URL_S3: 'https://app.us-east.insforge.app/storage/v1/s3',
  AWS_REGION: 'us-east-2',
  AWS_ACCESS_KEY_ID: 'x',
  AWS_SECRET_ACCESS_KEY: 'y',
  BUCKET_NAME: 'mybucket',
}

// A fake S3 client: records every command's `.input` instead of hitting the network.
function fakeClient() {
  const sent = []
  return { sent, async send(cmd) { sent.push(cmd); return {} } }
}

test('constants', () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024)
  assert.ok(ALLOWED_IMAGE_TYPES.has('image/jpeg'))
  assert.ok(!ALLOWED_IMAGE_TYPES.has('text/plain'))
})

test('publicBaseFromEndpoint strips the /storage/v1/s3 suffix', () => {
  assert.equal(
    publicBaseFromEndpoint('https://app.us-east.insforge.app/storage/v1/s3'),
    'https://app.us-east.insforge.app',
  )
  assert.equal(
    publicBaseFromEndpoint('https://app.us-east.insforge.app/storage/v1/s3/'),
    'https://app.us-east.insforge.app',
  )
})

test('contentTypeToExt maps allowed types and rejects others', () => {
  assert.equal(contentTypeToExt('image/jpeg'), 'jpg')
  assert.equal(contentTypeToExt('image/png'), 'png')
  assert.equal(contentTypeToExt('image/webp'), 'webp')
  assert.equal(contentTypeToExt('image/gif'), 'gif')
  assert.throws(() => contentTypeToExt('text/plain'))
})

test('publicUrl builds the public object URL', () => {
  const s = makeStorage(ENV, fakeClient())
  assert.equal(
    s.publicUrl('todos/abc.jpg'),
    'https://app.us-east.insforge.app/api/storage/buckets/mybucket/objects/todos/abc.jpg',
  )
})

test('uploadImage sends PutObject with the right params and returns key+url', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  const { key, url } = await s.uploadImage(Buffer.from('data'), 'image/png')
  assert.match(key, /^todos\/[0-9a-f-]+\.png$/)
  assert.equal(url, s.publicUrl(key))
  assert.equal(client.sent.length, 1)
  const input = client.sent[0].input
  assert.equal(input.Bucket, 'mybucket')
  assert.equal(input.Key, key)
  assert.equal(input.ContentType, 'image/png')
  assert.equal(input.Body.toString(), 'data')
})

test('deleteImage sends DeleteObject', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  await s.deleteImage('todos/x.jpg')
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].input.Bucket, 'mybucket')
  assert.equal(client.sent[0].input.Key, 'todos/x.jpg')
})

test('deleteImages is a no-op for empty input', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  await s.deleteImages([])
  assert.equal(client.sent.length, 0)
})

test('deleteImages sends one DeleteObjects with all keys', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  await s.deleteImages(['todos/a.jpg', 'todos/b.png'])
  assert.equal(client.sent.length, 1)
  assert.deepEqual(
    client.sent[0].input.Delete.Objects,
    [{ Key: 'todos/a.jpg' }, { Key: 'todos/b.png' }],
  )
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --env-file=../.env --test test/storage.test.js`
Expected: FAIL — cannot find module `../storage.js`.

- [ ] **Step 4: Implement `todo/storage.js`**

```javascript
import {
  S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function contentTypeToExt(type) {
  const ext = EXT_BY_TYPE[type]
  if (!ext) throw new Error(`unsupported image type: ${type}`)
  return ext
}

// The S3 gateway endpoint is `<host>/storage/v1/s3`; public objects are served off the host root.
export function publicBaseFromEndpoint(endpoint) {
  return String(endpoint ?? '').replace(/\/storage\/v1\/s3\/?$/, '').replace(/\/$/, '')
}

export function makeStorage(env = process.env, client) {
  const bucket = env.BUCKET_NAME
  const base = publicBaseFromEndpoint(env.AWS_ENDPOINT_URL_S3)
  const s3 = client ?? new S3Client({
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  })

  // NOTE: this URL shape is verified live in Task 2; adjust here + the publicUrl test if it differs.
  const publicUrl = (key) => `${base}/api/storage/buckets/${bucket}/objects/${key}`

  return {
    publicUrl,
    async uploadImage(buffer, contentType) {
      const key = `todos/${randomUUID()}.${contentTypeToExt(contentType)}`
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: contentType,
      }))
      return { key, url: publicUrl(key) }
    },
    async deleteImage(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },
    async deleteImages(keys) {
      if (!keys || keys.length === 0) return
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) },
      }))
    },
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --env-file=../.env --test test/storage.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/junwen/Work/Personal/firth/samples
git add todo/storage.js todo/test/storage.test.js todo/package.json todo/package-lock.json
git commit -m "feat(todo): storage module for S3 image upload/delete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Verify the public object URL format against live storage

This locks the one unknown in `storage.js` (`publicUrl`) before anything depends on it. It needs Task 1's dependency installed and network access to the project's InsForge storage.

**Files:**
- Modify (only if the live check disagrees): `todo/storage.js` (`publicUrl`), `todo/test/storage.test.js` (the `publicUrl` expectation)

**Interfaces:**
- Consumes: `makeStorage` (Task 1).
- Produces: a confirmed-correct `publicUrl` format + a public bucket.

- [ ] **Step 1: Upload a probe object and print the guessed public URL**

Run from `samples/todo/`:
```bash
node --env-file=../.env -e "import('./storage.js').then(async ({ makeStorage }) => { const s = makeStorage(); const { key, url } = await s.uploadImage(Buffer.from([0xff,0xd8,0xff,0xd9]), 'image/jpeg'); console.log('KEY=' + key); console.log('URL=' + url); })"
```
Expected: prints `KEY=todos/<uuid>.jpg` and `URL=<guessed public url>`. (If this errors with credentials/endpoint, fix the `.env` via `firth secrets` first.)

- [ ] **Step 2: Check whether the guessed URL serves the object**

Run (substitute the printed `URL=`):
```bash
curl -sS -o /dev/null -w "%{http_code}\n" "<URL from step 1>"
```
Expected: `200`.

- [ ] **Step 3: If not 200, find the working format and update the code**

If `403`: the bucket is likely private — make `BUCKET_NAME` public (InsForge Dashboard → Storage → bucket → set public, or recreate it public) and re-run Step 2.
If `404`: try these candidate shapes against the same `KEY` until one returns `200`:
```bash
BASE="https://<app-key>.<region>.insforge.app"   # AWS_ENDPOINT_URL_S3 minus /storage/v1/s3
KEY="todos/<uuid>.jpg"
BUCKET="<BUCKET_NAME>"
for u in \
  "$BASE/api/storage/buckets/$BUCKET/objects/$KEY" \
  "$BASE/storage/v1/object/public/$BUCKET/$KEY" \
  "$BASE/storage/v1/buckets/$BUCKET/objects/$KEY" ; do
  printf '%s -> ' "$u"; curl -sS -o /dev/null -w "%{http_code}\n" "$u"
done
```
Then set `publicUrl` in `todo/storage.js` to the winning shape and update the `publicUrl` test expectation in `todo/test/storage.test.js` to match. Re-run `node --env-file=../.env --test test/storage.test.js` → PASS.

- [ ] **Step 4: Delete the probe object**

Run (substitute `KEY` from Step 1):
```bash
node --env-file=../.env -e "import('./storage.js').then(async ({ makeStorage }) => { await makeStorage().deleteImage('<KEY from step 1>'); console.log('probe deleted'); })"
```
Expected: `probe deleted`.

- [ ] **Step 5: Commit (only if the format changed)**

```bash
cd /Users/junwen/Work/Personal/firth/samples
git add todo/storage.js todo/test/storage.test.js
git commit -m "fix(todo): lock verified public object URL format

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
If nothing changed, skip the commit and note "public URL format confirmed as the default shape."

---

## Task 3: Migration + data layer (`migrations/003`, `db.js`)

**Files:**
- Create: `migrations/003_todo_images.sql`
- Modify: `todo/db.js` (`COLS` line 4; `createTodo` ~lines 107-114; `deleteTodo` ~lines 135-141; `clearCompleted` ~lines 143-149; export `cleanTitle`)
- Modify: `todo/test/todos.test.js` (add tests; update 3 existing assertions)

**Interfaces:**
- Consumes: existing `db.js` (`makePool`, `createTodo`, `updateTodo`, `listTodos`, `createUser`).
- Produces:
  - `createTodo(db, userId, title, image?) → row` where `image` is `{ imageUrl, imageKey }` (optional). Row includes `image_url`, not `image_key`.
  - `deleteTodo(db, userId, id) → { deleted: boolean, imageKey: string | null }`
  - `clearCompleted(db, userId) → { count: number, imageKeys: string[] }`
  - `cleanTitle(title) → string` (now exported; throws `ValidationError`)

- [ ] **Step 1: Create `migrations/003_todo_images.sql`**

```sql
-- 003_todo_images.sql — one optional image per todo (public-bucket URL + storage key).
-- Additive and idempotent: two nullable columns; existing rows are unaffected.
alter table todos add column if not exists image_url text;
alter table todos add column if not exists image_key text;
```

- [ ] **Step 2: Apply the migration to the active DB**

Run from `samples/`:
```bash
cd /Users/junwen/Work/Personal/firth/samples
export DATABASE_URL="$(grep '^DATABASE_URL=' ./.env | cut -d= -f2-)"
psql "$DATABASE_URL" -f migrations/003_todo_images.sql
psql "$DATABASE_URL" -c '\d todos'
```
Expected: `ALTER TABLE` (x2); `\d todos` lists `image_url | text` and `image_key | text`.

- [ ] **Step 3: Write the failing data-layer tests** — append to `todo/test/todos.test.js`

```javascript
// --- todos: images ---
test('createTodo with an image stores image_url and hides image_key from clients', async () => {
  const t = await createTodo(client, userA.id, 'pic', { imageUrl: 'https://x/y.jpg', imageKey: 'todos/y.jpg' })
  assert.equal(t.image_url, 'https://x/y.jpg')
  assert.equal(t.image_key, undefined) // image_key is server-internal, not in COLS
})

test('createTodo without an image leaves image_url null', async () => {
  const t = await createTodo(client, userA.id, 'nopic')
  assert.equal(t.image_url, null)
})

test('listTodos includes image_url', async () => {
  await createTodo(client, userA.id, 'pic', { imageUrl: 'https://x/y.jpg', imageKey: 'todos/y.jpg' })
  const [row] = await listTodos(client, userA.id)
  assert.equal(row.image_url, 'https://x/y.jpg')
})

test('deleteTodo returns { deleted, imageKey } for an owned row', async () => {
  const t = await createTodo(client, userA.id, 'pic', { imageUrl: 'u', imageKey: 'todos/y.jpg' })
  assert.deepEqual(await deleteTodo(client, userA.id, t.id), { deleted: true, imageKey: 'todos/y.jpg' })
})

test('deleteTodo returns deleted:true, imageKey:null for an owned row with no image', async () => {
  const t = await createTodo(client, userA.id, 'nopic')
  assert.deepEqual(await deleteTodo(client, userA.id, t.id), { deleted: true, imageKey: null })
})

test('clearCompleted returns { count, imageKeys } with only non-null keys', async () => {
  const a1 = await createTodo(client, userA.id, 'withpic', { imageUrl: 'u', imageKey: 'todos/k1.jpg' })
  const a2 = await createTodo(client, userA.id, 'nopic')
  await updateTodo(client, userA.id, a1.id, { completed: true })
  await updateTodo(client, userA.id, a2.id, { completed: true })
  const res = await clearCompleted(client, userA.id)
  assert.equal(res.count, 2)
  assert.deepEqual(res.imageKeys, ['todos/k1.jpg'])
})
```

- [ ] **Step 4: Update the 3 existing assertions that change shape** — in `todo/test/todos.test.js`

In `test('deleteTodo returns false for another user\'s todo and leaves it intact', ...)` replace:
```javascript
  assert.equal(await deleteTodo(client, userA.id, t.id), false)
```
with:
```javascript
  assert.equal((await deleteTodo(client, userA.id, t.id)).deleted, false)
```

In `test('updateTodo / deleteTodo return null/false for a missing id', ...)` replace:
```javascript
  assert.equal(await deleteTodo(client, userA.id, MISSING_ID), false)
```
with:
```javascript
  assert.equal((await deleteTodo(client, userA.id, MISSING_ID)).deleted, false)
```

In `test('clearCompleted clears only the caller\'s completed todos', ...)` replace:
```javascript
  assert.equal(await clearCompleted(client, userA.id), 1)
```
with:
```javascript
  assert.equal((await clearCompleted(client, userA.id)).count, 1)
```

- [ ] **Step 5: Run the tests to verify the new/changed ones fail**

Run: `node --env-file=../.env --test test/todos.test.js`
Expected: FAIL — `createTodo` ignores the 4th arg (image_url null), `deleteTodo`/`clearCompleted` return the old types.

- [ ] **Step 6: Update `todo/db.js`**

Change `COLS` (line 4) to include `image_url` (but NOT `image_key`):
```javascript
const COLS = 'id, title, completed, image_url, created_at, updated_at'
```

Export `cleanTitle` — change its declaration (line 24) from `function cleanTitle(title) {` to:
```javascript
export function cleanTitle(title) {
```

Replace `createTodo` (lines ~107-114) with:
```javascript
export async function createTodo(db, userId, title, image) {
  const t = cleanTitle(title)
  const { rows } = await db.query(
    `insert into todos (user_id, title, image_url, image_key)
     values ($1, $2, $3, $4) returning ${COLS}`,
    [userId, t, image?.imageUrl ?? null, image?.imageKey ?? null],
  )
  return rows[0]
}
```

Replace `deleteTodo` (lines ~135-141) with:
```javascript
export async function deleteTodo(db, userId, id) {
  const { rows } = await db.query(
    'delete from todos where id = $1 and user_id = $2 returning image_key',
    [id, userId],
  )
  if (rows.length === 0) return { deleted: false, imageKey: null }
  return { deleted: true, imageKey: rows[0].image_key }
}
```

Replace `clearCompleted` (lines ~143-149) with:
```javascript
export async function clearCompleted(db, userId) {
  const { rows } = await db.query(
    'delete from todos where user_id = $1 and completed = true returning image_key',
    [userId],
  )
  return { count: rows.length, imageKeys: rows.map((r) => r.image_key).filter(Boolean) }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --env-file=../.env --test test/todos.test.js`
Expected: PASS (all — original tests plus the 6 new image tests).

- [ ] **Step 8: Commit**

```bash
cd /Users/junwen/Work/Personal/firth/samples
git add migrations/003_todo_images.sql todo/db.js todo/test/todos.test.js
git commit -m "feat(todo): image columns + data-layer image support

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Server wiring (`server.js`) + route tests

**Files:**
- Modify: `todo/server.js` (imports; `makeApp` signature; `POST /api/todos`; both DELETE routes; error middleware)
- Create: `todo/test/routes.test.js`
- Modify: `todo/package.json` (add `multer`, `supertest`)

**Interfaces:**
- Consumes: `makeStorage` (Task 1), `cleanTitle`/`createTodo`/`deleteTodo`/`clearCompleted` (Task 3), existing auth helpers.
- Produces: `makeApp(pool, storage = makeStorage())` — storage injectable for tests.

- [ ] **Step 1: Install multer + supertest**

```bash
cd /Users/junwen/Work/Personal/firth/samples/todo
npm install multer
npm install --save-dev supertest
```
Expected: `multer` in dependencies, `supertest` in devDependencies; `npm` exits 0.

- [ ] **Step 2: Write the failing route tests** — create `todo/test/routes.test.js`

```javascript
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { makeApp } from '../server.js'
import { makePool, createUser, createSession } from '../db.js'

// Fake storage records calls so we never touch real S3.
function fakeStorage() {
  const calls = { uploads: [], deletes: [], batchDeletes: [] }
  return {
    calls,
    async uploadImage(buffer, contentType) {
      calls.uploads.push({ size: buffer.length, contentType })
      return { key: 'todos/fake.jpg', url: 'https://example.test/todos/fake.jpg' }
    },
    async deleteImage(key) { calls.deletes.push(key) },
    async deleteImages(keys) { calls.batchDeletes.push(keys) },
    publicUrl: (k) => `https://example.test/${k}`,
  }
}

let pool, client, app, fake, token

before(() => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set')
  pool = makePool()
})
after(async () => { await pool.end() })

beforeEach(async () => {
  client = await pool.connect()
  await client.query('begin')
  await client.query('delete from users')
  const u = await createUser(client, 'img@example.com', 'password1')
  token = await createSession(client, u.id)
  fake = fakeStorage()
  app = makeApp(client, fake) // routes share the tx client as their "pool"
})
afterEach(async () => { await client.query('rollback'); client.release() })

const auth = (r) => r.set('Authorization', `Bearer ${token}`)

test('POST /api/todos with an image uploads and stores image_url', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', 'with pic')
    .attach('image', Buffer.from('fakejpegbytes'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  assert.equal(res.status, 201)
  assert.equal(res.body.title, 'with pic')
  assert.equal(res.body.image_url, 'https://example.test/todos/fake.jpg')
  assert.equal(res.body.image_key, undefined)
  assert.equal(fake.calls.uploads.length, 1)
  assert.equal(fake.calls.uploads[0].contentType, 'image/jpeg')
})

test('POST /api/todos without an image does not call storage', async () => {
  const res = await auth(request(app).post('/api/todos')).send({ title: 'no pic' })
  assert.equal(res.status, 201)
  assert.equal(res.body.image_url, null)
  assert.equal(fake.calls.uploads.length, 0)
})

test('POST /api/todos rejects an unsupported image type (no upload)', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', 'bad pic')
    .attach('image', Buffer.from('x'), { filename: 'p.txt', contentType: 'text/plain' })
  assert.equal(res.status, 400)
  assert.equal(fake.calls.uploads.length, 0)
})

test('POST /api/todos with a bad title does not upload (fail fast)', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', '   ')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  assert.equal(res.status, 400)
  assert.equal(fake.calls.uploads.length, 0)
})

test('DELETE /api/todos/:id deletes the image object', async () => {
  const created = (await auth(request(app).post('/api/todos'))
    .field('title', 't')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })).body
  const res = await auth(request(app).delete(`/api/todos/${created.id}`))
  assert.equal(res.status, 204)
  assert.deepEqual(fake.calls.deletes, ['todos/fake.jpg'])
})

test('DELETE /api/todos?completed=true batch-deletes image objects', async () => {
  const created = (await auth(request(app).post('/api/todos'))
    .field('title', 't')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })).body
  await auth(request(app).patch(`/api/todos/${created.id}`)).send({ completed: true })
  const res = await auth(request(app).delete('/api/todos?completed=true'))
  assert.equal(res.status, 200)
  assert.equal(res.body.deleted, 1)
  assert.deepEqual(fake.calls.batchDeletes, [['todos/fake.jpg']])
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --env-file=../.env --test test/routes.test.js`
Expected: FAIL — `makeApp` ignores the 2nd (storage) arg; `POST` doesn't parse multipart; image fields absent.

- [ ] **Step 4: Update `todo/server.js`**

Add imports near the top (after the existing `express`/`path` imports):
```javascript
import multer from 'multer'
import { makeStorage, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from './storage.js'
```

Add `cleanTitle` to the existing `db.js` import list (the destructured import at the top):
```javascript
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted, cleanTitle,
```

Change the `makeApp` signature (line 18) to:
```javascript
export function makeApp(pool, storage = makeStorage()) {
```

Just inside `makeApp`, after `app.use(express.json())`, add the multer instance:
```javascript
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } })
```

Replace the `POST /api/todos` route (lines ~65-67) with:
```javascript
  app.post('/api/todos', requireAuth, upload.single('image'), async (req, res, next) => {
    try {
      const title = cleanTitle(req.body?.title) // validate before any upload → no orphan objects
      let image
      if (req.file) {
        if (!ALLOWED_IMAGE_TYPES.has(req.file.mimetype)) {
          return res.status(400).json({ error: 'unsupported image type' })
        }
        const { url, key } = await storage.uploadImage(req.file.buffer, req.file.mimetype)
        image = { imageUrl: url, imageKey: key }
      }
      res.status(201).json(await createTodo(pool, req.userId, title, image))
    } catch (e) { next(e) }
  })
```

Replace the `DELETE /api/todos` (clear-completed) route (lines ~81-86) with:
```javascript
  app.delete('/api/todos', requireAuth, async (req, res, next) => {
    try {
      if (req.query.completed === 'true') {
        const { count, imageKeys } = await clearCompleted(pool, req.userId)
        if (imageKeys.length) {
          try { await storage.deleteImages(imageKeys) } catch (e) { console.error('image cleanup failed', e) }
        }
        return res.json({ deleted: count })
      }
      res.status(400).json({ error: 'specify ?completed=true to clear completed todos' })
    } catch (e) { next(e) }
  })
```

Replace the `DELETE /api/todos/:id` route (lines ~88-94) with:
```javascript
  app.delete('/api/todos/:id', requireAuth, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      const { deleted, imageKey } = await deleteTodo(pool, req.userId, req.params.id)
      if (!deleted) return res.status(404).json({ error: 'not found' })
      if (imageKey) {
        try { await storage.deleteImage(imageKey) } catch (e) { console.error('image cleanup failed', e) }
      }
      res.status(204).end()
    } catch (e) { next(e) }
  })
```

In the error-handling middleware (lines ~99-104), add a multer size-limit case before the `console.error` line:
```javascript
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message })
    if (err instanceof EmailTakenError) return res.status(409).json({ error: err.message })
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'image too large (max 5 MB)' })
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })
```

- [ ] **Step 5: Run the route tests to verify they pass**

Run: `node --env-file=../.env --test test/routes.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `node --env-file=../.env --test`
Expected: PASS (auth + todos + storage + routes).

- [ ] **Step 7: Commit**

```bash
cd /Users/junwen/Work/Personal/firth/samples
git add todo/server.js todo/test/routes.test.js todo/package.json todo/package-lock.json
git commit -m "feat(todo): multipart create + image upload/cleanup wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend (file input, FormData, thumbnail)

No automated frontend harness exists in this project, so this task is verified by a manual browser smoke test (Step 5). Keep titles rendered via `textContent`.

**Files:**
- Modify: `todo/public/index.html` (new-todo form, ~line 31-34)
- Modify: `todo/public/app.js` (`api()` ~lines 18-35; create submit ~lines 151-161; `renderItem` ~lines 88-112; add `new-image` element ref ~line 7)
- Modify: `todo/public/style.css` (add `.thumb` + file-input rules)

**Interfaces:**
- Consumes: the `image_url` field now returned by `GET /api/todos` and `POST /api/todos` (Tasks 3-4).

- [ ] **Step 1: Add the file input** — `todo/public/index.html`, replace the new-todo form (lines 31-34):
```html
      <form id="new-form" class="new">
        <input id="new-input" type="text" placeholder="What needs doing?" autocomplete="off" maxlength="500" />
        <input id="new-image" type="file" accept="image/*" class="file" />
        <button type="submit">Add</button>
      </form>
```

- [ ] **Step 2: Reference the file input** — `todo/public/app.js`, line 7, replace:
```javascript
const listEl = $('list'), countEl = $('count'), form = $('new-form'), input = $('new-input')
```
with:
```javascript
const listEl = $('list'), countEl = $('count'), form = $('new-form'), input = $('new-input')
const fileInput = $('new-image')
```

- [ ] **Step 3: Support FormData in `api()`** — `todo/public/app.js`, replace the body of `api` (lines 18-35):
```javascript
async function api(method, pathName, body) {
  const headers = {}
  const isForm = body instanceof FormData
  if (body && !isForm) headers['Content-Type'] = 'application/json' // browser sets multipart boundary itself
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(pathName, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  })
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
```

- [ ] **Step 4: Send the image on create + render the thumbnail** — `todo/public/app.js`

Replace the create-form submit handler (lines 151-161) with:
```javascript
form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const v = input.value.trim()
  if (!v) return
  try {
    const file = fileInput.files[0]
    let created
    if (file) {
      const fd = new FormData()
      fd.append('title', v)
      fd.append('image', file)
      created = await api('POST', '/api/todos', fd)
    } else {
      created = await api('POST', '/api/todos', { title: v })
    }
    todos.push(created)
    input.value = ''
    fileInput.value = ''
    clearError()
    render()
  } catch (err) { showError(err.message) }
})
```

In `renderItem` (lines 88-112), replace the final `li.append(cb, title, del)` (line 110) with a thumbnail insert between title and delete:
```javascript
  li.append(cb, title)
  if (t.image_url) {
    const link = document.createElement('a')
    link.href = t.image_url
    link.target = '_blank'
    link.rel = 'noopener'
    const img = document.createElement('img')
    img.className = 'thumb'
    img.src = t.image_url
    img.alt = ''
    img.loading = 'lazy'
    link.append(img)
    li.append(link)
  }
  li.append(del)
  return li
```

- [ ] **Step 5: Add styles** — `todo/public/style.css`, append at the end of the file:
```css
.item .thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--line); display: block; }
.new .file { flex: 0 0 auto; padding: 8px 0; border: none; background: none; font-size: 13px; }
```

- [ ] **Step 6: Manual browser smoke test**

Start the server (run from `samples/todo/`):
```bash
node --env-file=../.env server.js
```
Then in a browser at `http://localhost:8080`:
1. Register/log in.
2. Type a title, choose a JPEG/PNG, click **Add** → the item appears with a 40px thumbnail.
3. Click the thumbnail → the full image opens in a new tab (loads from the public URL).
4. Add a todo with **no** image → it renders normally (no broken-image icon).
5. Reload the page → the thumbnail still renders (served from `image_url`).
6. Delete the todo → it disappears.
Stop the server with Ctrl-C.

Expected: all six behave as described; no console errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/junwen/Work/Personal/firth/samples
git add todo/public/index.html todo/public/app.js todo/public/style.css
git commit -m "feat(todo): attach + show one image per todo in the UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: End-to-end live verification

Confirms the full path against real storage (not the fake): upload lands in the bucket, the public URL serves it, and deleting the todo removes the object.

**Files:** none (verification only).

- [ ] **Step 1: Start the server**

```bash
cd /Users/junwen/Work/Personal/firth/samples/todo
node --env-file=../.env server.js
```

- [ ] **Step 2: Register, create a todo with an image, capture its `image_url`**

In a second terminal:
```bash
BASE=http://localhost:8080
TOKEN=$(curl -sS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"e2e@example.com","password":"password1"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
# tiny valid JPEG (1x1) for the upload
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' > /tmp/px.jpg
CREATED=$(curl -sS -X POST "$BASE/api/todos" -H "Authorization: Bearer $TOKEN" \
  -F 'title=e2e pic' -F 'image=@/tmp/px.jpg;type=image/jpeg')
echo "$CREATED"
URL=$(echo "$CREATED" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).image_url))")
ID=$(echo "$CREATED"  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
```
Expected: `CREATED` JSON has a non-null `image_url`; no `image_key` field.

- [ ] **Step 3: Confirm the image is publicly served, then deleted**

```bash
echo -n "before delete: "; curl -sS -o /dev/null -w "%{http_code}\n" "$URL"   # expect 200
curl -sS -X DELETE "$BASE/api/todos/$ID" -H "Authorization: Bearer $TOKEN" -o /dev/null -w "delete: %{http_code}\n"  # expect 204
sleep 1
echo -n "after delete:  "; curl -sS -o /dev/null -w "%{http_code}\n" "$URL"   # expect 403/404
```
Expected: `200` before, `204` on delete, `403`/`404` after. Stop the server (Ctrl-C). If the "before" is not `200`, revisit Task 2 (URL format / bucket visibility).

- [ ] **Step 4: Clean up the e2e account**

```bash
psql "$(grep '^DATABASE_URL=' /Users/junwen/Work/Personal/firth/samples/.env | cut -d= -f2-)" \
  -c "delete from users where email = 'e2e@example.com';"
```
Expected: `DELETE 1` (cascades to the user's todos/sessions).

---

## Delivery (when ready to ship)

Migration `003` is additive and already applied to the active DB (Task 3, Step 2). To ship to the live app, follow the project's established build + `firth deploy` flow (see the multi-tenant plan's deploy/promote tasks): build the image, push the new tag to GHCR, `firth deploy`. If shipping via a Firth branch for isolation, create the branch first (`firth branch create todo-images`), `firth secrets` to refresh `./.env` (new branch DB **and** storage creds), apply `003` to the branch DB, run Tasks 2 + 6 against the branch, then merge the code + migration to `main` and re-run `003` against main's DB before deploying to main.

---

## Self-Review

**1. Spec coverage:**
- One optional image at creation → Task 4 (`POST` multipart, single image, fail-fast title). ✅
- Public bucket + `image_url`/`image_key`, key internal → Tasks 1, 3 (COLS), 4. ✅
- S3 gateway via `@aws-sdk/client-s3`, `forcePathStyle`, existing env → Task 1. ✅
- Key `todos/{uuid}.{ext}`; allowed types; 5 MB → Tasks 1 (gen + constants), 4 (type check + multer limit + error map). ✅
- Best-effort delete on single + clear-completed → Tasks 3 (return keys), 4 (try/catch cleanup). ✅
- `deleteTodo`/`clearCompleted` new shapes → Task 3 (impl + updated existing tests). ✅
- Migration `003` additive/idempotent → Task 3. ✅
- `storage.js` module + injectable storage in `makeApp` → Tasks 1, 4. ✅
- Frontend file input + FormData + thumbnail, `textContent` preserved → Task 5. ✅
- Tests: storage unit, db integration, route (supertest), live smoke → Tasks 1, 3, 4, 6. ✅
- Public URL format verification + bucket-public preflight → Task 2. ✅

**2. Placeholder scan:** No TBD/TODO. The one runtime unknown (public URL shape) is resolved by a concrete verification task (Task 2) with exact probe commands, not left vague.

**3. Type consistency:** `makeStorage(env, client)` / `uploadImage→{key,url}` / `deleteImage(key)` / `deleteImages(keys)` used identically across Tasks 1, 4, 6. `createTodo(db,userId,title,image)` with `image={imageUrl,imageKey}` consistent across Tasks 3, 4. `deleteTodo→{deleted,imageKey}` and `clearCompleted→{count,imageKeys}` consistent across Tasks 3, 4. `image_url` (client) vs `image_key` (internal) consistent across Tasks 1, 3, 4, 5.

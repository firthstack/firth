# Todo Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach one optional image to a todo at creation time; the image lives in the private Tigris bucket and is shown via a short-lived presigned URL.

**Architecture:** The Express backend receives the new todo as `multipart/form-data` (title + optional image), uploads the image to the private Tigris bucket through `@aws-sdk/client-s3` (`PutObject`), and stores only `image_key` on the `todos` row. On every todo read the backend mints a presigned GET URL (`@aws-sdk/s3-request-presigner`) and returns it as `image_url`; `image_key` is never sent to clients. Deleting a todo best-effort deletes its storage object.

**Tech Stack:** Node ESM, Express 4, `pg`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `multer`, `supertest` (dev), vanilla JS frontend, `node:test`.

**Spec:** [`docs/superpowers/specs/2026-06-25-todo-images-design.md`](../specs/2026-06-25-todo-images-design.md) (see its Revision History — this plan implements the revised presigned-URL design)

## Global Constraints

- **One optional image per todo, set only at creation** (`POST /api/todos`). Never edited/replaced after; deleting the todo deletes its image.
- **Private bucket + presigned GET URLs.** Store only `image_key`. On every read, the server mints a presigned `image_url` (default TTL 3600s). The bucket is never made public.
- **`image_key` is server-internal — never returned to clients.** Clients only see the presigned `image_url` (or `null`).
- **Storage backend is Tigris**, reached via the S3 protocol using the app's existing `.env` vars (`AWS_ENDPOINT_URL_S3` ≈ `https://t3.storage.dev`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BUCKET_NAME`). **`forcePathStyle: true` is required.** No new secrets.
- **Object key:** `todos/{uuid}.{ext}` (random UUID; `{ext}` from validated content type).
- **Allowed content types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`. **Max size: 5 MB** (`MAX_IMAGE_BYTES = 5 * 1024 * 1024`). Default presigned TTL `IMAGE_URL_TTL_SECONDS = 3600`.
- **Delete is best-effort:** DB row removed first; a storage-delete failure is logged, not surfaced.
- **Data-layer return shapes:** `deleteTodo → { deleted: boolean, imageKey: string | null }`; `clearCompleted → { count: number, imageKeys: string[] }` (only non-null keys).
- **Migration `003` is purely additive** (one nullable column `image_key`) and idempotent (`if not exists`).
- **Stay on `@aws-sdk/*`** (not the Tigris-native SDK) to avoid re-plumbing.
- **Unchanged guarantees:** titles render via `textContent` (XSS-safe); all SQL parameterized; todo rows stay owner-scoped.
- **Test command:** from `samples/todo/`, `node --env-file=../.env --test` (single file: `... --test test/<file>.test.js`). `DATABASE_URL` + `AWS_*` come from `samples/.env`.

---

## File Structure

- **Create/Revise** `todo/storage.js` — S3 wrapper: `uploadImage` (→`{key}`), `presignedGetUrl`, `deleteImage`, `deleteImages`, `contentTypeToExt`, constants. Injectable client for upload/delete tests.
- **Create/Revise** `todo/test/storage.test.js` — unit tests (injected fake client for upload/delete; real client + dummy creds for `presignedGetUrl`; no network).
- **Create** `migrations/003_todo_images.sql` — adds `image_key` to `todos`.
- **Create** `todo/test/routes.test.js` — HTTP route tests via `supertest` + fake storage (real DB, rolled-back tx).
- **Modify** `todo/db.js` — `COLS`, `createTodo`, `deleteTodo`, `clearCompleted`; export `cleanTitle`.
- **Modify** `todo/server.js` — `multer`, injectable storage, `toClient` presign helper on every row-returning route, create/delete wiring, multer error mapping.
- **Modify** `todo/test/todos.test.js` — add image-column tests; update the 3 changed `deleteTodo`/`clearCompleted` assertions.
- **Modify** `todo/public/index.html` — file input in the new-todo form.
- **Modify** `todo/public/app.js` — `FormData` in `api()`; image in create submit; thumbnail in `renderItem`.
- **Modify** `todo/public/style.css` — `.thumb` + file-input styling.
- **Modify** `todo/package.json` — add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `multer`, `supertest`.

---

## Task 1: Storage module (`todo/storage.js`)

> Revised for the Tigris/presigned design. (An earlier commit `27fff66` built a public-URL variant; this task brings `storage.js` + its tests to the presigned-URL version.)

**Files:**
- Create/Revise: `todo/storage.js`
- Create/Revise: `todo/test/storage.test.js`
- Modify: `todo/package.json` (add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)

**Interfaces:**
- Produces:
  - `makeStorage(env = process.env, client?) → { uploadImage(buffer, contentType) → Promise<{key}>, presignedGetUrl(key, expiresIn?) → Promise<string>, deleteImage(key) → Promise<void>, deleteImages(keys) → Promise<void> }`
  - `contentTypeToExt(type) → string` (throws on unsupported)
  - `ALLOWED_IMAGE_TYPES: Set<string>`, `MAX_IMAGE_BYTES: number`, `IMAGE_URL_TTL_SECONDS: number`
- Consumes: nothing from other tasks.

- [ ] **Step 1: Install the AWS S3 client + presigner**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner'
```
Expected: both packages in `package.json` dependencies; `npm` exits 0. (`@aws-sdk/client-s3` may already be present from the earlier commit — that's fine.)

- [ ] **Step 2: Write the test file** — replace `todo/test/storage.test.js` with exactly:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeStorage, contentTypeToExt,
  ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, IMAGE_URL_TTL_SECONDS,
} from '../storage.js'

const ENV = {
  AWS_ENDPOINT_URL_S3: 'https://t3.storage.dev',
  AWS_REGION: 'auto',
  AWS_ACCESS_KEY_ID: 'tid_test',
  AWS_SECRET_ACCESS_KEY: 'tsec_test',
  BUCKET_NAME: 'mybucket',
}

// A fake S3 client: records every command's `.input` instead of hitting the network.
// Used for the send-based ops (upload/delete). presignedGetUrl needs a real client (local signing).
function fakeClient() {
  const sent = []
  return { sent, async send(cmd) { sent.push(cmd); return {} } }
}

test('constants', () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024)
  assert.equal(IMAGE_URL_TTL_SECONDS, 3600)
  assert.ok(ALLOWED_IMAGE_TYPES.has('image/jpeg'))
  assert.ok(!ALLOWED_IMAGE_TYPES.has('text/plain'))
})

test('contentTypeToExt maps allowed types and rejects others', () => {
  assert.equal(contentTypeToExt('image/jpeg'), 'jpg')
  assert.equal(contentTypeToExt('image/png'), 'png')
  assert.equal(contentTypeToExt('image/webp'), 'webp')
  assert.equal(contentTypeToExt('image/gif'), 'gif')
  assert.throws(() => contentTypeToExt('text/plain'))
})

test('uploadImage sends PutObject with the right params and returns a key', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  const { key } = await s.uploadImage(Buffer.from('data'), 'image/png')
  assert.match(key, /^todos\/[0-9a-f-]+\.png$/)
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
  assert.equal(client.sent[0].input.Bucket, 'mybucket')
  assert.deepEqual(
    client.sent[0].input.Delete.Objects,
    [{ Key: 'todos/a.jpg' }, { Key: 'todos/b.png' }],
  )
})

test('presignedGetUrl returns a locally-signed URL for the object (no network)', async () => {
  const s = makeStorage(ENV) // real S3Client; getSignedUrl signs locally using the dummy creds
  const url = await s.presignedGetUrl('todos/x.jpg')
  assert.match(url, /^https:\/\/t3\.storage\.dev\/mybucket\/todos\/x\.jpg\?/)
  assert.match(url, /X-Amz-Signature=/)
  assert.match(url, /X-Amz-Expires=3600/)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env --test test/storage.test.js'
```
Expected: FAIL — `presignedGetUrl`/`IMAGE_URL_TTL_SECONDS` missing (or, if `storage.js` doesn't exist yet, module-not-found). The `presignedGetUrl` and `uploadImage` (returns `{key}` not `{key,url}`) tests must fail against the old version.

- [ ] **Step 4: Write `todo/storage.js`** — replace its entire contents with exactly:

```javascript
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const IMAGE_URL_TTL_SECONDS = 3600

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

export function makeStorage(env = process.env, client) {
  const bucket = env.BUCKET_NAME
  const s3 = client ?? new S3Client({
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  })

  return {
    async uploadImage(buffer, contentType) {
      const key = `todos/${randomUUID()}.${contentTypeToExt(contentType)}`
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: contentType,
      }))
      return { key }
    },
    // Short-lived presigned GET URL — the only way the (private) object is reached. Local crypto.
    async presignedGetUrl(key, expiresIn = IMAGE_URL_TTL_SECONDS) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn })
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

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env --test test/storage.test.js'
```
Expected: PASS (7 tests, output pristine). If the `presignedGetUrl` URL assertion fails on host/path ordering, inspect the actual URL printed by a quick `node --env-file=../.env -e "import('./storage.js').then(async({makeStorage})=>console.log(await makeStorage().presignedGetUrl('todos/x.jpg')))"` and adjust ONLY the regex in that one test to match the real path-style shape (still asserting bucket, key, `X-Amz-Signature`, `X-Amz-Expires=3600`).

- [ ] **Step 6: Commit**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples && git add todo/storage.js todo/test/storage.test.js todo/package.json todo/package-lock.json && git commit -m "feat(todo): Tigris storage module (upload, presigned GET, delete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"'
```

---

## Task 2: Verify the presigned GET path works live against Tigris

Confirms a real upload + presigned GET round-trips against the project's private Tigris bucket. Needs Task 1's deps and network access.

**Files:** none (verification only; no commit unless a code fix is needed).

**Interfaces:** Consumes `makeStorage` (Task 1).

- [ ] **Step 1: Upload a probe object, presign it, and fetch it**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env -e "import(\"./storage.js\").then(async ({ makeStorage }) => { const s = makeStorage(); const { key } = await s.uploadImage(Buffer.from([0xff,0xd8,0xff,0xd9]), \"image/jpeg\"); const url = await s.presignedGetUrl(key); console.log(\"KEY=\"+key); console.log(\"URL=\"+url); })"'
```
Expected: prints `KEY=todos/<uuid>.jpg` and a long `URL=...?X-Amz-...`.

- [ ] **Step 2: Confirm the presigned URL serves the object (200)**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "<URL from step 1>"
```
Expected: `200`. (If `403`: signing/clock/region issue — print the SDK error and report; do not work around it.)

- [ ] **Step 3: Delete the probe object and confirm the URL then 404s**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env -e "import(\"./storage.js\").then(async ({ makeStorage }) => { await makeStorage().deleteImage(\"<KEY from step 1>\"); console.log(\"probe deleted\"); })"'
curl -sS -o /dev/null -w "%{http_code}\n" "<URL from step 1>"   # expect 403 or 404 (object gone)
```
Expected: `probe deleted`, then `403`/`404`.

- [ ] **Step 4: Record the result in the report**

No code change expected. If Step 2 was not `200`, capture the exact error/status and STOP (report to controller) — the presigned read path is load-bearing for the whole feature.

---

## Task 3: Migration + data layer (`migrations/003`, `db.js`)

**Files:**
- Create: `migrations/003_todo_images.sql`
- Modify: `todo/db.js` (`COLS` line 4; `createTodo` ~lines 107-114; `deleteTodo` ~lines 135-141; `clearCompleted` ~lines 143-149; export `cleanTitle` line 24)
- Modify: `todo/test/todos.test.js` (add tests; update 3 existing assertions)

**Interfaces:**
- Consumes: existing `db.js` (`makePool`, `listTodos`, `updateTodo`, `createUser`).
- Produces:
  - `createTodo(db, userId, title, imageKey?) → row` — row includes `image_key`.
  - `deleteTodo(db, userId, id) → { deleted: boolean, imageKey: string | null }`
  - `clearCompleted(db, userId) → { count: number, imageKeys: string[] }`
  - `cleanTitle(title) → string` (now exported; throws `ValidationError`)

- [ ] **Step 1: Create `migrations/003_todo_images.sql`**

```sql
-- 003_todo_images.sql — one optional image per todo (Tigris storage object key).
-- Additive and idempotent: a single nullable column; existing rows are unaffected.
alter table todos add column if not exists image_key text;
```

- [ ] **Step 2: Apply the migration to the active DB**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples && export DATABASE_URL="$(grep "^DATABASE_URL=" ./.env | cut -d= -f2-)" && psql "$DATABASE_URL" -f migrations/003_todo_images.sql && psql "$DATABASE_URL" -c "\d todos"'
```
Expected: `ALTER TABLE`; `\d todos` lists `image_key | text`.

- [ ] **Step 3: Write the failing data-layer tests** — append to `todo/test/todos.test.js`:

```javascript
// --- todos: images ---
test('createTodo with an image key stores and returns image_key', async () => {
  const t = await createTodo(client, userA.id, 'pic', 'todos/y.jpg')
  assert.equal(t.image_key, 'todos/y.jpg')
})

test('createTodo without an image key leaves image_key null', async () => {
  const t = await createTodo(client, userA.id, 'nopic')
  assert.equal(t.image_key, null)
})

test('listTodos includes image_key', async () => {
  await createTodo(client, userA.id, 'pic', 'todos/y.jpg')
  const [row] = await listTodos(client, userA.id)
  assert.equal(row.image_key, 'todos/y.jpg')
})

test('deleteTodo returns { deleted, imageKey } for an owned row', async () => {
  const t = await createTodo(client, userA.id, 'pic', 'todos/y.jpg')
  assert.deepEqual(await deleteTodo(client, userA.id, t.id), { deleted: true, imageKey: 'todos/y.jpg' })
})

test('deleteTodo returns deleted:true, imageKey:null for an owned row with no image', async () => {
  const t = await createTodo(client, userA.id, 'nopic')
  assert.deepEqual(await deleteTodo(client, userA.id, t.id), { deleted: true, imageKey: null })
})

test('clearCompleted returns { count, imageKeys } with only non-null keys', async () => {
  const a1 = await createTodo(client, userA.id, 'withpic', 'todos/k1.jpg')
  const a2 = await createTodo(client, userA.id, 'nopic')
  await updateTodo(client, userA.id, a1.id, { completed: true })
  await updateTodo(client, userA.id, a2.id, { completed: true })
  const res = await clearCompleted(client, userA.id)
  assert.equal(res.count, 2)
  assert.deepEqual(res.imageKeys, ['todos/k1.jpg'])
})
```

- [ ] **Step 4: Update the 3 existing assertions that change shape** — in `todo/test/todos.test.js`:

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

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env --test test/todos.test.js'
```
Expected: FAIL — `createTodo` ignores the 4th arg; `deleteTodo`/`clearCompleted` return old types.

- [ ] **Step 6: Update `todo/db.js`**

Change `COLS` (line 4) to include `image_key`:
```javascript
const COLS = 'id, title, completed, image_key, created_at, updated_at'
```

Export `cleanTitle` — change its declaration (line 24) from `function cleanTitle(title) {` to:
```javascript
export function cleanTitle(title) {
```

Replace `createTodo` (lines ~107-114) with:
```javascript
export async function createTodo(db, userId, title, imageKey) {
  const t = cleanTitle(title)
  const { rows } = await db.query(
    `insert into todos (user_id, title, image_key) values ($1, $2, $3) returning ${COLS}`,
    [userId, t, imageKey ?? null],
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

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env --test test/todos.test.js'
```
Expected: PASS (original tests + the 6 new image tests).

- [ ] **Step 8: Commit**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples && git add migrations/003_todo_images.sql todo/db.js todo/test/todos.test.js && git commit -m "feat(todo): image_key column + data-layer image support

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"'
```

---

## Task 4: Server wiring (`server.js`) + route tests

**Files:**
- Modify: `todo/server.js` (imports; `makeApp` signature; `toClient` helper; `GET`, `POST`, `PATCH`, both `DELETE` routes; error middleware)
- Create: `todo/test/routes.test.js`
- Modify: `todo/package.json` (add `multer`, `supertest`)

**Interfaces:**
- Consumes: `makeStorage` (Task 1), `cleanTitle`/`createTodo`/`deleteTodo`/`clearCompleted`/`listTodos`/`updateTodo` (Task 3 + existing), existing auth helpers.
- Produces: `makeApp(pool, storage = makeStorage())` — storage injectable for tests; all row-returning responses carry a presigned `image_url` and no `image_key`.

- [ ] **Step 1: Install multer + supertest**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && npm install multer && npm install --save-dev supertest'
```
Expected: `multer` in dependencies, `supertest` in devDependencies; `npm` exits 0.

- [ ] **Step 2: Write the failing route tests** — create `todo/test/routes.test.js`:

```javascript
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { makeApp } from '../server.js'
import { makePool, createUser, createSession } from '../db.js'

// Fake storage records calls so we never touch real S3/presigning.
function fakeStorage() {
  const calls = { uploads: [], deletes: [], batchDeletes: [] }
  return {
    calls,
    async uploadImage(buffer, contentType) {
      calls.uploads.push({ size: buffer.length, contentType })
      return { key: 'todos/fake.jpg' }
    },
    async presignedGetUrl(key) { return `https://signed.test/${key}?sig=x` },
    async deleteImage(key) { calls.deletes.push(key) },
    async deleteImages(keys) { calls.batchDeletes.push(keys) },
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

test('POST /api/todos with an image uploads and returns a presigned image_url, no image_key', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', 'with pic')
    .attach('image', Buffer.from('fakejpegbytes'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  assert.equal(res.status, 201)
  assert.equal(res.body.title, 'with pic')
  assert.equal(res.body.image_url, 'https://signed.test/todos/fake.jpg?sig=x')
  assert.equal(res.body.image_key, undefined)
  assert.equal(fake.calls.uploads.length, 1)
  assert.equal(fake.calls.uploads[0].contentType, 'image/jpeg')
})

test('POST /api/todos without an image returns image_url null and does not call storage', async () => {
  const res = await auth(request(app).post('/api/todos')).send({ title: 'no pic' })
  assert.equal(res.status, 201)
  assert.equal(res.body.image_url, null)
  assert.equal(res.body.image_key, undefined)
  assert.equal(fake.calls.uploads.length, 0)
})

test('GET /api/todos returns a presigned image_url per todo that has an image', async () => {
  await auth(request(app).post('/api/todos'))
    .field('title', 'with pic')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  await auth(request(app).post('/api/todos')).send({ title: 'no pic' })
  const res = await auth(request(app).get('/api/todos'))
  assert.equal(res.status, 200)
  const byTitle = Object.fromEntries(res.body.map((t) => [t.title, t]))
  assert.equal(byTitle['with pic'].image_url, 'https://signed.test/todos/fake.jpg?sig=x')
  assert.equal(byTitle['no pic'].image_url, null)
  assert.ok(res.body.every((t) => t.image_key === undefined))
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

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env --test test/routes.test.js'
```
Expected: FAIL — `makeApp` ignores the storage arg; `POST` doesn't parse multipart; `image_url`/presigning absent.

- [ ] **Step 4: Update `todo/server.js`**

Add imports near the top (after the existing `express`/`path` imports):
```javascript
import multer from 'multer'
import { makeStorage, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from './storage.js'
```

Add `cleanTitle` to the destructured `db.js` import list at the top:
```javascript
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted, cleanTitle,
```

Change the `makeApp` signature (line 18) to:
```javascript
export function makeApp(pool, storage = makeStorage()) {
```

Just inside `makeApp`, after `app.use(express.json())`, add the multer instance and the client serializer:
```javascript
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } })

  // Map a db row (carrying internal image_key) to the client shape: a presigned image_url, no image_key.
  const toClient = async (row) => {
    const { image_key, ...rest } = row
    return { ...rest, image_url: image_key ? await storage.presignedGetUrl(image_key) : null }
  }
```

Replace the `GET /api/todos` route (lines ~61-63) with:
```javascript
  app.get('/api/todos', requireAuth, async (req, res, next) => {
    try {
      const rows = await listTodos(pool, req.userId)
      res.json(await Promise.all(rows.map(toClient)))
    } catch (e) { next(e) }
  })
```

Replace the `POST /api/todos` route (lines ~65-67) with:
```javascript
  app.post('/api/todos', requireAuth, upload.single('image'), async (req, res, next) => {
    try {
      const title = cleanTitle(req.body?.title) // validate before any upload → no orphan objects
      let imageKey
      if (req.file) {
        if (!ALLOWED_IMAGE_TYPES.has(req.file.mimetype)) {
          return res.status(400).json({ error: 'unsupported image type' })
        }
        const { key } = await storage.uploadImage(req.file.buffer, req.file.mimetype)
        imageKey = key
      }
      const row = await createTodo(pool, req.userId, title, imageKey)
      res.status(201).json(await toClient(row))
    } catch (e) { next(e) }
  })
```

Replace the `PATCH /api/todos/:id` route (lines ~69-79) with (same logic, response now via `toClient`):
```javascript
  app.patch('/api/todos/:id', requireAuth, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      const row = await updateTodo(pool, req.userId, req.params.id, {
        title: req.body?.title,
        completed: req.body?.completed,
      })
      if (!row) return res.status(404).json({ error: 'not found' })
      res.json(await toClient(row))
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

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env --test test/routes.test.js'
```
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env --test'
```
Expected: PASS (auth + todos + storage + routes).

- [ ] **Step 7: Commit**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples && git add todo/server.js todo/test/routes.test.js todo/package.json todo/package-lock.json && git commit -m "feat(todo): multipart create + presigned image_url serialization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"'
```

---

## Task 5: Frontend (file input, FormData, thumbnail)

No automated frontend harness exists, so this task is verified by a headless server+curl check (Step 6); the full browser/visual check happens in Task 6 and by the user. Keep titles rendered via `textContent`.

**Files:**
- Modify: `todo/public/index.html` (new-todo form, lines 31-34)
- Modify: `todo/public/app.js` (element ref line 7; `api()` lines 18-35; create submit lines 151-161; `renderItem` lines 88-112)
- Modify: `todo/public/style.css` (append `.thumb` + file-input rules)

**Interfaces:** Consumes the `image_url` field returned by `GET`/`POST`/`PATCH /api/todos` (Task 4).

- [ ] **Step 1: Add the file input** — `todo/public/index.html`, replace lines 31-34:
```html
      <form id="new-form" class="new">
        <input id="new-input" type="text" placeholder="What needs doing?" autocomplete="off" maxlength="500" />
        <input id="new-image" type="file" accept="image/*" class="file" />
        <button type="submit">Add</button>
      </form>
```

- [ ] **Step 2: Reference the file input** — `todo/public/app.js`, line 7, append after the existing line:
```javascript
const fileInput = $('new-image')
```

- [ ] **Step 3: Support FormData in `api()`** — `todo/public/app.js`, replace the `api` function (lines 18-35):
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

- [ ] **Step 5: Add styles** — `todo/public/style.css`, append at the end:
```css
.item .thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--line); display: block; }
.new .file { flex: 0 0 auto; padding: 8px 0; border: none; background: none; font-size: 13px; }
```

- [ ] **Step 6: Headless wiring check**

Start the server, confirm it serves the new markup, then stop it:
```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && (node --env-file=../.env server.js & echo $! > /tmp/todo-srv.pid; sleep 1; \
  echo -n "file-input present: "; curl -sS http://localhost:8080/ | grep -c "new-image"; \
  echo -n "app.js has FormData: "; curl -sS http://localhost:8080/app.js | grep -c "FormData"; \
  echo -n "healthz: "; curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:8080/healthz; \
  kill "$(cat /tmp/todo-srv.pid)")'
```
Expected: `file-input present: 1`, `app.js has FormData: 1` (or more), `healthz: 200`. (Full visual thumbnail check is covered in Task 6 / by the user.)

- [ ] **Step 7: Commit**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples && git add todo/public/index.html todo/public/app.js todo/public/style.css && git commit -m "feat(todo): attach + show one image per todo in the UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"'
```

---

## Task 6: End-to-end live verification

Confirms the full path against real Tigris (not the fake): upload lands, the presigned `image_url` from the API serves the bytes, and deleting the todo removes the object.

**Files:** none (verification only).

- [ ] **Step 1: Start the server**

```bash
bash -c 'cd /Users/junwen/Work/Personal/firth/samples/todo && node --env-file=../.env server.js > /tmp/todo-e2e.log 2>&1 & echo $! > /tmp/todo-e2e.pid; sleep 1; echo started'
```

- [ ] **Step 2: Register, create a todo with an image, capture its `image_url`**

```bash
BASE=http://localhost:8080
TOKEN=$(curl -sS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"e2e@example.com","password":"password1"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' > /tmp/px.jpg
CREATED=$(curl -sS -X POST "$BASE/api/todos" -H "Authorization: Bearer $TOKEN" \
  -F 'title=e2e pic' -F 'image=@/tmp/px.jpg;type=image/jpeg')
echo "$CREATED"
URL=$(echo "$CREATED" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).image_url))")
ID=$(echo "$CREATED"  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
```
Expected: `CREATED` JSON has a non-null `image_url` (a `…?X-Amz-…` presigned URL) and no `image_key`.

- [ ] **Step 3: Confirm the presigned URL serves the image, then 404s after delete**

```bash
echo -n "before delete: "; curl -sS -o /dev/null -w "%{http_code}\n" "$URL"   # expect 200
curl -sS -X DELETE "$BASE/api/todos/$ID" -H "Authorization: Bearer $TOKEN" -o /dev/null -w "delete: %{http_code}\n"  # expect 204
sleep 1
echo -n "after delete:  "; curl -sS -o /dev/null -w "%{http_code}\n" "$URL"   # expect 403/404
```
Expected: `200` before, `204` on delete, `403`/`404` after. If "before" is not `200`, revisit Task 2.

- [ ] **Step 4: Stop the server and clean up**

```bash
kill "$(cat /tmp/todo-e2e.pid)" 2>/dev/null
bash -c 'cd /Users/junwen/Work/Personal/firth/samples && psql "$(grep "^DATABASE_URL=" ./.env | cut -d= -f2-)" -c "delete from users where email = '"'"'e2e@example.com'"'"';"'
```
Expected: server stops; `DELETE 1` (cascades to the user's todos/sessions).

---

## Delivery (when ready to ship)

Migration `003` is additive and applied to the active DB (Task 3). No bucket-visibility change is needed (the bucket stays private). To ship to the live app, follow the project's established build + `firth deploy` flow (see the multi-tenant plan's deploy/promote tasks). If shipping via a Firth branch, `firth secrets` to refresh `./.env` (branch DB + storage creds), apply `003` to the branch DB, run Tasks 2 + 6 against the branch, then merge code + migration to `main` and re-run `003` against main's DB before deploying.

---

## Self-Review

**1. Spec coverage:**
- One optional image at creation; fail-fast title → Task 4 (`POST` multipart). ✅
- Private bucket + presigned `image_url`; `image_key` internal/never sent → Tasks 1 (`presignedGetUrl`), 3 (COLS image_key), 4 (`toClient` strips key + signs on GET/POST/PATCH). ✅
- Tigris via `@aws-sdk/*`, `forcePathStyle`, existing env → Task 1. ✅
- Key `todos/{uuid}.{ext}`; allowed types; 5 MB; TTL 3600 → Tasks 1 (gen + constants), 4 (type check + multer limit + error map). ✅
- Best-effort delete on single + clear-completed → Tasks 3 (return keys), 4 (try/catch cleanup). ✅
- `deleteTodo`/`clearCompleted` shapes → Task 3 (impl + updated existing tests). ✅
- Migration `003` additive/idempotent (image_key only) → Task 3. ✅
- `storage.js` module + injectable storage in `makeApp` → Tasks 1, 4. ✅
- Frontend file input + FormData + thumbnail, `textContent` preserved → Task 5. ✅
- Tests: storage unit (incl. presign), db integration, route (supertest, presigned url asserted), live smoke → Tasks 1, 3, 4, 6. ✅
- Live presigned read-path verification → Task 2. ✅

**2. Placeholder scan:** No TBD/TODO. Task 2 is concrete probe commands (load-bearing read path), not vague. The one self-adjusting item (presigned-URL regex in the Task 1 test) has explicit fallback instructions and asserts the invariant parts (bucket, key, signature, expiry).

**3. Type consistency:** `makeStorage(env, client)`; `uploadImage→{key}`; `presignedGetUrl(key)→string`; `deleteImage(key)`; `deleteImages(keys)` — used identically across Tasks 1, 4, 6 and the fake in Task 4. `createTodo(db,userId,title,imageKey)` consistent across Tasks 3, 4. `deleteTodo→{deleted,imageKey}` / `clearCompleted→{count,imageKeys}` consistent across Tasks 3, 4. `image_key` (db/internal) vs `image_url` (client/presigned) consistent across Tasks 1, 3, 4, 5.

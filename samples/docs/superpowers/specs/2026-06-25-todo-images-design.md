# Todo Images — Design

**Date:** 2026-06-25
**Status:** Approved (revised mid-implementation — see Revision History)

## Revision History

- **2026-06-25 (initial):** Approach B — public bucket + stored public URL, assuming the storage
  backend was the InsForge S3 gateway (which does not support presigned URLs).
- **2026-06-25 (revised):** A live probe during implementation (plan Task 2) showed the storage backend
  is actually **Tigris** (`t3.storage.dev`), the bucket is **private**, and **Tigris supports presigned
  URLs**. Since the only reason to pick the public-bucket approach was the assumed lack of presigned
  URLs, the user chose the stronger option: **keep the bucket private and serve images via short-lived
  presigned GET URLs.** Data model simplified to a single `image_key` column; the public-URL column and
  the "make the bucket public" preflight are removed.

## Goal

Let a user attach **one optional image** to a todo at **creation time**. The image is uploaded through
the Express backend to the project's already-provisioned **Tigris** (S3-compatible) bucket, which stays
**private**. The todo row stores only the storage object key (`image_key`); on every read the backend
mints a short-lived **presigned GET URL** so the frontend can show a thumbnail with a plain `<img>`.
Same single container (Express + vanilla frontend + direct Postgres) as the existing
[multi-tenant todo](./2026-06-20-multi-tenant-todo-design.md); we add a storage module, one nullable
column on `todos`, multipart handling on the create route, presigned-URL serialization on read, and
image cleanup on delete.

This extends the [multi-tenant todo](./2026-06-20-multi-tenant-todo-design.md). Its spec/plan are the baseline.

## Non-Goals

- **No multiple images per todo** — exactly one (or zero) image per todo.
- **No editing/replacing/removing the image after creation** — image is set only at `POST /api/todos`.
  (Title editing and the completion toggle are unchanged.) Deleting the todo deletes its image.
- **No public bucket / no permanently public objects** — the bucket stays private; images are reached
  only through expiring presigned URLs scoped to one object.
- **No image processing** — no server-side resizing, thumbnail generation, EXIF stripping, or format
  conversion. The original upload is stored as-is and scaled down with CSS for display.
- **No drag-and-drop or paste-to-upload** — a standard file input only.
- **No switch to the Tigris-native SDK (`@tigrisdata/storage`)** — we stay on `@aws-sdk/client-s3`
  (already wired and confirmed working against Tigris) plus `@aws-sdk/s3-request-presigner`, to avoid
  re-plumbing the storage layer. The native SDK is a viable future alternative, not used here.

## Decisions (locked)

- **Image count / timing:** one optional image, attached only when creating the todo.
- **Storage backend:** Tigris, reached via the S3 protocol at `AWS_ENDPOINT_URL_S3` (e.g.
  `https://t3.storage.dev`) using the app's existing `.env` vars (`AWS_REGION`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `BUCKET_NAME`). No new secrets. `forcePathStyle: true` is required.
- **Read approach: private bucket + presigned GET URLs.** Upload stays server-side (`PutObject`); the
  row stores only `image_key`. On every todo read, the backend generates a presigned GET URL
  (`@aws-sdk/s3-request-presigner`, default TTL **3600s**) and returns it as `image_url`. The bucket is
  never made public; presigned URLs are unguessable and expire.
- **Object key:** `todos/{uuid}.{ext}` — a random UUID; `{ext}` from the validated content type.
- **Allowed content types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`. Max size **5 MB**.
- **`image_key` is server-internal** — never returned to clients. Clients only ever see the presigned
  `image_url` (or `null`).
- **Upload transport from browser:** `multipart/form-data` parsed by `multer` (memory storage). The
  create route stays backward-compatible with a plain-JSON body when no image is sent.
- **Delete semantics:** deleting a todo (single delete or clear-completed) best-effort deletes its
  storage object(s) after the DB row is removed; a storage-delete failure is logged, not surfaced
  (orphaned objects acceptable and GC-able later).
- **Data-layer return shapes:** `deleteTodo → { deleted: boolean, imageKey: string | null }`;
  `clearCompleted → { count: number, imageKeys: string[] }` (only non-null keys).
- **Dependencies added:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (upload/delete/presign)
  and `multer` (multipart parsing); `supertest` (dev) for route tests.

## Architecture

```
Create with image:
  Browser ──multipart/form-data (title + image)──> POST /api/todos (requireAuth)
     → multer parses → validate title (fail fast) → validate image type+size
     → storage.uploadImage(buffer, contentType)  ──PutObject──> private bucket → { key }
     → createTodo(pool, userId, title, key)  → todos row (image_key)
     → toClient(row): presign image_key → 201 { ...todo, image_url } (image_key stripped)

Read (list / create / update responses):
  every returned row with image_key → storage.presignedGetUrl(key, 3600s) → image_url
  Browser <img src={todo.image_url}>  ──GET (presigned, no app auth)──> private bucket object

Delete (single / clear-completed):
  Browser ──DELETE──> route → DB delete RETURNING image_key
     → storage.deleteImage(s)(keys)  (best-effort)  ──DeleteObject(s)──> bucket
```

## Schema — `migrations/003_todo_images.sql`

```sql
-- 003_todo_images.sql — one optional image per todo (Tigris storage object key).
-- Additive and idempotent: a single nullable column; existing rows are unaffected.
alter table todos add column if not exists image_key text;
```

Nullable; `NULL` means no image. No public-URL column — the URL is generated per read and never stored.
Applied to the active DB; additive and safe to re-run.

## Module layout

- **`todo/storage.js` (new)** — single-purpose wrapper over the S3 client, no DB, unit-testable:
  - `makeStorage(env = process.env, client?) → { uploadImage, presignedGetUrl, deleteImage, deleteImages }`.
    Reads env at construction; an injected `client` (for upload/delete tests) bypasses the real `S3Client`.
  - `uploadImage(buffer, contentType) → { key }` — generates `todos/{uuid}.{ext}`, `PutObject` with
    `ContentType`, returns the key (no URL).
  - `presignedGetUrl(key, expiresIn = IMAGE_URL_TTL_SECONDS) → Promise<string>` — `getSignedUrl` over a
    `GetObjectCommand`. Local crypto; no network.
  - `deleteImage(key)` / `deleteImages(keys)` — `DeleteObject` / batch `DeleteObjects` (no-op on empty).
  - `contentTypeToExt`, `ALLOWED_IMAGE_TYPES`, `MAX_IMAGE_BYTES`, `IMAGE_URL_TTL_SECONDS` — exported.
- **`todo/db.js` (modified)** — `COLS` includes `image_key`; `createTodo` gains an optional `imageKey`;
  `deleteTodo`/`clearCompleted` return the deleted key(s); `cleanTitle` exported.
- **`todo/server.js` (modified)** — `multer` on create; injectable storage in `makeApp`; a `toClient`
  helper that strips `image_key` and adds a presigned `image_url`, applied to every row-returning route.

## Data layer (`db.js`) interface

- `COLS` becomes `id, title, completed, image_key, created_at, updated_at`. `image_key` is internal:
  the server strips it and substitutes a presigned `image_url` before responding (it is never sent raw).
- `createTodo(db, userId, title, imageKey)` — `imageKey` optional (string or none). Inserts `image_key`
  when provided, else `NULL`. Returns the row (including `image_key`). `cleanTitle` validation unchanged.
- `updateTodo(db, userId, id, fields)` — unchanged behavior (title/completed only). Returns the row
  including `image_key` (so the route can presign it).
- `deleteTodo(db, userId, id) → { deleted: boolean, imageKey: string | null }` — `delete ... where id and
  user_id returning image_key`. Struct avoids the falsy-`null` trap.
- `clearCompleted(db, userId) → { count: number, imageKeys: string[] }` — `delete ... returning
  image_key`; `count` = all deleted rows, `imageKeys` = the non-null keys.
- `listTodos`, user/session functions — unchanged (rows now carry `image_key`).
- `cleanTitle(title)` is exported so the route can validate the title before uploading (no orphan objects).

## Storage module (`storage.js`) interface

```js
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_URL_TTL_SECONDS = 3600

makeStorage(env, client?) → {
  uploadImage(buffer, contentType) → Promise<{ key }>,
  presignedGetUrl(key, expiresIn?) → Promise<string>,
  deleteImage(key) → Promise<void>,
  deleteImages(keys) → Promise<void>,   // no-op when keys is empty
}
```

- Config: `new S3Client({ endpoint: env.AWS_ENDPOINT_URL_S3, region: env.AWS_REGION, forcePathStyle: true,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } })`,
  bucket `env.BUCKET_NAME`.
- `presignedGetUrl` requires a real `S3Client` (it reads the client's resolved config to sign); the
  injected-fake-client path is only for `uploadImage`/`deleteImage(s)` param assertions.

## API

| Method & path | Auth | Body | Behavior | Status |
|---|---|---|---|---|
| `POST /api/todos` | yes | `multipart/form-data` (`title`, optional `image`) **or** JSON `{title}` | Validate title (fail fast); if an image is present validate type/size → upload → create with `image_key` → respond with presigned `image_url` | `201`, `400` bad title / bad image type / too large |
| `GET /api/todos` | yes | — | List the user's todos, each with a freshly presigned `image_url` (or `null`) | `200` |
| `PATCH /api/todos/:id` | yes | `{title?, completed?}` | Update (image not editable); response includes presigned `image_url` | `200`, `400`, `404` |
| `DELETE /api/todos/:id` | yes | — | Delete the user's todo, then best-effort delete its image object | `204`, `404` |
| `DELETE /api/todos?completed=true` | yes | — | Clear completed todos, then best-effort delete their image objects | `200 {deleted}` |

Image validation errors → `400`. `multer`'s file-size limit → `400` ("image too large"), mapped in the
error middleware rather than a generic `500`.

## Backend wiring (`server.js`)

- `makeApp(pool, storage = makeStorage())` — storage injectable so tests use a fake (no real S3/presign).
- `const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } })`.
- `const toClient = async (row) => { const { image_key, ...rest } = row; return { ...rest, image_url:
  image_key ? await storage.presignedGetUrl(image_key) : null } }`. Applied to every row-returning
  response: `GET /api/todos` (`Promise.all(rows.map(toClient))`), `POST`, and `PATCH`.
- Create route: `upload.single('image')`; validate `cleanTitle(req.body?.title)` before any upload; if
  `req.file`, check `ALLOWED_IMAGE_TYPES.has(req.file.mimetype)` (else `400`), then
  `const { key } = await storage.uploadImage(req.file.buffer, req.file.mimetype)`; `createTodo(pool,
  userId, title, key)`; respond `await toClient(row)`.
- Delete routes: as before — `deleteTodo → { deleted, imageKey }` (404 if `!deleted`, else best-effort
  `deleteImage`); `clearCompleted → { count, imageKeys }` (`{ deleted: count }` + best-effort
  `deleteImages`).
- Error middleware: add `if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400)...`.

## Frontend (vanilla, extends the existing page)

- **`index.html`** — add `<input id="new-image" type="file" accept="image/*" />` to the new-todo form.
- **`app.js`** — `api()` sends a `FormData` body as-is (no `JSON.stringify`, no `Content-Type`); create
  submit builds `FormData` (title + image) when a file is chosen, else posts JSON; `renderItem` renders
  `<img class="thumb" src={t.image_url} loading="lazy">` linked to the full image when `t.image_url` is
  set. Titles still render via `textContent`. (Presigned URLs expire ~1h; a list reload re-signs them —
  acceptable for this UI.)
- **`style.css`** — `.thumb` + file-input rules.

## Error handling

Server: bad title → `400`; unsupported image type → `400`; image over 5 MB → `400` (multer); upload
failure during create → `500` (generic JSON, no credentials leaked) and **no** todo row created (upload
precedes the DB insert). Delete-time storage failures are swallowed (logged) so the delete still
succeeds. A presign failure on read surfaces as `500` (the row exists but its URL couldn't be minted).
Frontend: failures surface on the existing dismissible error line.

## Testing

- **`storage.js` unit tests** (no network): `uploadImage` sends `PutObject` with the right
  bucket/key/ContentType and returns a `todos/{uuid}.{ext}` key (injected fake client); `contentTypeToExt`
  maps allowed types and rejects others; `deleteImage`/`deleteImages` send the right commands and
  `deleteImages([])` is a no-op; `presignedGetUrl` (real `S3Client`, dummy creds — local signing) returns
  a URL containing the bucket, key, and `X-Amz-Signature`/`X-Amz-Expires`.
- **`db.js` integration tests** (transaction-rollback, existing style): `createTodo` with a key stores
  and returns `image_key`; without a key it is `NULL`; `listTodos` includes `image_key`; `deleteTodo`
  returns `{ deleted, imageKey }`; `clearCompleted` returns `{ count, imageKeys }` (non-null only).
- **Route tests** (`supertest`, fake storage injected): `POST` multipart with an image calls
  `uploadImage` and the response carries the fake presigned `image_url` (and no `image_key`); JSON `POST`
  without an image → `image_url: null`, no upload; unsupported type / bad title → `400` with no upload;
  `DELETE` calls `deleteImage`; clear-completed calls `deleteImages`.
- **Live smoke** after wiring: create a todo with a JPEG → response `image_url` is a presigned URL that
  `GET`s `200`; delete the todo → the object is gone (the presigned URL then `403/404`).

## Delivery

Migration `003` is additive and applied to the active DB. To ship, follow the project's established build
+ `firth deploy` flow (see the multi-tenant plan's deploy/promote tasks). No bucket visibility change is
needed (the bucket stays private). If shipping via a Firth branch, `firth secrets` refreshes `./.env`
(branch DB + storage creds), apply `003` to the branch DB, verify the presigned read path there, then
merge code + migration to `main` and re-run `003` against main's DB before deploying.

## Security notes

- **Private images:** the bucket stays private; images are reached only via per-object presigned GET URLs
  that expire (default 1h) and are unguessable. No bucket-wide exposure; no permanently public objects.
- **Credentials stay server-side:** S3 access keys never reach the browser; the browser only ever sees a
  short-lived presigned URL.
- **Upload validation:** content-type allow-list + 5 MB cap bound abuse; keys are server-generated UUIDs
  (no client-controlled object paths → no path traversal).
- **Unchanged guarantees:** todo titles render via `textContent` (XSS-safe); all SQL parameterized; todo
  rows stay owner-scoped (`where ... user_id`). `image_key` is never exposed to clients.

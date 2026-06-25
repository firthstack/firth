# Todo Images — Design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)

## Goal

Let a user attach **one optional image** to a todo at **creation time**. The image is uploaded through
the Express backend to the already-provisioned InsForge S3-compatible bucket (a **public** bucket), and
the todo stores the image's public URL so the frontend can display a thumbnail with a plain `<img>`.
Same single container (Express + vanilla frontend + direct Postgres) as the existing
[multi-tenant todo](./2026-06-20-multi-tenant-todo-design.md); we add a storage module, two nullable
columns on `todos`, multipart handling on the create route, and image cleanup on delete.

This extends the [multi-tenant todo](./2026-06-20-multi-tenant-todo-design.md). Its spec/plan are the baseline.

## Non-Goals

- **No multiple images per todo** — exactly one (or zero) image per todo.
- **No editing/replacing/removing the image after creation** — image is set only at `POST /api/todos`.
  (Title editing and the completion toggle are unchanged.) Deleting the todo deletes its image.
- **No private/per-user image isolation** — the bucket is public and the image is served by a public
  URL (trade-off accepted below). The S3 gateway does not support presigned URLs, and its access keys
  are project-admin, so the only private alternative would be backend byte-proxying — explicitly not chosen.
- **No image processing** — no server-side resizing, thumbnail generation, EXIF stripping, or format
  conversion. The original upload is stored as-is and scaled down with CSS for display.
- **No drag-and-drop or paste-to-upload** — a standard file input only.

## Decisions (locked)

- **Image count / timing:** one optional image, attached only when creating the todo.
- **Storage approach (B): public bucket + public URL.** Backend uploads to the public bucket; the todo
  row stores the public `image_url` (for `<img src>`) and the `image_key` (for deletion). Chosen for the
  simplest frontend (no blob fetch, no auth header on reads) over strict per-user privacy.
- **Upload transport to storage:** the S3 gateway via `@aws-sdk/client-s3`, configured from the `.env`
  vars the app already has (`AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `BUCKET_NAME`). No new secrets, no InsForge admin API key needed.
  `forcePathStyle: true` is required (virtual-hosted style is unsupported by the gateway).
- **Upload transport from browser:** `multipart/form-data` parsed by `multer` (memory storage) on the
  create route. The route stays backward-compatible with a plain-JSON body when no image is sent.
- **Object key:** `todos/{uuid}.{ext}` — a random UUID makes keys non-enumerable (the only obscurity
  protection for public objects). `{ext}` derived from the validated content type.
- **Validation:** content type in `{image/jpeg, image/png, image/webp, image/gif}`; max size **5 MB**.
- **Delete semantics:** deleting a todo (single delete or clear-completed) best-effort deletes its
  storage object(s) after the DB row is removed; a storage-delete failure is logged, not surfaced as a
  request error (orphaned objects are acceptable and can be GC'd later).
- **Dependencies added:** `@aws-sdk/client-s3` (upload/delete) and `multer` (multipart parsing).

## Architecture

```
Create with image:
  Browser ──multipart/form-data (title + image)──> POST /api/todos (requireAuth)
     → multer parses → validate type+size
     → storage.uploadImage(buffer, contentType)  ──PutObject──> public bucket
     → createTodo(pool, userId, title, { imageUrl, imageKey })  → todos row
     → 201 { ...todo, image_url }

Display:
  Browser <img src={todo.image_url}>  ──GET (public, no auth)──> public bucket object

Delete (single / clear-completed):
  Browser ──DELETE──> route (requireAuth)
     → DB delete RETURNING image_key
     → storage.deleteImage(s)(keys)  (best-effort)  ──DeleteObject(s)──> bucket
```

## Schema — `migrations/003_todo_images.sql`

```sql
-- 003_todo_images.sql — one optional image per todo (public-bucket URL + storage key).
alter table todos add column if not exists image_url text;
alter table todos add column if not exists image_key text;
```

Both columns are nullable; `NULL`/`NULL` means no image. Existing rows are unaffected. Idempotent
(`if not exists`), consistent with the existing migrations. Applied to the active Firth branch DB first,
then to `main`'s DB on merge (same flow as 002).

## Module layout

- **`todo/storage.js` (new)** — single-purpose wrapper over the S3 client, no DB, unit-testable:
  - `makeStorage(env = process.env)` — builds and returns an `S3Client` + helpers from env. Reading env
    at construction keeps it testable and lets `makeApp` inject a fake.
  - `uploadImage(buffer, contentType) → { key, url }` — generates `todos/{uuid}.{ext}`, `PutObject`
    with `ContentType`, returns the key and the derived public URL.
  - `deleteImage(key) → void` — `DeleteObject` (best-effort; caller decides error handling).
  - `deleteImages(keys) → void` — batch `DeleteObjects` for clear-completed (no-op for empty input).
  - `publicUrl(key) → string` — pure helper: `${PUBLIC_BASE}/<path>/${key}` where `PUBLIC_BASE` is
    `AWS_ENDPOINT_URL_S3` with the `/storage/v1/s3` suffix stripped. **The exact public object path is
    verified empirically during implementation** (real upload + `curl`) before the frontend is wired.
  - `contentTypeToExt` / `EXT_BY_TYPE` — maps allowed content types to file extensions.
  - `ALLOWED_IMAGE_TYPES`, `MAX_IMAGE_BYTES` — exported constants (shared by `multer` limits + route check).
- **`todo/db.js` (modified)** — `createTodo` gains an optional image argument; `deleteTodo` and
  `clearCompleted` return the deleted `image_key`(s).
- **`todo/server.js` (modified)** — `multer` on the create route; upload-then-create wiring; delete-then-
  cleanup wiring; `makeApp(pool, storage)` takes an injectable storage.

## Data layer (`db.js`) interface

- `COLS` (client-facing) becomes `id, title, completed, image_url, created_at, updated_at`. `image_key`
  is **internal** (used only server-side for deletion) and is not returned to clients.
- `createTodo(db, userId, title, image)` — `image` is optional `{ imageUrl, imageKey }` (default none).
  Inserts `image_url` + `image_key` when provided; otherwise both `NULL`. Returns the client `COLS` row
  (with `image_url`). `cleanTitle` validation unchanged.
- `updateTodo(db, userId, id, fields)` — unchanged (title/completed only; image is never updated).
- `deleteTodo(db, userId, id) → { deleted: boolean, imageKey: string | null }` — `delete ... where id
  and user_id returning image_key`. `deleted` is whether a row matched; `imageKey` is that row's key
  (may be `null`). A struct (not a bare value) so "found with no image" can't be confused with "not
  found" — avoids the falsy-`null` trap. **Changes the existing return type** (was `boolean`); the
  existing `deleteTodo` tests are updated to assert `.deleted`.
- `clearCompleted(db, userId) → { count: number, imageKeys: string[] }` — `delete ... where user_id and
  completed returning image_key`. `count` is the number of deleted rows (all of them); `imageKeys` is
  only the non-null keys. Keeping a separate `count` preserves the deleted-count semantics even when some
  cleared todos had no image. **Changes the existing return type** (was a count `number`); the existing
  `clearCompleted` test is updated to assert `.count`.
- `listTodos`, user/session functions — unchanged.

## Storage module (`storage.js`) interface

```js
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

makeStorage(env) → {
  uploadImage(buffer, contentType) → Promise<{ key, url }>,
  deleteImage(key) → Promise<void>,
  deleteImages(keys) → Promise<void>,   // no-op when keys is empty
  publicUrl(key) → string,
}
```

- Config: `new S3Client({ endpoint: env.AWS_ENDPOINT_URL_S3, region: env.AWS_REGION, forcePathStyle: true,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } })`,
  bucket `env.BUCKET_NAME`.
- `uploadImage` rejects (or the route rejects before calling) an unsupported content type.

## API

| Method & path | Auth | Body | Behavior | Status |
|---|---|---|---|---|
| `POST /api/todos` | yes | `multipart/form-data` (`title`, optional `image`) **or** JSON `{title}` | Validate title; if an image is present validate type/size → upload → create todo with `image_url`/`image_key` | `201`, `400` bad title / bad image type / too large |
| `GET /api/todos` | yes | — | List the user's todos, each including `image_url` (or `null`) | `200` |
| `PATCH /api/todos/:id` | yes | `{title?, completed?}` | Unchanged (image not editable) | `200`, `400`, `404` |
| `DELETE /api/todos/:id` | yes | — | Delete the user's todo, then best-effort delete its image object | `204`, `404` |
| `DELETE /api/todos?completed=true` | yes | — | Clear the user's completed todos, then best-effort delete their image objects | `200 {deleted}` |

Image validation errors surface as `400` via a new `ValidationError` (reusing the existing error class /
handler). `multer`'s file-size limit returns `400` ("image too large") rather than a generic `500`.

## Backend wiring (`server.js`)

- Construct `const storage = makeStorage()` and pass it into `makeApp(pool, storage)`. `makeApp`'s
  signature becomes `makeApp(pool, storage = makeStorage())` so tests can inject a fake storage and never
  touch real S3.
- Create route: `app.post('/api/todos', requireAuth, upload.single('image'), handler)` where
  `upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } })`.
  `multer` populates `req.body.title` (multipart) or it comes from `express.json()` (JSON, no file).
  In the handler: if `req.file`, check `ALLOWED_IMAGE_TYPES.has(req.file.mimetype)` (else `400`), then
  `const { url, key } = await storage.uploadImage(req.file.buffer, req.file.mimetype)`, then
  `createTodo(pool, req.userId, title, { imageUrl: url, imageKey: key })`. No file → `createTodo(..., title)`.
- `DELETE /api/todos/:id`: `const { deleted, imageKey } = await deleteTodo(...)`; if `!deleted` → `404`;
  else respond `204`, and if `imageKey` is a string, best-effort `storage.deleteImage(imageKey)` (await +
  try/catch; failure logged, response still `204`).
- `DELETE /api/todos?completed=true`: `const { count, imageKeys } = await clearCompleted(...)`; respond
  `{ deleted: count }`; best-effort `storage.deleteImages(imageKeys)` (try/catch + log).
- Multer errors (e.g. `LIMIT_FILE_SIZE`) handled in the error middleware → `400 { error: 'image too large' }`.

## Frontend (vanilla, extends the existing page)

- **`index.html`** — add a file input to the new-todo form:
  `<input id="new-image" type="file" accept="image/*" />`.
- **`app.js`**
  - `api(method, path, body)`: when `body instanceof FormData`, send it as-is (no `JSON.stringify`, no
    `Content-Type` header — the browser sets the multipart boundary). Otherwise unchanged.
  - Create submit: if a file is selected, build `FormData` with `title` + `image` and POST it; otherwise
    POST JSON `{title}` as today. Reset both the text input and the file input afterward.
  - `renderItem(t)`: when `t.image_url`, render a thumbnail `<img class="thumb" src={t.image_url}
    loading="lazy" alt="">` inside the item; clicking it opens the full image in a new tab
    (`<a href={t.image_url} target="_blank" rel="noopener">`). Titles still render via `textContent`.
- **`public/style.css`** — `.thumb` (small fixed max-height, `object-fit: cover`, rounded corners) and
  minimal styling for the file input within `.new`.

## Error handling

Server: bad title → `400` (`ValidationError`, unchanged); unsupported image type → `400`; image over
5 MB → `400` (multer limit, mapped in the error middleware); upload/storage failure during create →
`500` (generic JSON, no credentials leaked) and **no** todo row is created (upload happens before the DB
insert). Delete-time storage failures are swallowed (logged) so the user-facing delete still succeeds.
Frontend: upload/validation failures surface on the existing dismissible error line.

## Testing

- **`storage.js` unit tests** (no network): `publicUrl(key)` builds the expected URL from a sample
  `AWS_ENDPOINT_URL_S3`; `contentTypeToExt` maps each allowed type; unsupported types are rejected;
  `deleteImages([])` is a no-op. The S3 client may be stubbed to assert `PutObject`/`DeleteObject` params
  (bucket, key, `ContentType`) without a real call.
- **`db.js` integration tests** (transaction-rollback, existing style): `createTodo` with an image stores
  and returns `image_url`; without an image both columns are `NULL`; `listTodos` includes `image_url`;
  `deleteTodo` returns `{ deleted: true, imageKey }` (and `{ deleted: false, ... }` for a
  missing/other-user row); `clearCompleted` returns `{ count, imageKeys }` with only non-null keys.
  Existing `deleteTodo`/`clearCompleted` assertions are updated to the new return shapes.
- **Route test (optional)** — a `makeApp(pool, fakeStorage)` test asserting that `POST /api/todos` with a
  multipart image calls `fakeStorage.uploadImage` and persists the returned URL, and that delete calls
  `deleteImage`. Requires adding `supertest`; deferred unless we decide to add it.
- **Live smoke** after deploy: create a todo with a JPEG → thumbnail renders from the public URL → the
  object is reachable via the stored URL; delete the todo → the object 404s afterward.

## Delivery

Follows the established Firth-branch + git-branch flow (see the multi-tenant spec's Delivery section):
work on a Firth branch (isolated DB + compute), apply `003_todo_images.sql` to the branch DB, verify the
public-bucket upload/serve path end-to-end on the branch URL (including the public-URL-format check),
then merge code + migration to `main`, re-run the migration against `main`'s DB, rebuild, and deploy.

**Pre-flight (implementation step):** confirm `BUCKET_NAME` is a public bucket
(`npx @insforge/cli storage buckets`); if it is private, make/use a public bucket. Confirm the public
object URL format with a real `PutObject` + public `curl GET` before wiring the frontend.

## Security notes

- **Public images (accepted trade-off):** objects are world-readable by URL; the random-UUID key is the
  only obscurity. No per-user authorization on image reads. Acceptable per the chosen approach; revisit
  with backend byte-proxying + a private bucket if image privacy is later required.
- **Credentials stay server-side:** S3 access keys are project-admin and never reach the browser; the
  browser only ever sees the public object URL.
- **Upload validation:** content type allow-list + 5 MB cap bound abuse; keys are server-generated UUIDs
  (no client-controlled paths → no path traversal in the object key).
- **Unchanged guarantees:** todo titles still render via `textContent` (XSS-safe); all SQL parameterized;
  todo rows remain owner-scoped (`where ... user_id`).

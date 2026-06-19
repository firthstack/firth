# Incremental, Idempotent Observe-Sync — Design

**Date:** 2026-06-19
**Status:** Approved (pending spec review)

## Goal

Make `firth observe sync` upload the local credential-audit log (`.firth/audit.jsonl`, written by the `observe/` hook) to the Firth cloud timeline **incrementally** (only findings not yet uploaded) and **idempotently** (re-running, or a mid-sync crash, never creates duplicate events). Today's command re-reads and re-POSTs the entire log every run, and the `events` table has no dedup key — so repeated syncs produce duplicate rows.

This is TODO #2 ("upload local audit log to cloud backend"). The basic upload already exists; this hardens it.

## Non-Goals

- **Automatic / background upload.** Sync stays an explicit, manual command (consistent with Observe's "nothing is sent unless you ask" trust model).
- **Branch attribution.** Uploaded events keep `branch_id: null`, as today. The local audit log is not branch-aware.
- **Changing what the hook detects** or the audit-line format.
- **Resource-event (`emit`) changes.** The `source:'resource'` ingest path is untouched.

## Two mechanisms

Idempotency is achieved by combining a client-side watermark (efficiency) with a server-side dedup key (correctness). Either alone is insufficient: a watermark alone leaves a crash-window duplicate; a dedup key alone forces re-reading the whole log every run.

### 1. Local watermark — `.firth/sync-state.json`

A small JSON state file beside `project.json` and `audit.jsonl` (the `.firth/` directory is already gitignored):

```json
{ "audit": { "offset": 12345, "syncedAt": "2026-06-19T21:00:00.000Z" } }
```

- `offset` — number of bytes of `audit.jsonl` already uploaded. Missing file or missing `audit` key ⇒ offset `0`.
- On sync: read `audit.jsonl` from `offset` to the **last newline boundary** in the file. A trailing partial line (the hook may be mid-write) is **not** sent; its bytes stay below the persisted offset and are picked up on the next sync once complete.
- After a batch is accepted (`201`), persist `offset` = byte position just past that batch's last complete line, and `syncedAt` = now.
- **Truncation guard:** if the current file size is **less** than the stored `offset`, the log was deleted/reset — set `offset` to `0` and re-read from the start. Re-upload is safe because of the dedup key.

### 2. Dedup key (server-side correctness)

- The CLI computes `dedup_key = sha256(rawLine)` (the exact JSONL line text with any trailing newline stripped), hex-encoded, and sends it as a top-level field on each event.
- Stability: the hook writes each finding exactly once; two genuinely distinct findings differ in at least one field (`ts`, `fingerprint`, `sink`, …) → different line → different key. A re-sent identical line hashes identically → deduped.
- Malformed lines (non-JSON) are still hashed from their raw bytes and uploaded as `{ raw: line }`.

## Data model — `events.dedup_key`

Migration on the live InsForge `events` table:

```sql
ALTER TABLE public.events ADD COLUMN dedup_key TEXT;
CREATE UNIQUE INDEX events_owner_proj_dedup_uniq
  ON public.events (owner, project_id, dedup_key);
```

A **non-partial** unique index is deliberate: Postgres treats `NULL`s as distinct in a unique index, so the existing `resource`/legacy events (which have `dedup_key IS NULL`) never conflict with each other and are entirely unaffected. Only `agent` events that carry a real `dedup_key` are deduplicated. This also keeps `ON CONFLICT` inference simple (`on_conflict=owner,project_id,dedup_key`, no index predicate).

RLS/grants are unchanged (owner-scoped, already in place; `dedup_key` is a non-secret hash).

## Components & flows

### `QueryBuilder` gains `upsert`

`control-plane/src/db/types.ts` — extend the narrowed injectable interface:

```ts
export interface QueryBuilder {
  insert(values: object | object[]): QueryBuilder
  upsert(values: object | object[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): QueryBuilder
  update(values: object): QueryBuilder
  select(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  is(column: string, value: unknown): QueryBuilder
  then<T>(onfulfilled: (r: { data: any[] | null; error: Error | null }) => T): Promise<T>
}
```

The real `DataClient` is the `@insforge/sdk` `database` client, which already implements `.upsert(values, { onConflict, ignoreDuplicates })` (maps to `Prefer: resolution=ignore-duplicates`, which InsForge documents and which requires a unique constraint — provided by the migration). Test fakes get a small `upsert` that models the `(owner, project_id, dedup_key)` unique key (skip when a row with the same non-null key exists; always insert when `dedup_key` is null).

### Ingest — `POST /projects/:id/events`

Per event:
- If `dedup_key` is present → upsert with `onConflict: 'owner,project_id,dedup_key', ignoreDuplicates: true`, `.select()` to learn whether a row was actually inserted.
- Else → plain insert (the existing `resource`/`emit` path, unchanged).

Response changes from `{ recorded }` to `{ recorded, skipped }`, where `recorded` = rows actually inserted and `skipped` = events whose `dedup_key` already existed. Validation is unchanged (`source` must be `agent`|`resource`); `dedup_key` is optional.

`EventsRepo.record` (or a new `recordMany`) gains a `dedup_key?: string` field on `NewEventRow` and chooses upsert vs insert accordingly, returning whether the row was inserted so the route can count.

### CLI — `firth observe sync [--all]`

`cli/src/commands/observe.ts` (and `cli/src/api.ts` `postEvents` returns `{ recorded, skipped }`):

1. Require a linked project (unchanged) and an existing `.firth/audit.jsonl` (unchanged: "no audit log found" → exit 0).
2. Load `.firth/sync-state.json` → `offset` (0 if absent). If `fileSize < offset`, reset `offset = 0`.
3. With `--all`, ignore the stored offset and start from `0`.
4. Read from `offset` to the last newline boundary; split into complete lines. If none → `nothing new to sync`, exit 0.
5. For each line: parse JSON (fallback `{ raw: line }`), build `{ source:'agent', kind:'agent.${sink ?? kind ?? 'action'}', payload, dedup_key: sha256(line) }`.
6. Send in batches of 500 events. After each batch's `201`, advance and persist `offset` to that batch's last-line boundary (and `syncedAt`). Stop at the first batch that fails (see Error handling). On `--all`, after all batches succeed set `offset` to end-of-file.
7. Print `synced N new finding(s)` (append ` (M already uploaded)` when `skipped > 0`).

### Error handling

- Not linked → error, exit 1 (unchanged). No `audit.jsonl` → message, exit 0 (unchanged).
- Malformed line → `{ raw: line }`, still hashed + uploaded.
- POST failure mid-run → stop at the first failing batch: batches already accepted keep their persisted offset; the failing batch's offset is **not** advanced and no further batches are sent; print the error and exit 1. A re-run resumes from the last persisted offset; the dedup key makes any overlap a no-op. The original error is never masked.
- All API error strings stay static/controlled (existing discipline).

## Trust model

Upload remains **opt-in and manual**. The source log is already redacted by the hook — it contains only fingerprints (`type ••••last4 #hash`), never raw secret values — so `observe sync` cannot transmit a raw secret. `dedup_key` is a hash of an already-redacted line. This invariant is restated, not changed.

## Testing (offline)

**CLI** (fake `FirthApi` + a temp `.firth/` dir):
- First sync uploads all lines and writes `offset` = file size.
- Re-sync with no new lines → `nothing new to sync`, no POST.
- Append new lines → next sync uploads **only** the new ones; offset advances.
- A trailing partial line (no newline) is not sent; once completed, it's sent exactly once.
- Truncation (file smaller than stored offset) → offset resets to 0, full re-read.
- `--all` re-sends the whole log regardless of offset.
- Batching: more than one batch → multiple POSTs; a failure on the 2nd batch leaves the 1st batch's offset persisted (durable partial progress).
- Malformed line → uploaded as `{ raw }` with a stable `dedup_key`.
- `dedup_key` equals `sha256` of the raw line (stable across runs).

**Control-plane** (fake `DataClient` with upsert):
- An event with a `dedup_key` upserts; a second identical `dedup_key` is skipped (`ignoreDuplicates`); response `{ recorded, skipped }` counts correctly.
- An event without a `dedup_key` (resource event) always inserts (null keys don't conflict).
- Migration verified live: `dedup_key` column + the unique index present.

## Build order (informs the plan)

1. Migration (`dedup_key` + unique index) + `NewEventRow.dedup_key` + `QueryBuilder.upsert` in the interface.
2. `EventsRepo` upsert-or-insert + `/events` route `{ recorded, skipped }` (+ fake `upsert`).
3. CLI watermark read/write + incremental read (newline boundary, truncation guard) + `dedup_key` + batching + `--all`, with `postEvents` returning `{ recorded, skipped }`.

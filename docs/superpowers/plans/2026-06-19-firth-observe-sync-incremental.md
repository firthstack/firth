# Incremental, Idempotent Observe-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `firth observe sync` upload `.firth/audit.jsonl` to the cloud timeline incrementally (only new findings, tracked by a local byte-offset watermark) and idempotently (a per-event `dedup_key` + a unique index + ignore-duplicates ingest, so re-runs and crashes never duplicate rows).

**Architecture:** Two cooperating mechanisms. (1) Server side: a `dedup_key` column + unique index on `events(owner, project_id, dedup_key)`; the `/events` ingest upserts dedup-keyed events with `ignoreDuplicates` and returns `{ recorded, skipped }`. (2) Client side: a `.firth/sync-state.json` byte-offset watermark; the CLI reads only new complete lines, hashes each as its `dedup_key`, and POSTs in batches, advancing the watermark per accepted batch.

**Tech Stack:** TypeScript/Node (control-plane Fastify + vitest; CLI + vitest), the injectable `DataClient`/`QueryBuilder` over `@insforge/sdk`, InsForge Postgres migrations.

## Global Constraints

- Upload is **opt-in / manual** only (no automatic or background push). Uploaded events keep `branch_id: null` (no branch attribution).
- The source log is already redacted (fingerprints only) — never transmit or log a raw secret. API error strings stay static/controlled.
- The unique index is **non-partial**: `UNIQUE(owner, project_id, dedup_key)`. Postgres treats NULLs as distinct, so `resource`/legacy events (NULL `dedup_key`) never conflict and are untouched. Only dedup-keyed `agent` events are deduplicated.
- `dedup_key = sha256(<raw audit line, trailing newline stripped>)`, hex.
- Batch size is **500** events per POST. Advance + persist the watermark only after a batch's `201`; stop at the first failing batch.
- The `resource`-event path (`emit()` → plain insert) must remain behaviorally unchanged.
- TDD: failing test → confirm fail → implement → pass → commit. Stage only the files each task names (never `git add -A`).

---

### Task 1: Server-side dedup (migration, types, EventsRepo, /events route)

**Files:**
- Create: `migrations/20260619230000_events-dedup-key.sql` (use a timestamp later than the newest existing migration, `20260619213418_…`)
- Modify: `control-plane/src/db/types.ts` (`NewEventRow`, `QueryBuilder`)
- Modify: `control-plane/src/db/repos.ts` (`EventsRepo.record`)
- Modify: `control-plane/src/server.ts:149-161` (the `POST /projects/:id/events` route)
- Test: `control-plane/test/server.test.ts` (extend the `fakeData()` fake with `upsert`; add dedup tests)

**Interfaces:**
- Consumes: existing `EventsRepo`, the `fakeData()` PostgREST-faithful fake in `server.test.ts`.
- Produces:
  - `NewEventRow` gains `dedup_key?: string | null`.
  - `QueryBuilder.upsert(values: object | object[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): QueryBuilder`.
  - `EventsRepo.record(row: NewEventRow): Promise<{ inserted: boolean }>` — upserts when `row.dedup_key` is set (ignore-duplicates), plain-inserts otherwise.
  - `POST /projects/:id/events` response: `{ recorded: number, skipped: number }` (`recorded` = rows actually inserted; accepts an optional per-event `dedup_key`).

- [ ] **Step 1: Write the migration SQL**

Create `migrations/20260619230000_events-dedup-key.sql`:

```sql
-- Add a content-hash idempotency key for uploaded audit findings.
-- Non-partial unique index: Postgres treats NULLs as distinct, so existing
-- resource/agent events with a NULL dedup_key never conflict and are unaffected.
ALTER TABLE public.events ADD COLUMN dedup_key TEXT;

CREATE UNIQUE INDEX events_owner_proj_dedup_uniq
  ON public.events (owner, project_id, dedup_key);
```

- [ ] **Step 2: Extend the types**

In `control-plane/src/db/types.ts`, add `dedup_key` to `NewEventRow`:

```ts
export type NewEventRow = {
  project_id: string; owner: string; branch_id: string | null
  source: 'agent' | 'resource'; kind: string; payload: Record<string, unknown>
  dedup_key?: string | null
}
```

And add `upsert` to the `QueryBuilder` interface (place it right after `insert`):

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

- [ ] **Step 3: Add `upsert` to the test fake and make the insert path conflict-aware**

In `control-plane/test/server.test.ts`, inside `fakeData()`'s `from(t)` builder, add an `upsert` method next to `insert`, and change the `then` insert branch so a skipped (conflicting) upsert returns no rows.

Add this method (right after the `insert(v)` method):

```ts
      upsert(v: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        mode = 'insert'
        const dk = (v as any).dedup_key
        // model UNIQUE(owner, project_id, dedup_key): NULL keys never conflict
        const conflict = opts?.ignoreDuplicates && dk != null && tables[t].some(
          (r) => r.owner === (v as any).owner && r.project_id === (v as any).project_id && r.dedup_key === dk,
        )
        if (conflict) { insertedRow = undefined; return api }
        const row = { id: `${t}-${tables[t].length}`, created_at: String(tables[t].length).padStart(10, '0'), ...v }
        tables[t].push(row)
        insertedRow = row
        return api
      },
```

Change the existing insert branch of `then` from:

```ts
        if (mode === 'insert') return res({ data: [insertedRow], error: null })
```

to:

```ts
        if (mode === 'insert') return res({ data: insertedRow ? [insertedRow] : [], error: null })
```

(Plain `insert` always sets `insertedRow`, so this is a no-op for existing inserts; it only matters for a skipped `upsert`.)

- [ ] **Step 4: Write the failing tests**

Append to `control-plane/test/server.test.ts`:

```ts
test('POST /events dedups by dedup_key: second identical key is skipped', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const ev = { source: 'agent', kind: 'agent.network', payload: { a: 1 }, dedup_key: 'abc123' }
  const r1 = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' }, payload: { events: [ev] } })
  expect(r1.statusCode).toBe(201)
  expect(r1.json()).toEqual({ recorded: 1, skipped: 0 })
  const r2 = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' }, payload: { events: [ev] } })
  expect(r2.json()).toEqual({ recorded: 0, skipped: 1 })
  expect(db.tables.events).toHaveLength(1)
})

test('POST /events without dedup_key always inserts (resource/legacy events)', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const payload = { events: [{ source: 'resource', kind: 'deploy', payload: {} }, { source: 'resource', kind: 'deploy', payload: {} }] }
  const r = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' }, payload })
  expect(r.json()).toEqual({ recorded: 2, skipped: 0 })
  expect(db.tables.events).toHaveLength(2)
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: FAIL — the route still returns `{ recorded: <count> }` (no `skipped`), and duplicate dedup_keys both insert (no `upsert` yet).

- [ ] **Step 6: Implement `EventsRepo.record`**

In `control-plane/src/db/repos.ts`, replace the `record` method:

```ts
  async record(row: NewEventRow): Promise<{ inserted: boolean }> {
    if (row.dedup_key) {
      const { data, error } = await this.db.from('events')
        .upsert(row, { onConflict: 'owner,project_id,dedup_key', ignoreDuplicates: true })
        .select()
      if (error) throw error
      return { inserted: (data ?? []).length > 0 }
    }
    const { error } = await this.db.from('events').insert(row).select()
    if (error) throw error
    return { inserted: true }
  }
```

(`emit()` in `server.ts` awaits `record` and ignores the returned object — no change needed there.)

- [ ] **Step 7: Implement the route**

In `control-plane/src/server.ts`, replace the body of `POST /projects/:id/events` (lines ~149-161):

```ts
  app.post('/projects/:id/events', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const events = ((req.body as any)?.events ?? []) as Array<any>
    if (!Array.isArray(events) || events.some((e) => e.source !== 'agent' && e.source !== 'resource')) {
      return reply.code(400).send({ error: 'each event needs source agent|resource' })
    }
    const repo = new EventsRepo(db)
    let recorded = 0
    for (const e of events) {
      const { inserted } = await repo.record({
        project_id: projectId, owner: uid, branch_id: e.branch ?? null,
        source: e.source, kind: String(e.kind), payload: e.payload ?? {},
        dedup_key: e.dedup_key ?? null,
      })
      if (inserted) recorded++
    }
    return reply.code(201).send({ recorded, skipped: events.length - recorded })
  })
```

- [ ] **Step 8: Run the full control-plane suite**

Run: `cd control-plane && npm test`
Expected: PASS — all prior tests plus the two new dedup tests. (The existing "deploy emits a resource event" test still passes: `emit` uses the no-`dedup_key` insert path.)

- [ ] **Step 9: Apply the migration live**

Run: `cd /Users/junwen/Work/Personal/firth && npx @insforge/cli db migrations up --all`
Expected: the new migration applies; `dedup_key` column + `events_owner_proj_dedup_uniq` index exist. Verify:
`npx @insforge/cli db query "SELECT column_name FROM information_schema.columns WHERE table_name='events' AND column_name='dedup_key'"` returns one row.

- [ ] **Step 10: Build + commit**

```bash
cd control-plane && npm run build
cd /Users/junwen/Work/Personal/firth
git add migrations/20260619230000_events-dedup-key.sql control-plane/src/db/types.ts control-plane/src/db/repos.ts control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: dedup-key idempotency on the events ingest"
```

---

### Task 2: CLI sync-state module (watermark + incremental read)

**Files:**
- Create: `cli/src/sync-state.ts`
- Test: `cli/test/sync-state.test.ts`

**Interfaces:**
- Consumes: nothing (pure + `node:fs`).
- Produces:
  - `readAuditOffset(cwd: string): number` — byte offset from `.firth/sync-state.json`, or `0` if absent/malformed.
  - `writeAuditOffset(cwd: string, offset: number, now: string): void` — persists `{ audit: { offset, syncedAt: now } }`.
  - `readNewAuditLines(content: string, offset: number): { lines: string[]; ends: number[]; newOffset: number }` — complete (non-blank) lines from `offset` to the last newline; `ends[i]` is the byte offset just past `lines[i]`; `newOffset` is the byte offset past the last complete line. Excludes a trailing partial line. If `offset > byteLength(content)` (truncation), restarts from `0`.

- [ ] **Step 1: Write the failing tests**

Create `cli/test/sync-state.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readAuditOffset, writeAuditOffset, readNewAuditLines } from '../src/sync-state.js'

test('readAuditOffset: missing file → 0; round-trips a written offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  expect(readAuditOffset(dir)).toBe(0)
  writeAuditOffset(dir, 42, '2026-06-19T00:00:00.000Z')
  expect(readAuditOffset(dir)).toBe(42)
  expect(JSON.parse(readFileSync(join(dir, '.firth', 'sync-state.json'), 'utf8')).audit.syncedAt).toBe('2026-06-19T00:00:00.000Z')
})

test('readAuditOffset: malformed JSON → 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'sync-state.json'), 'not json')
  expect(readAuditOffset(dir)).toBe(0)
})

test('readNewAuditLines: reads all complete lines from offset 0', () => {
  const r = readNewAuditLines('a\nbb\n', 0)
  expect(r.lines).toEqual(['a', 'bb'])
  expect(r.ends).toEqual([2, 5])
  expect(r.newOffset).toBe(5)
})

test('readNewAuditLines: offset at EOF → nothing new', () => {
  expect(readNewAuditLines('a\nbb\n', 5)).toEqual({ lines: [], ends: [], newOffset: 5 })
})

test('readNewAuditLines: resumes from a mid-file offset', () => {
  const r = readNewAuditLines('a\nbb\n', 2)
  expect(r.lines).toEqual(['bb'])
  expect(r.ends).toEqual([5])
  expect(r.newOffset).toBe(5)
})

test('readNewAuditLines: excludes a trailing partial line', () => {
  const r = readNewAuditLines('a\nb', 0)
  expect(r.lines).toEqual(['a'])
  expect(r.newOffset).toBe(2)
})

test('readNewAuditLines: truncation (offset > length) restarts from 0', () => {
  const r = readNewAuditLines('a\n', 100)
  expect(r.lines).toEqual(['a'])
  expect(r.newOffset).toBe(2)
})

test('readNewAuditLines: counts bytes, not chars, for multibyte lines', () => {
  const r = readNewAuditLines('✓\n', 0) // ✓ is 3 UTF-8 bytes + newline = 4
  expect(r.lines).toEqual(['✓'])
  expect(r.ends).toEqual([4])
  expect(r.newOffset).toBe(4)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cli && npx vitest run test/sync-state.test.ts`
Expected: FAIL — `Cannot find module '../src/sync-state.js'`.

- [ ] **Step 3: Implement the module**

Create `cli/src/sync-state.ts`:

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const statePath = (cwd: string) => join(cwd, '.firth', 'sync-state.json')

export function readAuditOffset(cwd: string): number {
  const p = statePath(cwd)
  if (!existsSync(p)) return 0
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'))
    return typeof s?.audit?.offset === 'number' ? s.audit.offset : 0
  } catch { return 0 }
}

export function writeAuditOffset(cwd: string, offset: number, now: string): void {
  mkdirSync(join(cwd, '.firth'), { recursive: true })
  writeFileSync(statePath(cwd), JSON.stringify({ audit: { offset, syncedAt: now } }, null, 2))
}

// Complete (non-blank) lines from `offset` to the last newline boundary.
// `ends[i]` = byte offset just past `lines[i]`; `newOffset` = byte offset past
// the last complete line (incl. any blank lines). A trailing partial line is
// excluded. `offset > byteLength(content)` (truncation) restarts from 0.
export function readNewAuditLines(content: string, offset: number): { lines: string[]; ends: number[]; newOffset: number } {
  const byteLen = Buffer.byteLength(content, 'utf8')
  const start = offset > byteLen ? 0 : offset
  const tail = Buffer.from(content, 'utf8').subarray(start).toString('utf8')
  const lastNl = tail.lastIndexOf('\n')
  if (lastNl < 0) return { lines: [], ends: [], newOffset: start }
  const block = tail.slice(0, lastNl + 1) // complete lines incl. trailing newline
  const raw = block.split('\n')
  if (raw[raw.length - 1] === '') raw.pop() // drop empty tail after the final '\n'
  const lines: string[] = []
  const ends: number[] = []
  let cursor = start
  for (const l of raw) {
    cursor += Buffer.byteLength(l, 'utf8') + 1 // + the newline
    if (l.trim()) { lines.push(l); ends.push(cursor) }
  }
  return { lines, ends, newOffset: cursor }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd cli && npx vitest run test/sync-state.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add cli/src/sync-state.ts cli/test/sync-state.test.ts
git commit -m "feat: cli sync-state watermark + incremental audit-line reader"
```

---

### Task 3: Rewrite `observe sync` to be incremental + idempotent

**Files:**
- Modify: `cli/src/commands/observe.ts`
- Modify: `cli/src/api.ts:48-50` (`postEvents` return type)
- Test: `cli/test/observe.test.ts` (update the two existing tests; add incremental + `--all` tests)

**Interfaces:**
- Consumes: `readAuditOffset`, `writeAuditOffset`, `readNewAuditLines` (Task 2); `FirthApi.postEvents` now returns `{ recorded, skipped }`; `apiFromDeps(deps)`; `readProjectLink`.
- Produces: `observe sync [--all]` that uploads only new findings (watermark), tags each with `dedup_key = sha256(line)`, batches by 500, advances the watermark per accepted batch, and prints `synced N new finding(s)` / `(M already uploaded)` / `nothing new to sync`.

- [ ] **Step 1: Type `postEvents`**

In `cli/src/api.ts`, change `postEvents` to declare its response shape:

```ts
  postEvents(projectId: string, events: unknown[]): Promise<{ recorded: number; skipped: number }> {
    return this.req('POST', `/projects/${projectId}/events`, { events })
  }
```

- [ ] **Step 2: Write the failing tests**

Replace the entire contents of `cli/test/observe.test.ts` with:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeSync } from '../src/commands/observe.js'
import { writeProjectLink } from '../src/config.js'
import { readAuditOffset } from '../src/sync-state.js'

function fakeApi(posted: any[]) {
  return { postEvents: async (_pid: string, evs: any[]) => { posted.push(...evs); return { recorded: evs.length, skipped: 0 } } }
}

test('first sync uploads all lines as agent events with a dedup_key and advances the watermark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  const log = '{"sink":"network","x":1}\n{"sink":"git"}\n'
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), log)
  const posted: any[] = []
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  expect(await observeSync([], d as any)).toBe(0)
  expect(posted).toHaveLength(2)
  expect(posted[0]).toMatchObject({ source: 'agent', kind: 'agent.network' })
  expect(typeof posted[0].dedup_key).toBe('string')
  expect(posted[0].dedup_key).toHaveLength(64) // sha256 hex
  expect(out.join('\n')).toMatch(/synced 2 new/)
  expect(readAuditOffset(dir)).toBe(Buffer.byteLength(log, 'utf8'))
})

test('second sync with no new lines is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), '{"sink":"git"}\n')
  const posted: any[] = []
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  await observeSync([], d as any)
  posted.length = 0
  const out: string[] = []
  const d2 = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  expect(await observeSync([], d2 as any)).toBe(0)
  expect(posted).toHaveLength(0)
  expect(out.join('\n')).toMatch(/nothing new/)
})

test('appended lines: the next sync uploads only the new ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  const p = join(dir, '.firth', 'audit.jsonl')
  writeFileSync(p, '{"sink":"git"}\n')
  const posted: any[] = []
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  await observeSync([], d as any)
  posted.length = 0
  appendFileSync(p, '{"sink":"network"}\n')
  await observeSync([], d as any)
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ kind: 'agent.network' })
})

test('--all re-sends the whole log regardless of the watermark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), '{"sink":"git"}\n{"sink":"network"}\n')
  const posted: any[] = []
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  await observeSync([], d as any)        // first: uploads 2
  posted.length = 0
  await observeSync(['--all'], d as any) // --all: re-reads all 2
  expect(posted).toHaveLength(2)
})

test('not linked → error, exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => fakeApi([]) }
  expect(await observeSync([], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/not linked/)
})

test('no audit log is a friendly no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi([]) }
  expect(await observeSync([], d as any)).toBe(0)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd cli && npx vitest run test/observe.test.ts`
Expected: FAIL — the current command has no `dedup_key`, no watermark, and prints the old "synced N agent events" message.

- [ ] **Step 4: Implement the command**

Replace the entire contents of `cli/src/commands/observe.ts` with:

```ts
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { readAuditOffset, writeAuditOffset, readNewAuditLines } from '../sync-state.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

const BATCH = 500

export async function observeSync(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { all: { type: 'boolean' } }, allowPositionals: true })
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const path = join(deps.cwd, '.firth', 'audit.jsonl')
  if (!existsSync(path)) { deps.print('no audit log found at .firth/audit.jsonl (is the observe hook installed?)'); return 0 }

  const content = readFileSync(path, 'utf8')
  const offset = values.all ? 0 : readAuditOffset(deps.cwd)
  const { lines, ends } = readNewAuditLines(content, offset)
  if (lines.length === 0) { deps.print('nothing new to sync'); return 0 }

  const api = apiFromDeps(deps)
  const events = lines.map((line) => {
    let parsed: any = {}
    try { parsed = JSON.parse(line) } catch { parsed = { raw: line } }
    return {
      source: 'agent' as const,
      kind: `agent.${parsed.sink ?? parsed.kind ?? 'action'}`,
      payload: parsed,
      dedup_key: createHash('sha256').update(line).digest('hex'),
    }
  })

  let recorded = 0, skipped = 0
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH)
    const res = await api.postEvents(link.projectId, batch)
    recorded += res.recorded
    skipped += res.skipped ?? 0
    writeAuditOffset(deps.cwd, ends[i + batch.length - 1], new Date().toISOString())
  }

  let msg = `synced ${recorded} new finding(s)`
  if (skipped > 0) msg += ` (${skipped} already uploaded)`
  deps.print(msg)
  return 0
}
```

- [ ] **Step 5: Run the observe tests to verify they pass**

Run: `cd cli && npx vitest run test/observe.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full CLI suite + build**

Run: `cd cli && npm test && npm run build`
Expected: PASS — all CLI tests (the `--all` flag and watermark don't affect other commands). Build clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add cli/src/commands/observe.ts cli/src/api.ts cli/test/observe.test.ts
git commit -m "feat: incremental, idempotent observe sync (watermark + dedup_key + --all)"
```

---

## Notes for the executor

- The `--all` watermark: because `readNewAuditLines` excludes a trailing partial line, after `--all` the watermark lands at the end of the last *complete* line — identical to the incremental path. No separate "set to EOF" step is needed.
- Mid-run failure: if `postEvents` throws, the loop propagates the error; batches already accepted keep their persisted offset and no further batches are sent. The CLI router prints `error: …` and returns 1. A re-run resumes from the last persisted offset; the server-side `dedup_key` makes any overlap a no-op. (No explicit test — it follows from per-batch `writeAuditOffset` ordering + the router's existing catch.)
- Help text: `cli/src/index.ts` already lists `observe sync`; optionally mention `--all` there, but it is not required by any test.

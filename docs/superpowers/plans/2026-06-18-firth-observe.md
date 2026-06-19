# Firth Observe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A v1 Observe layer: an append-only `events` timeline per project/branch that correlates **resource side-effects** (project/branch/deploy events the control plane emits) with **agent actions** (the local `observe/` hook's redacted findings, uploaded via `firth observe sync`). Plus `firth events` to view the timeline.

**Architecture:** A single append-only `events` table (RLS owner-scoped, insert+select only) on InsForge Postgres. Resource side-effects are recorded **best-effort from the route layer** (after a project create / branch create / deploy succeeds) so the existing services stay unchanged and an event-write failure never breaks the operation. Agent actions stay local in the `observe/` hook (preserving its "nothing leaves your machine" trust model); `firth observe sync` is the explicit, opt-in upload of its already-redacted `.firth/audit.jsonl` findings. The "correlation" in v1 is the shared `(project_id, branch_id)` + time ordering — one unified timeline; causal linking is a later refinement.

**Tech Stack:** Node 20 + TypeScript, `vitest`. Reuses the InsForge migration + repo + route + CLI patterns. No new deps.

## Global Constraints

- Reuse unchanged: `DataClient`/`QueryBuilder` (insert/select/eq/is/update — NO new builder methods; do sort/limit app-side in the repo), `firstOrThrow`, `buildServer`/`auth`/`ServerDeps`, the InsForge migration workflow, the `firth-cli` (`FirthApi`/`apiFromDeps`/`readProjectLink`).
- `events` table (append-only): `id uuid pk, project_id uuid→projects, owner uuid→auth.users, branch_id uuid?→branches, source text CHECK in ('agent','resource'), kind text, payload jsonb, created_at timestamptz`. RLS owner-only; grant `SELECT, INSERT` to authenticated (no UPDATE/DELETE — append-only audit). Index on `owner` and `(project_id, created_at)`.
- Event payloads must contain NO plaintext secret values. Resource events carry only non-secret metadata (ids, names, urls). Agent events forward the `observe/` hook's findings, which are ALREADY redacted (it stores only fingerprints) — `firth observe sync` does not add secrets.
- Resource side-effect emission is BEST-EFFORT: wrapped in try/catch in the route, after the operation succeeds; a failed event write is swallowed (never fails the create/deploy).
- v1 timeline = newest-first, app-side sort + limit (default 50). Pagination is a follow-up (note it; don't build it).

---

### Task 1: events schema (migration) + EventsRepo

**Files:**
- Create: `migrations/<version>_create-firth-events.sql`
- Modify: `control-plane/src/db/types.ts` (add `EventRow`, `NewEventRow`)
- Modify: `control-plane/src/db/repos.ts` (add `EventsRepo`)
- Test: `control-plane/test/db/repos.test.ts` (add cases), `control-plane/test/schema.integration.test.ts` (add an events-table assertion)

**Interfaces:**
- Produces:
  - `type NewEventRow = { project_id; owner; branch_id: string|null; source: 'agent'|'resource'; kind: string; payload: Record<string,unknown> }`
  - `type EventRow = NewEventRow & { id: string; created_at: string }`
  - `class EventsRepo { constructor(db); record(row: NewEventRow): Promise<void>; listByProject(owner, projectId, opts?: { branch?: string|null; limit?: number }): Promise<EventRow[]> }` — `listByProject` filters owner+project (and branch when `opts.branch` is a string), sorts by `created_at` desc app-side, slices to `opts.limit ?? 50`.

- [ ] **Step 1: Create the migration** — `npx @insforge/cli db migrations new create-firth-events`, then write:

```sql
CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('agent','resource')),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_owner ON public.events(owner);
CREATE INDEX idx_events_timeline ON public.events(project_id, created_at DESC);

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_owner_all ON public.events FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT ON public.events TO authenticated;
```

- [ ] **Step 2: Apply it** — `npx @insforge/cli db migrations up --all` (needs network — `dangerouslyDisableSandbox: true` if blocked). On failure, read the error and fix the SQL; do not write to managed schemas.

- [ ] **Step 3: Write the failing tests** — add to `control-plane/test/schema.integration.test.ts`:

```typescript
test('events table exists with RLS', () => {
  const rows = query("select relname from pg_class where relrowsecurity=true and relname='events'")
  expect(rows.length).toBe(1)
})
```

and to `control-plane/test/db/repos.test.ts`:

```typescript
import { EventsRepo } from '../../src/db/repos.js'

test('EventsRepo.record inserts; listByProject returns newest-first, limited, branch-filtered', async () => {
  const db = fakeDb()
  const repo = new EventsRepo(db as any)
  await repo.record({ project_id: 'p', owner: 'o', branch_id: null, source: 'resource', kind: 'project.create', payload: {} })
  await repo.record({ project_id: 'p', owner: 'o', branch_id: 'b1', source: 'resource', kind: 'deploy', payload: { url: 'x' } })
  const all = await repo.listByProject('o', 'p')
  expect(all.map((e) => e.kind)).toEqual(['deploy', 'project.create']) // newest-first (insertion order → reverse)
  const lim = await repo.listByProject('o', 'p', { limit: 1 })
  expect(lim).toHaveLength(1)
})
```

(`fakeDb` in `repos.test.ts` already supports insert/select/eq; ensure rows get a sortable `created_at`/order — see Step 5 note.)

- [ ] **Step 4: Add types to `control-plane/src/db/types.ts`**

```typescript
export type NewEventRow = {
  project_id: string; owner: string; branch_id: string | null
  source: 'agent' | 'resource'; kind: string; payload: Record<string, unknown>
}
export type EventRow = NewEventRow & { id: string; created_at: string }
```

- [ ] **Step 5: Implement `EventsRepo` in `control-plane/src/db/repos.ts`**

```typescript
import type { /* …existing… */ EventRow, NewEventRow } from './types.js'

export class EventsRepo {
  constructor(private db: DataClient) {}

  async record(row: NewEventRow): Promise<void> {
    const { error } = await this.db.from('events').insert(row).select()
    if (error) throw error
  }

  async listByProject(owner: string, projectId: string, opts: { branch?: string | null; limit?: number } = {}): Promise<EventRow[]> {
    let q = this.db.from('events').select().eq('owner', owner).eq('project_id', projectId)
    if (typeof opts.branch === 'string') q = q.eq('branch_id', opts.branch)
    const { data, error } = await q
    if (error) throw error
    const rows = (data ?? []) as EventRow[]
    // newest-first; app-side because the fake (and v1) don't use SQL ORDER/LIMIT. Pagination is a follow-up.
    const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    return sorted.slice(0, opts.limit ?? 50)
  }
}
```

> Note: the repo test must give inserted rows a comparable `created_at` (the fake can stamp an incrementing counter as `created_at`, e.g. `created_at: String(tables[t].length)`), since `Date.now()` ties are possible. If the fake doesn't set `created_at`, the sort is a stable no-op and "newest-first" falls back to insertion order reversed — adjust the fake to make the assertion meaningful, or assert on membership + length instead of order.

- [ ] **Step 6: Apply-check + run tests** — `cd control-plane && npx vitest run test/db/repos.test.ts test/schema.integration.test.ts` (the schema test needs network for the live DB query).

- [ ] **Step 7: Commit**

```bash
git add migrations/ control-plane/src/db/types.ts control-plane/src/db/repos.ts control-plane/test/db/repos.test.ts control-plane/test/schema.integration.test.ts
git commit -m "feat: events table (append-only, RLS) + EventsRepo"
```

---

### Task 2: Events API — POST ingest + GET timeline

**Files:**
- Modify: `control-plane/src/server.ts`
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- `POST /projects/:id/events` body `{ events: Array<{ source: 'agent'|'resource'; kind: string; payload?: object; branch?: string|null }> }` → records each (owner = uid, project_id = :id) → 201 `{ recorded: <n> }`. Rejects non-`agent`/`resource` source → 400.
- `GET /projects/:id/events?branch=<id>&limit=<n>` → 200 `{ events: EventRow[] }` (newest-first).

- [ ] **Step 1: Add failing tests** to `control-plane/test/server.test.ts`

```typescript
test('POST then GET /projects/:id/events records + lists newest-first', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const post = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' },
    payload: { events: [
      { source: 'resource', kind: 'project.create', payload: { name: 'demo' } },
      { source: 'agent', kind: 'agent.network', payload: { fingerprint: 'gh ••••e5f6' }, branch: null },
    ] } })
  expect(post.statusCode).toBe(201)
  expect(post.json().recorded).toBe(2)
  const list = await app.inject({ method: 'GET', url: '/projects/p1/events', headers: { authorization: 'Bearer good' } })
  expect(list.statusCode).toBe(200)
  expect(list.json().events.map((e: any) => e.kind)).toContain('agent.network')
})

test('POST /events rejects an invalid source', async () => {
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => fakeData() as any })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' },
    payload: { events: [{ source: 'hacker', kind: 'x' }] } })
  expect(r.statusCode).toBe(400)
})
```

(Ensure `fakeData()` stamps a sortable `created_at` on inserted rows so the timeline order is meaningful — mirror the repo-test fake.)

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/server.test.ts`.

- [ ] **Step 3: Add the routes to `control-plane/src/server.ts`** (import `EventsRepo`)

```typescript
  app.post('/projects/:id/events', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const events = ((req.body as any)?.events ?? []) as Array<any>
    if (!Array.isArray(events) || events.some((e) => e.source !== 'agent' && e.source !== 'resource')) {
      return reply.code(400).send({ error: 'each event needs source agent|resource' })
    }
    const repo = new EventsRepo(db)
    for (const e of events) {
      await repo.record({ project_id: projectId, owner: uid, branch_id: e.branch ?? null, source: e.source, kind: String(e.kind), payload: e.payload ?? {} })
    }
    return reply.code(201).send({ recorded: events.length })
  })

  app.get('/projects/:id/events', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const q = req.query as any
    const events = await new EventsRepo(db).listByProject(uid, projectId, {
      branch: q.branch, limit: q.limit ? Number(q.limit) : undefined,
    })
    return reply.send({ events })
  })
```

- [ ] **Step 4: Run server tests + full suite** — `cd control-plane && npx vitest run test/server.test.ts && npm test`.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: POST/GET /projects/:id/events (ingest + timeline)"
```

---

### Task 3: Emit resource side-effects from the routes

**Files:**
- Modify: `control-plane/src/server.ts`
- Test: `control-plane/test/server.test.ts`

**Interfaces:** after a successful `POST /projects` / `POST /projects/:id/branches` / `POST /projects/:id/deploy`, record a best-effort `source:'resource'` event: `project.create` (payload `{name, projectId}`), `branch.create` (payload `{name, branchId, from}`, `branch_id`=new branch), `deploy` (payload `{machineId, url}`, `branch_id`=resolved branch if known). Wrapped in try/catch so an event-write failure never changes the response.

- [ ] **Step 1: Add failing tests** to `control-plane/test/server.test.ts` — after a `POST /projects` (and a deploy), assert a corresponding event shows up in `GET /projects/:id/events`:

```typescript
test('POST /projects emits a resource event onto the timeline', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [] })
  const created = await app.inject({ method: 'POST', url: '/projects', headers: { authorization: 'Bearer good' }, payload: { name: 'demo' } })
  const pid = created.json().project.id
  const list = await app.inject({ method: 'GET', url: `/projects/${pid}/events`, headers: { authorization: 'Bearer good' } })
  expect(list.json().events.map((e: any) => e.kind)).toContain('project.create')
})
```

(Add a similar assertion for deploy if convenient.)

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/server.test.ts`.

- [ ] **Step 3: Add a best-effort emit helper + calls in `control-plane/src/server.ts`**

```typescript
  // best-effort: never let an event-write failure change the response
  async function emit(db: DataClient, uid: string, projectId: string, branchId: string | null, kind: string, payload: Record<string, unknown>) {
    try { await new EventsRepo(db).record({ project_id: projectId, owner: uid, branch_id: branchId, source: 'resource', kind, payload }) }
    catch { /* swallow */ }
  }
```

Then, after each operation succeeds (before `reply.send`):
- `POST /projects`: `await emit(db, uid, out.project.id, out.defaultBranch.id, 'project.create', { name, resources: out.resources?.map((r:any)=>r.kind) ?? [] })`
- `POST /projects/:id/branches`: `await emit(db, uid, projectId, out.branch.id, 'branch.create', { name: out.branch.name, from })`
- `POST /projects/:id/deploy`: `await emit(db, uid, projectId, null, 'deploy', { machineId: out.machineId, url: out.url })`

- [ ] **Step 4: Run server tests + full suite** — `cd control-plane && npx vitest run test/server.test.ts && npm test`.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: emit resource side-effect events (project/branch/deploy) onto the timeline"
```

---

### Task 4: CLI — `firth events` + `firth observe sync`

**Files:**
- Modify: `control-plane/src/cli/api.ts` (add `listEvents`, `postEvents`)
- Create: `control-plane/src/cli/commands/events.ts`
- Create: `control-plane/src/cli/commands/observe.ts`
- Modify: `control-plane/src/cli/index.ts` (register + USAGE)
- Test: `control-plane/test/cli/events.test.ts`, `control-plane/test/cli/observe.test.ts`

**Interfaces:**
- `FirthApi.listEvents(projectId, { branch?, limit? })` → `GET …/events`; `FirthApi.postEvents(projectId, events)` → `POST …/events`.
- `events(argv, deps)` — `--branch`, `--limit`; resolves linked project; prints `<created_at>  <source>  <kind>  <summary>` newest-first.
- `observeSync(argv, deps)` — reads `./.firth/audit.jsonl` (the `observe/` hook's redacted output), maps each non-empty JSON line to an event `{ source:'agent', kind: 'agent.'+(line.sink ?? line.kind ?? 'action'), payload: line }`, and `postEvents` them in one batch; prints how many were synced. If the file is absent, prints a friendly "no audit log found (is the observe hook installed?)" and returns 0.

- [ ] **Step 1: Write the failing tests** `control-plane/test/cli/events.test.ts`

```typescript
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { events } from '../../src/cli/commands/events.js'
import { writeProjectLink } from '../../src/cli/config.js'

test('events prints the timeline for the linked project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { listEvents: async () => [
    { id: 'e1', created_at: '2026-06-18T10:00:00Z', source: 'resource', kind: 'deploy', payload: { url: 'https://a.fly.dev' } },
    { id: 'e2', created_at: '2026-06-18T09:00:00Z', source: 'agent', kind: 'agent.network', payload: {} },
  ] }
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await events([], d as any)).toBe(0)
  expect(out.join('\n')).toMatch(/deploy/)
  expect(out.join('\n')).toMatch(/agent\.network/)
})
```

`control-plane/test/cli/observe.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeSync } from '../../src/cli/commands/observe.js'
import { writeProjectLink } from '../../src/cli/config.js'

test('observe sync uploads redacted audit lines as agent events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), '{"sink":"network","secret":"gh ••••e5f6"}\n{"sink":"git"}\n')
  const posted: any[] = []
  const api = { postEvents: async (_pid: string, evs: any[]) => { posted.push(...evs); return { recorded: evs.length } } }
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await observeSync([], d as any)).toBe(0)
  expect(posted).toHaveLength(2)
  expect(posted[0]).toMatchObject({ source: 'agent', kind: 'agent.network' })
  expect(out.join('\n')).toMatch(/2/)
})

test('observe sync with no audit log is a friendly no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => ({ postEvents: async () => ({ recorded: 0 }) }) }
  expect(await observeSync([], d as any)).toBe(0)
})
```

- [ ] **Step 2: Run to verify they fail** — `cd control-plane && npx vitest run test/cli/events.test.ts test/cli/observe.test.ts`.

- [ ] **Step 3: Add to `control-plane/src/cli/api.ts`** (in `FirthApi`)

```typescript
  listEvents(projectId: string, opts: { branch?: string; limit?: number } = {}) {
    const qs = new URLSearchParams()
    if (opts.branch) qs.set('branch', opts.branch)
    if (opts.limit) qs.set('limit', String(opts.limit))
    const q = qs.toString()
    return this.req('GET', `/projects/${projectId}/events${q ? `?${q}` : ''}`).then((r) => r.events as any[])
  }
  postEvents(projectId: string, events: unknown[]) {
    return this.req('POST', `/projects/${projectId}/events`, { events })
  }
```

- [ ] **Step 4: Implement `control-plane/src/cli/commands/events.ts`**

```typescript
import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function events(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { branch: { type: 'string' }, limit: { type: 'string' } }, allowPositionals: false })
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const rows = await apiFromDeps(deps).listEvents(link.projectId, { branch: values.branch, limit: values.limit ? Number(values.limit) : undefined })
  if (rows.length === 0) deps.print('(no events yet)')
  for (const e of rows) {
    const summary = e.payload?.url ?? e.payload?.name ?? e.payload?.machineId ?? ''
    deps.print(`${e.created_at}  ${e.source.padEnd(8)}  ${e.kind}${summary ? `  ${summary}` : ''}`)
  }
  return 0
}
```

- [ ] **Step 5: Implement `control-plane/src/cli/commands/observe.ts`**

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function observeSync(_argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const path = join(deps.cwd, '.firth', 'audit.jsonl')
  if (!existsSync(path)) { deps.print('no audit log found at .firth/audit.jsonl (is the observe hook installed?)'); return 0 }
  const events = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((line) => {
    let parsed: any = {}
    try { parsed = JSON.parse(line) } catch { parsed = { raw: line } }
    return { source: 'agent' as const, kind: `agent.${parsed.sink ?? parsed.kind ?? 'action'}`, payload: parsed }
  })
  if (events.length === 0) { deps.print('audit log is empty — nothing to sync'); return 0 }
  const res = await apiFromDeps(deps).postEvents(link.projectId, events)
  deps.print(`synced ${res.recorded} agent events to the timeline`)
  return 0
}
```

- [ ] **Step 6: Register in `control-plane/src/cli/index.ts`** — `COMMANDS['events'] = events; COMMANDS['observe sync'] = observeSync`; add USAGE lines: `  events                    Show the project's action↔side-effect timeline (--branch, --limit)` and `  observe sync              Upload local observe-hook findings (.firth/audit.jsonl) to the timeline`.

- [ ] **Step 7: Run CLI tests + full suite + build** — `cd control-plane && npx vitest run test/cli/ && npm test && npm run build`.

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/cli/api.ts control-plane/src/cli/commands/events.ts control-plane/src/cli/commands/observe.ts control-plane/src/cli/index.ts control-plane/test/cli/events.test.ts control-plane/test/cli/observe.test.ts
git commit -m "feat: firth events (timeline) + firth observe sync (upload agent findings)"
```

---

## Self-Review

**Spec coverage:** Observe = build-order step 7 / ARCHITECTURE §10. Events schema + repo (T1), ingest+timeline API (T2), resource side-effect emission from routes (T3), CLI timeline + agent-action upload (T4). The unit is "agent action ↔ resource side-effect" on one `(project, branch)` timeline. Failure analysis (F) is explicitly a later layer.

**Placeholder scan:** No TODO/TBD. The repo-test fake must stamp a sortable `created_at` for the newest-first assertion (called out in T1 Step 5) — flagged, not hand-waved.

**Type consistency:** `NewEventRow`/`EventRow` in `db/types.ts`, consumed by `EventsRepo`, the routes, and (shape-wise) the CLI. `source` constrained to `'agent'|'resource'` at the DB (CHECK), the route (400), and the types. snake_case columns (`branch_id`, `project_id`, `created_at`). `FirthApi.listEvents/postEvents` match the route bodies/shapes. Best-effort `emit` reuses `EventsRepo.record`.

**Known gaps / deferred:** pagination (v1 sorts/limits app-side, default 50 — fetches all matching rows); causal action↔side-effect linking (v1 = shared project/branch + time ordering only); a dashboard UI (Web, later); the `observe/` hook still writes locally and is uploaded only on explicit `firth observe sync` (preserves its local-trust model — no auto-exfiltration); provision/branch events depend on the route layer (services unchanged), so events emitted only for control-plane-initiated ops.

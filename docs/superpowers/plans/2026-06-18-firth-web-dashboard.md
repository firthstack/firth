# Firth Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A terminal-themed web dashboard (auth + project/branch CRUD + resource-handle metadata) for Firth, as a pure control-plane client.

**Architecture:** New `dashboard/` Vite+React+TS SPA authenticates via the InsForge SDK and calls the existing Firth control-plane API with a Bearer token. The control plane (`control-plane/`) gains a project-detail endpoint, soft-delete-with-teardown DELETE endpoints, and CORS.

**Tech Stack:** TypeScript, Node 20, Fastify, vitest (backend); Vite, React 18, TypeScript, Vitest + Testing Library + jsdom (frontend); @insforge/sdk for auth.

## Global Constraints
- ES modules throughout; relative imports in `control-plane/src` and tests use `.js` extensions.
- Backend errors are static/controlled strings only — never echo provider/DB error text (it can carry tokens). NotFoundError→404, ConflictError→409, UnauthorizedError→401.
- `provider_ref` exposed to clients ONLY through a per-kind key whitelist — credential-shaped keys (password/secret/key/token/uri/url/cred) are never listed and never returned.
- Soft delete = set `archived_at` + `status='deleted'`; lists/detail filter `archived_at IS NULL`. Rows are tombstones (never hard-deleted). The default branch cannot be deleted.
- Resource teardown is per-resource best-effort: a failed destroy is recorded in the response `teardown.failed` (not thrown) and the row is still archived.
- All tests run fully local/offline against in-memory fakes (no network, no live providers).

---

### Task 1: Migration + repo archive/find/list-filter

**Files:**
- Create: migration `migrations/<timestamp>_add-archived-at.sql` (run `cd /Users/junwen/Work/Personal/firth && npx @insforge/cli db migrations new add-archived-at` to get the timestamped path).
- Modify: `control-plane/src/db/repos.ts`
- Test: `control-plane/test/db/repos.test.ts`

**Interfaces:**
- Consumes: `DataClient`, `Project`, `BranchRow`, `ResourceRow` from `./types.js`; existing `firstOrThrow` from `./repos.js`. The `fakeData()` in-memory DataClient (PostgREST-faithful `is`/`eq`; `is(c, null)` returns rows where `r[c] == null`; freshly inserted rows have no `archived_at`, so they pass the null filter).
- Produces (added to `repos.ts`):
  - `ProjectsRepo.findById(owner: string, id: string): Promise<Project | null>`
  - `ProjectsRepo.archive(owner: string, id: string): Promise<void>`
  - `ProjectsRepo.listByOwner(owner: string): Promise<Project[]>` (now filters `archived_at IS NULL`)
  - `BranchesRepo.findById(owner: string, id: string): Promise<BranchRow | null>`
  - `BranchesRepo.archive(owner: string, id: string): Promise<void>`
  - `BranchesRepo.listByProject(owner: string, projectId: string): Promise<BranchRow[]>` (now filters `archived_at IS NULL`)
  - `ResourcesRepo.listByProject(owner: string, projectId: string): Promise<ResourceRow[]>`
  - `ResourcesRepo.markStatus(owner: string, id: string, status: string): Promise<void>`

#### Steps

- [ ] **Write the migration.** Run `cd /Users/junwen/Work/Personal/firth && npx @insforge/cli db migrations new add-archived-at`. Into the generated `migrations/<timestamp>_add-archived-at.sql`, write exactly:
  ```sql
  ALTER TABLE public.projects ADD COLUMN archived_at TIMESTAMPTZ;
  ALTER TABLE public.branches ADD COLUMN archived_at TIMESTAMPTZ;
  ```
  The existing owner-only RLS (`FOR ALL ... USING/WITH CHECK owner = auth.uid()`) and `GRANT ... UPDATE` already let the owner write the column — no policy/grant change. Apply with `cd /Users/junwen/Work/Personal/firth && npx @insforge/cli db migrations up --all` (needs the linked backend). If the backend is unavailable, note it and proceed — the repo tests are the automated gate; the migration is verified manually when a backend is linked.

- [ ] **Write failing tests** in `control-plane/test/db/repos.test.ts`. If the file exists, append the cases; otherwise create it with this content:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { ProjectsRepo, BranchesRepo, ResourcesRepo } from '../../src/db/repos.js'

  // PostgREST-faithful in-memory DataClient (mirrors test/server.test.ts).
  function fakeData() {
    const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], events: [] }
    return { tables, from(t: string) {
      const filters: Array<(r: any) => boolean> = []
      let mode: 'insert' | 'select' | 'update' = 'select'
      let insertedRow: any; let updatePayload: any
      const api: any = {
        insert(v: any) {
          mode = 'insert'
          const row = { id: `${t}-${tables[t].length}`, created_at: String(tables[t].length).padStart(10, '0'), ...v }
          tables[t].push(row); insertedRow = row; return api
        },
        update(v: any) { mode = 'update'; updatePayload = v; return api },
        select() { return api },
        eq(c: string, val: any) {
          filters.push(val === null ? () => false : (r: any) => r[c] === val); return api
        },
        is(c: string, val: any) {
          filters.push(val === null ? (r: any) => r[c] == null : (r: any) => r[c] === val); return api
        },
        async then(res: any) {
          if (mode === 'update') {
            for (const row of tables[t]) if (filters.every((fn) => fn(row))) Object.assign(row, updatePayload)
            return res({ data: [], error: null })
          }
          if (mode === 'insert') return res({ data: [insertedRow], error: null })
          return res({ data: tables[t].filter((r) => filters.every((fn) => fn(r))), error: null })
        },
      }
      return api
    } }
  }

  describe('ProjectsRepo archive/find/list', () => {
    it('listByOwner excludes an archived project', async () => {
      const db = fakeData() as any
      const repo = new ProjectsRepo(db)
      const a = await repo.create('uid-1', 'alpha')
      const b = await repo.create('uid-1', 'beta')
      await repo.archive('uid-1', a.id)
      const list = await repo.listByOwner('uid-1')
      expect(list.map((p) => p.id)).toEqual([b.id])
    })

    it('findById returns null for an archived project', async () => {
      const db = fakeData() as any
      const repo = new ProjectsRepo(db)
      const a = await repo.create('uid-1', 'alpha')
      expect((await repo.findById('uid-1', a.id))?.id).toBe(a.id)
      await repo.archive('uid-1', a.id)
      expect(await repo.findById('uid-1', a.id)).toBeNull()
    })

    it('archive sets status=deleted and archived_at', async () => {
      const db = fakeData() as any
      const repo = new ProjectsRepo(db)
      const a = await repo.create('uid-1', 'alpha')
      await repo.archive('uid-1', a.id)
      const row = db.tables.projects.find((r: any) => r.id === a.id)
      expect(row.status).toBe('deleted')
      expect(row.archived_at).toBeTruthy()
    })
  })

  describe('BranchesRepo archive/find/list', () => {
    it('listByProject excludes an archived branch + findById returns null after archive', async () => {
      const db = fakeData() as any
      const repo = new BranchesRepo(db)
      const main = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, status: 'active' })
      const dev = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'dev', parent_branch_id: main.id, is_default: false, status: 'active' })
      await repo.archive('uid-1', dev.id)
      const list = await repo.listByProject('uid-1', 'p1')
      expect(list.map((b) => b.id)).toEqual([main.id])
      expect(await repo.findById('uid-1', dev.id)).toBeNull()
    })
  })

  describe('ResourcesRepo listByProject/markStatus', () => {
    it('listByProject returns rows and markStatus updates status', async () => {
      const db = fakeData() as any
      // seed two resource rows directly via the fake
      await db.from('resources').insert({ owner: 'uid-1', project_id: 'p1', kind: 'neon', provider_ref: {}, status: 'active' })
      await db.from('resources').insert({ owner: 'uid-1', project_id: 'p1', kind: 'fly', provider_ref: {}, status: 'active' })
      const repo = new ResourcesRepo(db)
      const rows = await repo.listByProject('uid-1', 'p1')
      expect(rows.map((r) => r.kind).sort()).toEqual(['fly', 'neon'])
      await repo.markStatus('uid-1', rows[0].id, 'destroyed')
      const updated = db.tables.resources.find((r: any) => r.id === rows[0].id)
      expect(updated.status).toBe('destroyed')
    })
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. The new cases fail (e.g. `repo.findById is not a function`, `repo.archive is not a function`, `repo.markStatus is not a function`, and `listByOwner` still returns the archived project).

- [ ] **Implement** the repo changes in `control-plane/src/db/repos.ts`. Replace `ProjectsRepo` with:
  ```ts
  export class ProjectsRepo {
    constructor(private db: DataClient) {}

    async create(owner: string, name: string): Promise<Project> {
      const { data, error } = await this.db.from('projects')
        .insert({ owner, name, status: 'active' }).select()
      if (error) throw error
      return firstOrThrow(data, 'projects') as Project
    }

    async findById(owner: string, id: string): Promise<Project | null> {
      const { data, error } = await this.db.from('projects').select()
        .eq('owner', owner).eq('id', id).is('archived_at', null)
      if (error) throw error
      return ((data ?? [])[0] as Project) ?? null
    }

    async listByOwner(owner: string): Promise<Project[]> {
      const { data, error } = await this.db.from('projects').select()
        .eq('owner', owner).is('archived_at', null)
      if (error) throw error
      return (data ?? []) as Project[]
    }

    async archive(owner: string, id: string): Promise<void> {
      const { error } = await this.db.from('projects')
        .update({ archived_at: new Date().toISOString(), status: 'deleted' })
        .eq('owner', owner).eq('id', id)
      if (error) throw error
    }
  }
  ```
  Replace `ResourcesRepo` with:
  ```ts
  export class ResourcesRepo {
    constructor(private db: DataClient) {}

    async findByKind(owner: string, projectId: string, kind: string): Promise<ResourceRow | null> {
      const { data, error } = await this.db.from('resources').select()
        .eq('owner', owner).eq('project_id', projectId).eq('kind', kind)
      if (error) throw error
      return ((data ?? [])[0] as ResourceRow) ?? null
    }

    async listByProject(owner: string, projectId: string): Promise<ResourceRow[]> {
      const { data, error } = await this.db.from('resources').select()
        .eq('owner', owner).eq('project_id', projectId)
      if (error) throw error
      return (data ?? []) as ResourceRow[]
    }

    async markStatus(owner: string, id: string, status: string): Promise<void> {
      const { error } = await this.db.from('resources')
        .update({ status }).eq('owner', owner).eq('id', id)
      if (error) throw error
    }
  }
  ```
  Replace `BranchesRepo` with:
  ```ts
  export class BranchesRepo {
    constructor(private db: DataClient) {}

    async findByName(owner: string, projectId: string, name: string): Promise<BranchRow | null> {
      const { data, error } = await this.db.from('branches').select()
        .eq('owner', owner).eq('project_id', projectId).eq('name', name)
      if (error) throw error
      return ((data ?? [])[0] as BranchRow) ?? null
    }

    async findById(owner: string, id: string): Promise<BranchRow | null> {
      const { data, error } = await this.db.from('branches').select()
        .eq('owner', owner).eq('id', id).is('archived_at', null)
      if (error) throw error
      return ((data ?? [])[0] as BranchRow) ?? null
    }

    async create(row: {
      project_id: string; owner: string; name: string
      parent_branch_id: string | null; is_default: boolean; status: string
    }): Promise<BranchRow> {
      const { data, error } = await this.db.from('branches').insert(row).select()
      if (error) throw error
      return firstOrThrow(data, 'branch') as BranchRow
    }

    async listByProject(owner: string, projectId: string): Promise<BranchRow[]> {
      const { data, error } = await this.db.from('branches').select()
        .eq('owner', owner).eq('project_id', projectId).is('archived_at', null)
      if (error) throw error
      return (data ?? []) as BranchRow[]
    }

    async archive(owner: string, id: string): Promise<void> {
      const { error } = await this.db.from('branches')
        .update({ archived_at: new Date().toISOString(), status: 'deleted' })
        .eq('owner', owner).eq('id', id)
      if (error) throw error
    }
  }
  ```

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. All `repos.test.ts` cases pass; existing tests remain green.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add migrations/<timestamp>_add-archived-at.sql control-plane/src/db/repos.ts control-plane/test/db/repos.test.ts && git commit -m "feat(control-plane): archived_at soft-delete column + repo archive/find/list-filter methods"`

---

### Task 2: GET /projects/:id detail + provider_ref whitelist + NotFoundError

**Files:**
- Create: `control-plane/src/services/resource-view.ts`
- Modify: `control-plane/src/auth.ts` (add `NotFoundError`), `control-plane/src/server.ts` (import repos + `publicResourceView` + `NotFoundError`; add `GET /projects/:id`; add 404 handler branch)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `ProjectsRepo.findById`, `BranchesRepo.listByProject`, `ResourcesRepo.listByProject` (Task 1); existing `auth(req) → { uid, token, db }` helper.
- Produces:
  - `publicResourceView(r: { kind: string; status: string; provider_ref: Record<string, unknown> }): { kind: string; status: string; provider_ref: Record<string, unknown> }`
  - `class NotFoundError extends Error` in `auth.ts`
  - Route `GET /projects/:id` → `{ project: Project; branches: BranchRow[]; resources: Array<{ kind, status, provider_ref }> }`

#### Steps

- [ ] **Write failing tests** in `control-plane/test/server.test.ts`. Append these cases (reuse the existing `fakeData`, `fakeNeon`, `cfg`, and `buildServer({...})` helpers already in the file). Seed rows by inserting directly into the fake's tables before injecting:
  ```ts
  it('GET /projects/:id returns { project, branches, resources }', async () => {
    const db = fakeData()
    const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'alpha', status: 'active' }).then((r: any) => r)).data[0]
    await db.from('branches').insert({ project_id: project.id, owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' })
    await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: { neonProjectId: 'np-1' }, status: 'active' })
    const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
    const res = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.project.id).toBe(project.id)
    expect(body.branches.map((b: any) => b.name)).toEqual(['main'])
    expect(body.resources[0].kind).toBe('neon')
  })

  it('GET /projects/:id drops credential-shaped provider_ref keys (whitelist)', async () => {
    const db = fakeData()
    const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'alpha', status: 'active' }).then((r: any) => r)).data[0]
    await db.from('resources').insert({
      owner: 'uid-1', project_id: project.id, kind: 'neon',
      provider_ref: { neonProjectId: 'np', password: 'SECRET', connectionUri: 'postgres://u:p@h' }, status: 'active',
    })
    const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
    const res = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
    const ref = res.json().resources[0].provider_ref
    expect(ref.neonProjectId).toBe('np')
    expect(ref.password).toBeUndefined()
    expect(ref.connectionUri).toBeUndefined()
  })

  it('GET /projects/:id for an unknown project → 404', async () => {
    const db = fakeData()
    const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
    const res = await app.inject({ method: 'GET', url: '/projects/nope', headers: { authorization: 'Bearer good' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('project not found')
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. The `GET /projects/:id` cases fail (route not registered → 404 with `{error:'internal error'}` or no handler), and the import of `publicResourceView`/`NotFoundError` does not yet exist.

- [ ] **Create** `control-plane/src/services/resource-view.ts` with exactly:
  ```ts
  const WHITELIST: Record<string, string[]> = {
    neon: ['neonProjectId', 'defaultBranchId', 'dbName', 'roleName', 'host', 'database', 'region'],
    s3: ['bucket', 'bucketName', 'endpoint', 'region'],
    fly: ['app', 'appName', 'machineId', 'region'],
  }
  export function publicResourceView(r: { kind: string; status: string; provider_ref: Record<string, unknown> }) {
    const allowed = WHITELIST[r.kind] ?? []
    const ref: Record<string, unknown> = {}
    for (const k of allowed) if (k in r.provider_ref) ref[k] = r.provider_ref[k]
    return { kind: r.kind, status: r.status, provider_ref: ref }
  }
  ```

- [ ] **Add `NotFoundError`** to `control-plane/src/auth.ts`:
  ```ts
  export class NotFoundError extends Error {
    constructor(msg = 'not found') { super(msg); this.name = 'NotFoundError' }
  }
  ```

- [ ] **Wire the route + handler** in `control-plane/src/server.ts`. Update the imports at the top:
  ```ts
  import { resolveUid, UnauthorizedError, NotFoundError } from './auth.js'
  import { ProjectsRepo, SecretsRepo, BranchesRepo, ResourcesRepo, EventsRepo } from './db/repos.js'
  import { publicResourceView } from './services/resource-view.js'
  ```
  Add the 404 branch inside `setErrorHandler`, before the `return reply.code(500)` line (message is controlled/static — safe to echo):
  ```ts
  if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message })
  ```
  Add the route (place it after the existing `GET /projects` handler, before `POST /projects/:id/branches`):
  ```ts
  app.get('/projects/:id', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const project = await new ProjectsRepo(db).findById(uid, projectId)
    if (!project) throw new NotFoundError('project not found')
    const branches = await new BranchesRepo(db).listByProject(uid, projectId)
    const resources = (await new ResourcesRepo(db).listByProject(uid, projectId)).map(publicResourceView)
    return reply.send({ project, branches, resources })
  })
  ```

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. The three new cases pass; existing tests stay green.

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm run build` succeeds (no TS errors).

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add control-plane/src/services/resource-view.ts control-plane/src/auth.ts control-plane/src/server.ts control-plane/test/server.test.ts && git commit -m "feat(control-plane): GET /projects/:id detail with provider_ref whitelist + NotFoundError->404"`

---

### Task 3: ConflictError + TeardownService + DELETE endpoints + delete events

**Files:**
- Create: `control-plane/src/services/teardown.ts`
- Modify: `control-plane/src/auth.ts` (add `ConflictError`), `control-plane/src/server.ts` (import `TeardownService`; add 409 handler branch; add `DELETE /projects/:id` and `DELETE /projects/:id/branches/:bid`)
- Test: `control-plane/test/services/teardown.test.ts`, `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `ProjectsRepo` (`findById`, `archive`), `BranchesRepo` (`findById`, `archive`), `ResourcesRepo` (`listByProject`, `findByKind`, `markStatus`); `ProviderAdapter.destroy` and `ProviderAdapter.deleteBranch`; `NotFoundError` (Task 2); existing `auth` + `emit` helpers; `adaptersForToken(token)`.
- Produces:
  - `class ConflictError extends Error` in `auth.ts`
  - `type TeardownSummary = { destroyed: string[]; failed: Array<{ kind: string; message: string }> }`
  - `class TeardownService` with `deleteProject(owner, projectId)` → `{ project: Project & {status:'deleted'}; teardown: TeardownSummary }` and `deleteBranch(owner, projectId, branchId)` → `{ branch: BranchRow & {status:'deleted'}; teardown: TeardownSummary }`
  - Routes `DELETE /projects/:id` and `DELETE /projects/:id/branches/:bid`

#### Steps

- [ ] **Write failing service tests** in `control-plane/test/services/teardown.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { TeardownService } from '../../src/services/teardown.js'
  import { NotFoundError, ConflictError } from '../../src/auth.js'

  function fakeData() {
    const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], events: [] }
    return { tables, from(t: string) {
      const filters: Array<(r: any) => boolean> = []
      let mode: 'insert' | 'select' | 'update' = 'select'
      let insertedRow: any; let updatePayload: any
      const api: any = {
        insert(v: any) {
          mode = 'insert'
          const row = { id: `${t}-${tables[t].length}`, created_at: String(tables[t].length).padStart(10, '0'), ...v }
          tables[t].push(row); insertedRow = row; return api
        },
        update(v: any) { mode = 'update'; updatePayload = v; return api },
        select() { return api },
        eq(c: string, val: any) { filters.push(val === null ? () => false : (r: any) => r[c] === val); return api },
        is(c: string, val: any) { filters.push(val === null ? (r: any) => r[c] == null : (r: any) => r[c] === val); return api },
        async then(res: any) {
          if (mode === 'update') { for (const row of tables[t]) if (filters.every((fn) => fn(row))) Object.assign(row, updatePayload); return res({ data: [], error: null }) }
          if (mode === 'insert') return res({ data: [insertedRow], error: null })
          return res({ data: tables[t].filter((r) => filters.every((fn) => fn(r))), error: null })
        },
      }
      return api
    } }
  }

  const cfg = {} as any

  function okNeon(spy: { destroyed: number; deletedBranch: string | null }) {
    return {
      kind: 'neon', branchModel: 'native',
      async provision() { return { kind: 'neon', providerRef: {} } },
      async destroy() { spy.destroyed++ },
      async createBranch() { return 'br-x' },
      async deleteBranch(_h: any, ref: string) { spy.deletedBranch = ref },
      async mintCredentials() { return {} }, async readUsage() { return {} },
    }
  }

  describe('TeardownService.deleteProject', () => {
    it('destroys each resource, archives the project, summarizes destroyed kinds', async () => {
      const db = fakeData() as any
      const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
      await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: {}, status: 'active' })
      const spy = { destroyed: 0, deletedBranch: null as string | null }
      const out = await new TeardownService(db, cfg, [okNeon(spy) as any]).deleteProject('uid-1', project.id)
      expect(spy.destroyed).toBe(1)
      expect(out.teardown.destroyed).toEqual(['neon'])
      expect(out.teardown.failed).toEqual([])
      const row = db.tables.projects.find((r: any) => r.id === project.id)
      expect(row.status).toBe('deleted')
      expect(row.archived_at).toBeTruthy()
      const resource = db.tables.resources[0]
      expect(resource.status).toBe('destroyed')
    })

    it('records a failed destroy without throwing; project still archived; resource destroy_failed', async () => {
      const db = fakeData() as any
      const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
      await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: {}, status: 'active' })
      const boom = { kind: 'neon', branchModel: 'native', async provision() { return { kind: 'neon', providerRef: {} } }, async destroy() { throw new Error('boom') }, async createBranch() { return 'x' }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} } }
      const out = await new TeardownService(db, cfg, [boom as any]).deleteProject('uid-1', project.id)
      expect(out.teardown.destroyed).toEqual([])
      expect(out.teardown.failed).toEqual([{ kind: 'neon', message: 'boom' }])
      expect(db.tables.projects.find((r: any) => r.id === project.id).archived_at).toBeTruthy()
      expect(db.tables.resources[0].status).toBe('destroy_failed')
    })

    it('records "no adapter configured" when no adapter matches the kind', async () => {
      const db = fakeData() as any
      const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
      await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 's3', provider_ref: {}, status: 'active' })
      const out = await new TeardownService(db, cfg, []).deleteProject('uid-1', project.id)
      expect(out.teardown.failed).toEqual([{ kind: 's3', message: 'no adapter configured' }])
      expect(db.tables.resources[0].status).toBe('destroy_failed')
    })

    it('throws NotFoundError for a missing project', async () => {
      const db = fakeData() as any
      await expect(new TeardownService(db, cfg, []).deleteProject('uid-1', 'nope')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('TeardownService.deleteBranch', () => {
    it('rejects deleting the default branch with ConflictError', async () => {
      const db = fakeData() as any
      const main = (await db.from('branches').insert({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }).then((r: any) => r)).data[0]
      await expect(new TeardownService(db, cfg, []).deleteBranch('uid-1', 'p1', main.id)).rejects.toBeInstanceOf(ConflictError)
    })

    it('archives a non-default branch and calls neon.deleteBranch with its ref', async () => {
      const db = fakeData() as any
      await db.from('resources').insert({ owner: 'uid-1', project_id: 'p1', kind: 'neon', provider_ref: { neonProjectId: 'np' }, status: 'active' })
      const dev = (await db.from('branches').insert({ project_id: 'p1', owner: 'uid-1', name: 'dev', parent_branch_id: 'b0', is_default: false, neon_branch_ref: 'br-dev', status: 'active' }).then((r: any) => r)).data[0]
      const spy = { destroyed: 0, deletedBranch: null as string | null }
      const out = await new TeardownService(db, cfg, [okNeon(spy) as any]).deleteBranch('uid-1', 'p1', dev.id)
      expect(spy.deletedBranch).toBe('br-dev')
      expect(out.teardown.destroyed).toEqual(['neon-branch'])
      expect(db.tables.branches.find((r: any) => r.id === dev.id).archived_at).toBeTruthy()
    })

    it('throws NotFoundError when the branch is missing or belongs to another project', async () => {
      const db = fakeData() as any
      const dev = (await db.from('branches').insert({ project_id: 'other', owner: 'uid-1', name: 'dev', parent_branch_id: 'b0', is_default: false, neon_branch_ref: 'br-dev', status: 'active' }).then((r: any) => r)).data[0]
      await expect(new TeardownService(db, cfg, []).deleteBranch('uid-1', 'p1', dev.id)).rejects.toBeInstanceOf(NotFoundError)
    })
  })
  ```

- [ ] **Write failing route tests** in `control-plane/test/server.test.ts` (append; reuse existing helpers):
  ```ts
  it('DELETE /projects/:id → 200 with teardown summary', async () => {
    const db = fakeData()
    const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
    await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: {}, status: 'active' })
    const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
    const res = await app.inject({ method: 'DELETE', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().teardown.destroyed).toEqual(['neon'])
    expect(db.tables.projects.find((r: any) => r.id === project.id).archived_at).toBeTruthy()
  })

  it('DELETE default branch → 409', async () => {
    const db = fakeData()
    const main = (await db.from('branches').insert({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }).then((r: any) => r)).data[0]
    const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
    const res = await app.inject({ method: 'DELETE', url: `/projects/p1/branches/${main.id}`, headers: { authorization: 'Bearer good' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('cannot delete the default branch')
  })

  it('DELETE a missing project → 404', async () => {
    const db = fakeData()
    const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
    const res = await app.inject({ method: 'DELETE', url: '/projects/nope', headers: { authorization: 'Bearer good' } })
    expect(res.statusCode).toBe(404)
  })
  ```

- [ ] **Run the tests — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. `teardown.test.ts` fails to import `TeardownService`/`ConflictError`; the DELETE route cases 404/500.

- [ ] **Add `ConflictError`** to `control-plane/src/auth.ts`:
  ```ts
  export class ConflictError extends Error {
    constructor(msg = 'conflict') { super(msg); this.name = 'ConflictError' }
  }
  ```

- [ ] **Create** `control-plane/src/services/teardown.ts` with exactly:
  ```ts
  import { ProjectsRepo, BranchesRepo, ResourcesRepo } from '../db/repos.js'
  import { NotFoundError, ConflictError } from '../auth.js'
  import type { DataClient } from '../db/types.js'
  import type { FirthConfig } from '../config.js'
  import type { ProviderAdapter, ProviderKind } from '../adapters/types.js'

  export type TeardownSummary = { destroyed: string[]; failed: Array<{ kind: string; message: string }> }

  export class TeardownService {
    constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

    async deleteProject(owner: string, projectId: string) {
      const projects = new ProjectsRepo(this.db)
      const project = await projects.findById(owner, projectId)
      if (!project) throw new NotFoundError('project not found')
      const resources = await new ResourcesRepo(this.db).listByProject(owner, projectId)
      const repo = new ResourcesRepo(this.db)
      const summary: TeardownSummary = { destroyed: [], failed: [] }
      for (const r of resources) {
        const adapter = this.adapters.find((a) => a.kind === r.kind)
        if (!adapter) { summary.failed.push({ kind: r.kind, message: 'no adapter configured' }); await repo.markStatus(owner, r.id, 'destroy_failed'); continue }
        try {
          await adapter.destroy({ kind: r.kind as ProviderKind, providerRef: r.provider_ref })
          await repo.markStatus(owner, r.id, 'destroyed'); summary.destroyed.push(r.kind)
        } catch (e) {
          await repo.markStatus(owner, r.id, 'destroy_failed')
          summary.failed.push({ kind: r.kind, message: e instanceof Error ? e.message : String(e) })
        }
      }
      await projects.archive(owner, projectId)
      return { project: { ...project, status: 'deleted' }, teardown: summary }
    }

    async deleteBranch(owner: string, projectId: string, branchId: string) {
      const branches = new BranchesRepo(this.db)
      const branch = await branches.findById(owner, branchId)
      if (!branch || branch.project_id !== projectId) throw new NotFoundError('branch not found')
      if (branch.is_default) throw new ConflictError('cannot delete the default branch')
      const summary: TeardownSummary = { destroyed: [], failed: [] }
      const neon = this.adapters.find((a) => a.kind === 'neon')
      const resource = await new ResourcesRepo(this.db).findByKind(owner, projectId, 'neon')
      if (neon && resource && branch.neon_branch_ref) {
        try {
          await neon.deleteBranch({ kind: 'neon', providerRef: resource.provider_ref }, branch.neon_branch_ref)
          summary.destroyed.push('neon-branch')
        } catch (e) { summary.failed.push({ kind: 'neon-branch', message: e instanceof Error ? e.message : String(e) }) }
      }
      await branches.archive(owner, branchId)
      return { branch: { ...branch, status: 'deleted' }, teardown: summary }
    }
  }
  ```

- [ ] **Wire the routes + handler** in `control-plane/src/server.ts`. Add to the auth import: `import { resolveUid, UnauthorizedError, NotFoundError, ConflictError } from './auth.js'`. Add the import: `import { TeardownService } from './services/teardown.js'`. Add the 409 branch inside `setErrorHandler`, alongside the 404 branch:
  ```ts
  if (err instanceof ConflictError) return reply.code(409).send({ error: err.message })
  ```
  Add the two routes (after the `GET /projects/:id` route):
  ```ts
  app.delete('/projects/:id', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new TeardownService(db, deps.cfg, adapters).deleteProject(uid, projectId)
    await emit(db, uid, projectId, null, 'project.delete', { teardown: out.teardown })
    return reply.send(out)
  })
  app.delete('/projects/:id/branches/:bid', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const branchId = (req.params as any).bid
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new TeardownService(db, deps.cfg, adapters).deleteBranch(uid, projectId, branchId)
    await emit(db, uid, projectId, branchId, 'branch.delete', { name: out.branch.name, teardown: out.teardown })
    return reply.send(out)
  })
  ```

- [ ] **Run the tests — expect PASS.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. All `teardown.test.ts` cases and the three new server cases pass; existing tests stay green.

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm run build` succeeds.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add control-plane/src/services/teardown.ts control-plane/src/auth.ts control-plane/src/server.ts control-plane/test/services/teardown.test.ts control-plane/test/server.test.ts && git commit -m "feat(control-plane): TeardownService + DELETE project/branch endpoints + ConflictError->409 + delete events"`

---

### Task 4: CORS

**Files:**
- Modify: `control-plane/package.json` (add `@fastify/cors@^9`), `control-plane/src/config.ts` (add `corsOrigins?: string[]` to `FirthConfig` + parse `FIRTH_CORS_ORIGINS`), `control-plane/src/server.ts` (register the plugin before routes)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `deps.cfg.corsOrigins` (optional, defaults to `['http://localhost:5173']`).
- Produces: CORS response headers on every route (`access-control-allow-origin`, etc.); preflight `OPTIONS` handled by the plugin.

#### Steps

- [ ] **Install the dependency.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm i @fastify/cors@^9`. Confirm `@fastify/cors` now appears under `dependencies` in `control-plane/package.json`.

- [ ] **Write the failing test** in `control-plane/test/server.test.ts` (append; reuse existing helpers):
  ```ts
  it('sends an Access-Control-Allow-Origin header for the Vite dev origin', async () => {
    const db = fakeData()
    const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
    const res = await app.inject({ method: 'GET', url: '/projects', headers: { authorization: 'Bearer good', origin: 'http://localhost:5173' } })
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. The header is absent (`undefined !== 'http://localhost:5173'`).

- [ ] **Add the config field + parse.** Read `control-plane/src/config.ts` first to place the changes correctly. Add `corsOrigins?: string[]` to the `FirthConfig` type:
  ```ts
  export type FirthConfig = {
    keks: Map<string, Buffer>
    currentKek: string
    insforge: { baseUrl: string; anonKey: string; adminKey: string }
    neonApiKey?: string
    flyApiToken?: string
    flyOrgSlug?: string
    tigrisAccessKeyId?: string
    tigrisSecretAccessKey?: string
    corsOrigins?: string[]
  }
  ```
  Add the parse inside the returned object in `loadConfig` (after the `tigris*` fields):
  ```ts
  corsOrigins: env.FIRTH_CORS_ORIGINS ? env.FIRTH_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  ```

- [ ] **Register the plugin** in `control-plane/src/server.ts`. Add the import at the top: `import cors from '@fastify/cors'`. Register it inside `buildServer`, immediately after `setErrorHandler` and the `auth`/`emit` helpers but before the first route (`app.post('/projects', ...)`):
  ```ts
  app.register(cors, {
    origin: deps.cfg.corsOrigins ?? ['http://localhost:5173'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  })
  ```

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm test`. The CORS case passes; existing tests stay green.

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/control-plane && npm run build` succeeds.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add control-plane/package.json control-plane/package-lock.json control-plane/src/config.ts control-plane/src/server.ts control-plane/test/server.test.ts && git commit -m "feat(control-plane): CORS via @fastify/cors (FIRTH_CORS_ORIGINS, default localhost:5173)"`

---

### Task 5: dashboard/ scaffold (Vite+React+TS + Vitest/Testing Library + terminal theme)

**Files:**
- Create: `dashboard/package.json`, `dashboard/vite.config.ts`, `dashboard/tsconfig.json`, `dashboard/tsconfig.node.json`, `dashboard/index.html`, `dashboard/src/main.tsx`, `dashboard/src/App.tsx` (placeholder), `dashboard/src/theme.css`, `dashboard/src/types.ts`, `dashboard/src/test/setup.ts`, `dashboard/src/ui/Terminal.tsx`, `dashboard/.env.example`, `dashboard/.gitignore`
- Test: `dashboard/src/ui/Terminal.test.tsx`

**Interfaces:**
- Produces (presentational primitives in `Terminal.tsx`):
  - `Panel({ title, children }: { title: string; children: React.ReactNode })`
  - `Row({ children }: { children: React.ReactNode })`
  - `TButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>)`
  - `TInput(props: React.InputHTMLAttributes<HTMLInputElement>)`
  - `Confirm({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void })`
  - Frontend row types in `types.ts`: `Project`, `Branch`, `Resource`, `ProjectDetail`

#### Steps

- [ ] **Create the config + source files** (all complete, no placeholders).

  `dashboard/package.json`:
  ```json
  {
    "name": "firth-dashboard",
    "private": true,
    "version": "0.0.0",
    "type": "module",
    "scripts": {
      "dev": "vite",
      "build": "tsc -b && vite build",
      "preview": "vite preview",
      "test": "vitest run"
    },
    "dependencies": {
      "@insforge/sdk": "latest",
      "react": "^18.3.1",
      "react-dom": "^18.3.1"
    },
    "devDependencies": {
      "@testing-library/jest-dom": "^6.4.0",
      "@testing-library/react": "^16.0.0",
      "@testing-library/user-event": "^14.5.0",
      "@types/react": "^18.3.0",
      "@types/react-dom": "^18.3.0",
      "@vitejs/plugin-react": "^4.3.0",
      "jsdom": "^24.1.0",
      "typescript": "^5.5.0",
      "vite": "^5.4.0",
      "vitest": "^2.0.0"
    }
  }
  ```

  `dashboard/vite.config.ts`:
  ```ts
  /// <reference types="vitest/config" />
  import { defineConfig } from 'vite'
  import react from '@vitejs/plugin-react'

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
      globals: true,
    },
  })
  ```

  `dashboard/tsconfig.json`:
  ```json
  {
    "compilerOptions": {
      "target": "ES2020",
      "useDefineForClassFields": true,
      "lib": ["ES2020", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "skipLibCheck": true,
      "moduleResolution": "bundler",
      "allowImportingTsExtensions": true,
      "resolveJsonModule": true,
      "isolatedModules": true,
      "noEmit": true,
      "jsx": "react-jsx",
      "strict": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "noFallthroughCasesInSwitch": true,
      "types": ["vitest/globals", "@testing-library/jest-dom"]
    },
    "include": ["src"],
    "references": [{ "path": "./tsconfig.node.json" }]
  }
  ```

  `dashboard/tsconfig.node.json`:
  ```json
  {
    "compilerOptions": {
      "composite": true,
      "skipLibCheck": true,
      "module": "ESNext",
      "moduleResolution": "bundler",
      "allowSyntheticDefaultImports": true,
      "strict": true,
      "noEmit": true
    },
    "include": ["vite.config.ts"]
  }
  ```

  `dashboard/index.html`:
  ```html
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>firth</title>
    </head>
    <body>
      <div id="root"></div>
      <script type="module" src="/src/main.tsx"></script>
    </body>
  </html>
  ```

  `dashboard/src/theme.css`:
  ```css
  :root {
    --bg: #0a0e0a;
    --bg-panel: #0e140e;
    --border: #1f3a1f;
    --fg: #c8e6c8;
    --fg-dim: #6a8a6a;
    --green: #6ee06e;
    --amber: #e0b24a;
    --red: #e06c6c;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--mono);
    font-size: 14px;
    line-height: 1.5;
  }
  .firth-panel {
    border: 1px solid var(--border);
    background: var(--bg-panel);
    margin: 0 0 1rem;
  }
  .firth-panel__title {
    border-bottom: 1px solid var(--border);
    padding: 0.25rem 0.75rem;
    color: var(--green);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .firth-panel__body { padding: 0.75rem; }
  .firth-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.25rem 0;
    border-bottom: 1px dashed var(--border);
  }
  .firth-btn {
    font-family: var(--mono);
    font-size: inherit;
    background: transparent;
    color: var(--green);
    border: 1px solid var(--border);
    padding: 0.15rem 0.6rem;
    cursor: pointer;
  }
  .firth-btn:hover { background: var(--border); }
  .firth-btn:disabled { color: var(--fg-dim); cursor: not-allowed; opacity: 0.5; }
  .firth-btn--danger { color: var(--red); }
  .firth-input {
    font-family: var(--mono);
    font-size: inherit;
    background: #000;
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 0.25rem 0.5rem;
  }
  .firth-error { color: var(--red); }
  .firth-dim { color: var(--fg-dim); }
  .firth-confirm {
    border: 1px solid var(--red);
    background: var(--bg-panel);
    padding: 0.75rem;
    margin: 0.5rem 0;
  }
  ```

  `dashboard/src/types.ts`:
  ```ts
  export type Project = { id: string; name: string; status: string; created_at?: string }
  export type Branch = { id: string; name: string; is_default: boolean; neon_branch_ref: string | null; status: string }
  export type Resource = { kind: string; status: string; provider_ref: Record<string, unknown> }
  export type ProjectDetail = { project: Project; branches: Branch[]; resources: Resource[] }
  ```

  `dashboard/src/ui/Terminal.tsx`:
  ```tsx
  import React from 'react'

  export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
      <section className="firth-panel">
        <div className="firth-panel__title">{title}</div>
        <div className="firth-panel__body">{children}</div>
      </section>
    )
  }

  export function Row({ children }: { children: React.ReactNode }) {
    return <div className="firth-row">{children}</div>
  }

  export function TButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    const { className, ...rest } = props
    return <button {...rest} className={`firth-btn${className ? ` ${className}` : ''}`} />
  }

  export function TInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
    const { className, ...rest } = props
    return <input {...rest} className={`firth-input${className ? ` ${className}` : ''}`} />
  }

  export function Confirm({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
    return (
      <div className="firth-confirm" role="alertdialog" aria-label="confirm">
        <p className="firth-error">{message}</p>
        <Row>
          <TButton className="firth-btn--danger" onClick={onConfirm}>[confirm]</TButton>
          <TButton onClick={onCancel}>[cancel]</TButton>
        </Row>
      </div>
    )
  }
  ```

  `dashboard/src/App.tsx` (placeholder; replaced in Task 10):
  ```tsx
  import { Panel } from './ui/Terminal'

  export default function App() {
    return <Panel title="FIRTH">dashboard scaffold</Panel>
  }
  ```

  `dashboard/src/main.tsx` (placeholder; rewired in Task 10):
  ```tsx
  import React from 'react'
  import ReactDOM from 'react-dom/client'
  import App from './App'
  import './theme.css'

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
  ```

  `dashboard/src/test/setup.ts`:
  ```ts
  import '@testing-library/jest-dom'
  ```

  `dashboard/.env.example`:
  ```
  VITE_FIRTH_API_URL=http://localhost:3000
  VITE_INSFORGE_URL=https://your-backend.insforge.app
  VITE_INSFORGE_ANON_KEY=your-anon-key
  ```

  `dashboard/.gitignore`:
  ```
  node_modules
  dist
  .env
  ```

- [ ] **Install dependencies.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm install`. Confirm it completes without errors.

- [ ] **Write the failing smoke test** in `dashboard/src/ui/Terminal.test.tsx`:
  ```tsx
  import { describe, it, expect } from 'vitest'
  import { render, screen } from '@testing-library/react'
  import { Panel } from './Terminal'

  describe('Terminal primitives', () => {
    it('Panel renders its title and children', () => {
      render(<Panel title="PROJECTS">x</Panel>)
      expect(screen.getByText('PROJECTS')).toBeInTheDocument()
      expect(screen.getByText('x')).toBeInTheDocument()
    })
  })
  ```

- [ ] **Run the test — expect PASS** (the primitives were written above; this confirms the Vitest/jsdom/Testing Library harness works end to end). `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. To genuinely see RED→GREEN of the harness, temporarily change the assertion to `getByText('NOPE')`, run (FAIL), then revert to `getByText('PROJECTS')` and run again (PASS).

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm run build` succeeds (emits `dashboard/dist`).

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add dashboard/package.json dashboard/package-lock.json dashboard/vite.config.ts dashboard/tsconfig.json dashboard/tsconfig.node.json dashboard/index.html dashboard/src/main.tsx dashboard/src/App.tsx dashboard/src/theme.css dashboard/src/types.ts dashboard/src/test/setup.ts dashboard/src/ui/Terminal.tsx dashboard/src/ui/Terminal.test.tsx dashboard/.env.example dashboard/.gitignore && git commit -m "feat(dashboard): Vite+React+TS scaffold with terminal theme + Vitest/Testing Library harness"`

---

### Task 6: Auth module + AuthScreen

**Files:**
- Create: `dashboard/src/auth/auth.ts`, `dashboard/src/views/AuthScreen.tsx`
- Test: `dashboard/src/views/AuthScreen.test.tsx`

**Interfaces:**
- Consumes: `@insforge/sdk` `createClient`, `Panel`/`Row`/`TButton`/`TInput` from `../ui/Terminal`.
- Produces:
  - `type AuthUser = { id: string; email: string }`
  - `interface Auth` (`restore`, `signIn`, `signUp`, `signInWithOAuth`, `signOut`)
  - `createInsforgeAuth(baseUrl: string, anonKey: string): Auth`
  - `AuthScreen({ auth, onAuthed }: { auth: Auth; onAuthed: (token: string, user: AuthUser) => void })`

Note: the real SDK token-accessor path (`insforge.auth?.tokenManager?.getAccessToken?.()`) should be confirmed against the installed `@insforge/sdk` during implementation; the `AuthScreen` logic is tested against a FAKE `Auth`, so the tests do not depend on that path.

#### Steps

- [ ] **Create** `dashboard/src/auth/auth.ts` with exactly:
  ```ts
  import { createClient } from '@insforge/sdk'

  export type AuthUser = { id: string; email: string }

  export interface Auth {
    restore(): Promise<{ user: AuthUser; token: string } | null>
    signIn(email: string, password: string): Promise<{ user: AuthUser; token: string }>
    signUp(email: string, password: string, name?: string): Promise<{ needsVerification: boolean; user?: AuthUser; token?: string }>
    signInWithOAuth(provider: 'google' | 'github'): Promise<void>
    signOut(): Promise<void>
  }

  const TOKEN_KEY = 'firth_token'

  function toUser(u: any): AuthUser {
    return { id: u?.id ?? '', email: u?.email ?? '' }
  }

  export function createInsforgeAuth(baseUrl: string, anonKey: string): Auth {
    const insforge = createClient({ baseUrl, anonKey })

    function readToken(): string | null {
      // Defensive: SDK token accessor path may vary across versions; fall back to localStorage.
      const fromSdk = (insforge as any).auth?.tokenManager?.getAccessToken?.()
      return fromSdk ?? localStorage.getItem(TOKEN_KEY)
    }

    return {
      async restore() {
        const { data } = await insforge.auth.getCurrentUser()
        const user = data?.user
        if (!user) return null
        const token = readToken()
        if (!token) return null
        return { user: toUser(user), token }
      },

      async signIn(email, password) {
        const { data, error } = await insforge.auth.signInWithPassword({ email, password })
        if (error || !data) throw new Error(error ? 'sign-in failed' : 'sign-in failed')
        localStorage.setItem(TOKEN_KEY, data.accessToken)
        return { user: toUser(data.user), token: data.accessToken }
      },

      async signUp(email, password, name) {
        const { data, error } = await insforge.auth.signUp({ email, password, name })
        if (error || !data) throw new Error('sign-up failed')
        if ((data as any).accessToken) {
          localStorage.setItem(TOKEN_KEY, (data as any).accessToken)
          return { needsVerification: false, user: toUser((data as any).user), token: (data as any).accessToken }
        }
        return { needsVerification: true }
      },

      async signInWithOAuth(provider) {
        await insforge.auth.signInWithOAuth(provider, { redirectTo: window.location.origin })
      },

      async signOut() {
        await insforge.auth.signOut()
        localStorage.removeItem(TOKEN_KEY)
      },
    }
  }
  ```

  Note on `signUp` verification detection: the SDK signals an unverified sign-up by returning a response WITHOUT `accessToken` (the `requireEmailVerification` / `requireEmailVerification` flag may also be present). Treat "no `accessToken` in `data`" as `needsVerification: true`. If the installed SDK surfaces `data.requireEmailVerification` explicitly, prefer it: `const needsVerification = !!(data as any).requireEmailVerification || !(data as any).accessToken`.

- [ ] **Write the failing tests** in `dashboard/src/views/AuthScreen.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest'
  import { render, screen } from '@testing-library/react'
  import userEvent from '@testing-library/user-event'
  import { AuthScreen } from './AuthScreen'
  import type { Auth, AuthUser } from '../auth/auth'

  const user: AuthUser = { id: 'u1', email: 'a@b.co' }

  function fakeAuth(overrides: Partial<Auth> = {}): Auth {
    return {
      restore: vi.fn(async () => null),
      signIn: vi.fn(async () => ({ user, token: 'tok-1' })),
      signUp: vi.fn(async () => ({ needsVerification: false, user, token: 'tok-1' })),
      signInWithOAuth: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
      ...overrides,
    }
  }

  describe('AuthScreen', () => {
    it('signing in calls onAuthed with the token and user', async () => {
      const auth = fakeAuth()
      const onAuthed = vi.fn()
      render(<AuthScreen auth={auth} onAuthed={onAuthed} />)
      await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
      await userEvent.type(screen.getByLabelText(/password/i), 'pw')
      await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
      expect(auth.signIn).toHaveBeenCalledWith('a@b.co', 'pw')
      expect(onAuthed).toHaveBeenCalledWith('tok-1', user)
    })

    it('sign-up needing verification shows a verify message and does NOT call onAuthed', async () => {
      const auth = fakeAuth({ signUp: vi.fn(async () => ({ needsVerification: true })) })
      const onAuthed = vi.fn()
      render(<AuthScreen auth={auth} onAuthed={onAuthed} />)
      await userEvent.click(screen.getByRole('button', { name: /create account/i }))
      await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
      await userEvent.type(screen.getByLabelText(/password/i), 'pw')
      await userEvent.click(screen.getByRole('button', { name: /sign up/i }))
      expect(await screen.findByText(/check your email/i)).toBeInTheDocument()
      expect(onAuthed).not.toHaveBeenCalled()
    })

    it('a failed sign-in renders a terminal error line', async () => {
      const auth = fakeAuth({ signIn: vi.fn(async () => { throw new Error('sign-in failed') }) })
      const onAuthed = vi.fn()
      render(<AuthScreen auth={auth} onAuthed={onAuthed} />)
      await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
      await userEvent.type(screen.getByLabelText(/password/i), 'pw')
      await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
      expect(await screen.findByText(/sign-in failed/i)).toBeInTheDocument()
      expect(onAuthed).not.toHaveBeenCalled()
    })

    it('clicking the Google button calls signInWithOAuth("google")', async () => {
      const auth = fakeAuth()
      render(<AuthScreen auth={auth} onAuthed={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /google/i }))
      expect(auth.signInWithOAuth).toHaveBeenCalledWith('google')
    })
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. `AuthScreen` does not exist yet → import error.

- [ ] **Create** `dashboard/src/views/AuthScreen.tsx` with exactly:
  ```tsx
  import { useState } from 'react'
  import { Panel, Row, TButton, TInput } from '../ui/Terminal'
  import type { Auth, AuthUser } from '../auth/auth'

  export function AuthScreen({ auth, onAuthed }: { auth: Auth; onAuthed: (token: string, user: AuthUser) => void }) {
    const [mode, setMode] = useState<'signin' | 'signup'>('signin')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    async function submit(e: React.FormEvent) {
      e.preventDefault()
      setError(null); setNotice(null); setBusy(true)
      try {
        if (mode === 'signin') {
          const { user, token } = await auth.signIn(email, password)
          onAuthed(token, user)
        } else {
          const res = await auth.signUp(email, password)
          if (res.needsVerification || !res.token || !res.user) {
            setNotice('check your email to verify, then sign in')
          } else {
            onAuthed(res.token, res.user)
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'request failed')
      } finally {
        setBusy(false)
      }
    }

    async function oauth(provider: 'google' | 'github') {
      setError(null)
      try { await auth.signInWithOAuth(provider) }
      catch (err) { setError(err instanceof Error ? err.message : 'oauth failed') }
    }

    return (
      <Panel title="firth // access">
        <Row>
          <TButton onClick={() => { setMode('signin'); setError(null); setNotice(null) }} disabled={mode === 'signin'}>[sign in]</TButton>
          <TButton onClick={() => { setMode('signup'); setError(null); setNotice(null) }} disabled={mode === 'signup'}>[create account]</TButton>
        </Row>
        <form onSubmit={submit}>
          <Row>
            <label htmlFor="email">email</label>
            <TInput id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Row>
          <Row>
            <label htmlFor="password">password</label>
            <TInput id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Row>
          <Row>
            <TButton type="submit" disabled={busy}>{mode === 'signin' ? '[sign in]' : '[sign up]'}</TButton>
          </Row>
        </form>
        <Row>
          <span className="firth-dim">oauth:</span>
          <TButton onClick={() => oauth('google')}>[google]</TButton>
          <TButton onClick={() => oauth('github')}>[github]</TButton>
        </Row>
        {notice && <p className="firth-dim">{notice}</p>}
        {error && <p className="firth-error">! {error}</p>}
      </Panel>
    )
  }
  ```

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. All four `AuthScreen` cases pass.

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm run build` succeeds.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add dashboard/src/auth/auth.ts dashboard/src/views/AuthScreen.tsx dashboard/src/views/AuthScreen.test.tsx && git commit -m "feat(dashboard): InsForge auth module + terminal AuthScreen (sign-in/up/OAuth)"`

---

### Task 7: API client

**Files:**
- Create: `dashboard/src/api/client.ts`
- Test: `dashboard/src/api/client.test.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectDetail` from `../types`; a `Fetcher = typeof fetch`.
- Produces:
  - `class ApiError extends Error { status: number }`
  - `class Api` with `listProjects`, `getProject`, `createProject`, `deleteProject`, `createBranch`, `deleteBranch`; constructor `(baseUrl: string, getToken: () => string | null, fetcher?: Fetcher)`.

#### Steps

- [ ] **Write the failing tests** in `dashboard/src/api/client.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import { Api, ApiError } from './client'

  function jsonRes(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
  }

  describe('Api', () => {
    it('listProjects returns the array and sends a Bearer token', async () => {
      const fetcher = vi.fn(async () => jsonRes(200, { projects: [{ id: 'p1', name: 'a', status: 'active' }] }))
      const api = new Api('http://api', () => 'tok-1', fetcher as any)
      const projects = await api.listProjects()
      expect(projects).toEqual([{ id: 'p1', name: 'a', status: 'active' }])
      const [url, init] = fetcher.mock.calls[0] as any
      expect(url).toBe('http://api/projects')
      expect(init.method).toBe('GET')
      expect(init.headers.Authorization).toBe('Bearer tok-1')
    })

    it('omits the Authorization header when there is no token', async () => {
      const fetcher = vi.fn(async () => jsonRes(200, { projects: [] }))
      const api = new Api('http://api', () => null, fetcher as any)
      await api.listProjects()
      const [, init] = fetcher.mock.calls[0] as any
      expect(init.headers.Authorization).toBeUndefined()
    })

    it('a non-ok response throws ApiError with status and the server error string', async () => {
      const fetcher = vi.fn(async () => jsonRes(404, { error: 'project not found' }))
      const api = new Api('http://api', () => 'tok-1', fetcher as any)
      await expect(api.getProject('nope')).rejects.toMatchObject({ status: 404, message: 'project not found' })
      await expect(api.getProject('nope')).rejects.toBeInstanceOf(ApiError)
    })

    it('deleteProject hits the DELETE path', async () => {
      const fetcher = vi.fn(async () => jsonRes(200, { teardown: { destroyed: [], failed: [] } }))
      const api = new Api('http://api', () => 'tok-1', fetcher as any)
      await api.deleteProject('p1')
      const [url, init] = fetcher.mock.calls[0] as any
      expect(url).toBe('http://api/projects/p1')
      expect(init.method).toBe('DELETE')
    })
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. `client.ts` does not exist → import error.

- [ ] **Create** `dashboard/src/api/client.ts` with exactly:
  ```ts
  import type { Project, ProjectDetail } from '../types'
  export class ApiError extends Error { constructor(public status: number, message: string) { super(message); this.name = 'ApiError' } }
  export type Fetcher = typeof fetch
  export class Api {
    constructor(private baseUrl: string, private getToken: () => string | null, private fetcher: Fetcher = fetch) {}
    private async req(method: string, path: string, body?: unknown): Promise<any> {
      const token = this.getToken()
      const res = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) { let msg = ''; try { msg = (await res.json())?.error ?? '' } catch { /* ignore */ } throw new ApiError(res.status, msg || `request failed: ${res.status}`) }
      return res.json()
    }
    listProjects(): Promise<Project[]> { return this.req('GET', '/projects').then((r) => r.projects) }
    getProject(id: string): Promise<ProjectDetail> { return this.req('GET', `/projects/${id}`) }
    createProject(name: string) { return this.req('POST', '/projects', { name }) }
    deleteProject(id: string) { return this.req('DELETE', `/projects/${id}`) }
    createBranch(projectId: string, name: string, from: string) { return this.req('POST', `/projects/${projectId}/branches`, { name, from }) }
    deleteBranch(projectId: string, branchId: string) { return this.req('DELETE', `/projects/${projectId}/branches/${branchId}`) }
  }
  ```

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. All four `client.test.ts` cases pass.

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm run build` succeeds.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add dashboard/src/api/client.ts dashboard/src/api/client.test.ts && git commit -m "feat(dashboard): typed Api client over fetch with Bearer auth + ApiError"`

---

### Task 8: Projects view (list + create + delete-with-confirm)

**Files:**
- Create: `dashboard/src/views/Projects.tsx`
- Test: `dashboard/src/views/Projects.test.tsx`

**Interfaces:**
- Consumes: `Api` (`listProjects`, `createProject`, `deleteProject`), `Panel`/`Row`/`TButton`/`TInput`/`Confirm`, `Project` from `../types`.
- Produces: `Projects({ api, onOpen }: { api: Api; onOpen: (projectId: string) => void })`.

#### Steps

- [ ] **Write the failing tests** in `dashboard/src/views/Projects.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest'
  import { render, screen, waitFor } from '@testing-library/react'
  import userEvent from '@testing-library/user-event'
  import { Projects } from './Projects'
  import type { Api } from '../api/client'

  function fakeApi(overrides: Partial<Api> = {}): Api {
    return {
      listProjects: vi.fn(async () => [{ id: 'p1', name: 'alpha', status: 'active' }]),
      getProject: vi.fn(),
      createProject: vi.fn(async () => ({})),
      deleteProject: vi.fn(async () => ({})),
      createBranch: vi.fn(),
      deleteBranch: vi.fn(),
      ...overrides,
    } as unknown as Api
  }

  describe('Projects', () => {
    it('renders project names from listProjects', async () => {
      const api = fakeApi()
      render(<Projects api={api} onOpen={vi.fn()} />)
      expect(await screen.findByText('alpha')).toBeInTheDocument()
    })

    it('creating a project calls createProject then refreshes', async () => {
      const listProjects = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'p2', name: 'beta', status: 'active' }])
      const createProject = vi.fn(async () => ({}))
      const api = fakeApi({ listProjects, createProject })
      render(<Projects api={api} onOpen={vi.fn()} />)
      await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1))
      await userEvent.click(screen.getByRole('button', { name: /create/i }))
      await userEvent.type(screen.getByLabelText(/name/i), 'beta')
      await userEvent.click(screen.getByRole('button', { name: /^\[ok\]$/i }))
      expect(createProject).toHaveBeenCalledWith('beta')
      expect(await screen.findByText('beta')).toBeInTheDocument()
    })

    it('deleting a project shows a confirm; confirming calls deleteProject', async () => {
      const deleteProject = vi.fn(async () => ({}))
      const api = fakeApi({ deleteProject })
      render(<Projects api={api} onOpen={vi.fn()} />)
      await screen.findByText('alpha')
      await userEvent.click(screen.getByRole('button', { name: /delete/i }))
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
      expect(deleteProject).toHaveBeenCalledWith('p1')
    })

    it('opening a project calls onOpen with its id', async () => {
      const onOpen = vi.fn()
      const api = fakeApi()
      render(<Projects api={api} onOpen={onOpen} />)
      await screen.findByText('alpha')
      await userEvent.click(screen.getByRole('button', { name: /open/i }))
      expect(onOpen).toHaveBeenCalledWith('p1')
    })
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. `Projects` does not exist → import error.

- [ ] **Create** `dashboard/src/views/Projects.tsx` with exactly:
  ```tsx
  import { useCallback, useEffect, useState } from 'react'
  import { Panel, Row, TButton, TInput, Confirm } from '../ui/Terminal'
  import type { Api } from '../api/client'
  import type { Project } from '../types'

  export function Projects({ api, onOpen }: { api: Api; onOpen: (projectId: string) => void }) {
    const [projects, setProjects] = useState<Project[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)
    const [name, setName] = useState('')
    const [confirmId, setConfirmId] = useState<string | null>(null)

    const refresh = useCallback(async () => {
      setLoading(true); setError(null)
      try { setProjects(await api.listProjects()) }
      catch (err) { setError(err instanceof Error ? err.message : 'failed to load projects') }
      finally { setLoading(false) }
    }, [api])

    useEffect(() => { void refresh() }, [refresh])

    async function create() {
      if (!name.trim()) return
      setError(null)
      try { await api.createProject(name.trim()); setName(''); setCreating(false); await refresh() }
      catch (err) { setError(err instanceof Error ? err.message : 'failed to create project') }
    }

    async function remove(id: string) {
      setConfirmId(null); setError(null)
      try { await api.deleteProject(id); await refresh() }
      catch (err) { setError(err instanceof Error ? err.message : 'failed to delete project') }
    }

    return (
      <Panel title="projects">
        <Row>
          <TButton onClick={() => setCreating((c) => !c)}>[+ create]</TButton>
        </Row>
        {creating && (
          <Row>
            <label htmlFor="new-project-name">name</label>
            <TInput id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} />
            <TButton onClick={create}>[ok]</TButton>
            <TButton onClick={() => { setCreating(false); setName('') }}>[cancel]</TButton>
          </Row>
        )}
        {loading && <p className="firth-dim">loading...</p>}
        {error && <p className="firth-error">! {error}</p>}
        {!loading && projects.length === 0 && <p className="firth-dim">no projects yet</p>}
        {projects.map((p) => (
          <Row key={p.id}>
            <span style={{ flex: 1 }}>{p.name}</span>
            <span className="firth-dim">{p.status}</span>
            <span className="firth-dim">{p.created_at ?? ''}</span>
            <TButton onClick={() => onOpen(p.id)}>[open]</TButton>
            <TButton className="firth-btn--danger" onClick={() => setConfirmId(p.id)}>[delete]</TButton>
          </Row>
        ))}
        {confirmId && (
          <Confirm
            message="teardown is irreversible: this destroys the project's cloud resources (Neon/Fly/Tigris). continue?"
            onConfirm={() => remove(confirmId)}
            onCancel={() => setConfirmId(null)}
          />
        )}
      </Panel>
    )
  }
  ```
  Note: import is `import { useCallback, useEffect, useState } from 'react'` — fix the casing (`useCallback`, not `useCallBack`) if your editor autocompletes wrong.

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. All four `Projects` cases pass.

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm run build` succeeds.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add dashboard/src/views/Projects.tsx dashboard/src/views/Projects.test.tsx && git commit -m "feat(dashboard): Projects view (list + create + delete-with-confirm)"`

---

### Task 9: Project detail / branches view

**Files:**
- Create: `dashboard/src/views/ProjectDetail.tsx`
- Test: `dashboard/src/views/ProjectDetail.test.tsx`

**Interfaces:**
- Consumes: `Api` (`getProject`, `createBranch`, `deleteBranch`), `Panel`/`Row`/`TButton`/`TInput`/`Confirm`, `ProjectDetail`/`Branch`/`Resource` from `../types`.
- Produces: `ProjectDetail({ api, projectId, onBack }: { api: Api; projectId: string; onBack: () => void })`.

#### Steps

- [ ] **Write the failing tests** in `dashboard/src/views/ProjectDetail.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest'
  import { render, screen, waitFor } from '@testing-library/react'
  import userEvent from '@testing-library/user-event'
  import { ProjectDetail } from './ProjectDetail'
  import type { Api } from '../api/client'
  import type { ProjectDetail as Detail } from '../types'

  const detail: Detail = {
    project: { id: 'p1', name: 'alpha', status: 'active' },
    branches: [
      { id: 'b0', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' },
      { id: 'b1', name: 'dev', is_default: false, neon_branch_ref: 'br-dev', status: 'active' },
    ],
    resources: [{ kind: 'neon', status: 'active', provider_ref: { neonProjectId: 'np-1' } }],
  }

  function fakeApi(overrides: Partial<Api> = {}): Api {
    return {
      listProjects: vi.fn(),
      getProject: vi.fn(async () => detail),
      createProject: vi.fn(),
      deleteProject: vi.fn(),
      createBranch: vi.fn(async () => ({})),
      deleteBranch: vi.fn(async () => ({})),
      ...overrides,
    } as unknown as Api
  }

  describe('ProjectDetail', () => {
    it('renders branches and resource handles', async () => {
      render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
      expect(await screen.findByText('main')).toBeInTheDocument()
      expect(screen.getByText('dev')).toBeInTheDocument()
      expect(screen.getByText(/neon/i)).toBeInTheDocument()
      expect(screen.getByText(/np-1/)).toBeInTheDocument()
    })

    it('the default branch row exposes no delete control', async () => {
      render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
      await screen.findByText('main')
      // exactly one [delete] button (for the non-default 'dev' branch)
      expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(1)
    })

    it('deleting a non-default branch calls deleteBranch', async () => {
      const deleteBranch = vi.fn(async () => ({}))
      render(<ProjectDetail api={fakeApi({ deleteBranch })} projectId="p1" onBack={vi.fn()} />)
      await screen.findByText('dev')
      await userEvent.click(screen.getByRole('button', { name: /delete/i }))
      await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
      expect(deleteBranch).toHaveBeenCalledWith('p1', 'b1')
    })

    it('creating a branch calls createBranch', async () => {
      const createBranch = vi.fn(async () => ({}))
      const getProject = vi.fn().mockResolvedValue(detail)
      render(<ProjectDetail api={fakeApi({ createBranch, getProject })} projectId="p1" onBack={vi.fn()} />)
      await screen.findByText('main')
      await userEvent.click(screen.getByRole('button', { name: /create branch/i }))
      await userEvent.type(screen.getByLabelText(/^name$/i), 'feature')
      await userEvent.type(screen.getByLabelText(/^from$/i), 'main')
      await userEvent.click(screen.getByRole('button', { name: /^\[ok\]$/i }))
      await waitFor(() => expect(createBranch).toHaveBeenCalledWith('p1', 'feature', 'main'))
    })
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. `ProjectDetail` does not exist → import error.

- [ ] **Create** `dashboard/src/views/ProjectDetail.tsx` with exactly:
  ```tsx
  import { useCallback, useEffect, useState } from 'react'
  import { Panel, Row, TButton, TInput, Confirm } from '../ui/Terminal'
  import type { Api } from '../api/client'
  import type { ProjectDetail as Detail } from '../types'

  export function ProjectDetail({ api, projectId, onBack }: { api: Api; projectId: string; onBack: () => void }) {
    const [detail, setDetail] = useState<Detail | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)
    const [name, setName] = useState('')
    const [from, setFrom] = useState('main')
    const [confirmBranch, setConfirmBranch] = useState<string | null>(null)

    const refresh = useCallback(async () => {
      setLoading(true); setError(null)
      try { setDetail(await api.getProject(projectId)) }
      catch (err) { setError(err instanceof Error ? err.message : 'failed to load project') }
      finally { setLoading(false) }
    }, [api, projectId])

    useEffect(() => { void refresh() }, [refresh])

    async function create() {
      if (!name.trim()) return
      setError(null)
      try { await api.createBranch(projectId, name.trim(), from.trim() || 'main'); setName(''); setFrom('main'); setCreating(false); await refresh() }
      catch (err) { setError(err instanceof Error ? err.message : 'failed to create branch') }
    }

    async function removeBranch(branchId: string) {
      setConfirmBranch(null); setError(null)
      try { await api.deleteBranch(projectId, branchId); await refresh() }
      catch (err) { setError(err instanceof Error ? err.message : 'failed to delete branch') }
    }

    return (
      <div>
        <Row>
          <TButton onClick={onBack}>[&lt; back]</TButton>
          <span>{detail?.project.name ?? projectId}</span>
          <span className="firth-dim">{detail?.project.status ?? ''}</span>
        </Row>
        {loading && <p className="firth-dim">loading...</p>}
        {error && <p className="firth-error">! {error}</p>}
        {detail && (
          <>
            <Panel title="resources">
              {detail.resources.length === 0 && <p className="firth-dim">no resources</p>}
              {detail.resources.map((r, i) => (
                <Row key={`${r.kind}-${i}`}>
                  <span style={{ flex: 1 }}>{r.kind}</span>
                  <span className="firth-dim">{r.status}</span>
                  <span className="firth-dim">{Object.entries(r.provider_ref).map(([k, v]) => `${k}=${String(v)}`).join(' ')}</span>
                </Row>
              ))}
            </Panel>
            <Panel title="branches">
              <Row><TButton onClick={() => setCreating((c) => !c)}>[+ create branch]</TButton></Row>
              {creating && (
                <Row>
                  <label htmlFor="branch-name">name</label>
                  <TInput id="branch-name" value={name} onChange={(e) => setName(e.target.value)} />
                  <label htmlFor="branch-from">from</label>
                  <TInput id="branch-from" value={from} onChange={(e) => setFrom(e.target.value)} />
                  <TButton onClick={create}>[ok]</TButton>
                  <TButton onClick={() => { setCreating(false); setName(''); setFrom('main') }}>[cancel]</TButton>
                </Row>
              )}
              {detail.branches.map((b) => (
                <Row key={b.id}>
                  <span style={{ flex: 1 }}>{b.name}</span>
                  {b.is_default && <span className="firth-dim">default</span>}
                  <span className="firth-dim">{b.neon_branch_ref ?? '-'}</span>
                  <span className="firth-dim">{b.status}</span>
                  {!b.is_default && (
                    <TButton className="firth-btn--danger" onClick={() => setConfirmBranch(b.id)}>[delete]</TButton>
                  )}
                </Row>
              ))}
            </Panel>
            {confirmBranch && (
              <Confirm
                message="deleting this branch destroys its Neon branch. this is irreversible. continue?"
                onConfirm={() => removeBranch(confirmBranch)}
                onCancel={() => setConfirmBranch(null)}
              />
            )}
          </>
        )}
      </div>
    )
  }
  ```

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. All four `ProjectDetail` cases pass.

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm run build` succeeds.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add dashboard/src/views/ProjectDetail.tsx dashboard/src/views/ProjectDetail.test.tsx && git commit -m "feat(dashboard): ProjectDetail view (metadata + resources + branch create/delete; default branch undeletable)"`

---

### Task 10: App shell wiring + README

**Files:**
- Modify: `dashboard/src/App.tsx`, `dashboard/src/main.tsx`
- Create: `dashboard/README.md`
- Test: `dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: `Auth`/`AuthUser` (Task 6), `Api` (Task 7), `AuthScreen`/`Projects`/`ProjectDetail` views.
- Produces: `App({ auth, makeApi }: { auth: Auth; makeApi: (getToken: () => string | null) => Api })` — holds `{token, user}` + a view route (`projects | detail`). `main.tsx` wires the real `createInsforgeAuth(...)` and `makeApi`.

#### Steps

- [ ] **Write the failing tests** in `dashboard/src/App.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest'
  import { render, screen, waitFor } from '@testing-library/react'
  import userEvent from '@testing-library/user-event'
  import App from './App'
  import type { Auth, AuthUser } from './auth/auth'
  import type { Api } from './api/client'

  const user: AuthUser = { id: 'u1', email: 'a@b.co' }

  function fakeAuth(overrides: Partial<Auth> = {}): Auth {
    return {
      restore: vi.fn(async () => null),
      signIn: vi.fn(async () => ({ user, token: 'tok-1' })),
      signUp: vi.fn(async () => ({ needsVerification: false, user, token: 'tok-1' })),
      signInWithOAuth: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
      ...overrides,
    }
  }

  function makeApi(listProjects = vi.fn(async () => [])): (g: () => string | null) => Api {
    return () => ({
      listProjects, getProject: vi.fn(async () => ({ project: { id: 'p1', name: 'alpha', status: 'active' }, branches: [], resources: [] })),
      createProject: vi.fn(), deleteProject: vi.fn(), createBranch: vi.fn(), deleteBranch: vi.fn(),
    } as unknown as Api)
  }

  describe('App', () => {
    it('with no restored session renders the AuthScreen', async () => {
      render(<App auth={fakeAuth()} makeApi={makeApi()} />)
      expect(await screen.findByText(/firth \/\/ access/i)).toBeInTheDocument()
    })

    it('after sign-in renders the Projects view', async () => {
      render(<App auth={fakeAuth()} makeApi={makeApi()} />)
      await screen.findByText(/firth \/\/ access/i)
      await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
      await userEvent.type(screen.getByLabelText(/password/i), 'pw')
      await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
      expect(await screen.findByText(/projects/i)).toBeInTheDocument()
    })

    it('a restored session goes straight to Projects; logout returns to AuthScreen', async () => {
      const auth = fakeAuth({ restore: vi.fn(async () => ({ user, token: 'tok-1' })) })
      render(<App auth={auth} makeApi={makeApi()} />)
      expect(await screen.findByText(/projects/i)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: /logout/i }))
      expect(auth.signOut).toHaveBeenCalled()
      expect(await screen.findByText(/firth \/\/ access/i)).toBeInTheDocument()
    })

    it('a 401 from the api returns to the AuthScreen', async () => {
      const list = vi.fn(async () => { const e: any = new Error('unauthorized'); e.status = 401; e.name = 'ApiError'; throw e })
      const auth = fakeAuth({ restore: vi.fn(async () => ({ user, token: 'tok-1' })) })
      render(<App auth={auth} makeApi={makeApi(list)} />)
      expect(await screen.findByText(/firth \/\/ access/i)).toBeInTheDocument()
    })
  })
  ```

- [ ] **Run the test — expect FAIL.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. The current placeholder `App` takes no props and renders only the scaffold panel → assertions fail.

- [ ] **Rewrite** `dashboard/src/App.tsx` with exactly:
  ```tsx
  import { useCallback, useEffect, useRef, useState } from 'react'
  import { AuthScreen } from './views/AuthScreen'
  import { Projects } from './views/Projects'
  import { ProjectDetail } from './views/ProjectDetail'
  import { Row, TButton } from './ui/Terminal'
  import { ApiError, type Api } from './api/client'
  import type { Auth, AuthUser } from './auth/auth'

  type View = { name: 'projects' } | { name: 'detail'; projectId: string }

  export default function App({ auth, makeApi }: { auth: Auth; makeApi: (getToken: () => string | null) => Api }) {
    const [token, setToken] = useState<string | null>(null)
    const [user, setUser] = useState<AuthUser | null>(null)
    const [view, setView] = useState<View>({ name: 'projects' })
    const [ready, setReady] = useState(false)
    const tokenRef = useRef<string | null>(null)
    tokenRef.current = token

    useEffect(() => {
      let active = true
      void auth.restore().then((s) => {
        if (!active) return
        if (s) { setToken(s.token); setUser(s.user) }
        setReady(true)
      }).catch(() => { if (active) setReady(true) })
      return () => { active = false }
    }, [auth])

    const dropToAuth = useCallback(() => { setToken(null); setUser(null); setView({ name: 'projects' }) }, [])

    // Wrap the api so any 401 from the control plane drops the session back to the auth screen.
    const api = useCallback(() => {
      const base = makeApi(() => tokenRef.current)
      return new Proxy(base, {
        get(t, prop) {
          const orig = (t as any)[prop]
          if (typeof orig !== 'function') return orig
          return (...args: unknown[]) =>
            Promise.resolve(orig.apply(t, args)).catch((err) => {
              if (err instanceof ApiError && err.status === 401) dropToAuth()
              throw err
            })
        },
      })
    }, [makeApi, dropToAuth])()

    async function logout() {
      try { await auth.signOut() } finally { dropToAuth() }
    }

    if (!ready) return <p className="firth-dim">loading...</p>
    if (!token) {
      return <AuthScreen auth={auth} onAuthed={(t, u) => { setToken(t); setUser(u) }} />
    }
    return (
      <div>
        <Row>
          <span style={{ flex: 1 }}>firth</span>
          <span className="firth-dim">{user?.email}</span>
          <TButton onClick={logout}>[logout]</TButton>
        </Row>
        {view.name === 'projects' && <Projects api={api} onOpen={(projectId) => setView({ name: 'detail', projectId })} />}
        {view.name === 'detail' && <ProjectDetail api={api} projectId={view.projectId} onBack={() => setView({ name: 'projects' })} />}
      </div>
    )
  }
  ```
  Note: the `ApiError` instanceof check matches the real `Api` client; the 401 test throws an error whose `name`/`status` mimic `ApiError`. If your test object is a plain Error (not an `ApiError` instance), make the guard also accept `err?.status === 401` — i.e. `if ((err instanceof ApiError || (err as any)?.status === 401) && (err as any).status === 401) dropToAuth()`. Prefer the `status === 401` check so the test passes without constructing a real `ApiError`.

- [ ] **Rewrite** `dashboard/src/main.tsx` to wire the real dependencies:
  ```tsx
  import React from 'react'
  import ReactDOM from 'react-dom/client'
  import App from './App'
  import { createInsforgeAuth } from './auth/auth'
  import { Api } from './api/client'
  import './theme.css'

  const auth = createInsforgeAuth(import.meta.env.VITE_INSFORGE_URL, import.meta.env.VITE_INSFORGE_ANON_KEY)
  const makeApi = (getToken: () => string | null) => new Api(import.meta.env.VITE_FIRTH_API_URL, getToken)

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App auth={auth} makeApi={makeApi} />
    </React.StrictMode>,
  )
  ```
  Note: add a Vite env typing so `import.meta.env.VITE_*` type-checks. Create `dashboard/src/vite-env.d.ts` (commit it with this task):
  ```ts
  /// <reference types="vite/client" />
  interface ImportMetaEnv {
    readonly VITE_FIRTH_API_URL: string
    readonly VITE_INSFORGE_URL: string
    readonly VITE_INSFORGE_ANON_KEY: string
  }
  interface ImportMeta { readonly env: ImportMetaEnv }
  ```

- [ ] **Adjust the 401 guard** in `App.tsx` so the test's plain-status error routes to auth (per the note above): use `if ((err as any)?.status === 401) dropToAuth()` inside the catch. Re-confirm the `ApiError` import is still used (it is exported from the client and harmless to keep; if `noUnusedLocals` complains, change the import to `import { type Api } from './api/client'` and drop the `ApiError` import).

- [ ] **Run the test — expect PASS.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm test`. All four `App` cases pass; the full dashboard suite (Tasks 5-10) is green.

- [ ] **Write** `dashboard/README.md`:
  ```md
  # Firth Dashboard

  Terminal-themed web dashboard for Firth: auth, project/branch CRUD, and resource-handle
  metadata. It is a pure client of the Firth control-plane API.

  ## Local development

  1. Run the control plane locally (it must be reachable from the browser):
     `cd ../control-plane && npm run dev` (defaults to http://localhost:3000).
  2. Copy `.env.example` to `.env` and set:
     - `VITE_FIRTH_API_URL` — the control-plane base URL (e.g. `http://localhost:3000`).
     - `VITE_INSFORGE_URL` — your InsForge backend URL.
     - `VITE_INSFORGE_ANON_KEY` — the InsForge anon key.
  3. `npm install && npm run dev` — opens the Vite dev server on http://localhost:5173
     (the control plane's default CORS origin).

  ## Tests

  `npm test` — Vitest + Testing Library + jsdom, fully offline (faked api + auth, no network).

  ## OAuth (Google / GitHub)

  Email/password works with no extra setup. OAuth requires a one-time operator step in the
  InsForge backend: enable the Google/GitHub providers with their client credentials and add
  this dashboard's origin (`http://localhost:5173` in dev, the deployed origin in prod) to the
  allowed redirect URLs.

  ## Deploy (InsForge sites)

  `npm run build` produces `dist/`. Deploy it with the InsForge CLI:
  `npx @insforge/cli deployments deploy dist`. Set the three `VITE_*` vars for the build
  environment so the bundle points at the deployed control plane and backend.
  ```

- [ ] **Build.** `cd /Users/junwen/Work/Personal/firth/dashboard && npm run build` succeeds.

- [ ] **Commit.** `cd /Users/junwen/Work/Personal/firth && git add dashboard/src/App.tsx dashboard/src/App.test.tsx dashboard/src/main.tsx dashboard/src/vite-env.d.ts dashboard/README.md && git commit -m "feat(dashboard): App shell (auth gate + view routing + 401->auth) + README"`

---

## Build Notes

- **Migration apply needs the linked backend.** `npx @insforge/cli db migrations up --all` requires a linked InsForge backend. If one is not available during implementation, write the migration file, note that it is unapplied, and rely on the repo unit tests (Task 1) as the automated gate — they exercise the archive/filter semantics against the in-memory fake without a live DB.
- **The dashboard is a client of a not-yet-deployed control plane.** Until the control plane is deployed, the dashboard points at a locally-running instance (`VITE_FIRTH_API_URL=http://localhost:3000`). This mirrors the existing CLI "not deployed yet" wrinkle; the default CORS origin (`http://localhost:5173`) matches the Vite dev server.
- **OAuth needs InsForge provider config.** Google/GitHub sign-in only works once the providers are enabled with client credentials and the dashboard origin is added to the allowed redirect URLs in the InsForge backend. Email/password requires no extra configuration. All frontend tests run against a faked `Auth`, so the suite is green regardless of provider config.
- **`provider_ref` whitelist vs. spec key names.** The whitelist in `resource-view.ts` (Task 2) uses the adapter-emitted key names (`neonProjectId`, `defaultBranchId`, `dbName`, `roleName`, `host`, `database`, `region` for neon; `bucket`/`bucketName`/`endpoint`/`region` for s3; `app`/`appName`/`machineId`/`region` for fly). The design doc's prose used illustrative names (`project_id`, `branch_id`); the implementation follows the actual provisioning `provider_ref` shape (e.g. `fakeNeon` emits `neonProjectId`/`defaultBranchId`/`dbName`/`roleName`). The guarantee is unchanged: only whitelisted, non-credential keys are returned.

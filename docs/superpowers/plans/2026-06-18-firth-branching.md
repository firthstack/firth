# Firth Branching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `firth branch create` — create an additional branch on an existing project: a native **Neon branch** (off the parent firth branch's Neon branch) with its own branch-scoped `DATABASE_URL`. Storage (Tigris) is shared across branches and compute (Fly) is redeploy-based, so both are no-ops for branching. Includes a `BranchService` with compensating rollback, the `POST/GET /projects/:id/branches` API, and a live Neon branch-delete checkpoint.

**Architecture:** Extends the merged three-adapter control plane (`control-plane/`, TS/Node). Branching only touches the Neon resource. The flow reconstructs the project's Neon `ResourceHandle` from the stored `resources.provider_ref` (non-secret), calls `NeonAdapter.createBranch` with the parent firth branch's `neon_branch_ref` as the Neon parent, mints the new branch's connection string, and stores it AES-GCM-encrypted scoped to the new firth branch. A new adapter method `deleteBranch` enables branch-level rollback (Neon deletes just the branch — `DELETE /projects/{id}/branches/{branch_id}` — never the whole project).

**Tech Stack:** Node 20 + TypeScript, `vitest`. Reuses Neon Platform API (already in `NeonAdapter`).

## Global Constraints

- Reuse unchanged: `ProviderAdapter`/`ResourceHandle`/`SecretBundle` (`adapters/types.ts`), `NeonAdapter`/`FlyAdapter`/`TigrisAdapter`, `DataClient`/`QueryBuilder` (insert/update/select/eq/is/then), `firstOrThrow` + repos (`db/repos.ts`), `encryptSecret` (`crypto/secrets.ts`), `buildServer`/`ServerDeps` (`server.ts`).
- New adapter method on `ProviderAdapter`: `deleteBranch(handle: ResourceHandle, branchRef: string): Promise<void>`. Neon: `DELETE /projects/{neonProjectId}/branches/{branchRef}`. Fly + Tigris: no-op (storage shared, compute redeploys — there is no per-branch resource to delete).
- Branching is **Neon-only**: only the project's `neon` resource gets a branch + a new secret. The new `DATABASE_URL` is **branch-scoped** (`branch_id` = the new firth branch id).
- The Neon `ResourceHandle` is reconstructed from `resources.provider_ref` (the stored `{neonProjectId, defaultBranchId, dbName, roleName}` — non-secret). The Neon *parent* branch is the `from` firth branch's `neon_branch_ref`.
- Secrets discipline unchanged: encrypt before any DB write; never log the connection string; never put it in `provider_ref`.
- Rollback (best-effort, never masks the original error): if anything after the Neon branch is created fails, `deleteBranch` the Neon branch and mark the firth branch row `status:'error'`. (Orphaned firth branch row + any stored secret follow the same adjudicated v1 tech-debt as project rollback — the DataClient has no `delete`; rows are inert/error-status. Don't add a delete path here.)
- A project's default `main` branch already exists (created by the provisioning saga). This plan creates **non-default** branches (`is_default:false`).

---

### Task 1: Adapter `deleteBranch` (interface + Neon + Fly/Tigris no-op)

**Files:**
- Modify: `control-plane/src/adapters/types.ts` (add `deleteBranch` to `ProviderAdapter`)
- Modify: `control-plane/src/adapters/neon.ts`, `control-plane/src/adapters/fly.ts`, `control-plane/src/adapters/tigris.ts`
- Test: `control-plane/test/adapters/neon.test.ts` (add a case)

**Interfaces:**
- Produces: `ProviderAdapter.deleteBranch(handle: ResourceHandle, branchRef: string): Promise<void>`; Neon implementation deletes one branch; Fly/Tigris are no-ops.

- [ ] **Step 1: Add the failing test** to `control-plane/test/adapters/neon.test.ts`

```typescript
describe('NeonAdapter.deleteBranch', () => {
  test('DELETEs /projects/{id}/branches/{branchRef}', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'DELETE' && u.endsWith('/projects/proj-1/branches/br-x'), body: {} },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await adapter.deleteBranch(
      { kind: 'neon', providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'd', roleName: 'r' } },
      'br-x',
    )
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toMatch(/\/projects\/proj-1\/branches\/br-x$/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/adapters/neon.test.ts`
Expected: FAIL — `deleteBranch is not a function`.

- [ ] **Step 3: Add `deleteBranch` to the `ProviderAdapter` interface** in `control-plane/src/adapters/types.ts` (after `createBranch`):

```typescript
  deleteBranch(handle: ResourceHandle, branchRef: string): Promise<void>
```

- [ ] **Step 4: Implement in `control-plane/src/adapters/neon.ts`** (add after `createBranch`):

```typescript
  async deleteBranch(handle: ResourceHandle, branchRef: string): Promise<void> {
    const ref = handle.providerRef as NeonRef
    await this.call('DELETE', `/projects/${ref.neonProjectId}/branches/${branchRef}`)
  }
```

- [ ] **Step 5: Add no-op `deleteBranch` to `fly.ts` and `tigris.ts`** (after their `createBranch`):

```typescript
  async deleteBranch(): Promise<void> { /* no per-branch resource: storage shared, compute redeploys */ }
```

- [ ] **Step 6: Run the adapter tests + full suite**

Run: `cd control-plane && npx vitest run test/adapters/ && npm test`
Expected: all green (Neon deleteBranch passes; Fly/Tigris still implement `ProviderAdapter`).

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/adapters/types.ts control-plane/src/adapters/neon.ts control-plane/src/adapters/fly.ts control-plane/src/adapters/tigris.ts control-plane/test/adapters/neon.test.ts
git commit -m "feat: ProviderAdapter.deleteBranch (Neon real; Fly/Tigris no-op)"
```

---

### Task 2: Repositories for existing project metadata

**Files:**
- Modify: `control-plane/src/db/types.ts` (add `ResourceRow`, `BranchRow` types)
- Modify: `control-plane/src/db/repos.ts` (add `ResourcesRepo`, `BranchesRepo`)
- Test: `control-plane/test/db/repos.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `type ResourceRow = { id; project_id; owner; kind: string; provider_ref: Record<string,unknown>; status: string }`
  - `type BranchRow = { id; project_id; owner; name; parent_branch_id: string|null; is_default: boolean; neon_branch_ref: string|null; status: string }`
  - `class ResourcesRepo { constructor(db); findByKind(owner, projectId, kind): Promise<ResourceRow|null> }`
  - `class BranchesRepo { constructor(db); findByName(owner, projectId, name): Promise<BranchRow|null>; create(row: { project_id; owner; name; parent_branch_id: string|null; is_default: boolean; status: string }): Promise<BranchRow>; listByProject(owner, projectId): Promise<BranchRow[]> }`

- [ ] **Step 1: Write the failing test** `control-plane/test/db/repos.test.ts` (add; reuse the existing fake DataClient pattern in that file)

```typescript
import { BranchesRepo, ResourcesRepo } from '../../src/db/repos.js'

test('ResourcesRepo.findByKind returns the matching resource or null', async () => {
  const db = fakeDb({ resources: [
    { id: 'r1', owner: 'o', project_id: 'p', kind: 'neon', provider_ref: { neonProjectId: 'np' }, status: 'active' },
    { id: 'r2', owner: 'o', project_id: 'p', kind: 's3', provider_ref: {}, status: 'active' },
  ] })
  const repo = new ResourcesRepo(db as any)
  expect((await repo.findByKind('o', 'p', 'neon'))?.id).toBe('r1')
  expect(await repo.findByKind('o', 'p', 'fly')).toBeNull()
})

test('BranchesRepo.findByName + create + listByProject', async () => {
  const db = fakeDb({ branches: [
    { id: 'b-main', owner: 'o', project_id: 'p', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' },
  ] })
  const repo = new BranchesRepo(db as any)
  expect((await repo.findByName('o', 'p', 'main'))?.neon_branch_ref).toBe('br-main')
  const created = await repo.create({ project_id: 'p', owner: 'o', name: 'feat', parent_branch_id: 'b-main', is_default: false, status: 'creating' })
  expect(created.name).toBe('feat')
  expect((await repo.listByProject('o', 'p')).map((b) => b.name).sort()).toEqual(['feat', 'main'])
})
```

(Ensure `fakeDb` in `repos.test.ts` accepts a seed and supports insert/select/eq — it already does from the Foundation work; extend the seed param if needed.)

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/db/repos.test.ts` (FAIL: repos not exported).

- [ ] **Step 3: Add types to `control-plane/src/db/types.ts`**

```typescript
export type ResourceRow = {
  id: string; project_id: string; owner: string
  kind: string; provider_ref: Record<string, unknown>; status: string
}
export type BranchRow = {
  id: string; project_id: string; owner: string; name: string
  parent_branch_id: string | null; is_default: boolean
  neon_branch_ref: string | null; status: string
}
```

- [ ] **Step 4: Add the repos to `control-plane/src/db/repos.ts`**

```typescript
import type { DataClient, NewSecretRow, Project, SecretRow, ResourceRow, BranchRow } from './types.js'
// ...existing firstOrThrow, ProjectsRepo, SecretsRepo...

export class ResourcesRepo {
  constructor(private db: DataClient) {}
  async findByKind(owner: string, projectId: string, kind: string): Promise<ResourceRow | null> {
    const { data, error } = await this.db.from('resources').select()
      .eq('owner', owner).eq('project_id', projectId).eq('kind', kind)
    if (error) throw error
    return ((data ?? [])[0] as ResourceRow) ?? null
  }
}

export class BranchesRepo {
  constructor(private db: DataClient) {}
  async findByName(owner: string, projectId: string, name: string): Promise<BranchRow | null> {
    const { data, error } = await this.db.from('branches').select()
      .eq('owner', owner).eq('project_id', projectId).eq('name', name)
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
    const { data, error } = await this.db.from('branches').select().eq('owner', owner).eq('project_id', projectId)
    if (error) throw error
    return (data ?? []) as BranchRow[]
  }
}
```

- [ ] **Step 5: Run to verify it passes** — `cd control-plane && npx vitest run test/db/repos.test.ts` (green).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/db/types.ts control-plane/src/db/repos.ts control-plane/test/db/repos.test.ts
git commit -m "feat: ResourcesRepo.findByKind + BranchesRepo (findByName/create/listByProject)"
```

---

### Task 3: BranchService — create a branch with rollback

**Files:**
- Create: `control-plane/src/services/branches.ts`
- Test: `control-plane/test/services/branches.test.ts`

**Interfaces:**
- Consumes: `DataClient`, `FirthConfig`, `ProviderAdapter[]`, `ResourcesRepo`, `BranchesRepo`, `encryptSecret`.
- Produces: `class BranchService { constructor(db, cfg, adapters); createBranch(owner, projectId, name, fromName?='main'): Promise<{ branch: { id; name; parentBranchId } }> }`.

**Behavior:** find the `neon` adapter (throw if not configured) and the project's `neon` resource (throw if none); find the `fromName` branch (throw if missing or has no `neon_branch_ref`); insert a firth `branches` row (`is_default:false`, `status:'creating'`); reconstruct the Neon handle from `resource.provider_ref`; `createBranch(handle, name, parent.neon_branch_ref)` → new Neon branch id; update the branch row `neon_branch_ref` + `status:'active'`; `mintCredentials(handle, newRef)` → encrypt + store each entry as a `secrets` row scoped to the new branch (`branch_id` = new branch id). On any failure after the Neon branch is created: best-effort `deleteBranch(handle, newRef)` + mark the branch row `status:'error'`, then rethrow the original error.

- [ ] **Step 1: Write the failing test** `control-plane/test/services/branches.test.ts`

```typescript
import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { BranchService } from '../../src/services/branches.js'
import { decryptSecret, loadKeks } from '../../src/crypto/secrets.js'
import type { ProviderAdapter } from '../../src/adapters/types.js'

const { keks, current } = loadKeks({ FIRTH_KEK_CURRENT: 'V1', FIRTH_KEK_V1: randomBytes(32).toString('base64') })
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } } as any

// PostgREST-faithful fake (eq(null)→no-match, is(null)→null-match) supporting insert/select/eq/update.
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], ...seed }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    let mode: 'insert' | 'select' | 'update' = 'select'; let payload: any
    const api: any = {
      insert(v: any) { mode = 'insert'; payload = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(payload); return api },
      update(v: any) { mode = 'update'; payload = v; return api },
      select() { return api },
      eq(c: string, val: any) { filters.push(val === null ? () => false : (r: any) => r[c] === val); return api },
      is(c: string, val: any) { filters.push(val === null ? (r: any) => r[c] == null : (r: any) => r[c] === val); return api },
      async then(res: any) {
        if (mode === 'update') { for (const r of tables[t]) if (filters.every((f) => f(r))) Object.assign(r, payload); return res({ data: [], error: null }) }
        if (mode === 'insert') return res({ data: [payload], error: null })
        return res({ data: tables[t].filter((r) => filters.every((f) => f(r))), error: null })
      },
    }
    return api
  } }
}

function neonAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter & { deleted: string[] } {
  const deleted: string[] = []
  return {
    deleted, kind: 'neon', branchModel: 'native',
    async provision() { return { kind: 'neon', providerRef: {} } },
    async destroy() {},
    async createBranch() { return 'br-new' },
    async deleteBranch(_h, ref) { deleted.push(ref) },
    async mintCredentials() { return { DATABASE_URL: 'postgresql://branch-conn' } },
    async readUsage() { return {} },
    ...over,
  } as any
}

const seeded = () => fakeDb({
  resources: [{ id: 'r1', owner: 'o', project_id: 'p', kind: 'neon', provider_ref: { neonProjectId: 'np', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' }, status: 'active' }],
  branches: [{ id: 'b-main', owner: 'o', project_id: 'p', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }],
})

describe('BranchService.createBranch', () => {
  test('creates a Neon branch off the parent and stores a branch-scoped DATABASE_URL', async () => {
    const db = seeded(); const neon = neonAdapter()
    const out = await new BranchService(db as any, cfg, [neon]).createBranch('o', 'p', 'feat')
    expect(out.branch.name).toBe('feat')
    expect(out.branch.parentBranchId).toBe('b-main')
    const row = db.tables.branches.find((b: any) => b.name === 'feat')
    expect(row.neon_branch_ref).toBe('br-new')
    expect(row.status).toBe('active')
    const sec = db.tables.secrets.find((s: any) => s.branch_id === row.id && s.name === 'DATABASE_URL')
    expect(sec).toBeTruthy()
    expect(sec.ciphertext).not.toContain('postgres')
    expect(decryptSecret({ ciphertext: sec.ciphertext, nonce: sec.nonce, kekVersion: sec.kek_version }, keks)).toBe('postgresql://branch-conn')
  })

  test('rollback: if minting fails after the Neon branch is created, deleteBranch is called and the row is error', async () => {
    const db = seeded(); const neon = neonAdapter({ async mintCredentials() { throw new Error('mint failed') } })
    await expect(new BranchService(db as any, cfg, [neon]).createBranch('o', 'p', 'feat')).rejects.toThrow(/mint failed/)
    expect((neon as any).deleted).toEqual(['br-new'])
    expect(db.tables.branches.find((b: any) => b.name === 'feat').status).toBe('error')
    expect(db.tables.secrets.length).toBe(0)
  })

  test('throws if the parent branch is missing', async () => {
    const db = seeded()
    await expect(new BranchService(db as any, cfg, [neonAdapter()]).createBranch('o', 'p', 'feat', 'nope'))
      .rejects.toThrow(/parent branch/i)
  })

  test('throws if the project has no neon resource', async () => {
    const db = fakeDb({ branches: [{ id: 'b-main', owner: 'o', project_id: 'p', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }] })
    await expect(new BranchService(db as any, cfg, [neonAdapter()]).createBranch('o', 'p', 'feat'))
      .rejects.toThrow(/neon resource/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/services/branches.test.ts` (module not found).

- [ ] **Step 3: Implement `control-plane/src/services/branches.ts`**

```typescript
import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ProviderAdapter, ResourceHandle } from '../adapters/types.js'
import { BranchesRepo, ResourcesRepo } from '../db/repos.js'
import { encryptSecret } from '../crypto/secrets.js'

export class BranchService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async createBranch(owner: string, projectId: string, name: string, fromName = 'main'): Promise<{
    branch: { id: string; name: string; parentBranchId: string }
  }> {
    const neon = this.adapters.find((a) => a.kind === 'neon')
    if (!neon) throw new Error('neon adapter not configured')

    const resource = await new ResourcesRepo(this.db).findByKind(owner, projectId, 'neon')
    if (!resource) throw new Error('project has no neon resource')

    const branches = new BranchesRepo(this.db)
    const parent = await branches.findByName(owner, projectId, fromName)
    if (!parent || !parent.neon_branch_ref) throw new Error(`parent branch "${fromName}" not found or has no neon branch`)

    const handle: ResourceHandle = { kind: 'neon', providerRef: resource.provider_ref }
    const row = await branches.create({
      project_id: projectId, owner, name, parent_branch_id: parent.id, is_default: false, status: 'creating',
    })

    let neonRef: string | null = null
    try {
      neonRef = await neon.createBranch(handle, name, parent.neon_branch_ref)
      if (!neonRef) throw new Error('neon createBranch returned no branch id')
      const upd = await this.db.from('branches').update({ neon_branch_ref: neonRef, status: 'active' }).eq('id', row.id)
      if (upd.error) throw upd.error

      const bundle = await neon.mintCredentials(handle, neonRef)
      for (const [key, value] of Object.entries(bundle)) {
        const enc = encryptSecret(value, this.cfg.keks, this.cfg.currentKek)
        const sec = await this.db.from('secrets').insert({
          project_id: projectId, owner, branch_id: row.id, name: key,
          ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion,
        }).select()
        if (sec.error) throw sec.error
      }
      return { branch: { id: row.id, name, parentBranchId: parent.id } }
    } catch (err) {
      // best-effort rollback — never mask the original error
      try { if (neonRef) await neon.deleteBranch(handle, neonRef) } catch { /* best-effort */ }
      try { await this.db.from('branches').update({ status: 'error' }).eq('id', row.id) } catch { /* best-effort */ }
      throw err
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `cd control-plane && npx vitest run test/services/branches.test.ts` then `npm test` (all green).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/services/branches.ts control-plane/test/services/branches.test.ts
git commit -m "feat: BranchService creates a Neon branch + branch-scoped secret with rollback"
```

---

### Task 4: API — POST + GET /projects/:id/branches

**Files:**
- Modify: `control-plane/src/server.ts`
- Test: `control-plane/test/server.test.ts` (add cases)

**Interfaces:**
- `POST /projects/:id/branches` body `{ name, from? }` → 201 `{ branch }` via `BranchService`. `GET /projects/:id/branches` → 200 `{ branches }` via `BranchesRepo.listByProject`. Both authenticate first; the POST resolves adapters via the existing `deps.adaptersForToken`.

- [ ] **Step 1: Add failing tests** to `control-plane/test/server.test.ts` (reuse this file's `fakeData()` — already supports insert/select/eq/is/update; seed a project, a `main` branch with `neon_branch_ref`, and a `neon` resource)

```typescript
test('POST /projects/:id/branches creates a branch via BranchService', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  db.tables.resources.push({ id: 'r1', owner: 'uid-1', project_id: 'p1', kind: 'neon', provider_ref: { neonProjectId: 'np', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' }, status: 'active' })
  const neon = { kind: 'neon', branchModel: 'native',
    async provision() { return { kind: 'neon', providerRef: {} } }, async destroy() {},
    async createBranch() { return 'br-new' }, async deleteBranch() {},
    async mintCredentials() { return { DATABASE_URL: 'postgresql://c' } }, async readUsage() { return {} } }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [neon as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/branches', headers: { authorization: 'Bearer good' }, payload: { name: 'feat' } })
  expect(r.statusCode).toBe(201)
  expect(r.json().branch.name).toBe('feat')

  const list = await app.inject({ method: 'GET', url: '/projects/p1/branches', headers: { authorization: 'Bearer good' } })
  expect(list.json().branches.map((b: any) => b.name).sort()).toEqual(['feat', 'main'])
})

test('POST /projects/:id/branches requires a name', async () => {
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => fakeData() as any, adaptersForToken: () => [] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/branches', headers: { authorization: 'Bearer good' }, payload: {} })
  expect(r.statusCode).toBe(400)
})
```

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/server.test.ts` (404 / missing routes).

- [ ] **Step 3: Add the routes to `control-plane/src/server.ts`** — import `BranchService` and `BranchesRepo`, then add (after the existing project routes):

```typescript
  app.post('/projects/:id/branches', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const name = (req.body as any)?.name
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const from = (req.body as any)?.from ?? 'main'
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new BranchService(db, deps.cfg, adapters).createBranch(uid, projectId, name, from)
    return reply.code(201).send(out)
  })

  app.get('/projects/:id/branches', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const branches = await new BranchesRepo(db).listByProject(uid, projectId)
    return reply.send({ branches })
  })
```

(Add to the imports at the top: `import { BranchService } from './services/branches.js'` and extend the repos import to include `BranchesRepo`.)

- [ ] **Step 4: Run the server tests + full suite** — `cd control-plane && npx vitest run test/server.test.ts` then `npm test` (all green).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: POST/GET /projects/:id/branches"
```

---

### Task 5: Live Neon branch create+delete checkpoint

**Files:**
- Modify: `control-plane/scripts/live-neon-check.ts`

**Interfaces:** extend the existing gated Neon checkpoint so that, after creating a branch, it explicitly **deletes that branch** (verifying `deleteBranch` against the real API) before destroying the project. `NEON_API_KEY` is present in this environment, so this runs live.

- [ ] **Step 1: Edit `control-plane/scripts/live-neon-check.ts`** — after the existing `createBranch` call, capture the returned branch id and add a `deleteBranch` call, logging it:

```typescript
    const branch = await adapter.createBranch(handle, 'feature-check')
    console.log('created branch:', branch)
    if (branch) {
      await adapter.deleteBranch(handle, branch)
      console.log('deleted branch:', branch)
    }
```

(Keep the rest — `mintCredentials` presence log and the `finally { destroy }` — unchanged.)

- [ ] **Step 2: Run it live** (NEON_API_KEY is present):

Run: `cd control-plane && NEON_API_KEY="$(grep -E '^NEON_API_KEY=' .env | head -1 | cut -d= -f2-)" LIVE_TAG=$(git rev-parse --short HEAD) npm run live:neon`
Expected: the full provision → create branch → **delete branch** → mint → destroy sequence, ending with "destroyed project (cleanup) ✓". Capture output verbatim. If `deleteBranch` errors against the real API, that's a real finding — report it.

- [ ] **Step 3: Confirm no leak** — after the run, optionally list Neon projects and confirm no `firth-live-check` project remains (the `finally` destroy handles it).

- [ ] **Step 4: Commit**

```bash
git add control-plane/scripts/live-neon-check.ts
git commit -m "feat: live checkpoint verifies Neon branch delete"
```

---

## Self-Review

**Spec coverage:** branching = build-order step 5; ARCHITECTURE §8 (Neon native branch; storage shared; compute redeploy). Adapter `deleteBranch` (T1), metadata repos (T2), `BranchService` + rollback (T3), API (T4), live verification (T5). Storage/compute correctly do nothing on branch (no-op `deleteBranch`, no new secret).

**Placeholder scan:** No TODO/TBD. Complete code in every step. The live branch-delete actually runs (NEON_API_KEY present), so `deleteBranch` is verified against the real API — not flagged/deferred.

**Type consistency:** `deleteBranch(handle, branchRef)` added to `ProviderAdapter` and implemented by all three adapters (Neon real, Fly/Tigris no-op). `ResourceRow`/`BranchRow` in `db/types.ts`, consumed by the repos + `BranchService`. `BranchService` reuses `encryptSecret(value, keks, currentKek)` and stores snake_case columns (`kek_version`, `branch_id`, `neon_branch_ref`). Branch-scoped `branch_id = row.id`. The fake DataClient keeps the PostgREST `eq(null)`→no-match / `is(null)`→null-match semantics.

**Known gaps / deferred:** orphaned firth branch row + its secret on rollback are not deleted (same adjudicated v1 tech-debt as project rollback — DataClient has no `delete`; rows are error-status/inert); branching is Neon-only by design (storage shared, compute redeploy per ARCHITECTURE §8); the `firth-cli`/`deploy` surface and the secret-seam-returns-both-scopes note are later plans.

# Firth Neon Adapter + Create-Project Saga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the first provider adapter (Neon) against the real Neon Platform API, and turn `firth project create` into an adapter-driven **saga** that provisions a Neon project + default branch, mints the branch's connection string, and stores it through the existing secret seam — with per-resource status, compensating rollback on failure, and a live provisioning checkpoint gated on `NEON_API_KEY`.

**Architecture:** Extends the Foundation control plane (`control-plane/`, TS/Node on InsForge). A generic `ProviderAdapter` interface (from ARCHITECTURE.md §6) with a concrete `NeonAdapter` that talks to `https://console.neon.tech/api/v2` via an **injected HTTP client** (real `fetch` in prod, a fake in tests — no network in unit tests). A `ProvisioningService` orchestrates project + branch + resource + secret as a saga: on any failure it destroys what it created and marks resources `error` — never an orphan, never a false success. Writes happen in-request under the caller's token so RLS applies (no admin-context writes in this plan).

**Tech Stack:** Node 20 + TypeScript, `vitest`, Node global `fetch`. Neon **Platform API** (REST, `Authorization: Bearer <NEON_API_KEY>`). No new dependencies.

## Global Constraints

- Builds on the merged Foundation. Reuse existing modules: `crypto/secrets.ts` (`encryptSecret`), `db/types.ts` (`DataClient`/`QueryBuilder`), `db/repos.ts` (`firstOrThrow`, `SecretsRepo`), `services/projects.ts` (`ProjectService`), `config.ts` (`FirthConfig`), `server.ts` (`buildServer`).
- The `ProviderAdapter` interface is exactly (from ARCHITECTURE.md §6):
  ```ts
  interface ProviderAdapter {
    readonly kind: 'neon' | 's3' | 'fly'
    readonly branchModel: 'native' | 'shared' | 'redeploy'
    provision(projectName: string): Promise<ResourceHandle>
    destroy(handle: ResourceHandle): Promise<void>
    createBranch(handle: ResourceHandle, name: string, parentRef?: string): Promise<string | null>
    mintCredentials(handle: ResourceHandle, branchRef?: string): Promise<SecretBundle>
    readUsage(handle: ResourceHandle): Promise<UsageSnapshot>
  }
  ```
  `ResourceHandle = { kind: ProviderKind; providerRef: Record<string, unknown> }`; `SecretBundle = Record<string,string>`; `UsageSnapshot = Record<string, number>`; `ProviderKind = 'neon'|'s3'|'fly'`.
- `NeonAdapter` for the `neon` kind: `branchModel: 'native'`. Its `providerRef` shape is `{ neonProjectId: string; defaultBranchId: string; dbName: string; roleName: string }` — **non-secret metadata only** (it is stored in `resources.provider_ref`, which is plaintext jsonb; connection strings/passwords must NEVER go there — they go through the encrypted `secrets` seam).
- Neon Platform API (base `https://console.neon.tech/api/v2`, header `Authorization: Bearer <key>`):
  - `POST /projects` body `{"project":{"name":<name>}}` → `{ project:{id}, branch:{id}, databases:[{name}], roles:[{name}], connection_uris:[{connection_uri}], operations:[{id,status}] }`
  - `POST /projects/{id}/branches` body `{"branch":{"name","parent_id"},"endpoints":[{"type":"read_write"}]}` → `{ branch:{id}, operations:[...] }`
  - `GET /projects/{id}/connection_uri?branch_id=&database_name=&role_name=` → `{ "uri": "postgresql://..." }`
  - `DELETE /projects/{id}` → deletes the whole project (rollback)
  - `GET /projects/{id}/operations/{op_id}` → operation with `status`; terminal = `finished|skipped|cancelled`, error = `failed`, else keep polling.
- The DB credential secret minted for Neon is named **`DATABASE_URL`**, scoped to the project's `main` branch (`branch_id` = main branch id).
- Writes go through the injected `DataClient` (user-scoped client → RLS). Plaintext credentials and the Neon API key must never be logged or placed in an error message.
- Secrets/credentials live only in the encrypted `secrets` table; never in `resources.provider_ref`, logs, or responses.

---

### Task 1: ProviderAdapter interface + NeonAdapter (provision, destroy, operation polling)

**Files:**
- Create: `control-plane/src/adapters/types.ts`
- Create: `control-plane/src/adapters/neon.ts`
- Test: `control-plane/test/adapters/neon.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the `ProviderAdapter` interface + supporting types (`ProviderKind`, `ResourceHandle`, `SecretBundle`, `UsageSnapshot`, `HttpClient`, `HttpResponse`) in `types.ts`; and a `class NeonAdapter` in `neon.ts` with a working `provision()` and `destroy()` plus private helpers (`call`, `awaitOps`). Task 1's `NeonAdapter` does NOT yet declare `implements ProviderAdapter` — the remaining three methods (and the `implements` clause) arrive in Task 2. No stub methods.

- [ ] **Step 1: Write the failing test** `control-plane/test/adapters/neon.test.ts`

```typescript
import { describe, expect, test } from 'vitest'
import { NeonAdapter } from '../../src/adapters/neon.js'
import type { HttpClient } from '../../src/adapters/types.js'

// Build a fake HttpClient that records calls and returns scripted responses.
function fakeHttp(routes: Array<{ match: (url: string, init: any) => boolean; status?: number; body: any }>) {
  const calls: Array<{ url: string; init: any }> = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init))
    if (!r) throw new Error(`unexpected call: ${init.method} ${url}`)
    return { status: r.status ?? 200, json: async () => r.body, text: async () => JSON.stringify(r.body) }
  }
  return { http, calls }
}

const noSleep = async () => {}

describe('NeonAdapter.provision', () => {
  test('creates a project, captures provider_ref, waits for operations', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/projects'),
        body: { project: { id: 'proj-1' }, branch: { id: 'br-main' },
                databases: [{ name: 'neondb' }], roles: [{ name: 'neondb_owner' }],
                connection_uris: [{ connection_uri: 'postgresql://x' }],
                operations: [{ id: 'op-1', status: 'running' }] } },
      { match: (u) => u.includes('/operations/op-1'), body: { operation: { status: 'finished' } } },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    const handle = await adapter.provision('demo')
    expect(handle.kind).toBe('neon')
    expect(handle.providerRef).toEqual({
      neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner',
    })
    // Authorization header carries the bearer key; project name in the POST body.
    const post = calls.find((c) => c.init.method === 'POST')!
    expect(post.init.headers.Authorization).toBe('Bearer neon_key')
    expect(JSON.parse(post.init.body)).toEqual({ project: { name: 'demo' } })
  })

  test('throws (and does not leak the key) on a non-2xx create', async () => {
    const { http } = fakeHttp([
      { match: (u, i) => i.method === 'POST', status: 422, body: { message: 'bad' } },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await expect(adapter.provision('demo')).rejects.toThrow(/neon POST \/projects failed: 422/)
    await expect(adapter.provision('demo')).rejects.not.toThrow(/neon_key/)
  })

  test('throws if an operation reports failed', async () => {
    const { http } = fakeHttp([
      { match: (u, i) => i.method === 'POST', body: { project: { id: 'p' }, branch: { id: 'b' },
        databases: [{ name: 'd' }], roles: [{ name: 'r' }], connection_uris: [{ connection_uri: 'x' }],
        operations: [{ id: 'op-x', status: 'failed' }] } },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await expect(adapter.provision('demo')).rejects.toThrow(/operation op-x failed/)
  })
})

describe('NeonAdapter.destroy', () => {
  test('issues DELETE /projects/{id}', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'DELETE' && u.endsWith('/projects/proj-1'), body: {} },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await adapter.destroy({ kind: 'neon', providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'b', dbName: 'd', roleName: 'r' } })
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toMatch(/\/projects\/proj-1$/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run test/adapters/neon.test.ts`
Expected: FAIL — cannot find module `../../src/adapters/neon.js`.

- [ ] **Step 3: Implement `control-plane/src/adapters/types.ts`**

```typescript
export type ProviderKind = 'neon' | 's3' | 'fly'
export type SecretBundle = Record<string, string>
export type UsageSnapshot = Record<string, number>
export type ResourceHandle = { kind: ProviderKind; providerRef: Record<string, unknown> }

export type HttpResponse = { status: number; json(): Promise<any>; text(): Promise<string> }
export type HttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>

export interface ProviderAdapter {
  readonly kind: ProviderKind
  readonly branchModel: 'native' | 'shared' | 'redeploy'
  provision(projectName: string): Promise<ResourceHandle>
  destroy(handle: ResourceHandle): Promise<void>
  createBranch(handle: ResourceHandle, name: string, parentRef?: string): Promise<string | null>
  mintCredentials(handle: ResourceHandle, branchRef?: string): Promise<SecretBundle>
  readUsage(handle: ResourceHandle): Promise<UsageSnapshot>
}
```

- [ ] **Step 4: Implement `control-plane/src/adapters/neon.ts`** (Task 2 fills the three stubs)

```typescript
import type { HttpClient, ResourceHandle } from './types.js'

const NEON_BASE = 'https://console.neon.tech/api/v2'
const TERMINAL = ['finished', 'skipped', 'cancelled']

export type NeonRef = { neonProjectId: string; defaultBranchId: string; dbName: string; roleName: string }
export type NeonOptions = { baseUrl?: string; sleep?: (ms: number) => Promise<void>; pollMs?: number }

export class NeonAdapter {
  readonly kind = 'neon' as const
  readonly branchModel = 'native' as const
  private baseUrl: string
  private sleep: (ms: number) => Promise<void>
  private pollMs: number

  constructor(private apiKey: string, private http: HttpClient, opts: NeonOptions = {}) {
    this.baseUrl = opts.baseUrl ?? NEON_BASE
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.pollMs = opts.pollMs ?? 2000
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.http(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status < 200 || res.status >= 300) {
      // status only — never echo the request body or the bearer key
      throw new Error(`neon ${method} ${path} failed: ${res.status}`)
    }
    return res.json()
  }

  private async awaitOps(projectId: string, operations: Array<{ id: string; status: string }>): Promise<void> {
    for (const op of operations ?? []) {
      let status = op.status
      while (!TERMINAL.includes(status)) {
        if (status === 'failed') throw new Error(`neon operation ${op.id} failed`)
        await this.sleep(this.pollMs)
        const got = await this.call('GET', `/projects/${projectId}/operations/${op.id}`)
        status = got.operation?.status ?? got.status
      }
    }
  }

  async provision(projectName: string): Promise<ResourceHandle> {
    const data = await this.call('POST', '/projects', { project: { name: projectName } })
    const providerRef: NeonRef = {
      neonProjectId: data.project.id,
      defaultBranchId: data.branch.id,
      dbName: data.databases[0].name,
      roleName: data.roles[0].name,
    }
    await this.awaitOps(providerRef.neonProjectId, data.operations)
    return { kind: 'neon', providerRef }
  }

  async destroy(handle: ResourceHandle): Promise<void> {
    const ref = handle.providerRef as NeonRef
    await this.call('DELETE', `/projects/${ref.neonProjectId}`)
  }
}
```

(Task 2 adds `implements ProviderAdapter` to the class declaration and the three remaining methods.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd control-plane && npx vitest run test/adapters/neon.test.ts`
Expected: provision + destroy tests pass.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/adapters/types.ts control-plane/src/adapters/neon.ts control-plane/test/adapters/neon.test.ts
git commit -m "feat: ProviderAdapter interface + NeonAdapter provision/destroy"
```

---

### Task 2: NeonAdapter.createBranch + mintCredentials + readUsage

**Files:**
- Modify: `control-plane/src/adapters/neon.ts` (replace the three stubs)
- Test: `control-plane/test/adapters/neon.test.ts` (add cases)

**Interfaces:**
- Consumes: `NeonAdapter` (Task 1), `NeonRef`.
- Produces: `createBranch(handle, name, parentRef?)` → new Neon branch id (string); `mintCredentials(handle, branchRef?)` → `{ DATABASE_URL: <uri> }`; `readUsage(handle)` → `{}` (stub for v1 — return an empty snapshot; metering is out of scope per ARCHITECTURE §2).

- [ ] **Step 1: Add failing tests** to `control-plane/test/adapters/neon.test.ts`

```typescript
describe('NeonAdapter.createBranch', () => {
  test('POSTs a branch with parent_id and returns the new branch id', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/projects/proj-1/branches'),
        body: { branch: { id: 'br-new' }, operations: [] } },
    ])
    const adapter = new NeonAdapter('k', http, { sleep: noSleep })
    const handle = { kind: 'neon' as const, providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'd', roleName: 'r' } }
    const id = await adapter.createBranch(handle, 'feature-x', 'br-main')
    expect(id).toBe('br-new')
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ branch: { name: 'feature-x', parent_id: 'br-main' } })
  })
})

describe('NeonAdapter.mintCredentials', () => {
  test('GETs the connection_uri for the branch/db/role and returns DATABASE_URL', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'GET' && u.includes('/connection_uri'),
        body: { uri: 'postgresql://neondb_owner:pw@host/neondb?sslmode=require' } },
    ])
    const adapter = new NeonAdapter('k', http, { sleep: noSleep })
    const handle = { kind: 'neon' as const, providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } }
    const bundle = await adapter.mintCredentials(handle, 'br-main')
    expect(bundle).toEqual({ DATABASE_URL: 'postgresql://neondb_owner:pw@host/neondb?sslmode=require' })
    const url = calls[0].url
    expect(url).toContain('branch_id=br-main')
    expect(url).toContain('database_name=neondb')
    expect(url).toContain('role_name=neondb_owner')
  })

  test('defaults to the default branch when no branchRef is given', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'GET', body: { uri: 'postgresql://x' } },
    ])
    const adapter = new NeonAdapter('k', http, { sleep: noSleep })
    await adapter.mintCredentials(
      { kind: 'neon', providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } })
    expect(calls[0].url).toContain('branch_id=br-main')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd control-plane && npx vitest run test/adapters/neon.test.ts`
Expected: the new cases fail with "implemented in Task 2".

- [ ] **Step 3: Add the interface + three methods to `control-plane/src/adapters/neon.ts`**

Make three edits:
1. Update the import to: `import type { HttpClient, ProviderAdapter, ResourceHandle, SecretBundle, UsageSnapshot } from './types.js'`
2. Change the class declaration to: `export class NeonAdapter implements ProviderAdapter {`
3. Add these three methods to the class (after `destroy`):

```typescript
  async createBranch(handle: ResourceHandle, name: string, parentRef?: string): Promise<string | null> {
    const ref = handle.providerRef as NeonRef
    const parent_id = parentRef ?? ref.defaultBranchId
    const data = await this.call('POST', `/projects/${ref.neonProjectId}/branches`, {
      branch: { name, parent_id },
      endpoints: [{ type: 'read_write' }],
    })
    await this.awaitOps(ref.neonProjectId, data.operations)
    return data.branch.id as string
  }

  async mintCredentials(handle: ResourceHandle, branchRef?: string): Promise<SecretBundle> {
    const ref = handle.providerRef as NeonRef
    const branchId = branchRef ?? ref.defaultBranchId
    const qs = new URLSearchParams({
      branch_id: branchId,
      database_name: ref.dbName,
      role_name: ref.roleName,
    }).toString()
    const data = await this.call('GET', `/projects/${ref.neonProjectId}/connection_uri?${qs}`)
    return { DATABASE_URL: data.uri }
  }

  async readUsage(_handle: ResourceHandle): Promise<UsageSnapshot> {
    return {} // metering is out of scope for v1 (ARCHITECTURE.md §2)
  }
```

- [ ] **Step 4: Run to verify all NeonAdapter tests pass**

Run: `cd control-plane && npx vitest run test/adapters/neon.test.ts`
Expected: all NeonAdapter tests green.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/adapters/neon.ts control-plane/test/adapters/neon.test.ts
git commit -m "feat: NeonAdapter createBranch + mintCredentials + readUsage"
```

---

### Task 3: Config (NEON_API_KEY) + adapter factory + real HTTP client

**Files:**
- Modify: `control-plane/src/config.ts` (add optional `neonApiKey`)
- Create: `control-plane/src/adapters/factory.ts`
- Modify: `control-plane/.env.example`
- Test: `control-plane/test/config.test.ts` (add a case), `control-plane/test/adapters/factory.test.ts`

**Interfaces:**
- Consumes: `FirthConfig` (Task 4 of Foundation), `NeonAdapter`, `HttpClient`.
- Produces: `FirthConfig.neonApiKey?: string`; `fetchHttp: HttpClient` (a thin wrapper over global `fetch`); `buildAdapters(cfg, http?): ProviderAdapter[]` — returns `[new NeonAdapter(cfg.neonApiKey, http)]` when `neonApiKey` is set, else `[]`.

- [ ] **Step 1: Add the failing config test** to `control-plane/test/config.test.ts`

```typescript
test('exposes neonApiKey when set, undefined when absent', () => {
  const cfg = loadConfig({ ...base, NEON_API_KEY: 'neon_abc' })
  expect(cfg.neonApiKey).toBe('neon_abc')
  expect(loadConfig(base).neonApiKey).toBeUndefined()
})
```

- [ ] **Step 2: Write the failing factory test** `control-plane/test/adapters/factory.test.ts`

```typescript
import { expect, test } from 'vitest'
import { buildAdapters } from '../../src/adapters/factory.js'

const baseCfg = { keks: new Map(), currentKek: 'V1', insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } }
const http = async () => ({ status: 200, json: async () => ({}), text: async () => '' })

test('builds a NeonAdapter when neonApiKey is present', () => {
  const adapters = buildAdapters({ ...baseCfg, neonApiKey: 'neon_k' } as any, http)
  expect(adapters.map((a) => a.kind)).toEqual(['neon'])
})

test('builds no adapters when neonApiKey is absent', () => {
  expect(buildAdapters(baseCfg as any, http)).toEqual([])
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd control-plane && npx vitest run test/config.test.ts test/adapters/factory.test.ts`
Expected: FAIL (neonApiKey missing on type; factory module missing).

- [ ] **Step 4: Add `neonApiKey` to `control-plane/src/config.ts`**

In the `FirthConfig` type add `neonApiKey?: string`. In `loadConfig`, after building `insforge`, add `neonApiKey: env.NEON_API_KEY` (optional — do NOT route it through `required()`). Full updated return:

```typescript
export type FirthConfig = {
  keks: Map<string, Buffer>
  currentKek: string
  insforge: { baseUrl: string; anonKey: string; adminKey: string }
  neonApiKey?: string
}

export function loadConfig(env: NodeJS.ProcessEnv): FirthConfig {
  const { keks, current } = loadKeks(env)
  return {
    keks,
    currentKek: current,
    insforge: {
      baseUrl: required(env, 'INSFORGE_BASE_URL'),
      anonKey: required(env, 'INSFORGE_ANON_KEY'),
      adminKey: required(env, 'INSFORGE_ADMIN_KEY'),
    },
    neonApiKey: env.NEON_API_KEY,
  }
}
```

- [ ] **Step 5: Implement `control-plane/src/adapters/factory.ts`**

```typescript
import type { FirthConfig } from '../config.js'
import { NeonAdapter } from './neon.js'
import type { HttpClient, ProviderAdapter } from './types.js'

// Thin adapter over Node's global fetch, matching our HttpClient shape.
export const fetchHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
  return { status: res.status, json: () => res.json(), text: () => res.text() }
}

export function buildAdapters(cfg: FirthConfig, http: HttpClient = fetchHttp): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = []
  if (cfg.neonApiKey) adapters.push(new NeonAdapter(cfg.neonApiKey, http))
  return adapters
}
```

- [ ] **Step 6: Update `control-plane/.env.example`** — add under the InsForge keys:

```
# Optional: Firth's own Neon Platform API key (account-of-record provisioning).
# Without it, project create still works but provisions no Neon resource.
NEON_API_KEY=<neon_-platform-api-key>
```

- [ ] **Step 7: Run the tests**

Run: `cd control-plane && npx vitest run test/config.test.ts test/adapters/factory.test.ts`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/config.ts control-plane/src/adapters/factory.ts control-plane/.env.example control-plane/test/config.test.ts control-plane/test/adapters/factory.test.ts
git commit -m "feat: NEON_API_KEY config + adapter factory + fetch HttpClient"
```

---

### Task 4: ProvisioningService — the create-project saga

**Files:**
- Modify: `control-plane/src/db/types.ts` (add `update` to `QueryBuilder`)
- Create: `control-plane/src/services/provisioning.ts`
- Test: `control-plane/test/services/provisioning.test.ts`

**Interfaces:**
- Consumes: `DataClient`/`QueryBuilder` (extended here with `update`), `ProjectService`, `encryptSecret`, `FirthConfig`, `ProviderAdapter`/`ResourceHandle`, `firstOrThrow`.
- Produces: `class ProvisioningService { constructor(db: DataClient, cfg: FirthConfig, adapters: ProviderAdapter[]); provisionProject(owner: string, name: string): Promise<{ project: Project; defaultBranch: { id: string; name: string }; resources: Array<{ kind: string; status: string }> }> }`.
- Adds `update(values: object): QueryBuilder` to the `QueryBuilder` interface.

**Behavior:** create project + `main` branch (via `ProjectService`); for each adapter, insert a `resources` row (`status:'provisioning'`), call `adapter.provision(name)`, update the row to `provider_ref`/`status:'active'`; for the `neon` kind, set `branches.neon_branch_ref` on `main`, `mintCredentials` for the default branch, and store each entry as an encrypted branch-scoped `secrets` row. On ANY failure: `destroy` every already-provisioned handle (best-effort, reverse order), mark those `resources` rows `error`, and rethrow. (Compensating rollback; full idempotent `--resume` is a later enhancement.)

- [ ] **Step 1: Write the failing test** `control-plane/test/services/provisioning.test.ts`

```typescript
import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { ProvisioningService } from '../../src/services/provisioning.js'
import { loadKeks, decryptSecret } from '../../src/crypto/secrets.js'
import type { ProviderAdapter, ResourceHandle } from '../../src/adapters/types.js'

const { keks, current } = loadKeks({ FIRTH_KEK_CURRENT: 'V1', FIRTH_KEK_V1: randomBytes(32).toString('base64') })
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } } as any

// In-memory DataClient supporting insert/select/eq/update.
function fakeDb() {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [] }
  return {
    tables,
    from(t: string) {
      const filters: Array<[string, any]> = []
      let mode: 'insert' | 'select' | 'update' = 'select'
      let payload: any
      const api: any = {
        insert(v: any) { mode = 'insert'; payload = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(payload); return api },
        update(v: any) { mode = 'update'; payload = v; return api },
        select() { return api },
        eq(c: string, val: any) { filters.push([c, val]); return api },
        async then(res: any) {
          if (mode === 'update') {
            for (const row of tables[t]) if (filters.every(([c, v]) => row[c] === v)) Object.assign(row, payload)
            return res({ data: [], error: null })
          }
          if (mode === 'insert') return res({ data: [payload], error: null })
          const rows = tables[t].filter((r) => filters.every(([c, v]) => r[c] === v))
          return res({ data: rows, error: null })
        },
      }
      return api
    },
  }
}

function fakeNeon(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter & { destroyed: string[] } {
  const destroyed: string[] = []
  return {
    destroyed,
    kind: 'neon', branchModel: 'native',
    async provision(name: string): Promise<ResourceHandle> {
      return { kind: 'neon', providerRef: { neonProjectId: `np-${name}`, defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } }
    },
    async destroy(h) { destroyed.push((h.providerRef as any).neonProjectId) },
    async createBranch() { return 'br-x' },
    async mintCredentials() { return { DATABASE_URL: 'postgresql://secret-conn' } },
    async readUsage() { return {} },
    ...overrides,
  } as any
}

describe('ProvisioningService.provisionProject', () => {
  test('happy path: project + main branch + neon resource + encrypted DATABASE_URL', async () => {
    const db = fakeDb()
    const svc = new ProvisioningService(db as any, cfg, [fakeNeon()])
    const out = await svc.provisionProject('owner-1', 'demo')

    expect(out.project.name).toBe('demo')
    expect(out.resources).toEqual([{ kind: 'neon', status: 'active' }])

    const resource = db.tables.resources[0]
    expect(resource.status).toBe('active')
    expect(resource.provider_ref.neonProjectId).toBe('np-demo')

    // main branch got the neon branch ref
    expect(db.tables.branches[0].neon_branch_ref).toBe('br-main')

    // DATABASE_URL stored encrypted, scoped to main branch, and round-trips
    const secret = db.tables.secrets[0]
    expect(secret.name).toBe('DATABASE_URL')
    expect(secret.branch_id).toBe(out.defaultBranch.id)
    expect(secret.ciphertext).not.toContain('postgres')
    expect(decryptSecret({ ciphertext: secret.ciphertext, nonce: secret.nonce, kekVersion: secret.kek_version }, keks))
      .toBe('postgresql://secret-conn')
  })

  test('rollback: if provision throws, destroy is called and the resource is marked error', async () => {
    const db = fakeDb()
    const neon = fakeNeon({ async provision() { throw new Error('neon down') } })
    const svc = new ProvisioningService(db as any, cfg, [neon as any])
    await expect(svc.provisionProject('owner-1', 'demo')).rejects.toThrow(/neon down/)
    // resource row exists and is marked error; no secret stored; provision failed before a handle, so nothing to destroy
    expect(db.tables.resources[0].status).toBe('error')
    expect(db.tables.secrets.length).toBe(0)
  })

  test('rollback: if a later step throws after provision, the provisioned resource is destroyed', async () => {
    const db = fakeDb()
    const neon = fakeNeon({ async mintCredentials() { throw new Error('mint failed') } })
    const svc = new ProvisioningService(db as any, cfg, [neon as any])
    await expect(svc.provisionProject('owner-1', 'demo')).rejects.toThrow(/mint failed/)
    expect((neon as any).destroyed).toEqual(['np-demo']) // destroy compensated
    expect(db.tables.resources[0].status).toBe('error')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/services/provisioning.test.ts`
Expected: FAIL — module not found / `update` not on builder.

- [ ] **Step 3: Add `update` to `QueryBuilder`** in `control-plane/src/db/types.ts`

```typescript
export interface QueryBuilder {
  insert(values: object | object[]): QueryBuilder
  update(values: object): QueryBuilder
  select(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  is(column: string, value: unknown): QueryBuilder
  then<T>(onfulfilled: (r: { data: any[] | null; error: Error | null }) => T): Promise<T>
}
```

- [ ] **Step 4: Implement `control-plane/src/services/provisioning.ts`**

```typescript
import { ProjectService } from './projects.js'
import { firstOrThrow } from '../db/repos.js'
import type { DataClient, Project } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ProviderAdapter, ResourceHandle } from '../adapters/types.js'
import { encryptSecret } from '../crypto/secrets.js'

export type ProvisionResult = {
  project: Project
  defaultBranch: { id: string; name: string }
  resources: Array<{ kind: string; status: string }>
}

export class ProvisioningService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async provisionProject(owner: string, name: string): Promise<ProvisionResult> {
    const { project, defaultBranch } = await new ProjectService(this.db).createProject(owner, name)
    const done: Array<{ adapter: ProviderAdapter; handle: ResourceHandle; resourceId: string }> = []
    try {
      for (const adapter of this.adapters) {
        const ins = await this.db.from('resources')
          .insert({ project_id: project.id, owner, kind: adapter.kind, status: 'provisioning', provider_ref: {} })
          .select()
        if (ins.error) throw ins.error
        const resourceId = (firstOrThrow(ins.data, 'resource') as { id: string }).id

        const handle = await adapter.provision(name)
        done.push({ adapter, handle, resourceId })

        const upd = await this.db.from('resources')
          .update({ provider_ref: handle.providerRef, status: 'active' }).eq('id', resourceId)
        if (upd.error) throw upd.error

        if (adapter.kind === 'neon') {
          const branchRef = (handle.providerRef as { defaultBranchId: string }).defaultBranchId
          const bu = await this.db.from('branches').update({ neon_branch_ref: branchRef }).eq('id', defaultBranch.id)
          if (bu.error) throw bu.error
          const bundle = await adapter.mintCredentials(handle, branchRef)
          for (const [key, value] of Object.entries(bundle)) {
            const enc = encryptSecret(value, this.cfg.keks, this.cfg.currentKek)
            const sec = await this.db.from('secrets').insert({
              project_id: project.id, owner, branch_id: defaultBranch.id, name: key,
              ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion,
            }).select()
            if (sec.error) throw sec.error
          }
        }
      }
      return {
        project, defaultBranch,
        resources: done.map((d) => ({ kind: d.adapter.kind, status: 'active' })),
      }
    } catch (err) {
      for (const d of [...done].reverse()) {
        try { await d.adapter.destroy(d.handle) } catch { /* best-effort cleanup */ }
        await this.db.from('resources').update({ status: 'error' }).eq('id', d.resourceId)
      }
      // If we inserted a resource row but failed before pushing a handle, mark the latest provisioning row error.
      const pending = await this.db.from('resources').select().eq('project_id', project.id).eq('status', 'provisioning')
      for (const r of (pending.data ?? [])) {
        await this.db.from('resources').update({ status: 'error' }).eq('id', (r as { id: string }).id)
      }
      throw err
    }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/services/provisioning.test.ts`
Expected: 3 passing tests.

- [ ] **Step 6: Run the full suite (the `update` interface change is shared)**

Run: `cd control-plane && npm test`
Expected: all prior tests still green + the new ones.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/db/types.ts control-plane/src/services/provisioning.ts control-plane/test/services/provisioning.test.ts
git commit -m "feat: ProvisioningService create-project saga with compensating rollback"
```

---

### Task 5: Wire the saga into POST /projects

**Files:**
- Modify: `control-plane/src/server.ts`
- Modify: `control-plane/src/index.ts`
- Test: `control-plane/test/server.test.ts` (update the create-project path)

**Interfaces:**
- Consumes: `ProvisioningService`, `ProviderAdapter`, `buildAdapters`.
- Produces: `buildServer` deps gain `adaptersForToken?: (token: string) => ProviderAdapter[]` (defaults to `() => []`), and `POST /projects` calls `new ProvisioningService(db, cfg, adapters).provisionProject(uid, name)` instead of `ProjectService` directly. Response stays `{ project, defaultBranch }` plus `resources`.

- [ ] **Step 1: Update the server test** `control-plane/test/server.test.ts`

Replace the `POST /projects` round-trip test body so the fake data client also supports `update`, and assert the response includes `resources`. Add this test (keep the existing 401 + secrets-seam tests unchanged):

```typescript
test('POST /projects provisions via the saga and lists the project', async () => {
  const db = fakeData() // ensure fakeData supports insert/select/eq/update (mirror provisioning.test.ts fake)
  const fakeNeon = {
    kind: 'neon', branchModel: 'native',
    async provision(name: string) { return { kind: 'neon', providerRef: { neonProjectId: `np-${name}`, defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } } },
    async destroy() {}, async createBranch() { return 'br-x' },
    async mintCredentials() { return { DATABASE_URL: 'postgresql://conn' } }, async readUsage() { return {} },
  }
  const app = buildServer({
    cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any,
    adaptersForToken: () => [fakeNeon as any],
  })
  const created = await app.inject({ method: 'POST', url: '/projects', headers: { authorization: 'Bearer good' }, payload: { name: 'demo' } })
  expect(created.statusCode).toBe(201)
  expect(created.json().resources).toEqual([{ kind: 'neon', status: 'active' }])
  const list = await app.inject({ method: 'GET', url: '/projects', headers: { authorization: 'Bearer good' } })
  expect(list.json().projects).toHaveLength(1)
})
```

Update the `fakeData()` helper in this file to support `update` exactly as in `provisioning.test.ts` (insert/select/eq/update with the snake_case eq filtering and the PostgREST `eq(null)`→no-match / `is(null)`→null-match semantics already present). Keep the `?branch=` secrets-seam tests intact.

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: FAIL — `adaptersForToken` not used / `resources` missing.

- [ ] **Step 3: Update `control-plane/src/server.ts`**

Add the import and dep, and rewrite the `POST /projects` handler:

```typescript
import { ProvisioningService } from './services/provisioning.js'
import type { ProviderAdapter } from './adapters/types.js'
```

Add to `ServerDeps`:

```typescript
  adaptersForToken?: (token: string) => ProviderAdapter[]
```

Rewrite `auth` to also return the token, and the route:

```typescript
  async function auth(req: any) {
    const { uid, token } = await resolveUid(req.headers.authorization, deps.verifyToken)
    return { uid, token, db: deps.dataForToken(token) }
  }

  app.post('/projects', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const name = (req.body as any)?.name
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new ProvisioningService(db, deps.cfg, adapters).provisionProject(uid, name)
    return reply.code(201).send(out)
  })
```

(Leave `GET /projects` and the secrets seam unchanged.)

- [ ] **Step 4: Update `control-plane/src/index.ts`** to wire real adapters

```typescript
import { buildAdapters } from './adapters/factory.js'
```

In `main()`, pass `adaptersForToken` to `buildServer`:

```typescript
  const app = buildServer({
    cfg,
    verifyToken: (token) => verifyToken(cfg, token),
    dataForToken: (token) => userClient(cfg, token).database,
    adaptersForToken: () => buildAdapters(cfg),
  })
```

(Neon's API key is Firth's own master key from `cfg.neonApiKey`, the same for every request — so `adaptersForToken` ignores the token. The per-user isolation is in `dataForToken`/RLS, not the provider adapter.)

- [ ] **Step 5: Run server tests, then the full suite**

Run: `cd control-plane && npx vitest run test/server.test.ts` then `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/server.ts control-plane/src/index.ts control-plane/test/server.test.ts
git commit -m "feat: POST /projects runs the provisioning saga"
```

---

### Task 6: Live Neon provisioning checkpoint (gated on NEON_API_KEY)

**Files:**
- Create: `control-plane/scripts/live-neon-check.ts`
- Modify: `control-plane/package.json` (add a `live:neon` script)

**Interfaces:**
- Consumes: `NeonAdapter`, `fetchHttp`.
- Produces: a runnable script that provisions a throwaway Neon project against the REAL API and then deletes it — proving the adapter end-to-end. Gated: if `NEON_API_KEY` is unset, it prints a skip notice and exits 0.

- [ ] **Step 1: Implement `control-plane/scripts/live-neon-check.ts`**

```typescript
import { NeonAdapter } from '../src/adapters/neon.js'
import { fetchHttp } from '../src/adapters/factory.js'

async function main() {
  const key = process.env.NEON_API_KEY
  if (!key) {
    console.log('SKIP: NEON_API_KEY not set — live Neon provisioning checkpoint skipped.')
    return
  }
  const adapter = new NeonAdapter(key, fetchHttp)
  const name = `firth-live-check-${process.env.LIVE_TAG ?? 'manual'}`
  console.log(`provisioning Neon project "${name}" ...`)
  const handle = await adapter.provision(name)
  try {
    console.log('provisioned:', handle.providerRef)
    const branch = await adapter.createBranch(handle, 'feature-check')
    console.log('created branch:', branch)
    const creds = await adapter.mintCredentials(handle)
    console.log('minted DATABASE_URL present:', Boolean(creds.DATABASE_URL), '(value not printed)')
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed project (cleanup) ✓')
  }
}

main().catch((e) => { console.error('live check failed:', e.message); process.exit(1) })
```

(Note: never `console.log` the credential value — only whether it is present.)

- [ ] **Step 2: Add the script to `control-plane/package.json`**

Add to `"scripts"`: `"live:neon": "tsx scripts/live-neon-check.ts"`.

- [ ] **Step 3: Run the checkpoint**

Run (a real KEK is not needed; only `NEON_API_KEY`): `cd control-plane && NEON_API_KEY="$NEON_API_KEY" LIVE_TAG=$(git rev-parse --short HEAD) npm run live:neon`
Expected: either the full provision→branch→mint→destroy sequence with "destroyed project (cleanup) ✓", OR `SKIP: NEON_API_KEY not set`. If a real key is present and it fails, capture the exact Neon error — it is a real finding about the adapter or the API, not an expected gate.

- [ ] **Step 4: Commit**

```bash
git add control-plane/scripts/live-neon-check.ts control-plane/package.json
git commit -m "feat: gated live Neon provisioning checkpoint script"
```

---

## Self-Review

**1. Spec/plan coverage** (against ARCHITECTURE §6 adapter + §9 Flow 1 saga, Plan-2 scope = build-order step 3):
- ProviderAdapter interface → Task 1 ✓; NeonAdapter all 5 methods → Tasks 1–2 ✓ (real Neon endpoints, no placeholders).
- create-project saga (project + branch + resource + secret) → Task 4 ✓; compensating rollback → Task 4 ✓ (two rollback tests).
- secret seam reuse (DATABASE_URL, branch-scoped, encrypted) → Task 4 ✓.
- wired into the API → Task 5 ✓; live proof → Task 6 ✓ (gated like Foundation's compute deploy).
- **Deliberately deferred (noted, not silently dropped):** S3 + Fly adapters (Plan 3); parallel provision fan-out (Plan 3 — Plan 2 provisions sequentially for simpler rollback); full idempotent `--resume`; Neon operation polling uses a fixed `pollMs` with no max-attempts cap (acceptable for v1; a runaway operation would loop — add a cap in a later hardening pass); metering (`readUsage` stub).

**2. Placeholder scan:** No TODO/TBD. The Task 1 `NeonAdapter` "implemented in Task 2" stubs are explicit, throw loudly, and are replaced in Task 2 (not silent gaps). Every step has complete code.

**3. Type consistency:** `ProviderAdapter`/`ResourceHandle`/`SecretBundle`/`HttpClient` defined in Task 1, consumed unchanged in 2/3/4/5/6. `NeonRef` shape `{neonProjectId,defaultBranchId,dbName,roleName}` consistent across provision/destroy/createBranch/mintCredentials and the saga's `provider_ref` reads. `QueryBuilder.update` added in Task 4 and used there + relied on by Task 5's fake. `provisionProject` return `{project,defaultBranch,resources}` consistent between Task 4 and Task 5's assertion. Secret column names snake_case (`kek_version`, `branch_id`) match the Foundation schema.

**Known gaps carried forward:** background/admin-context provisioning (this plan provisions in-request under the user token, so RLS writes work and no admin context is needed — but a long Neon provision holds the HTTP request open; async provisioning is a later concern); operation-poll cap; the `resources` "mark stragglers error" rollback query is a coarse net (marks any still-`provisioning` row for the project) — fine for single-resource Plan 2, revisit when multiple resources provision concurrently in Plan 3.

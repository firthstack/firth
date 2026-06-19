# Firth Deploy (Flow 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `firth deploy --image <url> [--branch <name>] [--port <n>]` — deploy a prebuilt image to the project's Fly app, with the target branch's secrets (DB + storage) injected as the machine's env, via a control-plane-mediated flow. Returns the machine id + the app URL.

**Architecture:** Image-mode only (no local Docker/flyctl; source-build deferred). The CLI calls `POST /projects/:id/deploy` — the control plane is the right place because it holds the Fly token and can decrypt secrets. A new `ComputeAdapter` interface (`ProviderAdapter` + `deploy`) is implemented only by `FlyAdapter` (`deploy` = create a Fly machine on the app via the Machines API with `config.image`/`config.env`/`config.guest`/`config.services`). `DeployService` resolves the project's Fly resource handle from `resources.provider_ref`, resolves the target branch, fetches BOTH project- and branch-scoped secrets and decrypts+merges them server-side (the seam's both-scopes merge), and calls `adapter.deploy`.

**Tech Stack:** Node 20 + TypeScript, `vitest`. Fly Machines API (already used by `FlyAdapter`). No new deps.

## Global Constraints

- Reuse unchanged: `ProviderAdapter`/`ResourceHandle`/`HttpClient` + `FlyAdapter` (`adapters/`), `DataClient` + `ResourcesRepo`/`BranchesRepo`/`SecretsRepo` (`db/`), `decryptSecret` (`crypto/secrets.ts`), `FirthConfig` (`config.ts`), `buildServer`/`ServerDeps` + `auth` (`server.ts`), the `firth-cli` (`src/cli/`) incl. `FirthApi`/`apiFromDeps`.
- New `ComputeAdapter` interface in `adapters/types.ts`: `interface ComputeAdapter extends ProviderAdapter { deploy(handle: ResourceHandle, opts: DeployOpts): Promise<DeployResult> }` where `DeployOpts = { image: string; env: Record<string,string>; port?: number }` and `DeployResult = { machineId: string; url: string }`. `FlyAdapter` implements it.
- `FlyAdapter.deploy` → `POST /apps/{flyApp}/machines` with `{ config: { image, env, guest: {cpu_kind:'shared',cpus:1,memory_mb:256}, services?: [{protocol:'tcp', internal_port: port, ports:[{port:443,handlers:['tls','http']},{port:80,handlers:['http']}]}] } }`; `services` included only when `port` is given. Returns `{ machineId: <resp.id>, url: 'https://{flyApp}.fly.dev' }`. Status-only errors (no token leak).
- Secret injection: `DeployService` fetches project-scoped (`branch_id` null) + branch-scoped (`branch_id` = target) secret rows, `decryptSecret`s each, merges (branch overrides project on key collision), and passes them as `env`. Decrypted secrets/token are NEVER logged.
- Deploy goes through the control plane (`POST /projects/:id/deploy`); the CLI never holds the Fly token or decrypted secrets.
- Tigris scoped-key minting is currently blocked (see ledger), so the injected env in practice contains the Neon `DATABASE_URL` (+ any project-scoped secrets that exist) — deploy injects whatever the seam returns; it does not require storage creds.

---

### Task 1: ComputeAdapter interface + FlyAdapter.deploy

**Files:**
- Modify: `control-plane/src/adapters/types.ts` (add `ComputeAdapter`, `DeployOpts`, `DeployResult`)
- Modify: `control-plane/src/adapters/fly.ts` (implement `ComputeAdapter` + `deploy`)
- Test: `control-plane/test/adapters/fly.test.ts` (add cases)

**Interfaces:**
- Produces: `ComputeAdapter`/`DeployOpts`/`DeployResult` types; `FlyAdapter implements ComputeAdapter` with `deploy(handle, {image, env, port?})` → `{ machineId, url }`.

- [ ] **Step 1: Add the failing tests** to `control-plane/test/adapters/fly.test.ts`

```typescript
describe('FlyAdapter.deploy', () => {
  test('creates a machine with image + env, returns machineId + url', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/apps/firth-x-abc/machines'), body: { id: 'm-123', state: 'created' } },
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    const handle = { kind: 'fly' as const, providerRef: { flyApp: 'firth-x-abc', orgSlug: 'org' } }
    const out = await adapter.deploy(handle, { image: 'nginx:alpine', env: { DATABASE_URL: 'postgresql://c' }, port: 80 })
    expect(out).toEqual({ machineId: 'm-123', url: 'https://firth-x-abc.fly.dev' })
    const body = JSON.parse(calls[0].init.body)
    expect(body.config.image).toBe('nginx:alpine')
    expect(body.config.env.DATABASE_URL).toBe('postgresql://c')
    expect(body.config.guest).toEqual({ cpu_kind: 'shared', cpus: 1, memory_mb: 256 })
    expect(body.config.services[0].internal_port).toBe(80)
  })

  test('omits services when no port is given', async () => {
    const { http, calls } = fakeHttp([{ match: (u, i) => i.method === 'POST', body: { id: 'm-1' } }])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'img', env: {} })
    expect(JSON.parse(calls[0].init.body).config.services).toBeUndefined()
  })

  test('non-2xx deploy throws with status only', async () => {
    const { http } = fakeHttp([{ match: (u, i) => i.method === 'POST', status: 422, body: {} }])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await expect(adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'x', env: {} }))
      .rejects.toThrow(/fly POST \/apps\/a\/machines failed: 422/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/adapters/fly.test.ts`.

- [ ] **Step 3: Add types to `control-plane/src/adapters/types.ts`** (after `ProviderAdapter`)

```typescript
export type DeployOpts = { image: string; env: Record<string, string>; port?: number }
export type DeployResult = { machineId: string; url: string }

export interface ComputeAdapter extends ProviderAdapter {
  deploy(handle: ResourceHandle, opts: DeployOpts): Promise<DeployResult>
}
```

- [ ] **Step 4: Implement in `control-plane/src/adapters/fly.ts`** — change the class to `export class FlyAdapter implements ComputeAdapter {` (import `ComputeAdapter, DeployOpts, DeployResult`), and add:

```typescript
  async deploy(handle: ResourceHandle, opts: DeployOpts): Promise<DeployResult> {
    const ref = handle.providerRef as FlyRef
    const config: Record<string, unknown> = {
      image: opts.image,
      env: opts.env,
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
    }
    if (opts.port) {
      config.services = [{
        protocol: 'tcp',
        internal_port: opts.port,
        ports: [{ port: 443, handlers: ['tls', 'http'] }, { port: 80, handlers: ['http'] }],
      }]
    }
    const data = await this.call('POST', `/apps/${ref.flyApp}/machines`, { config })
    return { machineId: data.id, url: `https://${ref.flyApp}.fly.dev` }
  }
```

- [ ] **Step 5: Run to verify it passes** — `cd control-plane && npx vitest run test/adapters/fly.test.ts && npm test`.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/adapters/types.ts control-plane/src/adapters/fly.ts control-plane/test/adapters/fly.test.ts
git commit -m "feat: ComputeAdapter + FlyAdapter.deploy (create machine via Machines API)"
```

---

### Task 2: DeployService — resolve fly resource + merge secrets + deploy

**Files:**
- Create: `control-plane/src/services/deploy.ts`
- Test: `control-plane/test/services/deploy.test.ts`

**Interfaces:**
- Produces: `class DeployService { constructor(db: DataClient, cfg: FirthConfig, adapters: ProviderAdapter[]); deploy(owner, projectId, opts: { image: string; from?: string; port?: number }): Promise<DeployResult> }`.

**Behavior:** find the `fly` adapter (must be a `ComputeAdapter` — throw if absent); find the project's `fly` resource (throw if none); resolve the target branch (`from` name/id, else default branch); fetch project-scoped (`branch_id` null) + branch-scoped (`branch_id` = target) secret rows, `decryptSecret` each, merge (branch wins); call `adapter.deploy(handle, { image, env, port })`; return the `DeployResult`. Never log secrets.

- [ ] **Step 1: Write the failing test** `control-plane/test/services/deploy.test.ts`

```typescript
import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { DeployService } from '../../src/services/deploy.js'
import { encryptSecret, loadKeks } from '../../src/crypto/secrets.js'
import type { ProviderAdapter } from '../../src/adapters/types.js'

const { keks, current } = loadKeks({ FIRTH_KEK_CURRENT: 'V1', FIRTH_KEK_V1: randomBytes(32).toString('base64') })
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } } as any

function enc(v: string) { const e = encryptSecret(v, keks, current); return { ciphertext: e.ciphertext, nonce: e.nonce, kek_version: e.kekVersion } }

// PostgREST-faithful fake (eq(null)→no-match, is(null)→null-match) supporting select/eq/is.
function fakeDb(seed: Record<string, any[]>) {
  const tables: Record<string, any[]> = { resources: [], branches: [], secrets: [], ...seed }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    const api: any = {
      select() { return api }, insert() { return api }, update() { return api },
      eq(c: string, v: any) { filters.push(v === null ? () => false : (r: any) => r[c] === v); return api },
      is(c: string, v: any) { filters.push(v === null ? (r: any) => r[c] == null : (r: any) => r[c] === v); return api },
      async then(res: any) { return res({ data: tables[t].filter((r) => filters.every((f) => f(r))), error: null }) },
    }
    return api
  } }
}

function flyAdapter(captured: any): ProviderAdapter {
  return {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {},
    async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy(_h: any, opts: any) { captured.opts = opts; return { machineId: 'm-1', url: 'https://app.fly.dev' } },
  } as any
}

const seeded = () => fakeDb({
  resources: [{ id: 'r', owner: 'o', project_id: 'p', kind: 'fly', provider_ref: { flyApp: 'app', orgSlug: 'org' }, status: 'active' }],
  branches: [{ id: 'b-main', owner: 'o', project_id: 'p', name: 'main', is_default: true, neon_branch_ref: 'br', status: 'active' }],
  secrets: [
    { id: 's1', owner: 'o', project_id: 'p', branch_id: null, name: 'AWS_ACCESS_KEY_ID', ...enc('tid_x') },
    { id: 's2', owner: 'o', project_id: 'p', branch_id: 'b-main', name: 'DATABASE_URL', ...enc('postgresql://conn') },
  ],
})

describe('DeployService.deploy', () => {
  test('injects merged decrypted secrets (project + branch) and returns the result', async () => {
    const cap: any = {}; const db = seeded()
    const out = await new DeployService(db as any, cfg, [flyAdapter(cap)]).deploy('o', 'p', { image: 'nginx', port: 80 })
    expect(out).toEqual({ machineId: 'm-1', url: 'https://app.fly.dev' })
    expect(cap.opts.image).toBe('nginx'); expect(cap.opts.port).toBe(80)
    expect(cap.opts.env).toEqual({ AWS_ACCESS_KEY_ID: 'tid_x', DATABASE_URL: 'postgresql://conn' }) // both scopes, decrypted
  })

  test('throws when the project has no fly resource', async () => {
    const db = fakeDb({ branches: [{ id: 'b', owner: 'o', project_id: 'p', name: 'main', is_default: true, neon_branch_ref: 'x', status: 'active' }] })
    await expect(new DeployService(db as any, cfg, [flyAdapter({})]).deploy('o', 'p', { image: 'x' }))
      .rejects.toThrow(/fly resource/i)
  })

  test('throws when no fly adapter is configured', async () => {
    await expect(new DeployService(seeded() as any, cfg, []).deploy('o', 'p', { image: 'x' }))
      .rejects.toThrow(/fly adapter/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/services/deploy.test.ts`.

- [ ] **Step 3: Implement `control-plane/src/services/deploy.ts`**

```typescript
import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ComputeAdapter, DeployResult, ProviderAdapter, ResourceHandle } from '../adapters/types.js'
import { BranchesRepo, ResourcesRepo, SecretsRepo } from '../db/repos.js'
import { decryptSecret } from '../crypto/secrets.js'

export class DeployService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async deploy(owner: string, projectId: string, opts: { image: string; from?: string; port?: number }): Promise<DeployResult> {
    const fly = this.adapters.find((a) => a.kind === 'fly') as ComputeAdapter | undefined
    if (!fly?.deploy) throw new Error('fly adapter not configured')

    const resource = await new ResourcesRepo(this.db).findByKind(owner, projectId, 'fly')
    if (!resource) throw new Error('project has no fly resource')

    const branches = new BranchesRepo(this.db)
    const all = await branches.listByProject(owner, projectId)
    const target = opts.from
      ? all.find((b) => b.name === opts.from || b.id === opts.from)
      : (all.find((b) => b.is_default) ?? all[0])
    if (!target) throw new Error(`branch "${opts.from ?? '(default)'}" not found`)

    const secrets = new SecretsRepo(this.db)
    const rows = [
      ...(await secrets.listForScope(owner, projectId, null)),       // project-scoped
      ...(await secrets.listForScope(owner, projectId, target.id)),  // branch-scoped (override)
    ]
    const env: Record<string, string> = {}
    for (const r of rows) {
      env[r.name] = decryptSecret({ ciphertext: r.ciphertext, nonce: r.nonce, kekVersion: r.kek_version }, this.cfg.keks)
    }

    const handle: ResourceHandle = { kind: 'fly', providerRef: resource.provider_ref }
    return fly.deploy(handle, { image: opts.image, env, port: opts.port })
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `cd control-plane && npx vitest run test/services/deploy.test.ts && npm test`.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/services/deploy.ts control-plane/test/services/deploy.test.ts
git commit -m "feat: DeployService — merge+inject secrets, deploy image to Fly app"
```

---

### Task 3: POST /projects/:id/deploy

**Files:**
- Modify: `control-plane/src/server.ts`
- Test: `control-plane/test/server.test.ts`

**Interfaces:** `POST /projects/:id/deploy` body `{ image, from?, port? }` → auth → 400 if `image` missing → resolve adapters via `deps.adaptersForToken` → `new DeployService(db, deps.cfg, adapters).deploy(uid, projectId, { image, from, port })` → 200 `{ machineId, url }`.

- [ ] **Step 1: Add the failing test** to `control-plane/test/server.test.ts`

```typescript
test('POST /projects/:id/deploy deploys the image via DeployService', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br', status: 'active' })
  db.tables.resources.push({ id: 'r', owner: 'uid-1', project_id: 'p1', kind: 'fly', provider_ref: { flyApp: 'app', orgSlug: 'org' }, status: 'active' })
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy(_h: any, opts: any) { return { machineId: 'm-9', url: `https://app.fly.dev` } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy', headers: { authorization: 'Bearer good' }, payload: { image: 'nginx', port: 80 } })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ machineId: 'm-9', url: 'https://app.fly.dev' })
})

test('POST /projects/:id/deploy requires an image', async () => {
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => fakeData() as any, adaptersForToken: () => [] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy', headers: { authorization: 'Bearer good' }, payload: {} })
  expect(r.statusCode).toBe(400)
})
```

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/server.test.ts`.

- [ ] **Step 3: Add the route to `control-plane/src/server.ts`** — import `DeployService` and add after the branch routes:

```typescript
  app.post('/projects/:id/deploy', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const body = (req.body as any) ?? {}
    if (!body.image) return reply.code(400).send({ error: 'image is required' })
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new DeployService(db, deps.cfg, adapters).deploy(uid, projectId, {
      image: body.image, from: body.from, port: body.port,
    })
    return reply.send(out)
  })
```

(Add `import { DeployService } from './services/deploy.js'` at the top.)

- [ ] **Step 4: Run server tests + full suite** — `cd control-plane && npx vitest run test/server.test.ts && npm test`.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: POST /projects/:id/deploy"
```

---

### Task 4: CLI `firth deploy`

**Files:**
- Create: `control-plane/src/cli/commands/deploy.ts`
- Modify: `control-plane/src/cli/api.ts` (add `deploy`), `control-plane/src/cli/index.ts` (register + USAGE)
- Test: `control-plane/test/cli/deploy.test.ts`

**Interfaces:** `FirthApi.deploy(projectId, { image, from?, port? })` → `POST /projects/:id/deploy`. `deploy(argv, deps)` — `--image <url>` (required), `--from <branch>`, `--port <n>`; resolves the linked project; prints the URL.

- [ ] **Step 1: Write the failing test** `control-plane/test/cli/deploy.test.ts`

```typescript
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { deploy } from '../../src/cli/commands/deploy.js'
import { writeProjectLink } from '../../src/cli/config.js'

function deps(dir: string, api: any) {
  const out: string[] = []
  return { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
}

test('deploy posts the image + port and prints the url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { deploy: async (pid: string, o: any) => { calls.push([pid, o]); return { machineId: 'm1', url: 'https://app.fly.dev' } } }
  const d = deps(dir, api)
  expect(await deploy(['--image', 'nginx:alpine', '--port', '80'], d as any)).toBe(0)
  expect(calls[0][0]).toBe('p1')
  expect(calls[0][1]).toEqual({ image: 'nginx:alpine', from: undefined, port: 80 })
  expect(d.out.join('\n')).toMatch(/app\.fly\.dev/)
})

test('deploy requires --image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const d = deps(dir, {})
  expect(await deploy([], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/--image/)
})

test('deploy errors when not linked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const d = deps(dir, {})
  expect(await deploy(['--image', 'x'], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/not linked|project link/i)
})
```

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/cli/deploy.test.ts`.

- [ ] **Step 3: Add `deploy` to `control-plane/src/cli/api.ts`** (in `FirthApi`)

```typescript
  deploy(projectId: string, opts: { image: string; from?: string; port?: number }) {
    return this.req('POST', `/projects/${projectId}/deploy`, opts)
  }
```

- [ ] **Step 4: Implement `control-plane/src/cli/commands/deploy.ts`**

```typescript
import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function deploy(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    image: { type: 'string' }, from: { type: 'string' }, port: { type: 'string' },
  }, allowPositionals: false })
  if (!values.image) { deps.print('usage: firth deploy --image <url> [--from <branch>] [--port <n>]'); return 1 }
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const out = await apiFromDeps(deps).deploy(link.projectId, {
    image: values.image, from: values.from, port: values.port ? Number(values.port) : undefined,
  })
  deps.print(`deployed machine ${out.machineId} → ${out.url}`)
  return 0
}
```

- [ ] **Step 5: Register in `control-plane/src/cli/index.ts`** — `COMMANDS['deploy'] = deploy` + add a `deploy` line to the `USAGE` string: `  deploy                    Deploy --image <url> to the project's compute (--from, --port)`.

- [ ] **Step 6: Run CLI tests + full suite + build** — `cd control-plane && npx vitest run test/cli/ && npm test && npm run build`.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/cli/commands/deploy.ts control-plane/src/cli/api.ts control-plane/src/cli/index.ts control-plane/test/cli/deploy.test.ts
git commit -m "feat: firth deploy CLI command"
```

---

### Task 5: Live deploy checkpoint (gated on Fly creds)

**Files:**
- Create: `control-plane/scripts/live-deploy-check.ts`
- Modify: `control-plane/package.json` (add `live:deploy`)

**Interfaces:** a gated script: SKIP+exit-0 without `FLY_API_TOKEN`/`FLY_ORG_SLUG`; else provision a throwaway Fly app, `deploy` a small public image (`flyio/hellofly:latest`) with a dummy env + `--port 8080`, confirm the machine reaches a started state (poll `GET /apps/{app}/machines/{id}` or the `/wait` endpoint), then destroy the app in a `finally`. Never print secret values.

- [ ] **Step 1: Implement `control-plane/scripts/live-deploy-check.ts`** (mirror `live-fly-check.ts`; uses `FlyAdapter.provision` then `.deploy`, then polls machine state, then `destroy` in `finally`). Pseudostructure:

```typescript
import { FlyAdapter } from '../src/adapters/fly.js'
import { fetchHttp } from '../src/adapters/factory.js'

async function main() {
  const token = process.env.FLY_API_TOKEN, org = process.env.FLY_ORG_SLUG
  if (!token || !org) { console.log('SKIP: FLY_API_TOKEN/FLY_ORG_SLUG not set — live deploy checkpoint skipped.'); return }
  const adapter = new FlyAdapter(token, org, fetchHttp)
  const handle = await adapter.provision(`firth-live-deploy-${process.env.LIVE_TAG ?? 'manual'}`)
  try {
    const res = await adapter.deploy(handle, { image: 'flyio/hellofly:latest', env: { FIRTH_DEMO: '1' }, port: 8080 })
    console.log('deployed machine:', res.machineId, '→', res.url)
    // optional: poll machine state to 'started' via a new adapter helper or a direct GET (report what you observe)
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed app (cleanup) ✓')
  }
}
main().catch((e) => { console.error('live deploy failed:', e.message); process.exit(1) })
```

- [ ] **Step 2: Add `"live:deploy": "tsx scripts/live-deploy-check.ts"` to `control-plane/package.json`.**

- [ ] **Step 3: Run it LIVE** (a `FLY_API_TOKEN`+`FLY_ORG_SLUG` are in `control-plane/.env`):

Run: `cd control-plane && FLY_API_TOKEN="$(grep -E '^FLY_API_TOKEN=' .env | head -1 | cut -d= -f2-)" FLY_ORG_SLUG="$(grep -E '^FLY_ORG_SLUG=' .env | head -1 | cut -d= -f2-)" LIVE_TAG=$(git rev-parse --short HEAD) npm run live:deploy` (needs network — `dangerouslyDisableSandbox: true` if blocked).
Expected: provision → deploy machine (id + URL) → destroy ✓. Capture output verbatim. **If the deploy errors (e.g. the machine needs an IP allocated, or the image/config is rejected), that is a real finding** — capture the exact error and report it (this is image-mode's first real test; external HTTP reachability may need IP allocation, which is a documented v1 follow-up — confirm at least that the machine is created/started).

- [ ] **Step 4: Confirm cleanup** — the `finally` destroys the throwaway app; optionally list Fly apps to confirm no `firth-live-deploy` app remains.

- [ ] **Step 5: Commit**

```bash
git add control-plane/scripts/live-deploy-check.ts control-plane/package.json
git commit -m "feat: gated live Fly deploy checkpoint"
```

---

## Self-Review

**Spec coverage:** `firth deploy` = build-order step 6 (deploy portion / Flow 3). `ComputeAdapter` + `FlyAdapter.deploy` (T1), `DeployService` with server-side both-scopes secret merge (T2), `POST /projects/:id/deploy` (T3), CLI `firth deploy` (T4), live verification (T5). Image-mode only; source-build deferred. Resolves the flagged "seam returns either/or" item server-side for deploy (T2 merges both scopes).

**Placeholder scan:** No TODO/TBD. The live checkpoint (T5) is real (Fly creds present) and may surface a genuine finding about external reachability/IP allocation — flagged as a known v1 follow-up, with the floor being "machine created/started," not silently skipped.

**Type consistency:** `ComputeAdapter extends ProviderAdapter` + `deploy(handle, DeployOpts) → DeployResult`, implemented by `FlyAdapter`, consumed by `DeployService` (which narrows the fly adapter to `ComputeAdapter`). `DeployService.deploy(owner, projectId, {image, from?, port?})` consistent across the route + CLI. `FirthApi.deploy` matches the route body. Secret rows decrypted via `decryptSecret(enc, cfg.keks)` (snake_case `kek_version` → `kekVersion`), consistent with the seam route.

**Known gaps / deferred:** source-build deploy (flyctl) — image-mode only; external HTTP reachability may need Fly IP allocation (verify in T5; follow-up if needed); Tigris storage creds still blocked (deploy injects whatever secrets exist — Neon DATABASE_URL works); redeploy/update of an existing machine (v1 creates a machine; updating/replacing is a follow-up); no machine-state wait helper unless T5 shows it's needed.

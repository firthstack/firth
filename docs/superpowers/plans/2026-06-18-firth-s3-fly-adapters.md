# Firth S3 (Tigris) + Fly Adapters + Parallel Saga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the three-resource set by adding the **Fly** compute adapter and the **S3/Tigris** storage adapter (both implementing the existing `ProviderAdapter`), and generalize the create-project saga from single-resource (Neon) to **parallel multi-resource provisioning** with whole-set compensating rollback and per-kind secret scoping.

**Architecture:** Extends the merged Neon work (`control-plane/`, TS/Node). Both new adapters follow the `NeonAdapter` pattern: an **injected HTTP client** so unit tests run with no network. Fly speaks its Machines REST API (`api.machines.dev`) with a Bearer token. S3 is **Tigris** (S3-compatible, Fly's storage): bucket ops via the S3 API at `t3.storage.dev` and bucket-scoped key minting via Tigris IAM at `iam.storage.dev`, both **SigV4-signed** using Firth's Tigris account keys (signing isolated behind an injected `SignedHttp` so tests stay network-free). The saga provisions all configured adapters concurrently; on any failure it destroys every provisioned resource and marks rows `error`, rethrowing the original error.

**Tech Stack:** Node 20 + TypeScript, `vitest`, Node global `fetch`, **`aws4fetch`** (new dep — minimal SigV4-over-fetch signer). Fly Machines API; Tigris (S3 + IAM, S3-compatible).

## Global Constraints

- Reuse, unchanged: `ProviderAdapter`/`ResourceHandle`/`SecretBundle`/`HttpClient` (`adapters/types.ts`), `NeonAdapter` pattern, `ProvisioningService` (extended here), `encryptSecret`, `firstOrThrow`, the `DataClient` with `update`.
- Resource kinds remain exactly `'neon' | 's3' | 'fly'`. "s3" is the storage slot; its implementation is **Tigris** (S3-compatible). Add a one-line note to ARCHITECTURE.md §2/§6 that S3 = Tigris.
- `FlyAdapter`: `kind:'fly'`, `branchModel:'redeploy'`. Base `https://api.machines.dev/v1`, `Authorization: Bearer <FLY_API_TOKEN>`. `provision` → `POST /apps {app_name, org_slug}`; `destroy` → `DELETE /apps/{app_name}?force=true`. `createBranch`→null, `readUsage`→{}. `mintCredentials`→`{}` (compute consumes other resources' creds; deploy injects them in a later Flow-3 plan). `providerRef = { flyApp: string, orgSlug: string }`. App names are globally unique → derive `app_name = firth-<sanitized-name>-<short-random>`.
- `TigrisAdapter`: `kind:'s3'`, `branchModel:'shared'`. S3 endpoint `https://t3.storage.dev`, IAM endpoint `https://iam.storage.dev`, region `auto`. `provision` → create bucket; `destroy` → delete bucket (rollback of a fresh empty bucket); `createBranch`→null (shared bucket); `mintCredentials` → a **bucket-scoped** access key → bundle `{ AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, BUCKET_NAME, AWS_REGION }`; `readUsage`→{}. `providerRef = { bucket: string, endpoint: string, region: string }` — **non-secret only** (no keys).
- Secrets discipline (unchanged invariant): every minted credential is AES-GCM-encrypted before any DB write, stored via the secret seam, never logged, never in `provider_ref`. Tigris s3 creds are **project-scoped** (`branch_id` null — the bucket is shared across branches); Neon's `DATABASE_URL` stays **branch-scoped** to main.
- Master credentials (Firth's Neon key, Fly token, Tigris account keys) come from config/env, used server-side only, never logged or echoed.
- New config (all optional, gate live behavior): `FLY_API_TOKEN`, `FLY_ORG_SLUG`, `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY`.
- Saga: provision configured adapters **concurrently**; on ANY failure, destroy ALL provisioned handles (best-effort) + mark their rows `error`, rethrow the original error; never orphan, never false success.

---

### Task 1: FlyAdapter (provision / destroy / no-op methods)

**Files:**
- Create: `control-plane/src/adapters/fly.ts`
- Test: `control-plane/test/adapters/fly.test.ts`

**Interfaces:**
- Consumes: `HttpClient`, `ProviderAdapter`, `ResourceHandle`, `SecretBundle`, `UsageSnapshot` (`adapters/types.ts`).
- Produces: `class FlyAdapter implements ProviderAdapter` with constructor `(apiToken: string, orgSlug: string, http: HttpClient, opts?: { baseUrl?: string })`. `providerRef = { flyApp, orgSlug }`. `mkAppName(projectName, rand)` helper for the unique DNS-safe name.

- [ ] **Step 1: Write the failing test** `control-plane/test/adapters/fly.test.ts`

```typescript
import { describe, expect, test } from 'vitest'
import { FlyAdapter } from '../../src/adapters/fly.js'
import type { HttpClient } from '../../src/adapters/types.js'

function fakeHttp(routes: Array<{ match: (u: string, i: any) => boolean; status?: number; body?: any }>) {
  const calls: Array<{ url: string; init: any }> = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init))
    if (!r) throw new Error(`unexpected: ${init.method} ${url}`)
    return { status: r.status ?? 200, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) }
  }
  return { http, calls }
}

describe('FlyAdapter', () => {
  test('provision POSTs /apps with app_name + org_slug and returns a providerRef', async () => {
    const { http, calls } = fakeHttp([{ match: (u, i) => i.method === 'POST' && u.endsWith('/apps'), status: 201, body: {} }])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    const handle = await adapter.provision('My App')
    expect(handle.kind).toBe('fly')
    expect((handle.providerRef as any).orgSlug).toBe('firth-org')
    const body = JSON.parse(calls[0].init.body)
    expect(body.org_slug).toBe('firth-org')
    expect(body.app_name).toMatch(/^firth-my-app-[a-z0-9]+$/) // sanitized + unique suffix
    expect(calls[0].init.headers.Authorization).toBe('Bearer fly_tok')
    expect((handle.providerRef as any).flyApp).toBe(body.app_name)
  })

  test('destroy DELETEs /apps/{name} with force=true', async () => {
    const { http, calls } = fakeHttp([{ match: (u, i) => i.method === 'DELETE' && u.includes('/apps/firth-x-abc'), body: {} }])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    await adapter.destroy({ kind: 'fly', providerRef: { flyApp: 'firth-x-abc', orgSlug: 'firth-org' } })
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toContain('/apps/firth-x-abc')
    expect(calls[0].url).toContain('force=true')
  })

  test('non-2xx throws with status only (no token leak)', async () => {
    const { http } = fakeHttp([{ match: (u, i) => i.method === 'POST', status: 422, body: { error: 'taken' } }])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    await expect(adapter.provision('x')).rejects.toThrow(/fly POST \/apps failed: 422/)
    await expect(adapter.provision('x')).rejects.not.toThrow(/fly_tok/)
  })

  test('createBranch returns null; mintCredentials and readUsage are empty', async () => {
    const { http } = fakeHttp([])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    const h = { kind: 'fly' as const, providerRef: { flyApp: 'a', orgSlug: 'o' } }
    expect(await adapter.createBranch(h, 'b')).toBeNull()
    expect(await adapter.mintCredentials(h)).toEqual({})
    expect(await adapter.readUsage(h)).toEqual({})
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/adapters/fly.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane/src/adapters/fly.ts`**

```typescript
import { randomBytes } from 'node:crypto'
import type { HttpClient, ProviderAdapter, ResourceHandle, SecretBundle, UsageSnapshot } from './types.js'

const FLY_BASE = 'https://api.machines.dev/v1'

export type FlyRef = { flyApp: string; orgSlug: string }

export function mkAppName(projectName: string, rand: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'app'
  return `firth-${slug}-${rand}`
}

export class FlyAdapter implements ProviderAdapter {
  readonly kind = 'fly' as const
  readonly branchModel = 'redeploy' as const
  private baseUrl: string

  constructor(private apiToken: string, private orgSlug: string, private http: HttpClient, opts: { baseUrl?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? FLY_BASE
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.http(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`fly ${method} ${path} failed: ${res.status}`)
    return res.json().catch(() => ({}))
  }

  async provision(projectName: string): Promise<ResourceHandle> {
    const rand = randomBytes(4).toString('hex')
    const appName = mkAppName(projectName, rand)
    await this.call('POST', '/apps', { app_name: appName, org_slug: this.orgSlug })
    const providerRef: FlyRef = { flyApp: appName, orgSlug: this.orgSlug }
    return { kind: 'fly', providerRef }
  }

  async destroy(handle: ResourceHandle): Promise<void> {
    const ref = handle.providerRef as FlyRef
    await this.call('DELETE', `/apps/${ref.flyApp}?force=true`)
  }

  async createBranch(): Promise<string | null> { return null }
  async mintCredentials(): Promise<SecretBundle> { return {} }
  async readUsage(): Promise<UsageSnapshot> { return {} }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/adapters/fly.test.ts`
Expected: all FlyAdapter tests pass.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/adapters/fly.ts control-plane/test/adapters/fly.test.ts
git commit -m "feat: FlyAdapter (provision/destroy via Machines API)"
```

---

### Task 2: SignedHttp seam + TigrisAdapter provision/destroy (bucket)

**Files:**
- Create: `control-plane/src/adapters/signed-http.ts`
- Create: `control-plane/src/adapters/tigris.ts`
- Test: `control-plane/test/adapters/tigris.test.ts`
- Modify: `control-plane/package.json` (+`aws4fetch`)

**Interfaces:**
- Consumes: `HttpClient`, `ProviderAdapter`, `ResourceHandle`.
- Produces:
  - `type SignedHttp = (url: string, init: { method: string; headers?: Record<string,string>; body?: string }) => Promise<HttpResponse>` (an HttpClient-shaped fn that SigV4-signs). Real impl `makeSignedHttp({ accessKeyId, secretAccessKey, region, service })` wraps `aws4fetch`'s `AwsClient`.
  - `class TigrisAdapter implements ProviderAdapter` constructor `(s3: SignedHttp, iam: SignedHttp, opts?: { s3Endpoint?; iamEndpoint?; region? })`. `provision()` PUTs a bucket; `destroy()` DELETEs it. `mintCredentials`/`readUsage` land in Task 3 (Task 2 leaves them as part of the class but unimplemented is NOT allowed — so Task 2's class does NOT yet declare `implements ProviderAdapter`; it has provision/destroy/createBranch(→null) only, and Task 3 adds the `implements` clause + mintCredentials + readUsage). `providerRef = { bucket, endpoint, region }`.

- [ ] **Step 1: Add `aws4fetch`** to `control-plane/package.json` dependencies: `"aws4fetch": "^1.0.20"`, then `cd control-plane && npm install`.

- [ ] **Step 2: Write the failing test** `control-plane/test/adapters/tigris.test.ts`

```typescript
import { describe, expect, test } from 'vitest'
import { TigrisAdapter } from '../../src/adapters/tigris.js'
import type { SignedHttp } from '../../src/adapters/signed-http.js'

function fake(routes: Array<{ match: (u: string, i: any) => boolean; status?: number; body?: any }>) {
  const calls: Array<{ url: string; init: any }> = []
  const http: SignedHttp = async (url, init) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init))
    if (!r) throw new Error(`unexpected: ${init.method} ${url}`)
    return { status: r.status ?? 200, json: async () => r.body ?? {}, text: async () => '' }
  }
  return { http, calls }
}

describe('TigrisAdapter provision/destroy', () => {
  test('provision PUTs a bucket at the S3 endpoint and returns a non-secret providerRef', async () => {
    const { http, calls } = fake([{ match: (u, i) => i.method === 'PUT', status: 200 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    const handle = await adapter.provision('My App')
    expect(handle.kind).toBe('s3')
    const ref = handle.providerRef as any
    expect(ref.endpoint).toBe('https://t3.storage.dev')
    expect(ref.region).toBe('auto')
    expect(ref.bucket).toMatch(/^firth-my-app-[a-z0-9]+$/)
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].url).toContain(ref.bucket)
    // providerRef carries NO secret material
    expect(JSON.stringify(handle.providerRef)).not.toMatch(/secret|key/i)
  })

  test('destroy DELETEs the bucket', async () => {
    const { http, calls } = fake([{ match: (u, i) => i.method === 'DELETE', status: 204 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    await adapter.destroy({ kind: 's3', providerRef: { bucket: 'firth-x-abc', endpoint: 'https://t3.storage.dev', region: 'auto' } })
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toContain('firth-x-abc')
  })

  test('non-2xx on provision throws with status', async () => {
    const { http } = fake([{ match: (u, i) => i.method === 'PUT', status: 403 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    await expect(adapter.provision('x')).rejects.toThrow(/tigris PUT .* failed: 403/)
  })

  test('createBranch returns null (shared bucket)', async () => {
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(noop, noop)
    expect(await adapter.createBranch({ kind: 's3', providerRef: {} }, 'b')).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/adapters/tigris.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `control-plane/src/adapters/signed-http.ts`**

```typescript
import { AwsClient } from 'aws4fetch'
import type { HttpResponse } from './types.js'

export type SignedHttp = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>

// Real SigV4-signing client over global fetch. `service` is 's3' or 'iam' (Tigris uses the AWS service names).
export function makeSignedHttp(cfg: {
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: 's3' | 'iam'
}): SignedHttp {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: cfg.service,
  })
  return async (url, init) => {
    const res = await client.fetch(url, { method: init.method, headers: init.headers, body: init.body })
    return { status: res.status, json: () => res.json(), text: () => res.text() }
  }
}
```

- [ ] **Step 5: Implement `control-plane/src/adapters/tigris.ts`** (provision/destroy/createBranch; Task 3 adds `implements ProviderAdapter` + mint/usage)

```typescript
import { randomBytes } from 'node:crypto'
import type { ResourceHandle } from './types.js'
import type { SignedHttp } from './signed-http.js'

const S3_ENDPOINT = 'https://t3.storage.dev'
const IAM_ENDPOINT = 'https://iam.storage.dev'
const REGION = 'auto'

export type TigrisRef = { bucket: string; endpoint: string; region: string }
export type TigrisOptions = { s3Endpoint?: string; iamEndpoint?: string; region?: string }

export function mkBucketName(projectName: string, rand: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'bucket'
  return `firth-${slug}-${rand}`
}

export class TigrisAdapter {
  readonly kind = 's3' as const
  readonly branchModel = 'shared' as const
  readonly s3Endpoint: string
  readonly iamEndpoint: string
  readonly region: string

  constructor(private s3: SignedHttp, private iam: SignedHttp, opts: TigrisOptions = {}) {
    this.s3Endpoint = opts.s3Endpoint ?? S3_ENDPOINT
    this.iamEndpoint = opts.iamEndpoint ?? IAM_ENDPOINT
    this.region = opts.region ?? REGION
  }

  async provision(projectName: string): Promise<ResourceHandle> {
    const bucket = mkBucketName(projectName, randomBytes(4).toString('hex'))
    // S3 CreateBucket = PUT to the bucket subresource (path-style against the Tigris endpoint).
    const res = await this.s3(`${this.s3Endpoint}/${bucket}`, { method: 'PUT' })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris PUT /${bucket} failed: ${res.status}`)
    const providerRef: TigrisRef = { bucket, endpoint: this.s3Endpoint, region: this.region }
    return { kind: 's3', providerRef }
  }

  async destroy(handle: ResourceHandle): Promise<void> {
    const ref = handle.providerRef as TigrisRef
    const res = await this.s3(`${this.s3Endpoint}/${ref.bucket}`, { method: 'DELETE' })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris DELETE /${ref.bucket} failed: ${res.status}`)
  }

  async createBranch(): Promise<string | null> { return null }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/adapters/tigris.test.ts`
Expected: provision/destroy/createBranch tests pass.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/adapters/signed-http.ts control-plane/src/adapters/tigris.ts control-plane/test/adapters/tigris.test.ts control-plane/package.json control-plane/package-lock.json
git commit -m "feat: SignedHttp (SigV4) + TigrisAdapter bucket provision/destroy"
```

---

### Task 3: TigrisAdapter mintCredentials (bucket-scoped access key) + readUsage

**Files:**
- Modify: `control-plane/src/adapters/tigris.ts`
- Test: `control-plane/test/adapters/tigris.test.ts` (add cases)

**Interfaces:**
- Produces: `TigrisAdapter implements ProviderAdapter` (add the clause + imports); `mintCredentials(handle)` → `{ AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, BUCKET_NAME, AWS_REGION }`; `readUsage`→{}.

> **[VERIFY-LIVE]** The exact Tigris access-key-creation call is the one part not fully pinned from docs. The intended approach: a signed request to the Tigris IAM endpoint (`iam.storage.dev`) that creates an access key whose policy is scoped to this bucket (`s3:GetObject/PutObject/DeleteObject/ListBucket` on `arn:aws:s3:::<bucket>` and `/*`), returning `{ access_key_id/AccessKeyId, secret_access_key/SecretAccessKey }`. Confirm the exact action/payload against the live Tigris API (the implementer has Firth's Tigris keys) and adjust THIS method only — the returned `SecretBundle` shape and the `iam` SignedHttp seam stay fixed. If the live API differs structurally, report it (NEEDS_CONTEXT) rather than guessing.

- [ ] **Step 1: Add the failing tests** to `control-plane/test/adapters/tigris.test.ts`

```typescript
describe('TigrisAdapter.mintCredentials', () => {
  test('creates a bucket-scoped key via the IAM endpoint and returns the S3 bundle', async () => {
    const calls: any[] = []
    const s3: any = async () => ({ status: 200, json: async () => ({}), text: async () => '' })
    const iam: any = async (url: string, init: any) => {
      calls.push({ url, init })
      return { status: 200, json: async () => ({ access_key_id: 'tid_new', secret_access_key: 'tsec_new' }), text: async () => '' }
    }
    const adapter = new TigrisAdapter(s3, iam)
    const handle = { kind: 's3' as const, providerRef: { bucket: 'firth-x-abc', endpoint: 'https://t3.storage.dev', region: 'auto' } }
    const bundle = await adapter.mintCredentials(handle)
    expect(bundle).toEqual({
      AWS_ACCESS_KEY_ID: 'tid_new',
      AWS_SECRET_ACCESS_KEY: 'tsec_new',
      AWS_ENDPOINT_URL_S3: 'https://t3.storage.dev',
      BUCKET_NAME: 'firth-x-abc',
      AWS_REGION: 'auto',
    })
    // the IAM request references the bucket in its scoped policy
    expect(calls[0].url).toContain('https://iam.storage.dev')
    expect(JSON.stringify(calls[0].init.body ?? '')).toContain('firth-x-abc')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd control-plane && npx vitest run test/adapters/tigris.test.ts` (FAIL: mintCredentials not a function).

- [ ] **Step 3: Edit `control-plane/src/adapters/tigris.ts`:** (1) import `import type { ProviderAdapter, SecretBundle, UsageSnapshot } from './types.js'`; (2) class decl → `export class TigrisAdapter implements ProviderAdapter {`; (3) add:

```typescript
  async mintCredentials(handle: ResourceHandle): Promise<SecretBundle> {
    const ref = handle.providerRef as TigrisRef
    // [VERIFY-LIVE] Create a bucket-scoped access key via Tigris IAM. Confirm the exact
    // action/payload + response field names against the live API and adjust here only.
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${ref.bucket}/*`] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${ref.bucket}`] },
      ],
    }
    const res = await this.iam(`${this.iamEndpoint}/v1/access-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `firth-${ref.bucket}`, policy }),
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris create access-key failed: ${res.status}`)
    const data = await res.json()
    const id = data.access_key_id ?? data.AccessKeyId
    const secret = data.secret_access_key ?? data.SecretAccessKey
    if (!id || !secret) throw new Error('tigris access-key response missing credentials')
    return {
      AWS_ACCESS_KEY_ID: id,
      AWS_SECRET_ACCESS_KEY: secret,
      AWS_ENDPOINT_URL_S3: ref.endpoint,
      BUCKET_NAME: ref.bucket,
      AWS_REGION: ref.region,
    }
  }

  async readUsage(): Promise<UsageSnapshot> { return {} }
```

- [ ] **Step 4: Run to verify it passes** — `cd control-plane && npx vitest run test/adapters/tigris.test.ts` (all green).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/adapters/tigris.ts control-plane/test/adapters/tigris.test.ts
git commit -m "feat: TigrisAdapter mintCredentials (bucket-scoped key) + readUsage"
```

---

### Task 4: Parallel provisioning + register all three adapters

**Files:**
- Modify: `control-plane/src/services/provisioning.ts`
- Modify: `control-plane/src/adapters/factory.ts`
- Modify: `control-plane/src/config.ts`
- Modify: `control-plane/.env.example`
- Test: `control-plane/test/services/provisioning.test.ts` (add parallel + multi-rollback cases), `control-plane/test/adapters/factory.test.ts` (add fly/tigris)

**Interfaces:**
- `config.ts`: add optional `flyApiToken`, `flyOrgSlug`, `tigrisAccessKeyId`, `tigrisSecretAccessKey`.
- `factory.ts`: `buildAdapters(cfg, deps?)` now appends `FlyAdapter` when `flyApiToken && flyOrgSlug`, and `TigrisAdapter` when `tigrisAccessKeyId && tigrisSecretAccessKey` (building the two `SignedHttp` via `makeSignedHttp`). Keep Neon. Allow injecting http/signed-http for tests.
- `provisioning.ts`: provision all adapters **concurrently** (`Promise.all` over a per-adapter provision+postprocess step that records its own resource row); collect results; if any rejected, roll back ALL succeeded resources and rethrow the first error. Generalize the per-kind post-provision: after a successful `provision`, `mintCredentials`; store each bundle entry encrypted — **neon → branch-scoped (main)**, **others → project-scoped (`branch_id` null)**; for neon also set `branches.neon_branch_ref`. The straggler-sweep ownership invariant comment stays.

- [ ] **Step 1: Write failing tests** (`provisioning.test.ts`): one happy-path with `[fakeNeon, fakeS3, fakeFly]` asserting all three resource rows `active`, the neon `DATABASE_URL` branch-scoped, the s3 `AWS_*` project-scoped (`branch_id` null), no secret for fly; one rollback test where the s3 adapter's `provision` rejects and asserts BOTH the neon and fly handles get `destroy`d (whole-set rollback) and the original error propagates. (`factory.test.ts`): assert `buildAdapters` includes `fly`/`s3` kinds when their config is present, none when absent. Use fakes mirroring the existing ones; for the parallel test, the fakes must record `destroyed`.

```typescript
// sketch of the multi-adapter rollback assertion
const order: string[] = []
const mk = (kind, opts = {}) => ({ kind, branchModel: kind === 'neon' ? 'native' : kind === 's3' ? 'shared' : 'redeploy',
  async provision(n) { if (opts.fail) throw new Error(`${kind} provision failed`); return { kind, providerRef: { neonProjectId: `${kind}-${n}`, defaultBranchId: 'br-main', dbName: 'd', roleName: 'r', bucket: `b-${n}`, flyApp: `a-${n}`, endpoint: 'e', region: 'auto', orgSlug: 'o' } } },
  async destroy() { order.push(`destroy:${kind}`) },
  async createBranch() { return kind === 'neon' ? 'br-x' : null },
  async mintCredentials() { return kind === 'neon' ? { DATABASE_URL: 'postgresql://c' } : kind === 's3' ? { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' } : {} },
  async readUsage() { return {} }, ...opts })
// happy: [mk('neon'), mk('s3'), mk('fly')] → 3 resources active; secrets: DATABASE_URL(branch=main) + AWS_*(branch=null); fly none
// rollback: [mk('neon'), mk('s3',{fail:true}), mk('fly')] → rejects /s3 provision failed/; order includes destroy:neon and destroy:fly
```

- [ ] **Step 2: Run to verify they fail** — `cd control-plane && npx vitest run test/services/provisioning.test.ts test/adapters/factory.test.ts`.

- [ ] **Step 3: Update `config.ts`** — add the four optional fields, sourced directly from env (no `required()`):

```typescript
    flyApiToken: env.FLY_API_TOKEN,
    flyOrgSlug: env.FLY_ORG_SLUG,
    tigrisAccessKeyId: env.TIGRIS_ACCESS_KEY_ID,
    tigrisSecretAccessKey: env.TIGRIS_SECRET_ACCESS_KEY,
```
(and the matching optional fields on `FirthConfig`.)

- [ ] **Step 4: Update `factory.ts`**

```typescript
import { FlyAdapter } from './fly.js'
import { TigrisAdapter } from './tigris.js'
import { makeSignedHttp } from './signed-http.js'
// ...inside buildAdapters(cfg, http = fetchHttp):
if (cfg.neonApiKey) adapters.push(new NeonAdapter(cfg.neonApiKey, http))
if (cfg.flyApiToken && cfg.flyOrgSlug) adapters.push(new FlyAdapter(cfg.flyApiToken, cfg.flyOrgSlug, http))
if (cfg.tigrisAccessKeyId && cfg.tigrisSecretAccessKey) {
  const s3 = makeSignedHttp({ accessKeyId: cfg.tigrisAccessKeyId, secretAccessKey: cfg.tigrisSecretAccessKey, region: 'auto', service: 's3' })
  const iam = makeSignedHttp({ accessKeyId: cfg.tigrisAccessKeyId, secretAccessKey: cfg.tigrisSecretAccessKey, region: 'auto', service: 'iam' })
  adapters.push(new TigrisAdapter(s3, iam))
}
```

- [ ] **Step 5: Refactor `provisionProject` to parallel + per-kind scoping.** Replace the sequential `for` loop with a concurrent map; each item provisions, records its resource row, post-processes (mint + store secrets with `branchId = adapter.kind === 'neon' ? defaultBranch.id : null`; neon also sets `neon_branch_ref`). Collect via `Promise.allSettled`; if any rejected, run the existing best-effort rollback over all succeeded handles and `throw` the first rejection reason. (Full code in the brief — preserve the best-effort rollback guards and the straggler-sweep invariant comment from the Neon plan.)

- [ ] **Step 6: Update `.env.example`** — add `FLY_API_TOKEN`, `FLY_ORG_SLUG`, `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY` placeholders with a one-line "optional; gates live provisioning of that resource" comment.

- [ ] **Step 7: Run the full suite** — `cd control-plane && npm test` (all green).

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/services/provisioning.ts control-plane/src/adapters/factory.ts control-plane/src/config.ts control-plane/.env.example control-plane/test/services/provisioning.test.ts control-plane/test/adapters/factory.test.ts
git commit -m "feat: parallel multi-resource provisioning + register Fly/Tigris adapters"
```

---

### Task 5: Live checkpoints (Fly + Tigris) + ARCHITECTURE note

**Files:**
- Create: `control-plane/scripts/live-fly-check.ts`
- Create: `control-plane/scripts/live-tigris-check.ts`
- Modify: `control-plane/package.json` (scripts)
- Modify: `ARCHITECTURE.md` (note S3 = Tigris)

**Interfaces:** standalone gated scripts mirroring `live-neon-check.ts`: SKIP+exit-0 when the relevant creds are absent; else provision→(mint)→destroy with cleanup in `finally`; never print secret values.

- [ ] **Step 1: `live-fly-check.ts`** — gate on `FLY_API_TOKEN` + `FLY_ORG_SLUG`; `provision('firth-live-check-<tag>')` → log app name → `destroy` in `finally`.
- [ ] **Step 2: `live-tigris-check.ts`** — gate on `TIGRIS_ACCESS_KEY_ID` + `TIGRIS_SECRET_ACCESS_KEY`; build the two `makeSignedHttp` clients; `provision` → `mintCredentials` (log only `Boolean(bundle.AWS_ACCESS_KEY_ID)`) → `destroy` in `finally`.
- [ ] **Step 3: Add scripts** `"live:fly"`, `"live:tigris"` to `package.json`.
- [ ] **Step 4: Run both** — `cd control-plane && npm run live:fly && npm run live:tigris`. SKIP expected if creds absent; if present, capture full sequence + cleanup. Capture output verbatim.
- [ ] **Step 5: ARCHITECTURE.md** — add a sentence in §2/§6 that the `s3` slot is implemented by Tigris (S3-compatible, Fly's storage; `t3.storage.dev`), bucket-scoped keys via Tigris IAM.
- [ ] **Step 6: Commit**

```bash
git add control-plane/scripts/live-fly-check.ts control-plane/scripts/live-tigris-check.ts control-plane/package.json ARCHITECTURE.md
git commit -m "feat: gated live Fly + Tigris checkpoints; note S3=Tigris in ARCHITECTURE"
```

---

## Self-Review

**Spec coverage:** Fly adapter (T1), S3/Tigris adapter provision+destroy (T2) + mint (T3), parallel saga + factory registration + config (T4), live checkpoints + doc note (T5). Maps to build-order step 4 ("扩到 S3 + Fly 三件套") + the spec's "concurrent fan-out" (§7 Flow 1).

**Placeholder scan:** No TODO/TBD. One explicit **[VERIFY-LIVE]** on the Tigris access-key call (the only doc-unconfirmed API), isolated to `mintCredentials`, with a NEEDS_CONTEXT escalation path — flagged, not silent (same discipline as Foundation's InsForge-SDK unknowns).

**Type consistency:** `FlyRef`/`TigrisRef` are non-secret `providerRef` shapes; `SecretBundle` keys are the conventional `AWS_*`/`DATABASE_URL` env names; `SignedHttp` mirrors `HttpClient`; `buildAdapters` returns `ProviderAdapter[]`; the saga treats adapters uniformly via the interface. Both new adapters implement `ProviderAdapter` (Fly in T1; Tigris gains the clause in T3, matching the Neon two-step pattern).

**Known gaps / deferred:** Tigris bucket `destroy` assumes an empty bucket (true for rollback of a fresh bucket; emptying-then-deleting a populated bucket is a later concern); per-kind secret scoping is hardcoded by `kind` in the saga (fine for three known kinds); `fly deploy` / actually running compute is a later Flow-3 plan (this plan only provisions the app shell); the **[VERIFY-LIVE]** Tigris key API; `aws4fetch` version pin should be confirmed at install.

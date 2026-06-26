# Firth Copy-on-Write Storage Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every project branch its own isolated Tigris bucket via copy-on-write (CoW) forking, so storage isolation matches the Neon DB branch model.

**Architecture:** A branch's forked bucket is modeled as a branch-scoped `s3` resource row (`branch_id` set) — exactly like the per-branch Fly app, not like Neon. `TigrisAdapter.provision` now creates snapshot-enabled buckets; a new `forkBucket` method CoW-forks a parent bucket. `BranchService.createBranch` forks eagerly (after the Neon branch) and stores branch-scoped `AWS_*` secrets that override main's via the existing secret-merge seam. `TeardownService.deleteBranch` destroys the fork bucket. No schema migration (the `(project_id, branch_id, kind)` index already exists).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `node:crypto`, Fastify, Vitest, aws4fetch (SigV4), raw S3/IAM HTTP against Tigris (`t3.storage.dev` / `iam.storage.dev`).

## Global Constraints

- All work is in the `control-plane/` package. Run tests from there: `cd control-plane`.
- Test runner: `npx vitest run <path>` (single file) / `npx vitest run <path> -t "<name>"` (single test). Full suite: `npm test`.
- ESM imports MUST use the `.js` suffix (e.g. `'../db/repos.js'`), even for `.ts` sources.
- Provider error strings in thrown errors stay static/controlled — never interpolate raw provider response bodies (only status codes), per ARCHITECTURE.md §7.
- Tigris fork headers (verbatim): enable snapshots = `X-Tigris-Enable-Snapshot: true`; fork source = `X-Tigris-Fork-Source-Bucket: <parentBucket>`. Both set on the `PUT /{bucket}` CreateBucket call.
- Secrets are AES-256-GCM via `encryptSecret(value, cfg.keks, cfg.currentKek)` from `../crypto/secrets.js`. Branch-scoped secrets use `branch_id = <branch row id>`.
- Isolation invariant: a forked branch must store ALL 5 `AWS_*` keys branch-scoped (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `BUCKET_NAME`, `AWS_REGION`) so they fully override main's project-scoped creds.

---

### Task 1: TigrisAdapter — snapshot-enabled provision + `forkBucket` + `StorageAdapter` interface

**Files:**
- Modify: `control-plane/src/adapters/types.ts` (add `'fork'` to `branchModel` union; add `StorageAdapter` interface)
- Modify: `control-plane/src/adapters/tigris.ts` (`TigrisRef.snapshotEnabled`; `branchModel='fork'`; enable-snapshot header in `provision`; new `forkBucket`)
- Test: `control-plane/test/adapters/tigris.test.ts`

**Interfaces:**
- Consumes: existing `SignedHttp` (`{ method, headers?, body? }` — headers are SigV4-signed), `ResourceHandle`, `mkBucketName(projectName, rand)`.
- Produces:
  - `StorageAdapter extends ProviderAdapter { forkBucket(parent: ResourceHandle, name: string): Promise<ResourceHandle> }`
  - `TigrisRef` gains `snapshotEnabled?: boolean`.
  - `TigrisAdapter.provision()` → handle whose `providerRef.snapshotEnabled === true`.
  - `TigrisAdapter.forkBucket(parent, name)` → `{ kind: 's3', providerRef: { bucket, endpoint, region, snapshotEnabled: true } }`.

- [ ] **Step 1: Add `'fork'` to the branchModel union and the `StorageAdapter` interface**

In `control-plane/src/adapters/types.ts`, change the `branchModel` line in `ProviderAdapter`:

```typescript
  readonly branchModel: 'native' | 'shared' | 'redeploy' | 'fork'
```

Then add, after the `ComputeAdapter` interface at the end of the file:

```typescript
export interface StorageAdapter extends ProviderAdapter {
  // CoW-fork an existing (snapshot-enabled) bucket into a new branch-scoped bucket.
  forkBucket(parent: ResourceHandle, name: string): Promise<ResourceHandle>
}
```

- [ ] **Step 2: Write the failing tests for provision + forkBucket**

Add these tests to `control-plane/test/adapters/tigris.test.ts` (inside the existing `describe('TigrisAdapter provision/destroy', ...)` block, or at file end as a new `describe`). They reuse the file's existing `fake()` helper:

```typescript
test('provision enables snapshots (header + providerRef flag) so the bucket is forkable', async () => {
  const { http, calls } = fake([{ match: (u, i) => i.method === 'PUT', status: 200 }])
  const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
  const adapter = new TigrisAdapter(http, noop)
  const handle = await adapter.provision('My App')
  expect(calls[0].init.headers?.['X-Tigris-Enable-Snapshot']).toBe('true')
  expect((handle.providerRef as any).snapshotEnabled).toBe(true)
})

test('forkBucket creates a CoW fork from the parent bucket (fork-source + enable-snapshot headers)', async () => {
  const { http, calls } = fake([{ match: (u, i) => i.method === 'PUT', status: 200 }])
  const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
  const adapter = new TigrisAdapter(http, noop)
  const parent = { kind: 's3' as const, providerRef: { bucket: 'firth-app-parent', endpoint: 'https://t3.storage.dev', region: 'auto', snapshotEnabled: true } }
  const fork = await adapter.forkBucket(parent, 'feature')
  const ref = fork.providerRef as any
  expect(ref.bucket).toMatch(/^firth-feature-[a-z0-9]+$/)
  expect(ref.bucket).not.toBe('firth-app-parent')
  expect(ref.snapshotEnabled).toBe(true)
  expect(calls[0].init.method).toBe('PUT')
  expect(calls[0].url).toContain(ref.bucket)
  expect(calls[0].init.headers?.['X-Tigris-Fork-Source-Bucket']).toBe('firth-app-parent')
  expect(calls[0].init.headers?.['X-Tigris-Enable-Snapshot']).toBe('true')
})

test('forkBucket throws with status on non-2xx', async () => {
  const { http } = fake([{ match: (u, i) => i.method === 'PUT', status: 403 }])
  const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
  const adapter = new TigrisAdapter(http, noop)
  const parent = { kind: 's3' as const, providerRef: { bucket: 'firth-app-parent', endpoint: 'https://t3.storage.dev', region: 'auto' } }
  await expect(adapter.forkBucket(parent, 'feature')).rejects.toThrow(/tigris fork PUT .* failed: 403/)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd control-plane && npx vitest run test/adapters/tigris.test.ts -t "forkBucket"`
Expected: FAIL — `adapter.forkBucket is not a function`; the provision test FAILs on the missing header.

- [ ] **Step 4: Implement the changes in `tigris.ts`**

In `control-plane/src/adapters/tigris.ts`:

(a) Add `snapshotEnabled?: boolean` to `TigrisRef`:

```typescript
export type TigrisRef = {
  bucket: string
  endpoint: string
  region: string
  accessKeyId?: string
  policyArn?: string
  snapshotEnabled?: boolean
}
```

(b) Change the class to implement `StorageAdapter` and flip `branchModel`. Update the import and class declaration:

```typescript
import type { ProviderAdapter, ResourceHandle, SecretBundle, StorageAdapter, UsageSnapshot } from './types.js'
```

```typescript
export class TigrisAdapter implements StorageAdapter {
  readonly kind = 's3' as const
  readonly branchModel = 'fork' as const
```

(c) Replace `provision()` so it sends the enable-snapshot header and records the flag:

```typescript
  async provision(projectName: string): Promise<ResourceHandle> {
    const bucket = mkBucketName(projectName, randomBytes(4).toString('hex'))
    // S3 CreateBucket = PUT to the bucket subresource. The Tigris header opts the bucket into
    // snapshots at creation — required for it to be forkable later (cannot be retrofitted).
    const res = await this.s3(`${this.s3Endpoint}/${bucket}`, { method: 'PUT', headers: { 'X-Tigris-Enable-Snapshot': 'true' } })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris PUT /${bucket} failed: ${res.status}`)
    const providerRef: TigrisRef = { bucket, endpoint: this.s3Endpoint, region: this.region, snapshotEnabled: true }
    return { kind: 's3', providerRef }
  }
```

(d) Replace the `createBranch`/`deleteBranch` no-op lines with the same no-ops PLUS the new `forkBucket` (keep `createBranch`/`deleteBranch` for `ProviderAdapter` interface compliance — storage forking goes through `forkBucket`, mirroring how Fly provisions via `provision`, not `createBranch`):

```typescript
  async createBranch(_handle: ResourceHandle, _name: string, _parentRef?: string): Promise<string | null> { return null }

  async deleteBranch(): Promise<void> { /* fork buckets are torn down via destroy() on the branch's s3 resource */ }

  async forkBucket(parent: ResourceHandle, name: string): Promise<ResourceHandle> {
    const parentRef = parent.providerRef as TigrisRef
    const bucket = mkBucketName(name, randomBytes(4).toString('hex'))
    // CoW fork: CreateBucket with the fork-source header. Enable snapshots on the fork too so it
    // can itself be forked (grandchild branches). No snapshot version → Tigris snapshots the
    // source at fork time ("fork from now").
    const res = await this.s3(`${this.s3Endpoint}/${bucket}`, {
      method: 'PUT',
      headers: { 'X-Tigris-Enable-Snapshot': 'true', 'X-Tigris-Fork-Source-Bucket': parentRef.bucket },
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris fork PUT /${bucket} failed: ${res.status}`)
    const providerRef: TigrisRef = { bucket, endpoint: this.s3Endpoint, region: this.region, snapshotEnabled: true }
    return { kind: 's3', providerRef }
  }
```

- [ ] **Step 5: Run the new tests + the full Tigris suite to verify pass + no regressions**

Run: `cd control-plane && npx vitest run test/adapters/tigris.test.ts`
Expected: PASS (all tests, including the existing provision/destroy/mint tests — the `not.toMatch(/secret|key/i)` providerRef check still passes because `snapshotEnabled` contains neither).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/adapters/types.ts control-plane/src/adapters/tigris.ts control-plane/test/adapters/tigris.test.ts
git commit -m "feat(storage): snapshot-enabled buckets + Tigris forkBucket (CoW)"
```

---

### Task 2: `ResourcesRepo.findRootByKind` — project-root (branch_id NULL) lookup

**Files:**
- Modify: `control-plane/src/db/repos.ts` (add `findRootByKind`)
- Test: `control-plane/test/db/repos.test.ts`

**Interfaces:**
- Consumes: `DataClient`, `ResourceRow`.
- Produces: `ResourcesRepo.findRootByKind(owner, projectId, kind): Promise<ResourceRow | null>` — returns the resource of `kind` with `branch_id IS NULL` (the project root, e.g. main's bucket), never a branch fork row. (`findByKind` is left unchanged — it's only ever called for `'neon'`, which is always project-root.)

- [ ] **Step 1: Write the failing test**

Add to `control-plane/test/db/repos.test.ts` (reuses the file's `fakeDb` helper):

```typescript
test('ResourcesRepo.findRootByKind returns only the project-root (branch_id null) s3 resource', async () => {
  const db = fakeDb({ resources: [
    { id: 'r-root', owner: 'o', project_id: 'p', kind: 's3', branch_id: null, provider_ref: { bucket: 'root' }, status: 'active' },
    { id: 'r-fork', owner: 'o', project_id: 'p', kind: 's3', branch_id: 'b-feat', provider_ref: { bucket: 'fork' }, status: 'active' },
  ] })
  const repo = new ResourcesRepo(db as any)
  expect((await repo.findRootByKind('o', 'p', 's3'))?.id).toBe('r-root')
  expect(await repo.findRootByKind('o', 'p', 'fly')).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run test/db/repos.test.ts -t "findRootByKind"`
Expected: FAIL — `repo.findRootByKind is not a function`.

- [ ] **Step 3: Implement `findRootByKind`**

In `control-plane/src/db/repos.ts`, add to `ResourcesRepo` (right after `findByKind`):

```typescript
  async findRootByKind(owner: string, projectId: string, kind: string): Promise<ResourceRow | null> {
    // The project-root resource (branch_id IS NULL), e.g. main's bucket — never a branch fork row.
    const { data, error } = await this.db.from('resources').select()
      .eq('owner', owner).eq('project_id', projectId).eq('kind', kind).is('branch_id', null)
    if (error) throw error
    return ((data ?? [])[0] as ResourceRow) ?? null
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && npx vitest run test/db/repos.test.ts`
Expected: PASS (new test + existing repo tests).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/db/repos.ts control-plane/test/db/repos.test.ts
git commit -m "feat(storage): ResourcesRepo.findRootByKind for project-root lookups"
```

---

### Task 3: `BranchService.createBranch` — eager storage fork + rollback

**Files:**
- Modify: `control-plane/src/services/branches.ts`
- Test: `control-plane/test/services/branches.test.ts`

**Interfaces:**
- Consumes: `StorageAdapter.forkBucket` (Task 1), `ResourcesRepo.findRootByKind` (Task 2), `ResourcesRepo.findByKindForBranch` (existing), `firstOrThrow` (existing in `repos.js`), `mintCredentials`, `encryptSecret`.
- Produces: unchanged return shape `{ branch: { id, name, parentBranchId } }`. Side effects when the project root bucket is forkable: a branch-scoped `s3` `resources` row + branch-scoped `AWS_*` secrets.

- [ ] **Step 1: Write the failing tests**

In `control-plane/test/services/branches.test.ts`, first add an S3 adapter fake near the existing `flyAdapter` helper:

```typescript
function s3Adapter(over: Partial<any> = {}): any & { forked: Array<{ parent: string; name: string }>; destroyed: string[] } {
  const forked: Array<{ parent: string; name: string }> = []
  const destroyed: string[] = []
  return {
    forked, destroyed, kind: 's3', branchModel: 'fork',
    async provision(name: string) { return { kind: 's3', providerRef: { bucket: `firth-${name}-root`, endpoint: 'e', region: 'auto', snapshotEnabled: true } } },
    async destroy(h: any) { destroyed.push((h.providerRef as any).bucket) },
    async createBranch() { return null },
    async deleteBranch() {},
    async forkBucket(parent: any, name: string) {
      forked.push({ parent: (parent.providerRef as any).bucket, name })
      return { kind: 's3', providerRef: { bucket: `firth-${name}-fork`, endpoint: 'e', region: 'auto', snapshotEnabled: true } }
    },
    async mintCredentials(h: any) {
      return { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_ENDPOINT_URL_S3: 'e', BUCKET_NAME: (h.providerRef as any).bucket, AWS_REGION: 'auto' }
    },
    async readUsage() { return {} },
    ...over,
  }
}
```

Then add a `seededWithS3()` helper (a forkable project root bucket alongside the neon resource):

```typescript
const seededWithS3 = () => fakeDb({
  resources: [
    { id: 'r1', owner: 'o', project_id: 'p', kind: 'neon', branch_id: null, provider_ref: { neonProjectId: 'np', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' }, status: 'active' },
    { id: 'r-s3', owner: 'o', project_id: 'p', kind: 's3', branch_id: null, provider_ref: { bucket: 'firth-app-root', endpoint: 'e', region: 'auto', snapshotEnabled: true }, status: 'active' },
  ],
  branches: [{ id: 'b-main', owner: 'o', project_id: 'p', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }],
})
```

Now the tests:

```typescript
describe('BranchService storage fork', () => {
  test('forks the project root bucket and stores branch-scoped AWS_* when the root is snapshot-enabled', async () => {
    const db = seededWithS3(); const s3 = s3Adapter()
    const { branch } = await new BranchService(db as any, cfg, [neonAdapter(), s3, flyAdapter()]).createBranch('o', 'p', 'feature')
    // forked off main's root bucket
    expect(s3.forked).toEqual([{ parent: 'firth-app-root', name: 'feature' }])
    // a branch-scoped s3 resource row exists
    const s3Row = db.tables.resources.find((r: any) => r.kind === 's3' && r.branch_id === branch.id)
    expect(s3Row?.provider_ref.bucket).toBe('firth-feature-fork')
    expect(s3Row?.status).toBe('active')
    // all 5 AWS_* creds (+ BUCKET_NAME) are branch-scoped alongside DATABASE_URL — they override main's project-scoped creds
    const names = db.tables.secrets.filter((s: any) => s.branch_id === branch.id).map((s: any) => s.name).sort()
    expect(names).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'BUCKET_NAME', 'DATABASE_URL'])
  })

  test('does NOT fork when the project root bucket is not snapshot-enabled (legacy project)', async () => {
    const db = seededWithS3()
    // make the root bucket legacy (no snapshotEnabled flag)
    db.tables.resources.find((r: any) => r.kind === 's3').provider_ref = { bucket: 'firth-legacy-root', endpoint: 'e', region: 'auto' }
    const s3 = s3Adapter()
    const { branch } = await new BranchService(db as any, cfg, [neonAdapter(), s3, flyAdapter()]).createBranch('o', 'p', 'feature')
    expect(s3.forked).toEqual([])
    expect(db.tables.resources.find((r: any) => r.kind === 's3' && r.branch_id === branch.id)).toBeFalsy()
    // branch still active with its DB
    expect(db.tables.branches.find((b: any) => b.id === branch.id)?.status).toBe('active')
  })

  test('forks off the PARENT branch bucket when --from is a non-default branch', async () => {
    const db = seededWithS3()
    // add an existing feature branch with its own fork bucket
    db.tables.branches.push({ id: 'b-feat', owner: 'o', project_id: 'p', name: 'feat', parent_branch_id: 'b-main', is_default: false, neon_branch_ref: 'br-feat', status: 'active' })
    db.tables.resources.push({ id: 'r-s3-feat', owner: 'o', project_id: 'p', kind: 's3', branch_id: 'b-feat', provider_ref: { bucket: 'firth-feat-fork', endpoint: 'e', region: 'auto', snapshotEnabled: true }, status: 'active' })
    const s3 = s3Adapter()
    await new BranchService(db as any, cfg, [neonAdapter(), s3, flyAdapter()]).createBranch('o', 'p', 'child', 'feat')
    expect(s3.forked).toEqual([{ parent: 'firth-feat-fork', name: 'child' }])
  })

  test('rollback: a failing forkBucket deletes the neon branch, marks the branch error, stores no s3 secrets', async () => {
    const db = seededWithS3()
    const neon = neonAdapter()
    const s3 = s3Adapter({ async forkBucket() { throw new Error('fork failed') } })
    await expect(new BranchService(db as any, cfg, [neon, s3, flyAdapter()]).createBranch('o', 'p', 'feature'))
      .rejects.toThrow(/fork failed/)
    expect((neon as any).deleted).toEqual(['br-new'])
    expect(db.tables.branches.find((b: any) => b.name === 'feature').status).toBe('error')
    expect(db.tables.secrets.some((s: any) => s.name.startsWith('AWS_'))).toBe(false)
  })

  test('rollback: a failing s3 mintCredentials destroys the fork bucket and deletes the neon branch', async () => {
    const db = seededWithS3()
    const neon = neonAdapter()
    const s3 = s3Adapter({ async mintCredentials() { throw new Error('s3 mint failed') } })
    await expect(new BranchService(db as any, cfg, [neon, s3, flyAdapter()]).createBranch('o', 'p', 'feature'))
      .rejects.toThrow(/s3 mint failed/)
    expect(s3.destroyed).toEqual(['firth-feature-fork'])  // fork bucket cleaned up
    expect((neon as any).deleted).toEqual(['br-new'])
    expect(db.tables.branches.find((b: any) => b.name === 'feature').status).toBe('error')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd control-plane && npx vitest run test/services/branches.test.ts -t "storage fork"`
Expected: FAIL — no fork happens yet (`s3.forked` is empty; no branch-scoped `s3` row).

- [ ] **Step 3: Implement the storage fork in `branches.ts`**

Update the imports at the top of `control-plane/src/services/branches.ts`:

```typescript
import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ProviderAdapter, ResourceHandle, StorageAdapter } from '../adapters/types.js'
import { BranchesRepo, ResourcesRepo, firstOrThrow } from '../db/repos.js'
import { encryptSecret } from '../crypto/secrets.js'
```

Replace the whole `createBranch` method body with:

```typescript
  async createBranch(owner: string, projectId: string, name: string, fromName = 'main'): Promise<{
    branch: { id: string; name: string; parentBranchId: string }
  }> {
    const neon = this.adapters.find((a) => a.kind === 'neon')
    if (!neon) throw new Error('neon adapter not configured')

    const resources = new ResourcesRepo(this.db)
    const resource = await resources.findByKind(owner, projectId, 'neon')
    if (!resource) throw new Error('project has no neon resource')

    const branches = new BranchesRepo(this.db)
    const parent = await branches.findByName(owner, projectId, fromName)
    if (!parent || !parent.neon_branch_ref) throw new Error(`parent branch "${fromName}" not found or has no neon branch`)
    // Don't fork off a parent that isn't healthy — an 'error'/'creating' parent may carry a
    // stale neon_branch_ref pointing at a Neon branch a prior rollback already deleted.
    if (parent.status !== 'active') throw new Error(`parent branch "${fromName}" is not active (status: ${parent.status})`)

    const handle: ResourceHandle = { kind: 'neon', providerRef: resource.provider_ref }
    const row = await branches.create({
      project_id: projectId, owner, name, parent_branch_id: parent.id, is_default: false, status: 'creating',
    })

    const s3 = this.adapters.find((a) => a.kind === 's3') as StorageAdapter | undefined
    let neonRef: string | null = null
    let s3ForkHandle: ResourceHandle | null = null
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

      // Storage fork (CoW): if the project's root bucket is snapshot-enabled, give this branch its
      // own forked bucket so storage is isolated per branch (mirrors the Neon DB branch). Legacy
      // projects (root bucket created before snapshots) skip this and keep shared storage.
      const root = await resources.findRootByKind(owner, projectId, 's3')
      if (s3?.forkBucket && root && (root.provider_ref as { snapshotEnabled?: boolean }).snapshotEnabled) {
        // Fork from the PARENT branch's bucket (mirrors the DB --from): root for default, the
        // parent's branch-scoped bucket otherwise. CoW chains are fine (Tigris recursive lookups).
        const parentS3 = parent.is_default
          ? root
          : await resources.findByKindForBranch(owner, projectId, parent.id, 's3')
        const parentHandle: ResourceHandle = { kind: 's3', providerRef: (parentS3 ?? root).provider_ref }
        s3ForkHandle = await s3.forkBucket(parentHandle, name)
        const ins = await this.db.from('resources').insert({
          project_id: projectId, owner, kind: 's3', branch_id: row.id,
          provider_ref: s3ForkHandle.providerRef, status: 'active',
        }).select()
        if (ins.error) throw ins.error
        const s3ResourceId = (firstOrThrow(ins.data, 'resource') as { id: string }).id
        // mintCredentials enriches providerRef with accessKeyId+policyArn — re-persist it so destroy can clean up.
        const s3Bundle = await s3.mintCredentials(s3ForkHandle)
        const repersist = await this.db.from('resources').update({ provider_ref: s3ForkHandle.providerRef }).eq('id', s3ResourceId)
        if (repersist.error) throw repersist.error
        for (const [key, value] of Object.entries(s3Bundle)) {
          const enc = encryptSecret(value, this.cfg.keks, this.cfg.currentKek)
          const sec = await this.db.from('secrets').insert({
            project_id: projectId, owner, branch_id: row.id, name: key,
            ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion,
          }).select()
          if (sec.error) throw sec.error
        }
      }

      // Compute is provisioned LAZILY on first deploy (see DeployService.ensureCompute),
      // not here — so a branch is a DB+storage environment until something is deployed to it.

      return { branch: { id: row.id, name, parentBranchId: parent.id } }
    } catch (err) {
      // best-effort rollback; never mask the original error
      try { if (s3ForkHandle && s3) await s3.destroy(s3ForkHandle) } catch { /* best-effort */ }
      try { if (neonRef) await neon.deleteBranch(handle, neonRef) } catch { /* best-effort */ }
      try { await this.db.from('branches').update({ status: 'error' }).eq('id', row.id) } catch { /* best-effort */ }
      throw err
    }
  }
```

- [ ] **Step 4: Run the new tests + the full branches suite**

Run: `cd control-plane && npx vitest run test/services/branches.test.ts`
Expected: PASS — including the existing tests. Note the existing `branch create is DB-only — no compute provisioned` test uses `seeded()` (no s3 resource), so no fork is attempted there; it still passes.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/services/branches.ts control-plane/test/services/branches.test.ts
git commit -m "feat(storage): fork the parent bucket on branch create (CoW isolation)"
```

---

### Task 4: `TeardownService.deleteBranch` — destroy the fork bucket

**Files:**
- Modify: `control-plane/src/services/teardown.ts`
- Test: `control-plane/test/services/teardown.test.ts`

**Interfaces:**
- Consumes: `ResourcesRepo.findByKindForBranch` (existing), the s3 adapter's `destroy` (existing — empties + deletes the bucket, tears down IAM).
- Produces: `deleteBranch` now also destroys the branch's `s3` fork resource (marks it `destroyed`, pushes `'s3'` to `summary.destroyed`); failures recorded in `summary.failed` without throwing. `deleteProject` is unchanged (already iterates all `resources`).

- [ ] **Step 1: Write the failing test**

Add to `control-plane/test/services/teardown.test.ts`. It reuses the file's `fakeData`, `neonAdapter`, and `flySpy` helpers; add a small s3 spy inline:

```typescript
test('deleteBranch destroys the branch fork bucket + neon branch and marks the s3 resource destroyed', async () => {
  const s3Destroyed: string[] = []; const neonDeleted: string[] = []
  const db = fakeData()
  db.tables.projects.push({ id: 'p', owner: 'o', name: 'proj', status: 'active' })
  db.tables.branches.push({ id: 'b-feat', owner: 'o', project_id: 'p', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' })
  db.tables.resources.push({ id: 'r-neon', owner: 'o', project_id: 'p', kind: 'neon', branch_id: null, provider_ref: { neonProjectId: 'np' }, status: 'active' })
  db.tables.resources.push({ id: 'r-s3-root', owner: 'o', project_id: 'p', kind: 's3', branch_id: null, provider_ref: { bucket: 'root' }, status: 'active' })
  db.tables.resources.push({ id: 'r-s3-feat', owner: 'o', project_id: 'p', kind: 's3', branch_id: 'b-feat', provider_ref: { bucket: 'firth-feature-fork' }, status: 'active' })
  const neon = neonAdapter({ async deleteBranch(_h: any, ref: string) { neonDeleted.push(ref) } } as any)
  const s3 = { kind: 's3', branchModel: 'fork', async provision() { return { kind: 's3', providerRef: {} } }, async destroy(h: any) { s3Destroyed.push((h.providerRef as any).bucket) }, async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} } }
  const out = await new TeardownService(db as any, cfg, [neon, s3 as any]).deleteBranch('o', 'p', 'b-feat')
  expect(neonDeleted).toEqual(['br-feat'])
  expect(s3Destroyed).toEqual(['firth-feature-fork'])  // only the branch fork, NOT the root bucket
  expect(out.teardown.destroyed).toContain('s3')
  expect(db.tables.resources.find((r: any) => r.id === 'r-s3-feat').status).toBe('destroyed')
  expect(db.tables.resources.find((r: any) => r.id === 'r-s3-root').status).toBe('active')  // root untouched
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run test/services/teardown.test.ts -t "fork bucket"`
Expected: FAIL — `s3Destroyed` is empty (deleteBranch doesn't touch s3 yet).

- [ ] **Step 3: Implement the s3 teardown in `deleteBranch`**

In `control-plane/src/services/teardown.ts`, inside `deleteBranch`, add an s3 block right after the existing `fly` block (before `await branches.archive(...)`):

```typescript
    const s3 = this.adapters.find((a) => a.kind === 's3')
    const s3Resource = await new ResourcesRepo(this.db).findByKindForBranch(owner, projectId, branchId, 's3')
    if (s3 && s3Resource) {
      try {
        await s3.destroy({ kind: 's3', providerRef: s3Resource.provider_ref })
        await new ResourcesRepo(this.db).markStatus(owner, s3Resource.id, 'destroyed')
        summary.destroyed.push('s3')
      } catch (e) {
        summary.failed.push({ kind: 's3', message: e instanceof Error ? e.message : String(e) })
      }
    }
```

- [ ] **Step 4: Run the new test + full teardown suite**

Run: `cd control-plane && npx vitest run test/services/teardown.test.ts`
Expected: PASS — new test plus existing (`deleteProject` already iterates all `s3` rows, so per-branch fork buckets are destroyed there for free; existing tests unaffected because they have no branch-scoped s3 rows).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/services/teardown.ts control-plane/test/services/teardown.test.ts
git commit -m "feat(storage): destroy the branch fork bucket on branch delete"
```

---

### Task 5: Docs update + full-suite gate + live re-forkability verification

**Files:**
- Modify: `ARCHITECTURE.md` (§3 summary row, §6 adapter table, §8 branching semantics, §9 branch-create flow)
- Verify (manual/live): fork re-forkability against the real Tigris API

**Interfaces:** none (documentation + verification).

- [ ] **Step 1: Run the full control-plane suite to confirm no regressions**

Run: `cd control-plane && npm test`
Expected: PASS — entire suite green.

- [ ] **Step 2: Update `ARCHITECTURE.md` §8 (branching semantics)**

Replace the Storage row of the §8 table:

```markdown
| Storage (S3) | CoW-forked bucket, one per branch (new projects) | ✅ isolated (legacy projects: shared) |
```

Replace the line after the table:

```markdown
A branch ≈ a Neon DB branch + that branch's own secrets (connection string + bucket credentials) + that branch's own CoW-forked bucket + that branch's own isolated Fly app.
```

Replace the **Honest caveat** paragraph with:

```markdown
**Storage isolation (new projects):** each branch gets a Tigris copy-on-write fork of its parent's bucket — objects are shared until written, so an agent on a branch can read/overwrite/delete freely without touching the parent, and deleting the branch discards its bucket. "branch = undo" now holds for storage too. **Legacy caveat:** projects whose root bucket was created before snapshots were enabled cannot be forked (Tigris requires snapshots at bucket creation), so their branches keep the old shared-bucket behavior — no isolation, discarding the branch won't restore objects. Each branch also has its own Fly app; deploying "on a branch" targets that branch's app.
```

- [ ] **Step 3: Update the other ARCHITECTURE.md references**

- Line ~22 (§3 summary table) Branching row: change `storage shared` → `storage CoW-forked (new projects)`.
- Line ~92 (§6 adapter table) S3 row `branchModel` column: change `` `shared` (createBranch→null) `` → `` `fork` (CoW bucket fork) ``.
- Line ~123 (§9 flows) `firth branch create` bullet: change `S3 is shared (no-op)` → `S3 CoW-forks the parent's bucket (new projects; legacy stays shared)`.

- [ ] **Step 4: Commit the docs**

```bash
git add ARCHITECTURE.md
git commit -m "docs(storage): document per-branch CoW storage forks (ARCHITECTURE §8)"
```

- [ ] **Step 5: Live re-forkability verification (manual, requires Tigris creds)**

The one fact docs didn't fully settle: whether a freshly-forked bucket must itself be snapshot-enabled to be re-forkable. We pass `X-Tigris-Enable-Snapshot: true` on every fork (Task 1) defensively. Verify against the live API using the existing live-check harness pattern:

Run: `cd control-plane && npm run live:tigris`
Then manually (or by extending `scripts/live-tigris-check.ts`): create a snapshot-enabled bucket, `forkBucket` it, then `forkBucket` the fork (grandchild). Confirm the grandchild fork succeeds (2xx) and `HEAD` on the fork returns `X-Tigris-Enable-Snapshot: true`.

Expected: grandchild fork returns 2xx. If it does NOT, the fork-source bucket needs no extra handling (our defensive header already covers it) — document the confirmed behavior in `ARCHITECTURE.md §8` and remove the "to verify" note from the spec.

- [ ] **Step 6: Final commit (if the verification changed any code/docs)**

```bash
git add -A
git commit -m "chore(storage): confirm fork re-forkability against live Tigris"
```

---

## Self-Review

**1. Spec coverage:**
- Snapshot-enabled provision → Task 1. ✅
- `forkBucket` (fork-source header) → Task 1. ✅
- `branchModel: 'fork'` + `StorageAdapter` → Task 1. ✅
- `TigrisRef.snapshotEnabled` flag (forkable marker) → Task 1. ✅
- Root-vs-fork `s3` lookup (`findRootByKind`) → Task 2. ✅
- Eager fork in `createBranch` + parent-bucket resolution + branch-scoped `AWS_*` → Task 3. ✅
- Legacy-project skip (no snapshotEnabled) → Task 3 (test + guard). ✅
- Rollback (fork bucket destroyed + neon branch deleted + branch error) → Task 3. ✅
- `deleteBranch` destroys fork bucket → Task 4. ✅
- `deleteProject` destroys all fork buckets → Task 4 (unchanged, noted). ✅
- Secret-layering isolation (no endpoint change) → verified in Task 3 test asserting all 5 branch-scoped `AWS_*`. ✅
- No schema migration → confirmed (column + index pre-exist). ✅
- ARCHITECTURE §8 update → Task 5. ✅
- Live re-forkability verification → Task 5. ✅

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to" — every code step shows full code. ✅

**3. Type consistency:** `forkBucket(parent: ResourceHandle, name: string): Promise<ResourceHandle>`, `findRootByKind(owner, projectId, kind)`, `StorageAdapter`, `snapshotEnabled` used identically across Tasks 1→3→4. `firstOrThrow` imported in Task 3 from `repos.js` (where it's exported). The 5 `AWS_*` key names match `mintCredentials`'s real bundle. ✅

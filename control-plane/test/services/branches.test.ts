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

const seededWithS3 = () => fakeDb({
  resources: [
    { id: 'r1', owner: 'o', project_id: 'p', kind: 'neon', branch_id: null, provider_ref: { neonProjectId: 'np', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' }, status: 'active' },
    { id: 'r-s3', owner: 'o', project_id: 'p', kind: 's3', branch_id: null, provider_ref: { bucket: 'firth-app-root', endpoint: 'e', region: 'auto', snapshotEnabled: true }, status: 'active' },
  ],
  branches: [{ id: 'b-main', owner: 'o', project_id: 'p', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }],
})

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

function flyAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter & { provisioned: string[]; destroyed: string[] } {
  const provisioned: string[] = []
  const destroyed: string[] = []
  return {
    provisioned, destroyed, kind: 'fly', branchModel: 'redeploy',
    async provision(name: string) { provisioned.push(name); return { kind: 'fly', providerRef: { flyApp: `a-${name}`, orgSlug: 'o' } } },
    async destroy(h: any) { destroyed.push((h.providerRef as any).flyApp) },
    async createBranch() { return null },
    async deleteBranch() {},
    async mintCredentials() { return {} },
    async readUsage() { return {} },
    ...over,
  } as any
}

test('branch create is DB-only — no compute provisioned until first deploy', async () => {
  const db = seeded()
  const fly = flyAdapter()
  const { branch } = await new BranchService(db as any, cfg, [neonAdapter(), fly]).createBranch('o', 'p', 'feature')
  expect(fly.provisioned).toEqual([])  // lazy: no Fly microVM at create
  const flyRow = db.tables.resources.find((r: any) => r.kind === 'fly' && r.branch_id === branch.id)
  expect(flyRow).toBeFalsy()
  // the Neon DB branch + creds still exist (the data environment)
  expect(db.tables.branches.find((b: any) => b.id === branch.id)?.neon_branch_ref).toBeTruthy()
})

test('a failing Neon createBranch marks the branch error', async () => {
  const db = seeded()
  const neon = neonAdapter({ async createBranch() { throw new Error('neon createBranch failed') } } as any)
  await expect(new BranchService(db as any, cfg, [neon, flyAdapter()]).createBranch('o', 'p', 'feature'))
    .rejects.toThrow('neon createBranch failed')
  const row = db.tables.branches.find((b: any) => b.name === 'feature')
  expect(row.status).toBe('error')
})

describe('BranchService.createBranch', () => {
  test('creates a Neon branch off the parent and stores a branch-scoped DATABASE_URL', async () => {
    const db = seeded(); const neon = neonAdapter()
    const out = await new BranchService(db as any, cfg, [neon, flyAdapter()]).createBranch('o', 'p', 'feat')
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
    await expect(new BranchService(db as any, cfg, [neon, flyAdapter()]).createBranch('o', 'p', 'feat')).rejects.toThrow(/mint failed/)
    expect((neon as any).deleted).toEqual(['br-new'])
    expect(db.tables.branches.find((b: any) => b.name === 'feat').status).toBe('error')
    expect(db.tables.secrets.length).toBe(0)
  })

  test('throws if the parent branch is missing', async () => {
    const db = seeded()
    await expect(new BranchService(db as any, cfg, [neonAdapter(), flyAdapter()]).createBranch('o', 'p', 'feat', 'nope'))
      .rejects.toThrow(/parent branch/i)
  })

  test('throws if the project has no neon resource', async () => {
    const db = fakeDb({ branches: [{ id: 'b-main', owner: 'o', project_id: 'p', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }] })
    await expect(new BranchService(db as any, cfg, [neonAdapter(), flyAdapter()]).createBranch('o', 'p', 'feat'))
      .rejects.toThrow(/neon resource/i)
  })

  test('refuses to fork off a non-active parent branch', async () => {
    const db = fakeDb({
      resources: [{ id: 'r1', owner: 'o', project_id: 'p', kind: 'neon', provider_ref: { neonProjectId: 'np', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' }, status: 'active' }],
      branches: [{ id: 'b-bad', owner: 'o', project_id: 'p', name: 'broken', parent_branch_id: null, is_default: false, neon_branch_ref: 'br-stale', status: 'error' }],
    })
    await expect(new BranchService(db as any, cfg, [neonAdapter(), flyAdapter()]).createBranch('o', 'p', 'feat', 'broken'))
      .rejects.toThrow(/not active/i)
  })
})

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

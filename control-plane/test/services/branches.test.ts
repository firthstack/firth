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

test('branch create provisions a Fly app and records a fly resource with the new branch id', async () => {
  const db = seeded()
  const fly = flyAdapter()
  const { branch } = await new BranchService(db as any, cfg, [neonAdapter(), fly]).createBranch('o', 'p', 'feature')
  expect(fly.provisioned).toEqual(['feature'])
  const flyRow = db.tables.resources.find((r: any) => r.kind === 'fly' && r.branch_id === branch.id)
  expect(flyRow).toBeTruthy()
  expect(flyRow.status).toBe('active')
  expect(flyRow.provider_ref).toEqual({ flyApp: 'a-feature', orgSlug: 'o' })
})

test('a failing Fly provision rolls back the Neon branch and marks the branch error', async () => {
  const db = seeded()
  const neon = neonAdapter()
  const fly = flyAdapter({ async provision() { throw new Error('fly provision failed') } } as any)
  await expect(new BranchService(db as any, cfg, [neon, fly]).createBranch('o', 'p', 'feature'))
    .rejects.toThrow('fly provision failed')
  expect(neon.deleted).toEqual(['br-new'])  // neon.createBranch returns 'br-new'
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

import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { ProvisioningService } from '../../src/services/provisioning.js'
import { loadKeks, decryptSecret } from '../../src/crypto/secrets.js'
import type { ProviderAdapter, ResourceHandle } from '../../src/adapters/types.js'

const { keks, current } = loadKeks({ FIRTH_KEK_CURRENT: 'V1', FIRTH_KEK_V1: randomBytes(32).toString('base64') })
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } } as any

// In-memory DataClient supporting insert/select/eq/is/update.
// eq(col, null) matches no rows; is(col, null) matches rows where col is null.
function fakeDb() {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [] }
  return {
    tables,
    from(t: string) {
      const filters: Array<{ kind: 'eq' | 'is'; col: string; val: any }> = []
      let mode: 'insert' | 'select' | 'update' = 'select'
      let payload: any
      const api: any = {
        insert(v: any) { mode = 'insert'; payload = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(payload); return api },
        update(v: any) { mode = 'update'; payload = v; return api },
        select() { return api },
        eq(c: string, val: any) { filters.push({ kind: 'eq', col: c, val }); return api },
        is(c: string, val: any) { filters.push({ kind: 'is', col: c, val }); return api },
        async then(res: any) {
          const matchRow = (row: any) => filters.every(({ kind, col, val }) => {
            if (kind === 'eq') {
              // eq(col, null) → never matches (PostgREST semantics)
              if (val === null) return false
              return row[col] === val
            } else {
              // is(col, null) → matches rows where col is null/undefined
              return row[col] == null
            }
          })
          if (mode === 'update') {
            for (const row of tables[t]) if (matchRow(row)) Object.assign(row, payload)
            return res({ data: [], error: null })
          }
          if (mode === 'insert') return res({ data: [payload], error: null })
          const rows = tables[t].filter(matchRow)
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

// Generic multi-adapter fake builder matching the spec sketch
function mk(kind: 'neon' | 's3' | 'fly', opts: { fail?: boolean } = {}): ProviderAdapter & { destroyed: string[] } {
  const destroyed: string[] = []
  const branchModel = kind === 'neon' ? 'native' : kind === 's3' ? 'shared' : 'redeploy'
  return {
    destroyed,
    kind,
    branchModel,
    async provision(name: string): Promise<ResourceHandle> {
      if (opts.fail) throw new Error(`${kind} provision failed`)
      return {
        kind: kind as any,
        providerRef: {
          neonProjectId: `${kind}-${name}`, defaultBranchId: 'br-main',
          dbName: 'd', roleName: 'r',
          bucket: `b-${name}`, flyApp: `a-${name}`,
          endpoint: 'e', region: 'auto', orgSlug: 'o',
        },
      }
    },
    async destroy() { destroyed.push(kind) },
    async createBranch() { return kind === 'neon' ? 'br-x' : null },
    async mintCredentials() {
      if (kind === 'neon') return { DATABASE_URL: 'postgresql://c' }
      if (kind === 's3') return { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' }
      return {}
    },
    async readUsage() { return {} },
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
    expect(db.tables.secrets.length).toBe(0) // nothing persisted when minting failed
  })

  test('a DB fault during rollback never masks the original provision error', async () => {
    // A db that works normally but throws when the rollback marks a resource status='error'.
    const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [] }
    const db = {
      from(t: string) {
        const filters: Array<[string, any]> = []
        let mode: 'insert' | 'select' | 'update' = 'select'
        let payload: any
        const api: any = {
          insert(v: any) { mode = 'insert'; payload = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(payload); return api },
          update(v: any) { mode = 'update'; payload = v; return api },
          select() { return api },
          eq(c: string, val: any) { filters.push([c, val]); return api },
          is() { return api },
          then(resolve: any, reject: any) {
            if (mode === 'update') {
              if (payload.status === 'error') { reject(new Error('db down during rollback')); return }
              for (const row of tables[t]) if (filters.every(([c, v]) => row[c] === v)) Object.assign(row, payload)
              resolve({ data: [], error: null }); return
            }
            if (mode === 'insert') { resolve({ data: [payload], error: null }); return }
            resolve({ data: tables[t].filter((r) => filters.every(([c, v]) => r[c] === v)), error: null })
          },
        }
        return api
      },
    }
    const neon = fakeNeon({ async mintCredentials() { throw new Error('mint failed') } })
    const svc = new ProvisioningService(db as any, cfg, [neon as any])
    // Must reject with the ORIGINAL error, not 'db down during rollback'.
    await expect(svc.provisionProject('owner-1', 'demo')).rejects.toThrow(/mint failed/)
    expect((neon as any).destroyed).toEqual(['np-demo']) // destroy still attempted
  })

  test('parallel happy path: [neon, s3, fly] → 3 resources active; DATABASE_URL branch-scoped; AWS_* project-scoped; no fly secret', async () => {
    const db = fakeDb()
    const neonA = mk('neon')
    const s3A = mk('s3')
    const flyA = mk('fly')
    const svc = new ProvisioningService(db as any, cfg, [neonA as any, s3A as any, flyA as any])
    const out = await svc.provisionProject('owner-1', 'multi')

    // All 3 resource rows active
    expect(out.resources.map(r => r.kind).sort()).toEqual(['fly', 'neon', 's3'])
    expect(out.resources.every(r => r.status === 'active')).toBe(true)
    for (const row of db.tables.resources) {
      expect(row.status).toBe('active')
    }

    // Neon DATABASE_URL is branch-scoped (branch_id = main branch id)
    const dbUrlSecret = db.tables.secrets.find((s: any) => s.name === 'DATABASE_URL')
    expect(dbUrlSecret).toBeDefined()
    expect(dbUrlSecret.branch_id).toBe(out.defaultBranch.id)

    // AWS_* secrets are project-scoped (branch_id = null)
    const awsKeySecret = db.tables.secrets.find((s: any) => s.name === 'AWS_ACCESS_KEY_ID')
    const awsSecretSecret = db.tables.secrets.find((s: any) => s.name === 'AWS_SECRET_ACCESS_KEY')
    expect(awsKeySecret).toBeDefined()
    expect(awsKeySecret.branch_id).toBeNull()
    expect(awsSecretSecret).toBeDefined()
    expect(awsSecretSecret.branch_id).toBeNull()

    // No secret stored for fly (mintCredentials returns {})
    const flySecrets = db.tables.secrets.filter((s: any) => s.owner === 'owner-1' && !['DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].includes(s.name))
    expect(flySecrets.length).toBe(0)
    // Total secrets: 1 (DATABASE_URL) + 2 (AWS_*) = 3
    expect(db.tables.secrets.length).toBe(3)

    // Neon branch_ref set on main branch
    expect(db.tables.branches[0].neon_branch_ref).toBe('br-main')
  })

  test('multi-rollback: when one adapter provision rejects, all successfully provisioned adapters get destroyed and original error propagates', async () => {
    const db = fakeDb()
    const neonA = mk('neon')
    const s3A = mk('s3', { fail: true })
    const flyA = mk('fly')
    const svc = new ProvisioningService(db as any, cfg, [neonA as any, s3A as any, flyA as any])

    await expect(svc.provisionProject('owner-1', 'multi')).rejects.toThrow(/s3 provision failed/)

    // Both neon and fly (which succeeded before s3 failed) must have been destroyed
    expect((neonA as any).destroyed).toContain('neon')
    expect((flyA as any).destroyed).toContain('fly')

    // s3 never completed provision so it gets no destroy call
    expect((s3A as any).destroyed).not.toContain('s3')
  })

  test('fly resource is tagged with the default branch id; neon/s3 are not', async () => {
    const db = fakeDb()
    const svc = new ProvisioningService(db as any, cfg, [mk('neon'), mk('s3'), mk('fly')])
    await svc.provisionProject('owner-1', 'proj')
    const rows = db.tables.resources
    const fly = rows.find((r: any) => r.kind === 'fly')
    const neon = rows.find((r: any) => r.kind === 'neon')
    const s3 = rows.find((r: any) => r.kind === 's3')
    const defaultBranch = db.tables.branches.find((b: any) => b.is_default)
    expect(fly.branch_id).toBe(defaultBranch.id)
    expect(neon.branch_id == null).toBe(true)
    expect(s3.branch_id == null).toBe(true)
  })
})

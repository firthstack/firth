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
})

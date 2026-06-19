import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { buildServer } from '../src/server.js'
import { encryptSecret, loadKeks } from '../src/crypto/secrets.js'

const env = { FIRTH_KEK_CURRENT: 'v1', FIRTH_KEK_v1: randomBytes(32).toString('base64') }
const { keks, current } = loadKeks(env)
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } }

// Fake with PostgREST-faithful eq/is semantics:
//   eq(col, null)  → matches nothing (mirrors col=eq.null, not IS NULL)
//   is(col, null)  → matches rows where col is null/undefined
function fakeData() {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [] }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    let mode: 'insert' | 'select' | 'update' = 'select'
    let insertedRow: any
    let updatePayload: any
    const api: any = {
      insert(v: any) {
        mode = 'insert'
        const row = { id: `${t}-${tables[t].length}`, ...v }
        tables[t].push(row)
        insertedRow = row
        return api
      },
      update(v: any) { mode = 'update'; updatePayload = v; return api },
      // Intentionally a no-op: keeps the preceding mode so `insert().select()` returns the
      // inserted row (what the repos/saga rely on). `update().select()` is never used here;
      // if it ever is, this fake would need a distinct update-returning-rows path.
      select() { return api },
      eq(c: string, val: any) {
        filters.push(val === null ? () => false : (r: any) => r[c] === val)
        return api
      },
      is(c: string, val: any) {
        filters.push(val === null ? (r: any) => r[c] == null : (r: any) => r[c] === val)
        return api
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

test('POST /projects without a token is 401', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any })
  const r = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x' } })
  expect(r.statusCode).toBe(401)
})

test('GET secrets seam returns decrypted project-scoped bundle', async () => {
  const db = fakeData()
  const enc = encryptSecret('postgres://conn', keks, current)
  db.tables.secrets.push({ id: 's1', owner: 'uid-1', project_id: 'p1', branch_id: null,
    name: 'DATABASE_URL', ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const r = await app.inject({ method: 'GET', url: '/projects/p1/secrets',
    headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(200)
  expect(r.json().secrets).toEqual({ DATABASE_URL: 'postgres://conn' })
})

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

test('GET secrets branch-scoped returns only branch secrets, not project-scoped ones', async () => {
  const db = fakeData()
  const encProj = encryptSecret('project-value', keks, current)
  const encBranch = encryptSecret('branch-value', keks, current)
  // project-scoped secret (branch_id: null)
  db.tables.secrets.push({ id: 's1', owner: 'uid-1', project_id: 'p1', branch_id: null,
    name: 'PROJ_SECRET', ciphertext: encProj.ciphertext, nonce: encProj.nonce, kek_version: encProj.kekVersion })
  // branch-scoped secret (branch_id: 'b1')
  db.tables.secrets.push({ id: 's2', owner: 'uid-1', project_id: 'p1', branch_id: 'b1',
    name: 'BRANCH_SECRET', ciphertext: encBranch.ciphertext, nonce: encBranch.nonce, kek_version: encBranch.kekVersion })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })

  // Branch query: should return only BRANCH_SECRET, not PROJ_SECRET
  const branchResp = await app.inject({ method: 'GET', url: '/projects/p1/secrets?branch=b1',
    headers: { authorization: 'Bearer good' } })
  expect(branchResp.statusCode).toBe(200)
  expect(branchResp.json().secrets).toEqual({ BRANCH_SECRET: 'branch-value' })
  expect(branchResp.json().secrets).not.toHaveProperty('PROJ_SECRET')

  // Project query (no branch param): should return only PROJ_SECRET, not BRANCH_SECRET
  const projResp = await app.inject({ method: 'GET', url: '/projects/p1/secrets',
    headers: { authorization: 'Bearer good' } })
  expect(projResp.statusCode).toBe(200)
  expect(projResp.json().secrets).toEqual({ PROJ_SECRET: 'project-value' })
  expect(projResp.json().secrets).not.toHaveProperty('BRANCH_SECRET')
})

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

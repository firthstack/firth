import { randomBytes } from 'node:crypto'
import { expect, it, test } from 'vitest'
import { buildServer } from '../src/server.js'
import { encryptSecret, loadKeks } from '../src/crypto/secrets.js'

const env = { FIRTH_KEK_CURRENT: 'v1', FIRTH_KEK_v1: randomBytes(32).toString('base64') }
const { keks, current } = loadKeks(env)
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } }

const fakeNeon = {
  kind: 'neon', branchModel: 'native',
  async provision(name: string) { return { kind: 'neon', providerRef: { neonProjectId: `np-${name}`, defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } } },
  async destroy() {}, async createBranch() { return 'br-x' },
  async mintCredentials() { return { DATABASE_URL: 'postgresql://conn' } }, async readUsage() { return {} },
}

// Fake with PostgREST-faithful eq/is semantics:
//   eq(col, null)  → matches nothing (mirrors col=eq.null, not IS NULL)
//   is(col, null)  → matches rows where col is null/undefined
function fakeData() {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], events: [], governance_rules: [], approvals: [] }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    let mode: 'insert' | 'select' | 'update' = 'select'
    let insertedRow: any
    let updatePayload: any
    const api: any = {
      insert(v: any) {
        mode = 'insert'
        const row = { id: `${t}-${tables[t].length}`, created_at: String(tables[t].length).padStart(10, '0'), ...v }
        tables[t].push(row)
        insertedRow = row
        return api
      },
      upsert(v: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        mode = 'insert'
        if (opts?.onConflict && !opts?.ignoreDuplicates) {           // merge-on-conflict (governance_rules)
          const cols = opts.onConflict.split(',')
          const ex = tables[t].find((r) => cols.every((c) => r[c] === (v as any)[c]))
          if (ex) { Object.assign(ex, v); insertedRow = ex; return api }
        }
        const dk = (v as any).dedup_key
        // model UNIQUE(owner, project_id, dedup_key): NULL keys never conflict
        const conflict = opts?.ignoreDuplicates && dk != null && tables[t].some(
          (r) => r.owner === (v as any).owner && r.project_id === (v as any).project_id && r.dedup_key === dk,
        )
        if (conflict) { insertedRow = undefined; return api }
        const row = { id: `${t}-${tables[t].length}`, created_at: String(tables[t].length).padStart(10, '0'), ...v }
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
        if (mode === 'insert') return res({ data: insertedRow ? [insertedRow] : [], error: null })
        return res({ data: tables[t].filter((r) => filters.every((fn) => fn(r))), error: null })
      },
    }
    return api
  } }
}

test('POST /projects provisions via the saga and lists the project', async () => {
  const db = fakeData() // ensure fakeData supports insert/select/eq/update (mirror provisioning.test.ts fake)
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
  const fly = { kind: 'fly', branchModel: 'redeploy',
    async provision(name: string) { return { kind: 'fly', providerRef: { flyApp: `a-${name}`, orgSlug: 'o' } } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {},
    async mintCredentials() { return {} }, async readUsage() { return {} } }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [neon as any, fly as any] })
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
  db.tables.resources.push({ id: 'r', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'app', orgSlug: 'org' }, status: 'active' })
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

test('POST /projects/:id/deploy forwards branch param to deploy the named branch\'s fly app', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  db.tables.branches.push({ id: 'b-feat', owner: 'uid-1', project_id: 'p1', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' })
  db.tables.resources.push({ id: 'r-main', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main', orgSlug: 'org' }, status: 'active' })
  db.tables.resources.push({ id: 'r-feat', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-feat', provider_ref: { flyApp: 'a-feat', orgSlug: 'org' }, status: 'active' })
  const captured: any = {}
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy(h: any, opts: any) { captured.handle = h; captured.opts = opts; return { machineId: 'm-feat', url: 'https://a-feat.fly.dev' } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy', headers: { authorization: 'Bearer good' }, payload: { image: 'nginx', branch: 'b-feat' } })
  expect(r.statusCode).toBe(200)
  expect(captured.handle.providerRef.flyApp).toBe('a-feat')
})

test('POST /projects/:id/deploy: `from` overrides the caller\'s linked branch', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  db.tables.branches.push({ id: 'b-feat', owner: 'uid-1', project_id: 'p1', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' })
  db.tables.resources.push({ id: 'r-main', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main', orgSlug: 'org' }, status: 'active' })
  db.tables.resources.push({ id: 'r-feat', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-feat', provider_ref: { flyApp: 'a-feat', orgSlug: 'org' }, status: 'active' })
  const captured: any = {}
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy(h: any, opts: any) { captured.handle = h; captured.opts = opts; return { machineId: 'm-feat', url: 'https://a-feat.fly.dev' } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  // linked branch is main, but `from: feature` (by name) must win
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy', headers: { authorization: 'Bearer good' }, payload: { image: 'nginx', from: 'feature', branch: 'b-main' } })
  expect(r.statusCode).toBe(200)
  expect(captured.handle.providerRef.flyApp).toBe('a-feat')
})

test('POST then GET /projects/:id/events records + lists newest-first', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const post = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' },
    payload: { events: [
      { source: 'resource', kind: 'project.create', payload: { name: 'demo' } },
      { source: 'agent', kind: 'agent.network', payload: { fingerprint: 'gh ••••e5f6' }, branch: null },
    ] } })
  expect(post.statusCode).toBe(201)
  expect(post.json().recorded).toBe(2)
  const list = await app.inject({ method: 'GET', url: '/projects/p1/events', headers: { authorization: 'Bearer good' } })
  expect(list.statusCode).toBe(200)
  expect(list.json().events.map((e: any) => e.kind)).toContain('agent.network')
})

test('POST /events rejects an invalid source', async () => {
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => fakeData() as any })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' },
    payload: { events: [{ source: 'hacker', kind: 'x' }] } })
  expect(r.statusCode).toBe(400)
})

test('POST /projects emits a resource event onto the timeline', async () => {
  const db = fakeData()
  const fakeNeon = {
    kind: 'neon', branchModel: 'native',
    async provision(name: string) { return { kind: 'neon', providerRef: { neonProjectId: `np-${name}`, defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } } },
    async destroy() {}, async createBranch() { return 'br-x' },
    async mintCredentials() { return { DATABASE_URL: 'postgresql://conn' } }, async readUsage() { return {} },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const created = await app.inject({ method: 'POST', url: '/projects', headers: { authorization: 'Bearer good' }, payload: { name: 'demo' } })
  const pid = created.json().project.id
  const list = await app.inject({ method: 'GET', url: `/projects/${pid}/events`, headers: { authorization: 'Bearer good' } })
  expect(list.json().events.map((e: any) => e.kind)).toContain('project.create')
})

test('POST /projects/:id/deploy emits a resource event onto the timeline', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br', status: 'active' })
  db.tables.resources.push({ id: 'r', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'app', orgSlug: 'org' }, status: 'active' })
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy(_h: any, opts: any) { return { machineId: 'm-9', url: `https://app.fly.dev` } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy', headers: { authorization: 'Bearer good' }, payload: { image: 'nginx', port: 80 } })
  expect(r.statusCode).toBe(200)
  const list = await app.inject({ method: 'GET', url: '/projects/p1/events', headers: { authorization: 'Bearer good' } })
  expect(list.json().events.map((e: any) => e.kind)).toContain('deploy')
})

test('GET /projects/:id returns { project, branches, resources }', async () => {
  const db = fakeData()
  const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'alpha', status: 'active' }).then((r: any) => r)).data[0]
  await db.from('branches').insert({ project_id: project.id, owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: { neonProjectId: 'np-1' }, status: 'active' })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.project.id).toBe(project.id)
  expect(body.branches.map((b: any) => b.name)).toEqual(['main'])
  expect(body.resources[0].kind).toBe('neon')
})

test('GET /projects/:id drops credential-shaped provider_ref keys (whitelist)', async () => {
  const db = fakeData()
  const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'alpha', status: 'active' }).then((r: any) => r)).data[0]
  await db.from('resources').insert({
    owner: 'uid-1', project_id: project.id, kind: 'neon',
    provider_ref: { neonProjectId: 'np', password: 'SECRET', connectionUri: 'postgres://u:p@h' }, status: 'active',
  })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
  const ref = res.json().resources[0].provider_ref
  expect(ref.neonProjectId).toBe('np')
  expect(ref.password).toBeUndefined()
  expect(ref.connectionUri).toBeUndefined()
})

test('GET /projects/:id surfaces fly provider_ref flyApp + orgSlug (not stripped)', async () => {
  const db = fakeData()
  const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'fly-proj', status: 'active' }).then((r: any) => r)).data[0]
  await db.from('resources').insert({
    owner: 'uid-1', project_id: project.id, kind: 'fly',
    provider_ref: { flyApp: 'firth-x-ab12', orgSlug: 'my-org' }, status: 'active',
  })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(200)
  const ref = res.json().resources[0].provider_ref
  expect(ref.flyApp).toBe('firth-x-ab12')
  expect(ref.orgSlug).toBe('my-org')
})

test('GET /projects/:id returns branch_id on fly resources (no credential key stripped)', async () => {
  const db = fakeData()
  const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'bp', status: 'active' }).then((r: any) => r)).data[0]
  await db.from('resources').insert({
    owner: 'uid-1', project_id: project.id, kind: 'fly', branch_id: 'b-main',
    provider_ref: { flyApp: 'firth-bp-ab12', orgSlug: 'my-org', credentialKey: 'SECRET' }, status: 'active',
  })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(200)
  const flyRes = res.json().resources.find((r: any) => r.kind === 'fly')
  expect(flyRes.branch_id).toBe('b-main')
  // credential key not in whitelist must still be dropped
  expect(flyRes.provider_ref.credentialKey).toBeUndefined()
  expect(flyRes.provider_ref.flyApp).toBe('firth-bp-ab12')
})
test('GET /projects/:id omits destroyed resources (deleted-branch compute tombstones)', async () => {
  const db = fakeData()
  const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'gp', status: 'active' }).then((r: any) => r)).data[0]
  await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main', orgSlug: 'org' }, status: 'active' })
  await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'fly', branch_id: 'b-old', provider_ref: { flyApp: 'a-old', orgSlug: 'org' }, status: 'destroyed' })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(200)
  const fly = res.json().resources.filter((r: any) => r.kind === 'fly')
  expect(fly).toHaveLength(1)
  expect(fly[0].branch_id).toBe('b-main')
})

test('GET /projects/:id for an unknown project → 404', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'GET', url: '/projects/nope', headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(404)
  expect(res.json().error).toBe('project not found')
})

test('DELETE /projects/:id → 200 with teardown summary', async () => {
  const db = fakeData()
  const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
  await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: {}, status: 'active' })
  // project.delete defaults to 'approve' — seed a granted approval so the gate passes and teardown runs
  db.tables.approvals.push({ id: 'gr-200', owner: 'uid-1', project_id: project.id, action: 'project.delete', status: 'granted', requested_at: 'now', decided_at: null })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'DELETE', url: `/projects/${project.id}`, headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(200)
  expect(res.json().teardown.destroyed).toEqual(['neon'])
  expect(db.tables.projects.find((r: any) => r.id === project.id).archived_at).toBeTruthy()
})

test('DELETE default branch → 409', async () => {
  const db = fakeData()
  const main = (await db.from('branches').insert({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }).then((r: any) => r)).data[0]
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'DELETE', url: `/projects/p1/branches/${main.id}`, headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toBe('cannot delete the default branch')
})

test('DELETE a missing project → 404', async () => {
  const db = fakeData()
  // project.delete defaults to 'approve' — seed a granted approval so the gate passes and the real 404 surfaces
  db.tables.approvals.push({ id: 'gr-404', owner: 'uid-1', project_id: 'nope', action: 'project.delete', status: 'granted', requested_at: 'now', decided_at: null })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'DELETE', url: '/projects/nope', headers: { authorization: 'Bearer good' } })
  expect(res.statusCode).toBe(404)
})

it('sends an Access-Control-Allow-Origin header for the Vite dev origin', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fakeNeon as any] })
  const res = await app.inject({ method: 'GET', url: '/projects', headers: { authorization: 'Bearer good', origin: 'http://localhost:5173' } })
  expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
})

// ---- Auth proxy route tests ----

const fakeAuthProxy = {
  async login(email: string, _password: string) {
    if (email === 'fail@x.co') throw new Error('email not verified')
    return { token: 'tok-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } }
  },
  async refresh(refreshToken: string) {
    if (refreshToken !== 'good-refresh') throw new Error('invalid')
    return { token: 'tok-2', refreshToken: 'ref-2' }
  },
  async signUp(_email: string, _password: string) {
    return { needsVerification: true, token: null, user: null }
  },
  async resendVerification(_email: string) {},
  async me(token: string) {
    if (token !== 'good') return null
    return { id: 'u1', email: 'a@b.co' }
  },
}

test('POST /auth/login returns token + user on success', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.co', password: 'pw' } })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ token: 'tok-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } })
})

test('POST /auth/login missing password → 400', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.co' } })
  expect(r.statusCode).toBe(400)
})

test('POST /auth/login bad creds → 401 with error message', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'fail@x.co', password: 'pw' } })
  expect(r.statusCode).toBe(401)
  expect(r.json()).toEqual({ error: 'email not verified' })
})

test('POST /auth/signup returns needsVerification response', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'new@b.co', password: 'pw' } })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ needsVerification: true, token: null, user: null })
})

test('POST /auth/resend-verification with email → 200 { ok: true }', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/resend-verification', payload: { email: 'a@b.co' } })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ ok: true })
})

test('POST /auth/resend-verification missing email → 400', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/resend-verification', payload: {} })
  expect(r.statusCode).toBe(400)
})

test('GET /auth/me with valid Bearer token → 200 { user }', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ user: { id: 'u1', email: 'a@b.co' } })
})

test('GET /auth/me with no Authorization header → 401', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'GET', url: '/auth/me' })
  expect(r.statusCode).toBe(401)
  expect(r.json()).toEqual({ error: 'unauthorized' })
})

test('POST /events dedups by dedup_key: second identical key is skipped', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const ev = { source: 'agent', kind: 'agent.network', payload: { a: 1 }, dedup_key: 'abc123' }
  const r1 = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' }, payload: { events: [ev] } })
  expect(r1.statusCode).toBe(201)
  expect(r1.json()).toEqual({ recorded: 1, skipped: 0 })
  const r2 = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' }, payload: { events: [ev] } })
  expect(r2.json()).toEqual({ recorded: 0, skipped: 1 })
  expect(db.tables.events).toHaveLength(1)
})

test('POST /events without dedup_key always inserts (resource/legacy events)', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const payload = { events: [{ source: 'resource', kind: 'deploy', payload: {} }, { source: 'resource', kind: 'deploy', payload: {} }] }
  const r = await app.inject({ method: 'POST', url: '/projects/p1/events', headers: { authorization: 'Bearer good' }, payload })
  expect(r.json()).toEqual({ recorded: 2, skipped: 0 })
  expect(db.tables.events).toHaveLength(2)
})

test('POST /projects/:id/deploy-token mints an app-scoped token for the branch fly app', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  db.tables.resources.push({ id: 'r-main', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main', orgSlug: 'org' }, status: 'active' })
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy() { return { machineId: 'm', url: 'u' } },
    async mintDeployToken(h: any) { return { token: `FlyV1-for-${h.providerRef.flyApp}`, expirySeconds: 1200 } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy-token', headers: { authorization: 'Bearer good' }, payload: {} })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ token: 'FlyV1-for-a-main', expirySeconds: 1200, flyApp: 'a-main' })
})

test('POST /projects/:id/deploy-token 404 when the branch has no fly resource', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy() { return { machineId: 'm', url: 'u' } },
    async mintDeployToken() { return { token: 'x', expirySeconds: 1200 } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy-token', headers: { authorization: 'Bearer good' }, payload: {} })
  expect(r.statusCode).toBe(404)
  expect(r.json().error).toMatch(/fly resource/)
})

test('POST /projects/:id/deploy-token requires auth', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => db as any })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy-token', payload: {} })
  expect(r.statusCode).toBe(401)
})

test('POST /auth/login includes the refresh token', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.co', password: 'pw' } })
  expect(r.json()).toEqual({ token: 'tok-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } })
})

test('POST /auth/refresh rotates the pair (no bearer required)', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'good-refresh' } })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ token: 'tok-2', refreshToken: 'ref-2' })
})

test('POST /auth/refresh 400 when refreshToken missing', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} })
  expect(r.statusCode).toBe(400)
})

test('POST /auth/refresh 401 with a static message on an invalid token', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'nope' } })
  expect(r.statusCode).toBe(401)
  expect(r.json()).toEqual({ error: 'invalid refresh token' })
})

// ---- Governance gate tests ----

test('DELETE /projects/:id is gated: default approve → 202 pending, project not torn down', async () => {
  const db = fakeData()
  await db.from('projects').insert({ owner: 'uid-1', name: 'gp', status: 'active' })
  let destroyed = false
  const fly = { kind: 'fly', branchModel: 'redeploy', async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() { destroyed = true }, async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} } }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'DELETE', url: '/projects/projects-0', headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(202)
  expect(r.json().status).toBe('approval_required')
  expect(typeof r.json().approvalId).toBe('string')
  expect(db.tables.approvals.filter((a: any) => a.status === 'pending')).toHaveLength(1)
  expect(db.tables.events.map((e: any) => e.kind)).toContain('govern.pending')
  expect(destroyed).toBe(false)
})

test('DELETE /projects/:id proceeds after the approval is granted (grant consumed)', async () => {
  const db = fakeData()
  await db.from('projects').insert({ owner: 'uid-1', name: 'gp', status: 'active' })
  // Push a granted approval directly (Task 4 approve route not yet implemented)
  db.tables.approvals.push({ id: 'a1', owner: 'uid-1', project_id: 'projects-0', action: 'project.delete', status: 'granted', requested_at: 'now', decided_at: null })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [] })
  const r2 = await app.inject({ method: 'DELETE', url: '/projects/projects-0', headers: { authorization: 'Bearer good' } })
  expect(r2.statusCode).toBe(200)
  expect(db.tables.events.map((e: any) => e.kind)).toContain('govern.approved')
  expect(db.tables.approvals.find((a: any) => a.id === 'a1')?.status).toBe('consumed')
})

test('DELETE /projects/:id with policy=deny → 403, not torn down', async () => {
  const db = fakeData()
  await db.from('projects').insert({ owner: 'uid-1', name: 'gp', status: 'active' })
  db.tables.governance_rules.push({ id: 'gr1', owner: 'uid-1', project_id: 'projects-0', action: 'project.delete', decision: 'deny' })
  let destroyed = false
  const fly = { kind: 'fly', branchModel: 'redeploy', async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() { destroyed = true }, async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} } }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'DELETE', url: '/projects/projects-0', headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(403)
  expect(destroyed).toBe(false)
})

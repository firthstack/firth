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
  const tables: Record<string, any[]> = { projects: [], branches: [], secrets: [] }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    const api: any = {
      insert(v: any) { const row = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(row); api._row = row; return api },
      select() { api._sel = true; return api },
      eq(c: string, val: any) {
        filters.push(val === null ? () => false : (r: any) => r[c] === val)
        return api
      },
      is(c: string, val: any) {
        filters.push(val === null ? (r: any) => r[c] == null : (r: any) => r[c] === val)
        return api
      },
      async then(res: any) {
        if (api._sel && !api._row) return res({ data: tables[t].filter((r) => filters.every((fn) => fn(r))), error: null })
        return res({ data: [api._row], error: null })
      },
    }
    return api
  } }
}

test('POST /projects then GET /projects round-trips for the owner', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const created = await app.inject({ method: 'POST', url: '/projects',
    headers: { authorization: 'Bearer good' }, payload: { name: 'demo' } })
  expect(created.statusCode).toBe(201)
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

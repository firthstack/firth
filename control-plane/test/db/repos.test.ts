import { describe, expect, it, test } from 'vitest'
import { ProjectsRepo, SecretsRepo, ResourcesRepo, BranchesRepo, EventsRepo } from '../../src/db/repos.js'

// PostgREST-faithful in-memory DataClient.
// eq/is semantics mirror real PostgREST:
//   eq(col, null)  → matches nothing (PostgREST emits col=eq.null, not IS NULL)
//   is(col, null)  → matches rows where col is null/undefined
// Supports insert / update / select modes including insert().select() returning the inserted row.
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], events: [], ...seed }
  return {
    tables,
    from(table: string) {
      let rows = tables[table]
      const filters: Array<(r: any) => boolean> = []
      let mode: 'insert' | 'update' | 'select' = 'select'
      let insertedRow: any
      let updatePayload: any
      const api: any = {
        insert(values: any) {
          mode = 'insert'
          const arr = Array.isArray(values) ? values : [values]
          const row = { id: `${table}-${tables[table].length}`, created_at: String(tables[table].length).padStart(10, '0'), ...arr[0] }
          tables[table].push(row)
          insertedRow = row
          return api
        },
        update(v: any) { mode = 'update'; updatePayload = v; return api },
        select() { return api },
        eq(col: string, val: any) {
          // PostgREST eq(col, null) emits col=eq.null — matches nothing (not IS NULL)
          filters.push(val === null ? () => false : (r: any) => r[col] === val)
          return api
        },
        is(col: string, val: any) {
          // PostgREST is(col, null) → SQL IS NULL
          filters.push(val === null ? (r: any) => r[col] == null : (r: any) => r[col] === val)
          return api
        },
        async then(res: any) {
          if (mode === 'update') {
            for (const row of tables[table]) if (filters.every((fn) => fn(row))) Object.assign(row, updatePayload)
            return res({ data: [], error: null })
          }
          if (mode === 'insert') return res({ data: [insertedRow], error: null })
          rows = tables[table].filter((r) => filters.every((fn) => fn(r)))
          return res({ data: rows, error: null })
        },
      }
      return api
    },
  }
}

// ─── Original tests (restored from 2579a56) ──────────────────────────────────

test('ProjectsRepo.create inserts with owner and default status', async () => {
  const db = fakeDb()
  const repo = new ProjectsRepo(db as any)
  const p = await repo.create('owner-1', 'my-proj')
  expect(p.owner).toBe('owner-1')
  expect(p.name).toBe('my-proj')
  expect(p.status).toBe('active')
  expect(db.tables.projects.length).toBe(1)
})

test('SecretsRepo.listForScope filters by project and null branch', async () => {
  const db = fakeDb({ secrets: [
    { id: 's1', owner: 'o', project_id: 'p', branch_id: null, name: 'S3_KEY', ciphertext: 'c', nonce: 'n', kek_version: 'v1' },
    { id: 's2', owner: 'o', project_id: 'p', branch_id: 'b1', name: 'DB_URL', ciphertext: 'c', nonce: 'n', kek_version: 'v1' },
  ] })
  const repo = new SecretsRepo(db as any)
  const rows = await repo.listForScope('o', 'p', null)
  expect(rows.map((r) => r.name)).toEqual(['S3_KEY'])
})

test('ResourcesRepo.findByKind returns the matching resource or null', async () => {
  const db = fakeDb({ resources: [
    { id: 'r1', owner: 'o', project_id: 'p', kind: 'neon', provider_ref: { neonProjectId: 'np' }, status: 'active' },
    { id: 'r2', owner: 'o', project_id: 'p', kind: 's3', provider_ref: {}, status: 'active' },
  ] })
  const repo = new ResourcesRepo(db as any)
  expect((await repo.findByKind('o', 'p', 'neon'))?.id).toBe('r1')
  expect(await repo.findByKind('o', 'p', 'fly')).toBeNull()
})

test('BranchesRepo.findByName + create + listByProject', async () => {
  const db = fakeDb({ branches: [
    { id: 'b-main', owner: 'o', project_id: 'p', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' },
  ] })
  const repo = new BranchesRepo(db as any)
  expect((await repo.findByName('o', 'p', 'main'))?.neon_branch_ref).toBe('br-main')
  const created = await repo.create({ project_id: 'p', owner: 'o', name: 'feat', parent_branch_id: 'b-main', is_default: false, status: 'creating' })
  expect(created.name).toBe('feat')
  expect((await repo.listByProject('o', 'p')).map((b) => b.name).sort()).toEqual(['feat', 'main'])
})

test('EventsRepo.record inserts; listByProject returns newest-first, limited, branch-filtered', async () => {
  const db = fakeDb()
  const repo = new EventsRepo(db as any)
  await repo.record({ project_id: 'p', owner: 'o', branch_id: null, source: 'resource', kind: 'project.create', payload: {} })
  await repo.record({ project_id: 'p', owner: 'o', branch_id: 'b1', source: 'resource', kind: 'deploy', payload: { url: 'x' } })
  const all = await repo.listByProject('o', 'p')
  expect(all.map((e) => e.kind)).toEqual(['deploy', 'project.create']) // newest-first (insertion order → reverse)
  const lim = await repo.listByProject('o', 'p', { limit: 1 })
  expect(lim).toHaveLength(1)
})

// ─── New archived_at tests (from e1dd283) ────────────────────────────────────

describe('ProjectsRepo archive/find/list', () => {
  it('listByOwner excludes an archived project', async () => {
    const db = fakeDb() as any
    const repo = new ProjectsRepo(db)
    const a = await repo.create('uid-1', 'alpha')
    const b = await repo.create('uid-1', 'beta')
    await repo.archive('uid-1', a.id)
    const list = await repo.listByOwner('uid-1')
    expect(list.map((p) => p.id)).toEqual([b.id])
  })

  it('findById returns null for an archived project', async () => {
    const db = fakeDb() as any
    const repo = new ProjectsRepo(db)
    const a = await repo.create('uid-1', 'alpha')
    expect((await repo.findById('uid-1', a.id))?.id).toBe(a.id)
    await repo.archive('uid-1', a.id)
    expect(await repo.findById('uid-1', a.id)).toBeNull()
  })

  it('archive sets status=deleted and archived_at', async () => {
    const db = fakeDb() as any
    const repo = new ProjectsRepo(db)
    const a = await repo.create('uid-1', 'alpha')
    await repo.archive('uid-1', a.id)
    const row = db.tables.projects.find((r: any) => r.id === a.id)
    expect(row.status).toBe('deleted')
    expect(row.archived_at).toBeTruthy()
  })
})

describe('BranchesRepo archive/find/list', () => {
  it('listByProject excludes an archived branch + findById returns null after archive', async () => {
    const db = fakeDb() as any
    const repo = new BranchesRepo(db)
    const main = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, status: 'active' })
    const dev = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'dev', parent_branch_id: main.id, is_default: false, status: 'active' })
    await repo.archive('uid-1', dev.id)
    const list = await repo.listByProject('uid-1', 'p1')
    expect(list.map((b) => b.id)).toEqual([main.id])
    expect(await repo.findById('uid-1', dev.id)).toBeNull()
  })

  it('findByName ignores an archived branch and resolves the live one when a name is reused', async () => {
    const db = fakeDb() as any
    const repo = new BranchesRepo(db)
    const main = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, status: 'active' })
    const dev1 = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'dev', parent_branch_id: main.id, is_default: false, status: 'active' })
    await repo.archive('uid-1', dev1.id)
    // only an archived 'dev' exists → not found (so it can't be resolved as a parent)
    expect(await repo.findByName('uid-1', 'p1', 'dev')).toBeNull()
    // reuse the freed name with a new live branch → findByName resolves the LIVE row, not the tombstone
    const dev2 = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'dev', parent_branch_id: main.id, is_default: false, status: 'active' })
    const found = await repo.findByName('uid-1', 'p1', 'dev')
    expect(found?.id).toBe(dev2.id)
    expect(found?.status).toBe('active')
  })
})

describe('ResourcesRepo listByProject/markStatus', () => {
  it('listByProject returns rows and markStatus updates status', async () => {
    const db = fakeDb() as any
    // seed two resource rows directly via the fake
    await db.from('resources').insert({ owner: 'uid-1', project_id: 'p1', kind: 'neon', provider_ref: {}, status: 'active' })
    await db.from('resources').insert({ owner: 'uid-1', project_id: 'p1', kind: 'fly', provider_ref: {}, status: 'active' })
    const repo = new ResourcesRepo(db)
    const rows = await repo.listByProject('uid-1', 'p1')
    expect(rows.map((r) => r.kind).sort()).toEqual(['fly', 'neon'])
    await repo.markStatus('uid-1', rows[0].id, 'destroyed')
    const updated = db.tables.resources.find((r: any) => r.id === rows[0].id)
    expect(updated.status).toBe('destroyed')
  })
})

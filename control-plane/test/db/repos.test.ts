import { expect, test } from 'vitest'
import { ProjectsRepo, SecretsRepo, ResourcesRepo, BranchesRepo, EventsRepo } from '../../src/db/repos.js'

// Minimal fake implementing the DataClient query-builder surface we use.
// eq/is semantics mirror real PostgREST:
//   eq(col, null)  → matches nothing (PostgREST emits col=eq.null, not IS NULL)
//   is(col, null)  → matches rows where col is null/undefined
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], events: [], ...seed }
  return {
    tables,
    from(table: string) {
      let rows = tables[table]
      const filters: Array<(r: any) => boolean> = []
      const api: any = {
        insert(values: any) { const arr = Array.isArray(values) ? values : [values]
          const insertedIds: string[] = []
          for (const v of arr) {
            const id = `id-${tables[table].length}`
            const created_at = String(tables[table].length).padStart(10, '0')
            tables[table].push({ id, created_at, ...v })
            insertedIds.push(id)
          }
          api._inserted = arr; api._insertedIds = insertedIds; return api },
        select() { api._mode = 'select'; return api },
        eq(col: string, val: any) {
          // PostgREST eq(col, null) emits col=eq.null — matches nothing (not IS NULL)
          filters.push(val === null ? () => false : (r) => r[col] === val)
          return api
        },
        is(col: string, val: any) {
          // PostgREST is(col, null) → SQL IS NULL
          filters.push(val === null ? (r) => r[col] == null : (r) => r[col] === val)
          return api
        },
        async then(res: any) {
          if (api._mode === 'select') {
            // If this is an insert().select(), return only the inserted rows
            if (api._insertedIds) {
              rows = tables[table].filter((r) => api._insertedIds.includes(r.id))
            } else {
              rows = tables[table].filter((r) => filters.every((fn) => fn(r)))
            }
            return res({ data: rows, error: null })
          }
          return res({ data: api._inserted, error: null })
        },
      }
      return api
    },
  }
}

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

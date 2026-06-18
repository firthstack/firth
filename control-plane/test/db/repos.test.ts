import { expect, test } from 'vitest'
import { ProjectsRepo, SecretsRepo } from '../../src/db/repos.js'

// Minimal fake implementing the DataClient query-builder surface we use.
// eq/is semantics mirror real PostgREST:
//   eq(col, null)  → matches nothing (PostgREST emits col=eq.null, not IS NULL)
//   is(col, null)  → matches rows where col is null/undefined
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { projects: [], branches: [], secrets: [], ...seed }
  return {
    tables,
    from(table: string) {
      let rows = tables[table]
      const filters: Array<(r: any) => boolean> = []
      const api: any = {
        insert(values: any) { const arr = Array.isArray(values) ? values : [values]
          for (const v of arr) tables[table].push({ id: `id-${tables[table].length}`, ...v })
          api._inserted = arr; return api },
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
            rows = tables[table].filter((r) => filters.every((fn) => fn(r)))
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

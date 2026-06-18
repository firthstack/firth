import { expect, test } from 'vitest'
import { ProjectService } from '../../src/services/projects.js'

function fakeDb() {
  const tables: Record<string, any[]> = { projects: [], branches: [] }
  return {
    tables,
    from(table: string) {
      const api: any = {
        insert(v: any) { const row = { id: `${table}-${tables[table].length}`, ...v }
          tables[table].push(row); api._row = row; return api },
        select() { return api },
        eq() { return api },
        async then(res: any) { return res({ data: [api._row], error: null }) },
      }
      return api
    },
  }
}

test('createProject creates project then a default main branch', async () => {
  const db = fakeDb()
  const svc = new ProjectService(db as any)
  const out = await svc.createProject('owner-1', 'demo')
  expect(out.project.name).toBe('demo')
  expect(out.defaultBranch.name).toBe('main')
  expect(out.defaultBranch.id).toBeTruthy()
  expect(db.tables.branches[0].is_default).toBe(true)
  expect(db.tables.branches[0].owner).toBe('owner-1')
  expect(db.tables.branches[0].project_id).toBe(out.project.id)
})

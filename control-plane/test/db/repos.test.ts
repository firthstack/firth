import { describe, it, expect } from 'vitest'
import { ProjectsRepo, BranchesRepo, ResourcesRepo } from '../../src/db/repos.js'

// PostgREST-faithful in-memory DataClient (mirrors test/server.test.ts).
function fakeData() {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], events: [] }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    let mode: 'insert' | 'select' | 'update' = 'select'
    let insertedRow: any; let updatePayload: any
    const api: any = {
      insert(v: any) {
        mode = 'insert'
        const row = { id: `${t}-${tables[t].length}`, created_at: String(tables[t].length).padStart(10, '0'), ...v }
        tables[t].push(row); insertedRow = row; return api
      },
      update(v: any) { mode = 'update'; updatePayload = v; return api },
      select() { return api },
      eq(c: string, val: any) {
        filters.push(val === null ? () => false : (r: any) => r[c] === val); return api
      },
      is(c: string, val: any) {
        filters.push(val === null ? (r: any) => r[c] == null : (r: any) => r[c] === val); return api
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

describe('ProjectsRepo archive/find/list', () => {
  it('listByOwner excludes an archived project', async () => {
    const db = fakeData() as any
    const repo = new ProjectsRepo(db)
    const a = await repo.create('uid-1', 'alpha')
    const b = await repo.create('uid-1', 'beta')
    await repo.archive('uid-1', a.id)
    const list = await repo.listByOwner('uid-1')
    expect(list.map((p) => p.id)).toEqual([b.id])
  })

  it('findById returns null for an archived project', async () => {
    const db = fakeData() as any
    const repo = new ProjectsRepo(db)
    const a = await repo.create('uid-1', 'alpha')
    expect((await repo.findById('uid-1', a.id))?.id).toBe(a.id)
    await repo.archive('uid-1', a.id)
    expect(await repo.findById('uid-1', a.id)).toBeNull()
  })

  it('archive sets status=deleted and archived_at', async () => {
    const db = fakeData() as any
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
    const db = fakeData() as any
    const repo = new BranchesRepo(db)
    const main = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, status: 'active' })
    const dev = await repo.create({ project_id: 'p1', owner: 'uid-1', name: 'dev', parent_branch_id: main.id, is_default: false, status: 'active' })
    await repo.archive('uid-1', dev.id)
    const list = await repo.listByProject('uid-1', 'p1')
    expect(list.map((b) => b.id)).toEqual([main.id])
    expect(await repo.findById('uid-1', dev.id)).toBeNull()
  })
})

describe('ResourcesRepo listByProject/markStatus', () => {
  it('listByProject returns rows and markStatus updates status', async () => {
    const db = fakeData() as any
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

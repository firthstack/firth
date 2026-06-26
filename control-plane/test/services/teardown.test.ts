import { describe, it, test, expect } from 'vitest'
import { TeardownService } from '../../src/services/teardown.js'
import { NotFoundError, ConflictError } from '../../src/auth.js'
import type { ProviderAdapter } from '../../src/adapters/types.js'

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
      eq(c: string, val: any) { filters.push(val === null ? () => false : (r: any) => r[c] === val); return api },
      is(c: string, val: any) { filters.push(val === null ? (r: any) => r[c] == null : (r: any) => r[c] === val); return api },
      async then(res: any) {
        if (mode === 'update') { for (const row of tables[t]) if (filters.every((fn) => fn(row))) Object.assign(row, updatePayload); return res({ data: [], error: null }) }
        if (mode === 'insert') return res({ data: [insertedRow], error: null })
        return res({ data: tables[t].filter((r) => filters.every((fn) => fn(r))), error: null })
      },
    }
    return api
  } }
}

const cfg = {} as any

function okNeon(spy: { destroyed: number; deletedBranch: string | null }) {
  return {
    kind: 'neon', branchModel: 'native',
    async provision() { return { kind: 'neon', providerRef: {} } },
    async destroy() { spy.destroyed++ },
    async createBranch() { return 'br-x' },
    async deleteBranch(_h: any, ref: string) { spy.deletedBranch = ref },
    async mintCredentials() { return {} }, async readUsage() { return {} },
  }
}

function neonAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    kind: 'neon', branchModel: 'native',
    async provision() { return { kind: 'neon', providerRef: {} } },
    async destroy() {},
    async createBranch() { return 'br-x' },
    async deleteBranch() {},
    async mintCredentials() { return {} }, async readUsage() { return {} },
    ...overrides,
  } as any
}

function flySpy(destroyed: string[]): ProviderAdapter {
  return {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } },
    async destroy(h: any) { destroyed.push((h.providerRef as any).flyApp) },
    async createBranch() { return null }, async deleteBranch() {},
    async mintCredentials() { return {} }, async readUsage() { return {} },
  } as any
}

describe('TeardownService.deleteProject', () => {
  it('destroys each resource, archives the project, summarizes destroyed kinds', async () => {
    const db = fakeData() as any
    const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
    await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: {}, status: 'active' })
    const spy = { destroyed: 0, deletedBranch: null as string | null }
    const out = await new TeardownService(db, cfg, [okNeon(spy) as any]).deleteProject('uid-1', project.id)
    expect(spy.destroyed).toBe(1)
    expect(out.teardown.destroyed).toEqual(['neon'])
    expect(out.teardown.failed).toEqual([])
    const row = db.tables.projects.find((r: any) => r.id === project.id)
    expect(row.status).toBe('deleted')
    expect(row.archived_at).toBeTruthy()
    const resource = db.tables.resources[0]
    expect(resource.status).toBe('destroyed')
  })

  it('records a failed destroy without throwing; project still archived; resource destroy_failed', async () => {
    const db = fakeData() as any
    const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
    await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 'neon', provider_ref: {}, status: 'active' })
    const boom = { kind: 'neon', branchModel: 'native', async provision() { return { kind: 'neon', providerRef: {} } }, async destroy() { throw new Error('boom') }, async createBranch() { return 'x' }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} } }
    const out = await new TeardownService(db, cfg, [boom as any]).deleteProject('uid-1', project.id)
    expect(out.teardown.destroyed).toEqual([])
    expect(out.teardown.failed).toEqual([{ kind: 'neon', message: 'boom' }])
    expect(db.tables.projects.find((r: any) => r.id === project.id).archived_at).toBeTruthy()
    expect(db.tables.resources[0].status).toBe('destroy_failed')
  })

  it('records "no adapter configured" when no adapter matches the kind', async () => {
    const db = fakeData() as any
    const project = (await db.from('projects').insert({ owner: 'uid-1', name: 'a', status: 'active' }).then((r: any) => r)).data[0]
    await db.from('resources').insert({ owner: 'uid-1', project_id: project.id, kind: 's3', provider_ref: {}, status: 'active' })
    const out = await new TeardownService(db, cfg, []).deleteProject('uid-1', project.id)
    expect(out.teardown.failed).toEqual([{ kind: 's3', message: 'no adapter configured' }])
    expect(db.tables.resources[0].status).toBe('destroy_failed')
  })

  it('throws NotFoundError for a missing project', async () => {
    const db = fakeData() as any
    await expect(new TeardownService(db, cfg, []).deleteProject('uid-1', 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('TeardownService.deleteBranch', () => {
  it('rejects deleting the default branch with ConflictError', async () => {
    const db = fakeData() as any
    const main = (await db.from('branches').insert({ project_id: 'p1', owner: 'uid-1', name: 'main', parent_branch_id: null, is_default: true, neon_branch_ref: 'br-main', status: 'active' }).then((r: any) => r)).data[0]
    await expect(new TeardownService(db, cfg, []).deleteBranch('uid-1', 'p1', main.id)).rejects.toBeInstanceOf(ConflictError)
  })

  it('archives a non-default branch and calls neon.deleteBranch with its ref', async () => {
    const db = fakeData() as any
    await db.from('resources').insert({ owner: 'uid-1', project_id: 'p1', kind: 'neon', provider_ref: { neonProjectId: 'np' }, status: 'active' })
    const dev = (await db.from('branches').insert({ project_id: 'p1', owner: 'uid-1', name: 'dev', parent_branch_id: 'b0', is_default: false, neon_branch_ref: 'br-dev', status: 'active' }).then((r: any) => r)).data[0]
    const spy = { destroyed: 0, deletedBranch: null as string | null }
    const out = await new TeardownService(db, cfg, [okNeon(spy) as any]).deleteBranch('uid-1', 'p1', dev.id)
    expect(spy.deletedBranch).toBe('br-dev')
    expect(out.teardown.destroyed).toEqual(['neon-branch'])
    expect(db.tables.branches.find((r: any) => r.id === dev.id).archived_at).toBeTruthy()
  })

  it('throws NotFoundError when the branch is missing or belongs to another project', async () => {
    const db = fakeData() as any
    const dev = (await db.from('branches').insert({ project_id: 'other', owner: 'uid-1', name: 'dev', parent_branch_id: 'b0', is_default: false, neon_branch_ref: 'br-dev', status: 'active' }).then((r: any) => r)).data[0]
    await expect(new TeardownService(db, cfg, []).deleteBranch('uid-1', 'p1', dev.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

test('deleteBranch destroys the branch fly app + neon branch and marks the fly resource destroyed', async () => {
  const flyDestroyed: string[] = []; const neonDeleted: string[] = []
  const db = fakeData()
  db.tables.projects.push({ id: 'p', owner: 'o', name: 'proj', status: 'active' })
  db.tables.branches.push({ id: 'b-feat', owner: 'o', project_id: 'p', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' })
  db.tables.resources.push({ id: 'r-neon', owner: 'o', project_id: 'p', kind: 'neon', branch_id: null, provider_ref: { neonProjectId: 'np' }, status: 'active' })
  db.tables.resources.push({ id: 'r-fly', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-feat', provider_ref: { flyApp: 'a-feat' }, status: 'active' })
  const neon = neonAdapter({ async deleteBranch(_h: any, ref: string) { neonDeleted.push(ref) } } as any)  // file's neon fake
  await new TeardownService(db as any, cfg, [neon, flySpy(flyDestroyed)]).deleteBranch('o', 'p', 'b-feat')
  expect(neonDeleted).toEqual(['br-feat'])
  expect(flyDestroyed).toEqual(['a-feat'])
  expect(db.tables.resources.find((r: any) => r.id === 'r-fly').status).toBe('destroyed')
})

test('deleteBranch destroys the branch fork bucket + neon branch and marks the s3 resource destroyed', async () => {
  const s3Destroyed: string[] = []; const neonDeleted: string[] = []
  const db = fakeData()
  db.tables.projects.push({ id: 'p', owner: 'o', name: 'proj', status: 'active' })
  db.tables.branches.push({ id: 'b-feat', owner: 'o', project_id: 'p', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' })
  db.tables.resources.push({ id: 'r-neon', owner: 'o', project_id: 'p', kind: 'neon', branch_id: null, provider_ref: { neonProjectId: 'np' }, status: 'active' })
  db.tables.resources.push({ id: 'r-s3-root', owner: 'o', project_id: 'p', kind: 's3', branch_id: null, provider_ref: { bucket: 'root' }, status: 'active' })
  db.tables.resources.push({ id: 'r-s3-feat', owner: 'o', project_id: 'p', kind: 's3', branch_id: 'b-feat', provider_ref: { bucket: 'firth-feature-fork' }, status: 'active' })
  const neon = neonAdapter({ async deleteBranch(_h: any, ref: string) { neonDeleted.push(ref) } } as any)
  const s3 = { kind: 's3', branchModel: 'fork', async provision() { return { kind: 's3', providerRef: {} } }, async destroy(h: any) { s3Destroyed.push((h.providerRef as any).bucket) }, async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} } }
  const out = await new TeardownService(db as any, cfg, [neon, s3 as any]).deleteBranch('o', 'p', 'b-feat')
  expect(neonDeleted).toEqual(['br-feat'])
  expect(s3Destroyed).toEqual(['firth-feature-fork'])  // only the branch fork, NOT the root bucket
  expect(out.teardown.destroyed).toContain('s3')
  expect(db.tables.resources.find((r: any) => r.id === 'r-s3-feat').status).toBe('destroyed')
  expect(db.tables.resources.find((r: any) => r.id === 'r-s3-root').status).toBe('active')  // root untouched
})

test('deleteProject destroys every branch\'s fly app and skips an already-destroyed one', async () => {
  const flyDestroyed: string[] = []
  const db = fakeData()
  db.tables.projects.push({ id: 'p', owner: 'o', name: 'proj', status: 'active' })
  db.tables.resources.push({ id: 'r-neon', owner: 'o', project_id: 'p', kind: 'neon', branch_id: null, provider_ref: { neonProjectId: 'np' }, status: 'active' })
  db.tables.resources.push({ id: 'r-fly-main', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main' }, status: 'active' })
  db.tables.resources.push({ id: 'r-fly-gone', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-old', provider_ref: { flyApp: 'a-old' }, status: 'destroyed' })
  await new TeardownService(db as any, cfg, [neonAdapter(), flySpy(flyDestroyed)]).deleteProject('o', 'p')
  expect(flyDestroyed).toEqual(['a-main'])  // a-old skipped (already destroyed)
})

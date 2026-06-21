import { describe, expect, it, test } from 'vitest'
import { ProjectsRepo, SecretsRepo, ResourcesRepo, BranchesRepo, EventsRepo, GovernanceRepo } from '../../src/db/repos.js'

// PostgREST-faithful in-memory DataClient.
// eq/is semantics mirror real PostgREST:
//   eq(col, null)  → matches nothing (PostgREST emits col=eq.null, not IS NULL)
//   is(col, null)  → matches rows where col is null/undefined
// Supports insert / update / select modes including insert().select() returning the inserted row.
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { projects: [], branches: [], resources: [], secrets: [], events: [], governance_rules: [], approvals: [], ...seed }
  return {
    tables,
    from(table: string) {
      let rows = tables[table]
      const filters: Array<(r: any) => boolean> = []
      let mode: 'insert' | 'update' | 'select' = 'select'
      let inserted: any
      let updatePayload: any
      const t = table
      const api: any = {
        insert(values: any) {
          mode = 'insert'
          const arr = Array.isArray(values) ? values : [values]
          const row = { id: `${table}-${tables[table].length}`, created_at: String(tables[table].length).padStart(10, '0'), ...arr[0] }
          tables[table].push(row)
          inserted = row
          return api
        },
        upsert(v: any, opts?: any) {
          mode = 'insert'
          if (opts?.onConflict && !opts?.ignoreDuplicates) {
            const cols = opts.onConflict.split(',')
            const ex = tables[t].find((r) => cols.every((c: string) => r[c] === v[c]))
            if (ex) { Object.assign(ex, v); inserted = ex; return api }
          }
          const row = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(row); inserted = row; return api
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
          if (mode === 'insert') return res({ data: [inserted], error: null })
          rows = tables[table].filter((r) => filters.every((fn) => fn(r)))
          return res({ data: rows, error: null })
        },
      }
      return api
    },
  }
}

// Alias used by GovernanceRepo tests
const fakeData = fakeDb

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

describe('ResourcesRepo.findByKindForBranch', () => {
  test('returns the fly row for a given branch and null for another branch', async () => {
    const db = fakeDb({ resources: [
      { id: 'r-a', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main' }, status: 'active' },
      { id: 'r-b', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-feat', provider_ref: { flyApp: 'a-feat' }, status: 'active' },
    ] })
    const repo = new ResourcesRepo(db as any)
    const main = await repo.findByKindForBranch('o', 'p', 'b-main', 'fly')
    expect(main?.id).toBe('r-a')
    const feat = await repo.findByKindForBranch('o', 'p', 'b-feat', 'fly')
    expect(feat?.id).toBe('r-b')
    const none = await repo.findByKindForBranch('o', 'p', 'b-missing', 'fly')
    expect(none).toBeNull()
  })
})

describe('GovernanceRepo.findGrantedApproval ordering', () => {
  it('returns the oldest granted approval when multiple exist (not insertion order)', async () => {
    const olderTs = new Date('2024-01-01T10:00:00.000Z').toISOString()
    const newerTs = new Date('2024-01-01T11:00:00.000Z').toISOString()
    // Seed NEWER first so that insertion-order [0] would return the wrong (newer) row.
    const db = fakeDb({
      approvals: [
        { id: 'ap-newer', owner: 'o1', project_id: 'p1', action: 'project.delete', status: 'granted', requested_at: newerTs },
        { id: 'ap-older', owner: 'o1', project_id: 'p1', action: 'project.delete', status: 'granted', requested_at: olderTs },
      ],
    })
    const repo = new GovernanceRepo(db as any)
    const result = await repo.findGrantedApproval('o1', 'p1', 'project.delete')
    expect(result?.id).toBe('ap-older')
  })
})

test('GovernanceRepo: upsert/find rule, grant lifecycle', async () => {
  const db = fakeData()
  const repo = new GovernanceRepo(db as any)
  await repo.upsertRule('o1', 'p1', 'project.delete', 'approve')
  await repo.upsertRule('o1', 'p1', 'project.delete', 'deny') // upsert overrides
  expect((await repo.findRule('o1', 'p1', 'project.delete'))?.decision).toBe('deny')
  expect(await repo.findRule('o1', 'p1', 'deploy')).toBeNull()

  const ap = await repo.createApproval('o1', 'p1', 'project.delete')
  expect(ap.status).toBe('pending')
  expect(await repo.findGrantedApproval('o1', 'p1', 'project.delete')).toBeNull()
  await repo.decideApproval('o1', ap.id, 'granted')
  expect((await repo.findGrantedApproval('o1', 'p1', 'project.delete'))?.id).toBe(ap.id)
  await repo.markConsumed('o1', ap.id)
  expect(await repo.findGrantedApproval('o1', 'p1', 'project.delete')).toBeNull()
})

describe('GovernanceRepo: listRules', () => {
  it('returns only rules for the matching owner+project, not those for a different project', async () => {
    const db = fakeData()
    const repo = new GovernanceRepo(db as any)
    // Two rules for the project under test
    await repo.upsertRule('o1', 'p1', 'deploy', 'deny')
    await repo.upsertRule('o1', 'p1', 'project.delete', 'approve')
    // One rule for a different project that must NOT appear
    await repo.upsertRule('o1', 'p2', 'deploy', 'allow')

    const rules = await repo.listRules('o1', 'p1')
    expect(rules).toHaveLength(2)
    const actions = rules.map((r) => r.action).sort()
    expect(actions).toEqual(['deploy', 'project.delete'])
    // Confirm each returned rule belongs to the right project
    for (const r of rules) {
      expect(r.owner).toBe('o1')
      expect(r.project_id).toBe('p1')
    }
  })
})

describe('GovernanceRepo: listApprovals', () => {
  it('returns all approvals for the project and filters by status when provided', async () => {
    const db = fakeData()
    const repo = new GovernanceRepo(db as any)
    // Seed: two pending + one granted for p1, and one pending for p2 (must not appear)
    const ap1 = await repo.createApproval('o1', 'p1', 'deploy')
    const ap2 = await repo.createApproval('o1', 'p1', 'project.delete')
    const ap3 = await repo.createApproval('o1', 'p1', 'branch.delete')
    await repo.decideApproval('o1', ap3.id, 'granted')
    await repo.createApproval('o1', 'p2', 'deploy') // different project — must not appear

    // Unfiltered: returns all three p1 approvals
    const all = await repo.listApprovals('o1', 'p1')
    expect(all).toHaveLength(3)
    expect(all.map((a) => a.id).sort()).toEqual([ap1.id, ap2.id, ap3.id].sort())

    // Filtered to 'pending': only the two pending ones
    const pending = await repo.listApprovals('o1', 'p1', 'pending')
    expect(pending).toHaveLength(2)
    expect(pending.every((a) => a.status === 'pending')).toBe(true)
    expect(pending.map((a) => a.id).sort()).toEqual([ap1.id, ap2.id].sort())

    // Filtered to 'granted': only the one granted one
    const granted = await repo.listApprovals('o1', 'p1', 'granted')
    expect(granted).toHaveLength(1)
    expect(granted[0].id).toBe(ap3.id)
    expect(granted[0].status).toBe('granted')
  })
})

describe('GovernanceRepo: findApproval', () => {
  it('returns the matching approval by id and null for a missing id', async () => {
    const db = fakeData()
    const repo = new GovernanceRepo(db as any)
    const ap = await repo.createApproval('o1', 'p1', 'deploy')

    const found = await repo.findApproval('o1', 'p1', ap.id)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(ap.id)
    expect(found?.action).toBe('deploy')
    expect(found?.status).toBe('pending')

    const missing = await repo.findApproval('o1', 'p1', 'no-such-id')
    expect(missing).toBeNull()
  })
})

describe('GovernanceRepo: decideApproval denied', () => {
  it("flips status to 'denied' and sets decided_at", async () => {
    const db = fakeData()
    const repo = new GovernanceRepo(db as any)
    const ap = await repo.createApproval('o1', 'p1', 'project.delete')
    // The fake DataClient does not pre-populate decided_at; the real DB column defaults to NULL.
    // Either way, decided_at must not be set (truthy) before a decision is made.
    expect(ap.decided_at).toBeFalsy()

    await repo.decideApproval('o1', ap.id, 'denied')

    // Inspect table state directly to verify the update was applied
    const row = db.tables.approvals.find((r: any) => r.id === ap.id)
    expect(row.status).toBe('denied')
    expect(row.decided_at).toBeTruthy()
  })
})

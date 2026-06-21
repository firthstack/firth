import { expect, test } from 'vitest'
import { GovernService } from '../../src/services/govern.js'

function fakeData() {
  const tables: Record<string, any[]> = { governance_rules: [], approvals: [] }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    let mode: 'insert' | 'select' | 'update' = 'select'; let inserted: any; let upd: any
    const api: any = {
      insert(v: any) { mode = 'insert'; const row = { id: `${t}-${tables[t].length}`, requested_at: 'now', decided_at: null, ...v }; tables[t].push(row); inserted = row; return api },
      upsert(v: any, opts?: any) {
        mode = 'insert'
        const ex = tables[t].find((r) => r.project_id === v.project_id && r.action === v.action)
        if (ex) { Object.assign(ex, v); inserted = ex } else { const row = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(row); inserted = row }
        return api
      },
      update(v: any) { mode = 'update'; upd = v; return api },
      select() { return api },
      eq(c: string, val: any) { filters.push((r: any) => r[c] === val); return api },
      async then(res: any) {
        if (mode === 'update') { for (const r of tables[t]) if (filters.every((f) => f(r))) Object.assign(r, upd); return res({ data: [], error: null }) }
        if (mode === 'insert') return res({ data: [inserted], error: null })
        return res({ data: tables[t].filter((r) => filters.every((f) => f(r))), error: null })
      },
    }
    return api
  } }
}

test('gate: default approve creates a pending approval; grant then consume', async () => {
  const db = fakeData(); const svc = new GovernService(db as any)
  const g1 = await svc.gate('o1', 'p1', 'project.delete')   // default approve, no grant
  expect(g1).toMatchObject({ decision: 'approval_required' })
  expect(db.tables.approvals.filter((a) => a.status === 'pending')).toHaveLength(1)

  await svc.decide('o1', 'p1', (g1 as any).approvalId, 'granted')
  const g2 = await svc.gate('o1', 'p1', 'project.delete')   // now a grant exists
  expect(g2).toMatchObject({ decision: 'approved' })
  expect(db.tables.approvals.find((a) => a.id === (g1 as any).approvalId)?.status).toBe('consumed')
})

test('gate: default allow → allow; explicit deny → deny', async () => {
  const db = fakeData(); const svc = new GovernService(db as any)
  expect(await svc.gate('o1', 'p1', 'deploy')).toEqual({ decision: 'allow' })
  await svc.setRule('o1', 'p1', 'deploy', 'deny')
  expect(await svc.gate('o1', 'p1', 'deploy')).toEqual({ decision: 'deny' })
})

test('gate: secrets.read and branch.delete default to allow', async () => {
  const db = fakeData(); const svc = new GovernService(db as any)
  expect(await svc.gate('o1', 'p1', 'secrets.read')).toEqual({ decision: 'allow' })
  expect(await svc.gate('o1', 'p1', 'branch.delete')).toEqual({ decision: 'allow' })
})

test('listApprovals: returns pending approvals filtered by status', async () => {
  const db = fakeData(); const svc = new GovernService(db as any)
  // Gate twice to create two pending approvals for project.delete (each gate creates a new pending if none granted)
  const g1 = await svc.gate('o1', 'p1', 'project.delete')
  expect(g1.decision).toBe('approval_required')
  // Grant and consume g1 so the next gate also goes pending
  await svc.decide('o1', 'p1', (g1 as any).approvalId, 'granted')
  const g2 = await svc.gate('o1', 'p1', 'project.delete') // consumes the grant → approved, no new pending
  expect(g2.decision).toBe('approved')
  // Now create a fresh pending
  const g3 = await svc.gate('o1', 'p1', 'project.delete')
  expect(g3.decision).toBe('approval_required')

  // listApprovals filtered to 'pending' should return only the pending one
  const pending = await svc.listApprovals('o1', 'p1', 'pending')
  expect(pending).toHaveLength(1)
  expect(pending[0].id).toBe((g3 as any).approvalId)
  expect(pending[0].status).toBe('pending')

  // listApprovals without filter returns all approvals for the project
  const all = await svc.listApprovals('o1', 'p1')
  expect(all.length).toBeGreaterThanOrEqual(2)
})

test('effectivePolicy merges defaults with overrides', async () => {
  const db = fakeData(); const svc = new GovernService(db as any)
  await svc.setRule('o1', 'p1', 'deploy', 'approve')
  const p = await svc.effectivePolicy('o1', 'p1')
  expect(p).toEqual({ 'secrets.read': 'allow', deploy: 'approve', 'project.delete': 'approve', 'branch.delete': 'allow' })
})

test('decide on a missing approval throws NotFoundError', async () => {
  const db = fakeData(); const svc = new GovernService(db as any)
  await expect(svc.decide('o1', 'p1', 'nope', 'granted')).rejects.toThrow(/not found/)
})

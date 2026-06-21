# Govern at the Credential Boundary — Implementation Plan (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project policy gates four high-blast-radius actions — `secrets.read`, `deploy`, `project.delete`, `branch.delete` — deciding allow / deny / require-approval; "require-approval" pauses the action until a human grants a one-shot approval. Every decision lands on the Observe timeline.

**Architecture:** A `GovernService.gate()` consults `governance_rules` (overrides) merged with code `DEFAULTS`; the 4 routes call `gate()` before doing their work (deny→403, approval_required→202, approved/allow→proceed). Approvals are a one-shot grant ledger; CLI + dashboard let a human approve/deny + edit policy.

**Tech Stack:** TypeScript/Node (control-plane Fastify + vitest), InsForge Postgres + RLS migrations, the `firth` CLI (vitest), the React dashboard (vitest + jsdom).

## Global Constraints

- Gated actions + defaults (code constant `DEFAULTS`, its keys are the canonical set): `secrets.read`→`allow`, `deploy`→`allow`, `project.delete`→`approve`, `branch.delete`→`allow`. Decisions: `allow` | `deny` | `approve`.
- `gate()` matching is by **`(project_id, action)`** (coarse, v1). A grant is **consumed when the gate passes**, before the action runs (spent on attempt, not success).
- `gate()` runs **before** any side effect (no decrypt/deploy/teardown on deny or pending). Deny → `ForbiddenError` → **403**. approval_required → **202** `{ status: 'approval_required', approvalId, action, message }`, action NOT performed.
- Timeline events via the existing `emit(db, uid, projectId, branchId, kind, payload)` (`source: 'resource'`): `govern.pending`, `govern.approved` (from gated routes), `govern.denied` (from the deny route). Policy-deny 403 is not emitted in v1.
- Owner-scoped RLS on both new tables (mirror `events`: `owner = (SELECT auth.uid())`); v1 approver = the project owner. Approval/policy payloads carry no secrets; static error strings; tokens/secrets never logged.
- TDD: failing test → confirm fail → implement → pass → commit. Stage only the files each task names (never `git add -A`).

---

### Task 1: Migration + row types + `GovernanceRepo`

**Files:**
- Create: `migrations/20260621230000_govern.sql` (use a timestamp later than the newest existing migration)
- Modify: `control-plane/src/db/types.ts` (Decision + row types)
- Modify: `control-plane/src/db/repos.ts` (`GovernanceRepo`)
- Test: `control-plane/test/db/repos.test.ts`

**Interfaces:**
- Consumes: the injectable `DataClient`/`QueryBuilder` (`insert`/`upsert`/`update`/`select`/`eq`), `firstOrThrow`.
- Produces:
  - `Decision = 'allow' | 'deny' | 'approve'`; `ApprovalStatus = 'pending' | 'granted' | 'denied' | 'consumed'`.
  - `GovernanceRuleRow = { id; project_id; owner; action; decision: Decision }`.
  - `ApprovalRow = { id; project_id; owner; action; status: ApprovalStatus; requested_at: string; decided_at: string | null }`.
  - `GovernanceRepo` methods: `findRule`, `listRules`, `upsertRule`, `createApproval`, `findGrantedApproval`, `findApproval`, `markConsumed`, `decideApproval`, `listApprovals`.

- [ ] **Step 1: Write the migration**

Create `migrations/20260621230000_govern.sql`:

```sql
CREATE TABLE public.governance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','approve')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, action)
);
CREATE INDEX idx_governance_rules_owner ON public.governance_rules(owner);

CREATE TABLE public.approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','denied','consumed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX idx_approvals_owner ON public.approvals(owner);
CREATE INDEX idx_approvals_lookup ON public.approvals(project_id, action, status);

ALTER TABLE public.governance_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY governance_rules_owner_all ON public.governance_rules FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY approvals_owner_all ON public.approvals FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE ON public.governance_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.approvals TO authenticated;
```

- [ ] **Step 2: Add the row types**

In `control-plane/src/db/types.ts`, add:

```ts
export type Decision = 'allow' | 'deny' | 'approve'
export type GovernanceRuleRow = { id: string; project_id: string; owner: string; action: string; decision: Decision }
export type ApprovalStatus = 'pending' | 'granted' | 'denied' | 'consumed'
export type ApprovalRow = {
  id: string; project_id: string; owner: string; action: string
  status: ApprovalStatus; requested_at: string; decided_at: string | null
}
```

- [ ] **Step 3: Write the failing repo test**

In `control-plane/test/db/repos.test.ts`, add the test below. **Prerequisite:** the file's in-memory fake must support `upsert` with **merge-on-conflict** (`upsertRule` calls `.upsert(row, { onConflict: 'project_id,action' })` and the test upserts twice expecting the second to override). If the fake's `upsert` is missing or only models ignore-duplicates, add/extend it so that when `opts.onConflict` is set (and not `ignoreDuplicates`), it finds an existing row matching those columns and `Object.assign`s onto it; otherwise inserts:

```ts
upsert(v, opts) {
  mode = 'insert'
  if (opts?.onConflict && !opts?.ignoreDuplicates) {
    const cols = opts.onConflict.split(',')
    const ex = tables[t].find((r) => cols.every((c) => r[c] === v[c]))
    if (ex) { Object.assign(ex, v); inserted = ex; return api }
  }
  const row = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(row); inserted = row; return api
},
```

The test:

```ts
import { GovernanceRepo } from '../../src/db/repos.js'

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
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/db/repos.test.ts`
Expected: FAIL — `GovernanceRepo` not exported.

- [ ] **Step 5: Implement `GovernanceRepo`**

In `control-plane/src/db/repos.ts`, add the imports (`GovernanceRuleRow`, `ApprovalRow`, `ApprovalStatus`, `Decision` to the `./types.js` import) and the class:

```ts
export class GovernanceRepo {
  constructor(private db: DataClient) {}

  async findRule(owner: string, projectId: string, action: string): Promise<GovernanceRuleRow | null> {
    const { data, error } = await this.db.from('governance_rules').select()
      .eq('owner', owner).eq('project_id', projectId).eq('action', action)
    if (error) throw error
    return ((data ?? [])[0] as GovernanceRuleRow) ?? null
  }
  async listRules(owner: string, projectId: string): Promise<GovernanceRuleRow[]> {
    const { data, error } = await this.db.from('governance_rules').select().eq('owner', owner).eq('project_id', projectId)
    if (error) throw error
    return (data ?? []) as GovernanceRuleRow[]
  }
  async upsertRule(owner: string, projectId: string, action: string, decision: Decision): Promise<void> {
    const { error } = await this.db.from('governance_rules')
      .upsert({ owner, project_id: projectId, action, decision, updated_at: new Date().toISOString() }, { onConflict: 'project_id,action' })
      .select()
    if (error) throw error
  }
  async createApproval(owner: string, projectId: string, action: string): Promise<ApprovalRow> {
    const { data, error } = await this.db.from('approvals')
      .insert({ owner, project_id: projectId, action, status: 'pending' }).select()
    if (error) throw error
    return firstOrThrow(data, 'approvals') as ApprovalRow
  }
  async findGrantedApproval(owner: string, projectId: string, action: string): Promise<ApprovalRow | null> {
    const { data, error } = await this.db.from('approvals').select()
      .eq('owner', owner).eq('project_id', projectId).eq('action', action).eq('status', 'granted')
    if (error) throw error
    return ((data ?? [])[0] as ApprovalRow) ?? null
  }
  async findApproval(owner: string, projectId: string, id: string): Promise<ApprovalRow | null> {
    const { data, error } = await this.db.from('approvals').select()
      .eq('owner', owner).eq('project_id', projectId).eq('id', id)
    if (error) throw error
    return ((data ?? [])[0] as ApprovalRow) ?? null
  }
  async decideApproval(owner: string, id: string, status: 'granted' | 'denied'): Promise<void> {
    const { error } = await this.db.from('approvals')
      .update({ status, decided_at: new Date().toISOString() }).eq('owner', owner).eq('id', id)
    if (error) throw error
  }
  async markConsumed(owner: string, id: string): Promise<void> {
    const { error } = await this.db.from('approvals').update({ status: 'consumed' }).eq('owner', owner).eq('id', id)
    if (error) throw error
  }
  async listApprovals(owner: string, projectId: string, status?: ApprovalStatus): Promise<ApprovalRow[]> {
    let q = this.db.from('approvals').select().eq('owner', owner).eq('project_id', projectId)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as ApprovalRow[]
  }
}
```

- [ ] **Step 6: Run the test + apply the migration live + build**

Run: `cd control-plane && npx vitest run test/db/repos.test.ts` → PASS.
Run: `cd /Users/junwen/Work/Personal/firth && npx @insforge/cli db migrations up --all` → applies; verify: `npx @insforge/cli db query "SELECT tablename FROM pg_tables WHERE tablename IN ('governance_rules','approvals')"` returns both.
Run: `cd control-plane && npm test && npm run build` → green.

- [ ] **Step 7: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add migrations/20260621230000_govern.sql control-plane/src/db/types.ts control-plane/src/db/repos.ts control-plane/test/db/repos.test.ts
git commit -m "feat: governance_rules + approvals tables + GovernanceRepo"
```

---

### Task 2: `GovernService` + `ForbiddenError`

**Files:**
- Create: `control-plane/src/services/govern.ts`
- Modify: `control-plane/src/auth.ts` (`ForbiddenError`)
- Modify: `control-plane/src/server.ts` (handler mapping — just the one `setErrorHandler` line)
- Test: `control-plane/test/services/govern.test.ts`

**Interfaces:**
- Consumes: `GovernanceRepo` (Task 1), `Decision`/`ApprovalRow`/`ApprovalStatus`, `NotFoundError`.
- Produces:
  - `GATED_ACTIONS` (readonly tuple), `GatedAction`, `isGatedAction(s): s is GatedAction`.
  - `GateResult = { decision:'allow' } | { decision:'deny' } | { decision:'approval_required'; approvalId } | { decision:'approved'; approvalId }`.
  - `GovernService(db)` with `gate`, `effectivePolicy`, `setRule`, `listApprovals`, `decide`.
  - `ForbiddenError` (auth.ts) → `403`.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/test/services/govern.test.ts` (self-contained fake supporting `from/insert/upsert/update/select/eq/then`):

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd control-plane && npx vitest run test/services/govern.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ForbiddenError` + handler**

In `control-plane/src/auth.ts`, add next to the other error classes:

```ts
export class ForbiddenError extends Error {}
```

In `control-plane/src/server.ts`, import it (`import { resolveUid, UnauthorizedError, NotFoundError, ConflictError, ForbiddenError } from './auth.js'`) and add to `setErrorHandler` (after the ConflictError line):

```ts
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.message })
```

- [ ] **Step 4: Implement `GovernService`**

Create `control-plane/src/services/govern.ts`:

```ts
import type { DataClient, Decision, ApprovalRow, ApprovalStatus } from '../db/types.js'
import { GovernanceRepo } from '../db/repos.js'
import { NotFoundError } from '../auth.js'

export const GATED_ACTIONS = ['secrets.read', 'deploy', 'project.delete', 'branch.delete'] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]
export function isGatedAction(a: string): a is GatedAction { return (GATED_ACTIONS as readonly string[]).includes(a) }

const DEFAULTS: Record<GatedAction, Decision> = {
  'secrets.read': 'allow', deploy: 'allow', 'project.delete': 'approve', 'branch.delete': 'allow',
}

export type GateResult =
  | { decision: 'allow' }
  | { decision: 'deny' }
  | { decision: 'approval_required'; approvalId: string }
  | { decision: 'approved'; approvalId: string }

export class GovernService {
  private repo: GovernanceRepo
  constructor(db: DataClient) { this.repo = new GovernanceRepo(db) }

  async gate(owner: string, projectId: string, action: GatedAction): Promise<GateResult> {
    const rule = await this.repo.findRule(owner, projectId, action)
    const decision = rule?.decision ?? DEFAULTS[action]
    if (decision === 'allow') return { decision: 'allow' }
    if (decision === 'deny') return { decision: 'deny' }
    // approve: consume an existing grant, else create a pending approval
    const granted = await this.repo.findGrantedApproval(owner, projectId, action)
    if (granted) { await this.repo.markConsumed(owner, granted.id); return { decision: 'approved', approvalId: granted.id } }
    const pending = await this.repo.createApproval(owner, projectId, action)
    return { decision: 'approval_required', approvalId: pending.id }
  }

  async effectivePolicy(owner: string, projectId: string): Promise<Record<GatedAction, Decision>> {
    const rules = await this.repo.listRules(owner, projectId)
    const map: Record<GatedAction, Decision> = { ...DEFAULTS }
    for (const r of rules) if (isGatedAction(r.action)) map[r.action] = r.decision
    return map
  }

  async setRule(owner: string, projectId: string, action: GatedAction, decision: Decision): Promise<void> {
    await this.repo.upsertRule(owner, projectId, action, decision)
  }

  async listApprovals(owner: string, projectId: string, status?: ApprovalStatus): Promise<ApprovalRow[]> {
    return this.repo.listApprovals(owner, projectId, status)
  }

  async decide(owner: string, projectId: string, approvalId: string, status: 'granted' | 'denied'): Promise<ApprovalRow> {
    const found = await this.repo.findApproval(owner, projectId, approvalId)
    if (!found) throw new NotFoundError('approval not found')
    await this.repo.decideApproval(owner, approvalId, status)
    return { ...found, status, decided_at: new Date().toISOString() }
  }
}
```

- [ ] **Step 5: Run + build + commit**

Run: `cd control-plane && npx vitest run test/services/govern.test.ts` → PASS; then `npm test && npm run build` → green.

```bash
cd /Users/junwen/Work/Personal/firth
git add control-plane/src/services/govern.ts control-plane/src/auth.ts control-plane/src/server.ts control-plane/test/services/govern.test.ts
git commit -m "feat: GovernService (gate/policy/approvals) + ForbiddenError(403)"
```

---

### Task 3: Enforce `gate` at the 4 routes + timeline events

**Files:**
- Modify: `control-plane/src/server.ts` (a `gateOrReply` helper + the 4 gated routes)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `GovernService` + `GateResult` + `GatedAction` (Task 2), `ForbiddenError`, the existing `emit` helper.
- Produces: gated behavior on `GET /projects/:id/secrets`, `POST /projects/:id/deploy`, `DELETE /projects/:id`, `DELETE /projects/:id/branches/:bid`.

- [ ] **Step 0: Extend the `fakeData()` fake (prerequisite for every govern route test)**

In `control-plane/test/server.test.ts`, the `gate()` path reads/writes two new tables and `upsertRule` needs merge-on-conflict. Make two edits to `fakeData()`:

1. Add the tables to the `tables` literal: `governance_rules: [], approvals: []` (alongside `projects/branches/resources/secrets/events`).
2. Generalize `upsert` to handle merge-on-conflict (the existing `ignoreDuplicates` events path stays). At the top of the `upsert(v, opts)` body, before the existing dedup logic:

```ts
      upsert(v: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        mode = 'insert'
        if (opts?.onConflict && !opts?.ignoreDuplicates) {           // merge-on-conflict (governance_rules)
          const cols = opts.onConflict.split(',')
          const ex = tables[t].find((r) => cols.every((c) => r[c] === (v as any)[c]))
          if (ex) { Object.assign(ex, v); insertedRow = ex; return api }
        }
        // ... existing ignoreDuplicates(dedup_key) path + default insert unchanged ...
      },
```

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/server.test.ts`:

```ts
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
})

test('DELETE /projects/:id proceeds after the approval is granted (grant consumed)', async () => {
  const db = fakeData()
  await db.from('projects').insert({ owner: 'uid-1', name: 'gp', status: 'active' })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [] })
  const r1 = await app.inject({ method: 'DELETE', url: '/projects/projects-0', headers: { authorization: 'Bearer good' } })
  const approvalId = r1.json().approvalId
  await app.inject({ method: 'POST', url: `/projects/projects-0/approvals/${approvalId}/approve`, headers: { authorization: 'Bearer good' } })
  const r2 = await app.inject({ method: 'DELETE', url: '/projects/projects-0', headers: { authorization: 'Bearer good' } })
  expect(r2.statusCode).toBe(200)
  expect(db.tables.events.map((e: any) => e.kind)).toContain('govern.approved')
  expect(db.tables.approvals.find((a: any) => a.id === approvalId)?.status).toBe('consumed')
})

test('DELETE /projects/:id with policy=deny → 403, not torn down', async () => {
  const db = fakeData()
  await db.from('projects').insert({ owner: 'uid-1', name: 'gp', status: 'active' })
  db.tables.governance_rules.push({ id: 'gr1', owner: 'uid-1', project_id: 'projects-0', action: 'project.delete', decision: 'deny' })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [] })
  const r = await app.inject({ method: 'DELETE', url: '/projects/projects-0', headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(403)
})
```

(These rely on the Task 4 approve route; if implementing strictly task-by-task, the second test's `/approve` call needs Task 4 — note that and run it after Task 4, or stub the grant by pushing a `granted` approval row directly. To keep Task 3 self-contained, the second test may instead push `db.tables.approvals.push({ id:'a1', owner:'uid-1', project_id:'projects-0', action:'project.delete', status:'granted', requested_at:'now', decided_at:null })` before the DELETE and assert it becomes `consumed`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: FAIL — DELETE currently tears down + returns 200, no gate.

- [ ] **Step 3: Add the `gateOrReply` helper**

In `control-plane/src/server.ts`, add a helper inside `buildServer` (next to `emit`), and import `GovernService` + `GatedAction`:

```ts
import { GovernService, type GatedAction } from './services/govern.js'
```

```ts
  // Returns true if the caller should proceed; false means a 202 was already sent.
  async function gateOrReply(db: DataClient, uid: string, projectId: string, action: GatedAction, branchId: string | null, reply: any): Promise<boolean> {
    const g = await new GovernService(db).gate(uid, projectId, action)
    if (g.decision === 'deny') throw new ForbiddenError(`${action} denied by policy`)
    if (g.decision === 'approval_required') {
      await emit(db, uid, projectId, branchId, 'govern.pending', { action, approvalId: g.approvalId })
      reply.code(202).send({ status: 'approval_required', approvalId: g.approvalId, action,
        message: `${action} requires approval — have a human run \`firth approve ${g.approvalId}\`, then retry` })
      return false
    }
    if (g.decision === 'approved') await emit(db, uid, projectId, branchId, 'govern.approved', { action, approvalId: g.approvalId })
    return true
  }
```

- [ ] **Step 4: Gate the 4 routes**

`DELETE /projects/:id` — first line after `projectId`:
```ts
    if (!(await gateOrReply(db, uid, projectId, 'project.delete', null, reply))) return
```
`DELETE /projects/:id/branches/:bid` — after `branchId`:
```ts
    if (!(await gateOrReply(db, uid, projectId, 'branch.delete', branchId, reply))) return
```
`POST /projects/:id/deploy` — after `branch` is resolved (so the event carries the branch), before constructing `DeployService`:
```ts
    if (!(await gateOrReply(db, uid, projectId, 'deploy', branch ?? null, reply))) return
```
`GET /projects/:id/secrets` — after `branch`, before `SecretsRepo.listForScope`:
```ts
    if (!(await gateOrReply(db, uid, projectId, 'secrets.read', branch, reply))) return
```

- [ ] **Step 5: Run the suite + build**

Run: `cd control-plane && npm test && npm run build`
Expected: PASS. (The existing deploy/delete/secrets tests use default policy: `deploy`/`branch.delete`/`secrets.read` = `allow` → unchanged behavior; only `project.delete` defaults to `approve`. Any existing `DELETE /projects/:id` test that expected 200 must be updated to first grant an approval — update those tests in this step.)

- [ ] **Step 6: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: gate secrets/deploy/project.delete/branch.delete + govern timeline events"
```

---

### Task 4: Approval + policy API routes

**Files:**
- Modify: `control-plane/src/server.ts` (5 routes)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `GovernService`, `isGatedAction` (Task 2), `emit`.
- Produces: `GET /projects/:id/approvals`, `POST /…/approvals/:aid/approve`, `POST /…/approvals/:aid/deny`, `GET /…/policy`, `PUT /…/policy/:action`.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/server.test.ts`:

```ts
test('approvals: list pending, approve flips to granted', async () => {
  const db = fakeData()
  db.tables.approvals.push({ id: 'a1', owner: 'uid-1', project_id: 'p1', action: 'project.delete', status: 'pending', requested_at: 'now', decided_at: null })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const list = await app.inject({ method: 'GET', url: '/projects/p1/approvals?status=pending', headers: { authorization: 'Bearer good' } })
  expect(list.json().approvals.map((a: any) => a.id)).toEqual(['a1'])
  const ap = await app.inject({ method: 'POST', url: '/projects/p1/approvals/a1/approve', headers: { authorization: 'Bearer good' } })
  expect(ap.statusCode).toBe(200)
  expect(db.tables.approvals[0].status).toBe('granted')
})

test('approvals: deny flips to denied + emits govern.denied', async () => {
  const db = fakeData()
  db.tables.approvals.push({ id: 'a1', owner: 'uid-1', project_id: 'p1', action: 'project.delete', status: 'pending', requested_at: 'now', decided_at: null })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/approvals/a1/deny', headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(200)
  expect(db.tables.approvals[0].status).toBe('denied')
  expect(db.tables.events.map((e: any) => e.kind)).toContain('govern.denied')
})

test('approve a missing approval → 404', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/approvals/nope/approve', headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(404)
})

test('policy: get defaults, set an override', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const p0 = await app.inject({ method: 'GET', url: '/projects/p1/policy', headers: { authorization: 'Bearer good' } })
  expect(p0.json().policy['project.delete']).toBe('approve')
  const set = await app.inject({ method: 'PUT', url: '/projects/p1/policy/deploy', headers: { authorization: 'Bearer good' }, payload: { decision: 'approve' } })
  expect(set.statusCode).toBe(200)
  expect(set.json().policy.deploy).toBe('approve')
})

test('policy: unknown action → 400', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const r = await app.inject({ method: 'PUT', url: '/projects/p1/policy/bogus', headers: { authorization: 'Bearer good' }, payload: { decision: 'deny' } })
  expect(r.statusCode).toBe(400)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: FAIL — routes don't exist (404).

- [ ] **Step 3: Implement the routes**

In `control-plane/src/server.ts`, add (import `isGatedAction` from `./services/govern.js`):

```ts
  app.get('/projects/:id/approvals', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const status = (req.query as any).status
    const approvals = await new GovernService(db).listApprovals(uid, projectId, status)
    return reply.send({ approvals })
  })

  app.post('/projects/:id/approvals/:aid/approve', async (req, reply) => {
    const { uid, db } = await auth(req)
    const approval = await new GovernService(db).decide(uid, (req.params as any).id, (req.params as any).aid, 'granted')
    return reply.send({ approval })
  })

  app.post('/projects/:id/approvals/:aid/deny', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const approval = await new GovernService(db).decide(uid, projectId, (req.params as any).aid, 'denied')
    await emit(db, uid, projectId, null, 'govern.denied', { action: approval.action, approvalId: approval.id })
    return reply.send({ approval })
  })

  app.get('/projects/:id/policy', async (req, reply) => {
    const { uid, db } = await auth(req)
    const policy = await new GovernService(db).effectivePolicy(uid, (req.params as any).id)
    return reply.send({ policy })
  })

  app.put('/projects/:id/policy/:action', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const action = (req.params as any).action
    const { decision } = (req.body as any) ?? {}
    if (!isGatedAction(action)) return reply.code(400).send({ error: 'unknown action' })
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'approve') return reply.code(400).send({ error: 'decision must be allow|deny|approve' })
    const svc = new GovernService(db)
    await svc.setRule(uid, projectId, action, decision)
    return reply.send({ policy: await svc.effectivePolicy(uid, projectId) })
  })
```

- [ ] **Step 4: Run the suite + build + commit**

Run: `cd control-plane && npm test && npm run build` → PASS/clean.

```bash
cd /Users/junwen/Work/Personal/firth
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: approvals + policy API routes"
```

---

### Task 5: CLI — govern commands + gated-command approval handling

**Files:**
- Modify: `cli/src/api.ts` (`FirthApi` + `getSecrets` contract)
- Create: `cli/src/commands/govern.ts`
- Modify: `cli/src/commands/deploy.ts`, `cli/src/commands/project.ts` (projectDelete), `cli/src/commands/branch.ts` (branchDelete), `cli/src/commands/secrets.ts` (gated-command handling)
- Modify: `cli/src/index.ts` (register + USAGE)
- Test: `cli/test/govern.test.ts`, `cli/test/deploy.test.ts`

**Interfaces:**
- Consumes: `POST /…/approvals/:aid/approve|deny`, `GET /…/approvals`, `GET/PUT /…/policy`; gated routes' `202 { status:'approval_required', approvalId, action }`.
- Produces: `firth approvals` / `approve <id>` / `deny <id>` / `policy [set <action> <decision>]`; gated commands print the approval message.

- [ ] **Step 1: Add the `FirthApi` methods**

In `cli/src/api.ts`, add:

```ts
  listApprovals(projectId: string, status?: string): Promise<any[]> {
    return this.req('GET', `/projects/${projectId}/approvals${status ? `?status=${status}` : ''}`).then((r) => r.approvals)
  }
  approve(projectId: string, id: string) { return this.req('POST', `/projects/${projectId}/approvals/${id}/approve`).then((r) => r.approval) }
  deny(projectId: string, id: string) { return this.req('POST', `/projects/${projectId}/approvals/${id}/deny`).then((r) => r.approval) }
  getPolicy(projectId: string): Promise<Record<string, string>> { return this.req('GET', `/projects/${projectId}/policy`).then((r) => r.policy) }
  setPolicy(projectId: string, action: string, decision: string): Promise<Record<string, string>> {
    return this.req('PUT', `/projects/${projectId}/policy/${action}`, { decision }).then((r) => r.policy)
  }
```

Change `getSecrets` to return the raw response (so the gated command can see `status`):

```ts
  getSecrets(projectId: string, branch?: string): Promise<{ secrets?: Record<string, string>; status?: string; approvalId?: string; action?: string }> {
    const q = branch ? `?branch=${encodeURIComponent(branch)}` : ''
    return this.req('GET', `/projects/${projectId}/secrets${q}`)
  }
```

- [ ] **Step 2: Write the failing govern-command tests**

Create `cli/test/govern.test.ts` (mirror the deploy/branch test fake style):

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { approvals, approve, policy } from '../src/commands/govern.js'
import { writeProjectLink } from '../src/config.js'

function deps(dir: string, api: any) {
  const out: string[] = []
  return { d: { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }, out }
}

test('approvals lists pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { listApprovals: async () => [{ id: 'a1', action: 'project.delete', requested_at: 'now' }] }
  const { d, out } = deps(dir, api)
  expect(await approvals([], d as any)).toBe(0)
  expect(out.join('\n')).toMatch(/a1/)
  expect(out.join('\n')).toMatch(/project\.delete/)
})

test('approve calls the api', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { approve: async (pid: string, id: string) => { calls.push([pid, id]); return { id, status: 'granted' } } }
  const { d } = deps(dir, api)
  expect(await approve(['a1'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'a1'])
})

test('policy set calls the api with action + decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { setPolicy: async (pid: string, a: string, dcn: string) => { calls.push([pid, a, dcn]); return { deploy: dcn } } }
  const { d } = deps(dir, api)
  expect(await policy(['set', 'deploy', 'approve'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'deploy', 'approve'])
})
```

- [ ] **Step 3: Run to verify they fail, then implement `govern.ts`**

Run: `cd cli && npx vitest run test/govern.test.ts` → FAIL (module missing).

Create `cli/src/commands/govern.ts`:

```ts
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

type Deps = CliDeps & { makeApi?: () => FirthApi }

function linkedProjectId(deps: Deps): string | null {
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return null }
  return link.projectId
}

export async function approvals(_argv: string[], deps: Deps): Promise<number> {
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  const list = await apiFromDeps(deps).listApprovals(projectId, 'pending')
  if (list.length === 0) { deps.print('no pending approvals'); return 0 }
  for (const a of list) deps.print(`${a.id}  ${a.action}  (requested ${a.requested_at})`)
  return 0
}

export async function approve(argv: string[], deps: Deps): Promise<number> {
  const id = argv[0]; if (!id) { deps.print('usage: firth approve <id>'); return 1 }
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  await apiFromDeps(deps).approve(projectId, id)
  deps.print(`approved ${id}`)
  return 0
}

export async function deny(argv: string[], deps: Deps): Promise<number> {
  const id = argv[0]; if (!id) { deps.print('usage: firth deny <id>'); return 1 }
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  await apiFromDeps(deps).deny(projectId, id)
  deps.print(`denied ${id}`)
  return 0
}

export async function policy(argv: string[], deps: Deps): Promise<number> {
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  const api = apiFromDeps(deps)
  if (argv[0] === 'set') {
    const [, action, decision] = argv
    if (!action || !decision) { deps.print('usage: firth policy set <action> <allow|deny|approve>'); return 1 }
    const p = await api.setPolicy(projectId, action, decision)
    for (const [a, d] of Object.entries(p)) deps.print(`${a}: ${d}`)
    return 0
  }
  const p = await api.getPolicy(projectId)
  for (const [a, d] of Object.entries(p)) deps.print(`${a}: ${d}`)
  return 0
}
```

Run: `cd cli && npx vitest run test/govern.test.ts` → PASS.

- [ ] **Step 4: Gated-command approval handling (failing test first)**

In `cli/test/deploy.test.ts`, add:

```ts
test('source/image deploy: approval_required response is reported, exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { deploy: async () => ({ status: 'approval_required', approvalId: 'a9', action: 'deploy' }) }
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await deploy(['--image', 'nginx'], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/requires approval \(id a9\)/)
})
```

- [ ] **Step 5: Run to verify it fails, then implement the gated-command handling**

Run: `cd cli && npx vitest run test/deploy.test.ts` → FAIL (deploy treats it as success / prints undefined url).

Add a shared helper at the top of `cli/src/commands/govern.ts` and export it:

```ts
// If a gated control-plane action returned `approval_required`, print the guidance and signal "not done".
export function reportIfGated(res: any, deps: { print: (s: string) => void }): boolean {
  if (res && res.status === 'approval_required') {
    deps.print(`⛔ ${res.action} requires approval (id ${res.approvalId}) — have a human run \`firth approve ${res.approvalId}\`, then re-run.`)
    return true
  }
  return false
}
```

In `cli/src/commands/deploy.ts`, both modes: after `const out = await api.deploy(...)` (and after the image-mode deploy call), insert before printing success:
```ts
  if (reportIfGated(out, deps)) return 1
```
(import `reportIfGated` from `./govern.js`).

In `cli/src/commands/project.ts` `projectDelete`: after the `deleteProject` call, `if (reportIfGated(out, deps)) return 1` before printing the teardown summary.

In `cli/src/commands/branch.ts` `branchDelete`: same after `deleteBranch`.

In `cli/src/commands/secrets.ts`: `getSecrets` now returns the raw response; handle it:
```ts
  const res = await apiFromDeps(deps).getSecrets(projectId, branch)
  if (reportIfGated(res, deps)) return 1
  const secrets = res.secrets ?? {}
  // ... existing .env-writing logic using `secrets`
```

- [ ] **Step 6: Register the commands + USAGE**

In `cli/src/index.ts`, import `{ approvals, approve, deny, policy } from './commands/govern.js'` and register:
```ts
COMMANDS['approvals'] = approvals
COMMANDS['approve'] = approve
COMMANDS['deny'] = deny
COMMANDS['policy'] = policy
```
Add USAGE lines:
```
  approvals                 List pending approvals
  approve <id>              Approve a pending request
  deny <id>                 Deny a pending request
  policy [set <a> <d>]      Show or set the project's govern policy
```

- [ ] **Step 7: Run the full CLI suite + build**

Run: `cd cli && npm test && npm run build`
Expected: PASS — new govern + deploy-gated tests; the existing secrets/deploy/delete tests stay green (update any that asserted the old `getSecrets` `secrets`-shaped return to read `res.secrets`).

- [ ] **Step 8: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add cli/src/api.ts cli/src/commands/govern.ts cli/src/commands/deploy.ts cli/src/commands/project.ts cli/src/commands/branch.ts cli/src/commands/secrets.ts cli/src/index.ts cli/test/govern.test.ts cli/test/deploy.test.ts
git commit -m "feat: cli govern commands + gated-command approval handling"
```

---

### Task 6: Dashboard — Approvals panel

**Files:**
- Modify: `dashboard/src/api/client.ts` (`Api` methods)
- Modify: `dashboard/src/views/ProjectDetail.tsx` (Approvals panel)
- Test: `dashboard/src/api/client.test.ts`, `dashboard/src/views/ProjectDetail.test.tsx`

**Interfaces:**
- Consumes: `GET /…/approvals`, `POST /…/approvals/:aid/approve|deny`.
- Produces: `Api.listApprovals/approve/deny`; an Approvals panel in the project detail.

- [ ] **Step 1: Add the `Api` methods (failing test first)**

In `dashboard/src/api/client.test.ts`, add:

```ts
it('listApprovals / approve / deny hit the right endpoints', async () => {
  const seen: string[] = []
  const fetcher = ((url: string) => { seen.push(url); return Promise.resolve(resp(200, { approvals: [{ id: 'a1', action: 'project.delete' }], approval: { id: 'a1' } })) }) as unknown as typeof fetch
  const api = new Api('http://cp', () => 't', fetcher)
  await api.listApprovals('p1', 'pending')
  await api.approve('p1', 'a1')
  await api.deny('p1', 'a1')
  expect(seen).toEqual(['http://cp/projects/p1/approvals?status=pending', 'http://cp/projects/p1/approvals/a1/approve', 'http://cp/projects/p1/approvals/a1/deny'])
})
```

(`resp` helper as defined in that file.)

In `dashboard/src/api/client.ts`, add:

```ts
  listApprovals(projectId: string, status?: string): Promise<Array<{ id: string; action: string; status: string; requested_at: string }>> {
    const q = status ? `?status=${status}` : ''
    return this.req('GET', `/projects/${projectId}/approvals${q}`).then((r) => r.approvals)
  }
  approve(projectId: string, id: string) { return this.req('POST', `/projects/${projectId}/approvals/${id}/approve`) }
  deny(projectId: string, id: string) { return this.req('POST', `/projects/${projectId}/approvals/${id}/deny`) }
```

- [ ] **Step 2: Write the failing panel test**

In `dashboard/src/views/ProjectDetail.test.tsx`, extend `fakeApi` with `listApprovals` (returns one pending) + `approve`, and add:

```ts
it('approvals panel lists a pending approval and approves it', async () => {
  const approved: string[] = []
  const api = fakeApi({
    listApprovals: vi.fn(async () => [{ id: 'a1', action: 'project.delete', status: 'pending', requested_at: 'now' }]),
    approve: vi.fn(async (_pid: string, id: string) => { approved.push(id); return {} }),
  })
  render(<ProjectDetail api={api} projectId="p1" onBack={vi.fn()} />)
  expect(await screen.findByText('project.delete')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /approve/i }))
  expect(approved).toEqual(['a1'])
})
```

(Add `listApprovals`/`approve`/`deny` to the test's `fakeApi` default so other tests still pass.)

- [ ] **Step 3: Run to verify it fails, then implement the panel**

Run: `cd dashboard && npx vitest run src/views/ProjectDetail.test.tsx` → FAIL.

In `dashboard/src/views/ProjectDetail.tsx`, add an `ApprovalsPanel` component and render it inside the detail (near the other panels):

```tsx
function ApprovalsPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [items, setItems] = useState<Array<{ id: string; action: string; requested_at: string }>>([])
  const load = useCallback(() => { api.listApprovals(projectId, 'pending').then(setItems).catch(() => setItems([])) }, [api, projectId])
  useEffect(() => { load() }, [load])
  const decide = async (id: string, kind: 'approve' | 'deny') => { await (kind === 'approve' ? api.approve(projectId, id) : api.deny(projectId, id)); load() }
  return (
    <Panel title="approvals">
      {items.length === 0 ? (
        <p className="firth-dim">no pending approvals</p>
      ) : items.map((a) => (
        <Row key={a.id}>
          <strong>{a.action}</strong>
          <span className="firth-dim">{a.requested_at}</span>
          <TButton onClick={() => decide(a.id, 'approve')}>[approve]</TButton>
          <TButton onClick={() => decide(a.id, 'deny')}>[deny]</TButton>
        </Row>
      ))}
    </Panel>
  )
}
```

Render `<ApprovalsPanel api={api} projectId={projectId} />` within the `ProjectDetail` return (alongside the postgres/storage/compute cards). Ensure `useState`/`useEffect`/`useCallback` and `Panel`/`Row`/`TButton` are imported (they already are for the other cards).

- [ ] **Step 4: Run the full dashboard suite + build + commit**

Run: `cd dashboard && npm test && npm run build` → PASS/clean.

```bash
cd /Users/junwen/Work/Personal/firth
git add dashboard/src/api/client.ts dashboard/src/views/ProjectDetail.tsx dashboard/src/api/client.test.ts dashboard/src/views/ProjectDetail.test.tsx
git commit -m "feat: dashboard approvals panel (list + approve/deny)"
```

---

## Notes for the executor

- The gate is checked **before** any side effect — assert in tests that the adapter/teardown was not invoked on deny/pending.
- Default policy means only `project.delete` is gated out of the box; the existing deploy/branch-delete/secrets tests are unaffected, but any existing `DELETE /projects/:id` (project teardown) test that expected `200` must first grant an approval (Task 3 Step 5 / Task 4) — update those in the task that touches them.
- `getSecrets` (CLI) changes shape from `Record<string,string>` to the raw response; the `secrets` command + its test read `res.secrets`. Grep for other `getSecrets` callers before changing (the `secrets` command is the only one).
- Live migration (Task 1 Step 6) hits the production InsForge DB — verify the two tables exist after.
- After merge, the control plane needs a redeploy for gating to take effect in prod; the CLI ships on the next publish; the dashboard panel needs a Sites redeploy.

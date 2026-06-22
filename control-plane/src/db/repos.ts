import type { DataClient, NewSecretRow, Project, SecretRow, ResourceRow, BranchRow, EventRow, NewEventRow, GovernanceRuleRow, ApprovalRow, ApprovalStatus, Decision } from './types.js'

export function firstOrThrow<T>(data: T[] | null, what: string): T {
  if (!data || data.length === 0) throw new Error(`${what} insert returned no row`)
  return data[0]
}

export class ProjectsRepo {
  constructor(private db: DataClient) {}

  async create(owner: string, name: string): Promise<Project> {
    const { data, error } = await this.db.from('projects')
      .insert({ owner, name, status: 'active' }).select()
    if (error) throw error
    return firstOrThrow(data, 'projects') as Project
  }

  async findById(owner: string, id: string): Promise<Project | null> {
    const { data, error } = await this.db.from('projects').select()
      .eq('owner', owner).eq('id', id).is('archived_at', null)
    if (error) throw error
    return ((data ?? [])[0] as Project) ?? null
  }

  async listByOwner(owner: string): Promise<Project[]> {
    const { data, error } = await this.db.from('projects').select()
      .eq('owner', owner).is('archived_at', null)
    if (error) throw error
    return (data ?? []) as Project[]
  }

  async archive(owner: string, id: string): Promise<void> {
    const { error } = await this.db.from('projects')
      .update({ archived_at: new Date().toISOString(), status: 'deleted' })
      .eq('owner', owner).eq('id', id)
    if (error) throw error
  }
}

export class SecretsRepo {
  constructor(private db: DataClient) {}

  async store(row: NewSecretRow): Promise<void> {
    const { error } = await this.db.from('secrets').insert(row)
    if (error) throw error
  }

  async listForScope(owner: string, projectId: string, branchId: string | null): Promise<SecretRow[]> {
    let q = this.db.from('secrets').select().eq('owner', owner).eq('project_id', projectId)
    q = branchId === null ? q.is('branch_id', null) : q.eq('branch_id', branchId)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as SecretRow[]
  }
}

export class ResourcesRepo {
  constructor(private db: DataClient) {}

  async findByKind(owner: string, projectId: string, kind: string): Promise<ResourceRow | null> {
    const { data, error } = await this.db.from('resources').select()
      .eq('owner', owner).eq('project_id', projectId).eq('kind', kind)
    if (error) throw error
    return ((data ?? [])[0] as ResourceRow) ?? null
  }

  async findByKindForBranch(owner: string, projectId: string, branchId: string, kind: string): Promise<ResourceRow | null> {
    const { data, error } = await this.db.from('resources').select()
      .eq('owner', owner).eq('project_id', projectId).eq('branch_id', branchId).eq('kind', kind)
    if (error) throw error
    return ((data ?? [])[0] as ResourceRow) ?? null
  }

  async listByProject(owner: string, projectId: string): Promise<ResourceRow[]> {
    const { data, error } = await this.db.from('resources').select()
      .eq('owner', owner).eq('project_id', projectId)
    if (error) throw error
    return (data ?? []) as ResourceRow[]
  }

  async markStatus(owner: string, id: string, status: string): Promise<void> {
    const { error } = await this.db.from('resources')
      .update({ status }).eq('owner', owner).eq('id', id)
    if (error) throw error
  }
}

export class EventsRepo {
  constructor(private db: DataClient) {}

  async record(row: NewEventRow): Promise<{ inserted: boolean }> {
    if (row.dedup_key) {
      // ignoreDuplicates → ON CONFLICT DO NOTHING, so this needs only the
      // events table's existing INSERT grant (no UPDATE). The SDK's .upsert is
      // verified against the live backend, not the compiler (DataClient is a cast).
      const { data, error } = await this.db.from('events')
        .upsert(row, { onConflict: 'owner,project_id,dedup_key', ignoreDuplicates: true })
        .select()
      if (error) throw error
      return { inserted: (data ?? []).length > 0 }
    }
    const { error } = await this.db.from('events').insert(row).select()
    if (error) throw error
    return { inserted: true }
  }

  async listByProject(owner: string, projectId: string, opts: { branch?: string | null; limit?: number } = {}): Promise<EventRow[]> {
    const { data, error } = await this.db.from('events').select().eq('owner', owner).eq('project_id', projectId)
    if (error) throw error
    let rows = (data ?? []) as EventRow[]
    // A branch view also includes project-scoped events (branch_id null) — project-level
    // actions (project.delete, project-scoped secrets, govern.*) apply to every branch, so the
    // audit trail must surface them. Filter app-side (the QueryBuilder has no OR / IS-NULL chain).
    if (typeof opts.branch === 'string') {
      const branch = opts.branch
      rows = rows.filter((r) => r.branch_id === branch || r.branch_id == null)
    }
    // newest-first; app-side because the fake (and v1) don't use SQL ORDER/LIMIT. Pagination is a follow-up.
    const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    return sorted.slice(0, opts.limit ?? 50)
  }
}

export class BranchesRepo {
  constructor(private db: DataClient) {}

  async findByName(owner: string, projectId: string, name: string): Promise<BranchRow | null> {
    // Live branches only: a name can be reused after the old branch is archived, so a
    // tombstone with the same name must not be resolved (e.g. as a createBranch parent).
    const { data, error } = await this.db.from('branches').select()
      .eq('owner', owner).eq('project_id', projectId).eq('name', name).is('archived_at', null)
    if (error) throw error
    return ((data ?? [])[0] as BranchRow) ?? null
  }

  async findById(owner: string, id: string): Promise<BranchRow | null> {
    const { data, error } = await this.db.from('branches').select()
      .eq('owner', owner).eq('id', id).is('archived_at', null)
    if (error) throw error
    return ((data ?? [])[0] as BranchRow) ?? null
  }

  async create(row: {
    project_id: string; owner: string; name: string
    parent_branch_id: string | null; is_default: boolean; status: string
  }): Promise<BranchRow> {
    const { data, error } = await this.db.from('branches').insert(row).select()
    if (error) throw error
    return firstOrThrow(data, 'branch') as BranchRow
  }

  async listByProject(owner: string, projectId: string): Promise<BranchRow[]> {
    const { data, error } = await this.db.from('branches').select()
      .eq('owner', owner).eq('project_id', projectId).is('archived_at', null)
    if (error) throw error
    return (data ?? []) as BranchRow[]
  }

  async archive(owner: string, id: string): Promise<void> {
    const { error } = await this.db.from('branches')
      .update({ archived_at: new Date().toISOString(), status: 'deleted' })
      .eq('owner', owner).eq('id', id)
    if (error) throw error
  }
}

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
    const rows = (data ?? []) as ApprovalRow[]
    // oldest-first; app-side because the fake (and v1) don't use SQL ORDER (mirrors listEvents). One grant consumed per gate.
    const sorted = [...rows].sort((a, b) => (a.requested_at < b.requested_at ? -1 : a.requested_at > b.requested_at ? 1 : 0))
    return sorted[0] ?? null
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

import type { DataClient, NewSecretRow, Project, SecretRow, ResourceRow, BranchRow } from './types.js'

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

  async listByOwner(owner: string): Promise<Project[]> {
    const { data, error } = await this.db.from('projects').select().eq('owner', owner)
    if (error) throw error
    return (data ?? []) as Project[]
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
}

export class BranchesRepo {
  constructor(private db: DataClient) {}

  async findByName(owner: string, projectId: string, name: string): Promise<BranchRow | null> {
    const { data, error } = await this.db.from('branches').select()
      .eq('owner', owner).eq('project_id', projectId).eq('name', name)
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
    const { data, error } = await this.db.from('branches').select().eq('owner', owner).eq('project_id', projectId)
    if (error) throw error
    return (data ?? []) as BranchRow[]
  }
}

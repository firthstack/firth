import type { DataClient, NewSecretRow, Project, SecretRow } from './types.js'

export class ProjectsRepo {
  constructor(private db: DataClient) {}

  async create(owner: string, name: string): Promise<Project> {
    const { data, error } = await this.db.from('projects')
      .insert({ owner, name, status: 'active' }).select()
    if (error) throw error
    return data![0] as Project
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
    const { error } = await this.db.from('secrets').insert(row).select()
    if (error) throw error
  }

  async listForScope(owner: string, projectId: string, branchId: string | null): Promise<SecretRow[]> {
    let q = this.db.from('secrets').select().eq('owner', owner).eq('project_id', projectId)
    q = branchId === null ? q.eq('branch_id', null) : q.eq('branch_id', branchId)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as SecretRow[]
  }
}

import { ProjectsRepo, firstOrThrow } from '../db/repos.js'
import type { DataClient, Project } from '../db/types.js'

export class ProjectService {
  private projects: ProjectsRepo
  constructor(private db: DataClient) { this.projects = new ProjectsRepo(db) }

  async createProject(owner: string, name: string): Promise<{
    project: Project; defaultBranch: { id: string; name: string }
  }> {
    const project = await this.projects.create(owner, name)
    const { data, error } = await this.db.from('branches').insert({
      project_id: project.id, owner, name: 'main', is_default: true, status: 'active',
    }).select()
    if (error) throw error
    const branch = firstOrThrow(data, 'branches') as { id: string; name: string }
    return { project, defaultBranch: { id: branch.id, name: branch.name } }
  }
}

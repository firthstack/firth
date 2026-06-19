import { ProjectsRepo, BranchesRepo, ResourcesRepo } from '../db/repos.js'
import { NotFoundError, ConflictError } from '../auth.js'
import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ProviderAdapter, ProviderKind } from '../adapters/types.js'

export type TeardownSummary = { destroyed: string[]; failed: Array<{ kind: string; message: string }> }

export class TeardownService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async deleteProject(owner: string, projectId: string) {
    const projects = new ProjectsRepo(this.db)
    const project = await projects.findById(owner, projectId)
    if (!project) throw new NotFoundError('project not found')
    const resources = await new ResourcesRepo(this.db).listByProject(owner, projectId)
    const repo = new ResourcesRepo(this.db)
    const summary: TeardownSummary = { destroyed: [], failed: [] }
    for (const r of resources) {
      const adapter = this.adapters.find((a) => a.kind === r.kind)
      if (!adapter) { summary.failed.push({ kind: r.kind, message: 'no adapter configured' }); await repo.markStatus(owner, r.id, 'destroy_failed'); continue }
      try {
        await adapter.destroy({ kind: r.kind as ProviderKind, providerRef: r.provider_ref })
        await repo.markStatus(owner, r.id, 'destroyed'); summary.destroyed.push(r.kind)
      } catch (e) {
        await repo.markStatus(owner, r.id, 'destroy_failed')
        summary.failed.push({ kind: r.kind, message: e instanceof Error ? e.message : String(e) })
      }
    }
    await projects.archive(owner, projectId)
    return { project: { ...project, status: 'deleted' }, teardown: summary }
  }

  async deleteBranch(owner: string, projectId: string, branchId: string) {
    const branches = new BranchesRepo(this.db)
    const branch = await branches.findById(owner, branchId)
    if (!branch || branch.project_id !== projectId) throw new NotFoundError('branch not found')
    if (branch.is_default) throw new ConflictError('cannot delete the default branch')
    const summary: TeardownSummary = { destroyed: [], failed: [] }
    const neon = this.adapters.find((a) => a.kind === 'neon')
    const resource = await new ResourcesRepo(this.db).findByKind(owner, projectId, 'neon')
    if (neon && resource && branch.neon_branch_ref) {
      try {
        await neon.deleteBranch({ kind: 'neon', providerRef: resource.provider_ref }, branch.neon_branch_ref)
        summary.destroyed.push('neon-branch')
      } catch (e) { summary.failed.push({ kind: 'neon-branch', message: e instanceof Error ? e.message : String(e) }) }
    }
    await branches.archive(owner, branchId)
    return { branch: { ...branch, status: 'deleted' }, teardown: summary }
  }
}

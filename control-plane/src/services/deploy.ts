import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ComputeAdapter, DeployResult, ProviderAdapter, ResourceHandle } from '../adapters/types.js'
import { BranchesRepo, ResourcesRepo, SecretsRepo } from '../db/repos.js'
import { decryptSecret } from '../crypto/secrets.js'
import { NotFoundError } from '../auth.js'

export class DeployService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  // Find the branch's compute, or provision it on demand. Compute is created on the
  // FIRST deploy (not at branch create), so envs start DB-only and only spin up a
  // Fly microVM when something is actually deployed to them.
  private async ensureCompute(owner: string, projectId: string, branchId: string, branchName: string, fly: ComputeAdapter): Promise<ResourceHandle> {
    const existing = await new ResourcesRepo(this.db).findByKindForBranch(owner, projectId, branchId, 'fly')
    if (existing) return { kind: 'fly', providerRef: existing.provider_ref }
    const handle = await fly.provision(branchName)
    const res = await this.db.from('resources').insert({
      project_id: projectId, owner, kind: 'fly', branch_id: branchId,
      provider_ref: handle.providerRef, status: 'active',
    }).select()
    if (res.error) throw res.error
    return handle
  }

  async deploy(owner: string, projectId: string, opts: { image: string; from?: string; port?: number }): Promise<DeployResult> {
    const fly = this.adapters.find((a) => a.kind === 'fly') as ComputeAdapter | undefined
    if (!fly?.deploy) throw new Error('fly adapter not configured')

    const branches = new BranchesRepo(this.db)
    const all = await branches.listByProject(owner, projectId)
    const target = opts.from
      ? all.find((b) => b.name === opts.from || b.id === opts.from)
      : (all.find((b) => b.is_default) ?? all[0])
    if (!target) throw new Error(`branch "${opts.from ?? '(default)'}" not found`)

    const handle = await this.ensureCompute(owner, projectId, target.id, target.name, fly)

    const secrets = new SecretsRepo(this.db)
    const rows = [
      ...(await secrets.listForScope(owner, projectId, null)),       // project-scoped
      ...(await secrets.listForScope(owner, projectId, target.id)),  // branch-scoped (override)
    ]
    const env: Record<string, string> = {}
    for (const r of rows) {
      env[r.name] = decryptSecret({ ciphertext: r.ciphertext, nonce: r.nonce, kekVersion: r.kek_version }, this.cfg.keks)
    }

    return fly.deploy(handle, { image: opts.image, env, port: opts.port, persistent: target.is_default })
  }

  async mintDeployToken(owner: string, projectId: string, opts: { from?: string }): Promise<{ token: string; expirySeconds: number; flyApp: string }> {
    const fly = this.adapters.find((a) => a.kind === 'fly') as ComputeAdapter | undefined
    if (!fly || typeof fly.mintDeployToken !== 'function') throw new Error('fly adapter not configured')

    const all = await new BranchesRepo(this.db).listByProject(owner, projectId)
    const target = opts.from
      ? all.find((b) => b.name === opts.from || b.id === opts.from)
      : (all.find((b) => b.is_default) ?? all[0])
    if (!target) throw new NotFoundError(`branch "${opts.from ?? '(default)'}" not found`)

    const handle = await this.ensureCompute(owner, projectId, target.id, target.name, fly)
    const { token, expirySeconds } = await fly.mintDeployToken(handle, { expirySeconds: 1200 })
    return { token, expirySeconds, flyApp: String((handle.providerRef as { flyApp?: string }).flyApp) }
  }
}

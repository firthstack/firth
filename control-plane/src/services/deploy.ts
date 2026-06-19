import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ComputeAdapter, DeployResult, ProviderAdapter, ResourceHandle } from '../adapters/types.js'
import { BranchesRepo, ResourcesRepo, SecretsRepo } from '../db/repos.js'
import { decryptSecret } from '../crypto/secrets.js'

export class DeployService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async deploy(owner: string, projectId: string, opts: { image: string; from?: string; port?: number }): Promise<DeployResult> {
    const fly = this.adapters.find((a) => a.kind === 'fly') as ComputeAdapter | undefined
    if (!fly?.deploy) throw new Error('fly adapter not configured')

    const resource = await new ResourcesRepo(this.db).findByKind(owner, projectId, 'fly')
    if (!resource) throw new Error('project has no fly resource')

    const branches = new BranchesRepo(this.db)
    const all = await branches.listByProject(owner, projectId)
    const target = opts.from
      ? all.find((b) => b.name === opts.from || b.id === opts.from)
      : (all.find((b) => b.is_default) ?? all[0])
    if (!target) throw new Error(`branch "${opts.from ?? '(default)'}" not found`)

    const secrets = new SecretsRepo(this.db)
    const rows = [
      ...(await secrets.listForScope(owner, projectId, null)),       // project-scoped
      ...(await secrets.listForScope(owner, projectId, target.id)),  // branch-scoped (override)
    ]
    const env: Record<string, string> = {}
    for (const r of rows) {
      env[r.name] = decryptSecret({ ciphertext: r.ciphertext, nonce: r.nonce, kekVersion: r.kek_version }, this.cfg.keks)
    }

    const handle: ResourceHandle = { kind: 'fly', providerRef: resource.provider_ref }
    return fly.deploy(handle, { image: opts.image, env, port: opts.port })
  }
}

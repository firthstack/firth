import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ProviderAdapter, ResourceHandle } from '../adapters/types.js'
import { BranchesRepo, ResourcesRepo } from '../db/repos.js'
import { encryptSecret } from '../crypto/secrets.js'

export class BranchService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async createBranch(owner: string, projectId: string, name: string, fromName = 'main'): Promise<{
    branch: { id: string; name: string; parentBranchId: string }
  }> {
    const neon = this.adapters.find((a) => a.kind === 'neon')
    if (!neon) throw new Error('neon adapter not configured')

    const resource = await new ResourcesRepo(this.db).findByKind(owner, projectId, 'neon')
    if (!resource) throw new Error('project has no neon resource')

    const branches = new BranchesRepo(this.db)
    const parent = await branches.findByName(owner, projectId, fromName)
    if (!parent || !parent.neon_branch_ref) throw new Error(`parent branch "${fromName}" not found or has no neon branch`)
    // Don't fork off a parent that isn't healthy — an 'error'/'creating' parent may carry a
    // stale neon_branch_ref pointing at a Neon branch a prior rollback already deleted.
    if (parent.status !== 'active') throw new Error(`parent branch "${fromName}" is not active (status: ${parent.status})`)

    const handle: ResourceHandle = { kind: 'neon', providerRef: resource.provider_ref }
    const row = await branches.create({
      project_id: projectId, owner, name, parent_branch_id: parent.id, is_default: false, status: 'creating',
    })

    let neonRef: string | null = null
    try {
      neonRef = await neon.createBranch(handle, name, parent.neon_branch_ref)
      if (!neonRef) throw new Error('neon createBranch returned no branch id')
      const upd = await this.db.from('branches').update({ neon_branch_ref: neonRef, status: 'active' }).eq('id', row.id)
      if (upd.error) throw upd.error

      const bundle = await neon.mintCredentials(handle, neonRef)
      for (const [key, value] of Object.entries(bundle)) {
        const enc = encryptSecret(value, this.cfg.keks, this.cfg.currentKek)
        const sec = await this.db.from('secrets').insert({
          project_id: projectId, owner, branch_id: row.id, name: key,
          ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion,
        }).select()
        if (sec.error) throw sec.error
      }
      return { branch: { id: row.id, name, parentBranchId: parent.id } }
    } catch (err) {
      // best-effort rollback — never mask the original error
      try { if (neonRef) await neon.deleteBranch(handle, neonRef) } catch { /* best-effort */ }
      try { await this.db.from('branches').update({ status: 'error' }).eq('id', row.id) } catch { /* best-effort */ }
      throw err
    }
  }
}

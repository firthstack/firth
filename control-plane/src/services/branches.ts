import type { DataClient } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ProviderAdapter, ResourceHandle, StorageAdapter } from '../adapters/types.js'
import { BranchesRepo, ResourcesRepo, firstOrThrow } from '../db/repos.js'
import { encryptSecret } from '../crypto/secrets.js'

export class BranchService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async createBranch(owner: string, projectId: string, name: string, fromName = 'main'): Promise<{
    branch: { id: string; name: string; parentBranchId: string }
  }> {
    const neon = this.adapters.find((a) => a.kind === 'neon')
    if (!neon) throw new Error('neon adapter not configured')

    const resources = new ResourcesRepo(this.db)
    const resource = await resources.findByKind(owner, projectId, 'neon')
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

    const s3 = this.adapters.find((a) => a.kind === 's3') as StorageAdapter | undefined
    let neonRef: string | null = null
    let s3ForkHandle: ResourceHandle | null = null
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

      // Storage fork (CoW): if the project's root bucket is snapshot-enabled, give this branch its
      // own forked bucket so storage is isolated per branch (mirrors the Neon DB branch). Legacy
      // projects (root bucket created before snapshots) skip this and keep shared storage.
      const root = await resources.findRootByKind(owner, projectId, 's3')
      if (s3?.forkBucket && root && (root.provider_ref as { snapshotEnabled?: boolean }).snapshotEnabled) {
        // Fork from the PARENT branch's bucket (mirrors the DB --from): root for default, the
        // parent's branch-scoped bucket otherwise. CoW chains are fine (Tigris recursive lookups).
        const parentS3 = parent.is_default
          ? root
          : await resources.findByKindForBranch(owner, projectId, parent.id, 's3')
        const parentHandle: ResourceHandle = { kind: 's3', providerRef: (parentS3 ?? root).provider_ref }
        s3ForkHandle = await s3.forkBucket(parentHandle, name)
        const ins = await this.db.from('resources').insert({
          project_id: projectId, owner, kind: 's3', branch_id: row.id,
          provider_ref: s3ForkHandle.providerRef, status: 'active',
        }).select()
        if (ins.error) throw ins.error
        const s3ResourceId = (firstOrThrow(ins.data, 'resource') as { id: string }).id
        // mintCredentials enriches providerRef with accessKeyId+policyArn — re-persist it so destroy can clean up.
        const s3Bundle = await s3.mintCredentials(s3ForkHandle)
        const repersist = await this.db.from('resources').update({ provider_ref: s3ForkHandle.providerRef }).eq('id', s3ResourceId)
        if (repersist.error) throw repersist.error
        for (const [key, value] of Object.entries(s3Bundle)) {
          const enc = encryptSecret(value, this.cfg.keks, this.cfg.currentKek)
          const sec = await this.db.from('secrets').insert({
            project_id: projectId, owner, branch_id: row.id, name: key,
            ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion,
          }).select()
          if (sec.error) throw sec.error
        }
      }

      // Compute is provisioned LAZILY on first deploy (see DeployService.ensureCompute),
      // not here — so a branch is a DB+storage environment until something is deployed to it.

      return { branch: { id: row.id, name, parentBranchId: parent.id } }
    } catch (err) {
      // best-effort rollback; never mask the original error
      try { if (s3ForkHandle && s3) await s3.destroy(s3ForkHandle) } catch { /* best-effort */ }
      try { if (neonRef) await neon.deleteBranch(handle, neonRef) } catch { /* best-effort */ }
      try { await this.db.from('branches').update({ status: 'error' }).eq('id', row.id) } catch { /* best-effort */ }
      throw err
    }
  }
}

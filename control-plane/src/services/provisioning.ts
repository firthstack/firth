import { ProjectService } from './projects.js'
import { firstOrThrow } from '../db/repos.js'
import type { DataClient, Project } from '../db/types.js'
import type { FirthConfig } from '../config.js'
import type { ProviderAdapter, ResourceHandle } from '../adapters/types.js'
import { encryptSecret } from '../crypto/secrets.js'

export type ProvisionResult = {
  project: Project
  defaultBranch: { id: string; name: string }
  resources: Array<{ kind: string; status: string }>
}

export class ProvisioningService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async provisionProject(owner: string, name: string): Promise<ProvisionResult> {
    const { project, defaultBranch } = await new ProjectService(this.db).createProject(owner, name)
    const done: Array<{ adapter: ProviderAdapter; handle: ResourceHandle; resourceId: string }> = []
    try {
      for (const adapter of this.adapters) {
        const ins = await this.db.from('resources')
          .insert({ project_id: project.id, owner, kind: adapter.kind, status: 'provisioning', provider_ref: {} })
          .select()
        if (ins.error) throw ins.error
        const resourceId = (firstOrThrow(ins.data, 'resource') as { id: string }).id

        const handle = await adapter.provision(name)
        done.push({ adapter, handle, resourceId })

        const upd = await this.db.from('resources')
          .update({ provider_ref: handle.providerRef, status: 'active' }).eq('id', resourceId)
        if (upd.error) throw upd.error

        if (adapter.kind === 'neon') {
          const branchRef = (handle.providerRef as { defaultBranchId: string }).defaultBranchId
          const bu = await this.db.from('branches').update({ neon_branch_ref: branchRef }).eq('id', defaultBranch.id)
          if (bu.error) throw bu.error
          const bundle = await adapter.mintCredentials(handle, branchRef)
          for (const [key, value] of Object.entries(bundle)) {
            const enc = encryptSecret(value, this.cfg.keks, this.cfg.currentKek)
            const sec = await this.db.from('secrets').insert({
              project_id: project.id, owner, branch_id: defaultBranch.id, name: key,
              ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion,
            }).select()
            if (sec.error) throw sec.error
          }
        }
      }
      return {
        project, defaultBranch,
        resources: done.map((d) => ({ kind: d.adapter.kind, status: 'active' })),
      }
    } catch (err) {
      // Rollback bookkeeping is BEST-EFFORT: every step is individually guarded so a
      // destroy or DB fault during cleanup can never replace the original error.
      for (const d of [...done].reverse()) {
        try { await d.adapter.destroy(d.handle) } catch { /* best-effort: never mask err */ }
        try { await this.db.from('resources').update({ status: 'error' }).eq('id', d.resourceId) } catch { /* best-effort */ }
      }
      // If we inserted a resource row but failed before pushing a handle, mark stragglers error.
      try {
        const pending = await this.db.from('resources').select().eq('project_id', project.id).eq('status', 'provisioning')
        for (const r of (pending.data ?? [])) {
          try { await this.db.from('resources').update({ status: 'error' }).eq('id', (r as { id: string }).id) } catch { /* best-effort */ }
        }
      } catch { /* best-effort: never mask err */ }
      throw err
    }
  }
}

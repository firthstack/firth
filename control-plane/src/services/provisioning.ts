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

// Tracks a provisioned handle that must be destroyed on rollback.
type RollbackEntry = { adapter: ProviderAdapter; handle: ResourceHandle; resourceId: string }

export class ProvisioningService {
  constructor(private db: DataClient, private cfg: FirthConfig, private adapters: ProviderAdapter[]) {}

  async provisionProject(owner: string, name: string): Promise<ProvisionResult> {
    const { project, defaultBranch } = await new ProjectService(this.db).createProject(owner, name)

    // Entries registered as soon as provision() returns, even if the rest of the routine fails.
    // This ensures the destroy() cleanup covers handles that were obtained but whose post-processing failed.
    const provisioned: RollbackEntry[] = []

    // Provision all adapters concurrently. Each routine is self-contained: it inserts its
    // resource row, calls provision, post-processes (credential minting + secret storage),
    // and returns its handle for rollback use. Errors are collected via allSettled so that
    // one adapter's failure does not cancel concurrent work mid-flight.
    const results = await Promise.allSettled(
      this.adapters.map(async (adapter): Promise<RollbackEntry> => {
        const ins = await this.db.from('resources')
          .insert({
            project_id: project.id, owner, kind: adapter.kind,
            branch_id: adapter.kind === 'fly' ? defaultBranch.id : null,
            status: 'provisioning', provider_ref: {},
          })
          .select()
        if (ins.error) throw ins.error
        const resourceId = (firstOrThrow(ins.data, 'resource') as { id: string }).id

        const handle = await adapter.provision(name)

        // Register for rollback as soon as we have a live handle — before any post-processing
        // that could fail. Any subsequent error in this routine will cause rollback to call destroy().
        provisioned.push({ adapter, handle, resourceId })

        const upd = await this.db.from('resources')
          .update({ provider_ref: handle.providerRef, status: 'active' }).eq('id', resourceId)
        if (upd.error) throw upd.error

        // Per-kind post-provision: neon is branch-scoped; all others are project-scoped.
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
        } else {
          // S3 buckets and Fly apps are project-scoped (branch_id null): the bucket is shared
          // across branches, and Fly mints no credentials at all.
          const bundle = await adapter.mintCredentials(handle)

          // Re-persist providerRef: mintCredentials may have enriched it with minted handles
          // (e.g. TigrisAdapter adds accessKeyId + policyArn). Generic — harmless for adapters
          // whose mint does not mutate the handle.
          const repersist = await this.db.from('resources').update({ provider_ref: handle.providerRef }).eq('id', resourceId)
          if (repersist.error) throw repersist.error

          for (const [key, value] of Object.entries(bundle)) {
            const enc = encryptSecret(value, this.cfg.keks, this.cfg.currentKek)
            const sec = await this.db.from('secrets').insert({
              project_id: project.id, owner, branch_id: null, name: key,
              ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion,
            }).select()
            if (sec.error) throw sec.error
          }
        }

        return { adapter, handle, resourceId }
      }),
    )

    const succeeded: RollbackEntry[] = []
    let firstRejection: unknown | undefined
    for (const r of results) {
      if (r.status === 'fulfilled') succeeded.push(r.value)
      else if (firstRejection === undefined) firstRejection = r.reason
    }

    if (firstRejection !== undefined) {
      // Rollback bookkeeping is BEST-EFFORT: every step is individually guarded so a
      // destroy or DB fault during cleanup can never replace the original error.
      // Use the `provisioned` list (not `succeeded`) so handles obtained mid-flight are also destroyed.
      // Order is not reversed: adapters provision concurrently, so insertion order is non-deterministic
      // and LIFO teardown carries no meaning here.
      for (const d of provisioned) {
        try { await d.adapter.destroy(d.handle) } catch { /* best-effort: never mask err */ }
        try { await this.db.from('resources').update({ status: 'error' }).eq('id', d.resourceId) } catch { /* best-effort */ }
      }
      // If we inserted a resource row but failed before pushing a handle, mark stragglers error.
      // Safe to sweep by project_id: this project was just created and is exclusively owned by this
      // saga — the concurrent adapters all run inside this single saga invocation, so no other actor
      // holds this project_id.
      try {
        const pending = await this.db.from('resources').select().eq('project_id', project.id).eq('status', 'provisioning')
        for (const r of (pending.data ?? [])) {
          try { await this.db.from('resources').update({ status: 'error' }).eq('id', (r as { id: string }).id) } catch { /* best-effort */ }
        }
      } catch { /* best-effort: never mask err */ }
      throw firstRejection
    }

    return {
      project, defaultBranch,
      resources: succeeded.map((d) => ({ kind: d.adapter.kind, status: 'active' })),
    }
  }
}

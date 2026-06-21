import type { DataClient, Decision, ApprovalRow, ApprovalStatus } from '../db/types.js'
import { GovernanceRepo } from '../db/repos.js'
import { NotFoundError } from '../auth.js'

export const GATED_ACTIONS = ['secrets.read', 'deploy', 'project.delete', 'branch.delete'] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]
export function isGatedAction(a: string): a is GatedAction { return (GATED_ACTIONS as readonly string[]).includes(a) }

const DEFAULTS: Record<GatedAction, Decision> = {
  'secrets.read': 'allow', deploy: 'allow', 'project.delete': 'approve', 'branch.delete': 'allow',
}

export type GateResult =
  | { decision: 'allow' }
  | { decision: 'deny' }
  | { decision: 'approval_required'; approvalId: string }
  | { decision: 'approved'; approvalId: string }

export class GovernService {
  private repo: GovernanceRepo
  constructor(db: DataClient) { this.repo = new GovernanceRepo(db) }

  async gate(owner: string, projectId: string, action: GatedAction): Promise<GateResult> {
    const rule = await this.repo.findRule(owner, projectId, action)
    const decision = rule?.decision ?? DEFAULTS[action]
    if (decision === 'allow') return { decision: 'allow' }
    if (decision === 'deny') return { decision: 'deny' }
    // approve: consume an existing grant, else create a pending approval
    const granted = await this.repo.findGrantedApproval(owner, projectId, action)
    if (granted) { await this.repo.markConsumed(owner, granted.id); return { decision: 'approved', approvalId: granted.id } }
    const pending = await this.repo.createApproval(owner, projectId, action)
    return { decision: 'approval_required', approvalId: pending.id }
  }

  async effectivePolicy(owner: string, projectId: string): Promise<Record<GatedAction, Decision>> {
    const rules = await this.repo.listRules(owner, projectId)
    const map: Record<GatedAction, Decision> = { ...DEFAULTS }
    for (const r of rules) if (isGatedAction(r.action)) map[r.action] = r.decision
    return map
  }

  async setRule(owner: string, projectId: string, action: GatedAction, decision: Decision): Promise<void> {
    await this.repo.upsertRule(owner, projectId, action, decision)
  }

  async listApprovals(owner: string, projectId: string, status?: ApprovalStatus): Promise<ApprovalRow[]> {
    return this.repo.listApprovals(owner, projectId, status)
  }

  async decide(owner: string, projectId: string, approvalId: string, status: 'granted' | 'denied'): Promise<ApprovalRow> {
    const found = await this.repo.findApproval(owner, projectId, approvalId)
    if (!found) throw new NotFoundError('approval not found')
    await this.repo.decideApproval(owner, approvalId, status)
    const updated = await this.repo.findApproval(owner, projectId, approvalId)
    if (!updated) throw new NotFoundError('approval not found')
    return updated
  }
}

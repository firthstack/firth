export type Project = { id: string; name: string; status: string; created_at?: string }
export type Branch = {
  id: string
  name: string
  is_default: boolean
  neon_branch_ref: string | null
  status: string
  parent_branch_id?: string | null
  created_at?: string
}
export type Resource = { kind: string; status: string; branch_id?: string; provider_ref: Record<string, unknown> }
export type ProjectDetail = { project: Project; branches: Branch[]; resources: Resource[] }

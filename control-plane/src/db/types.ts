export type Project = { id: string; owner: string; name: string; status: string }
export type NewSecretRow = {
  project_id: string; owner: string; branch_id: string | null
  name: string; ciphertext: string; nonce: string; kek_version: string
}
export type SecretRow = NewSecretRow & { id: string }
export type ResourceRow = {
  id: string; project_id: string; owner: string
  kind: string; provider_ref: Record<string, unknown>; status: string
  branch_id?: string | null
}
export type BranchRow = {
  id: string; project_id: string; owner: string; name: string
  parent_branch_id: string | null; is_default: boolean
  neon_branch_ref: string | null; status: string
}

export type NewEventRow = {
  project_id: string; owner: string; branch_id: string | null
  source: 'agent' | 'resource'; kind: string; payload: Record<string, unknown>
  dedup_key?: string | null
}
export type EventRow = NewEventRow & { id: string; created_at: string }

export type Decision = 'allow' | 'deny' | 'approve'
export type GovernanceRuleRow = { id: string; project_id: string; owner: string; action: string; decision: Decision; updated_at?: string }
export type ApprovalStatus = 'pending' | 'granted' | 'denied' | 'consumed'
export type ApprovalRow = {
  id: string; project_id: string; owner: string; action: string
  status: ApprovalStatus; requested_at: string; decided_at: string | null
}

// The subset of @insforge/sdk's `database` query builder we depend on.
export interface QueryBuilder {
  insert(values: object | object[]): QueryBuilder
  upsert(values: object | object[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): QueryBuilder
  update(values: object): QueryBuilder
  select(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  is(column: string, value: unknown): QueryBuilder
  then<T>(onfulfilled: (r: { data: any[] | null; error: Error | null }) => T): Promise<T>
}
export interface DataClient { from(table: string): QueryBuilder }

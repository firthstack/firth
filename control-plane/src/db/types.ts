export type Project = { id: string; owner: string; name: string; status: string }
export type NewSecretRow = {
  project_id: string; owner: string; branch_id: string | null
  name: string; ciphertext: string; nonce: string; kek_version: string
}
export type SecretRow = NewSecretRow & { id: string }

// The subset of @insforge/sdk's `database` query builder we depend on.
export interface QueryBuilder {
  insert(values: object | object[]): QueryBuilder
  select(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  is(column: string, value: unknown): QueryBuilder
  then<T>(onfulfilled: (r: { data: any[] | null; error: Error | null }) => T): Promise<T>
}
export interface DataClient { from(table: string): QueryBuilder }

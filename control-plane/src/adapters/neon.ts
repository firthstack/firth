import type { HttpClient, ProviderAdapter, ResourceHandle, SecretBundle, UsageSnapshot } from './types.js'

const NEON_BASE = 'https://console.neon.tech/api/v2'
const TERMINAL = ['finished', 'skipped', 'cancelled']

export type NeonRef = { neonProjectId: string; defaultBranchId: string; dbName: string; roleName: string }
export type NeonOptions = {
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  pollAttempts?: number
}

export class NeonAdapter implements ProviderAdapter {
  readonly kind = 'neon' as const
  readonly branchModel = 'native' as const
  private baseUrl: string
  private sleep: (ms: number) => Promise<void>
  private pollMs: number
  private pollAttempts: number

  constructor(private apiKey: string, private http: HttpClient, opts: NeonOptions = {}) {
    this.baseUrl = opts.baseUrl ?? NEON_BASE
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.pollMs = opts.pollMs ?? 2000
    this.pollAttempts = opts.pollAttempts ?? 60
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.http(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status < 200 || res.status >= 300) {
      // status only — never echo the request body or the bearer key
      throw new Error(`neon ${method} ${path} failed: ${res.status}`)
    }
    return res.json()
  }

  private async awaitOps(projectId: string, operations: Array<{ id: string; status: string }>): Promise<void> {
    for (const op of operations ?? []) {
      let status = op.status
      if (status === 'failed') throw new Error(`neon operation ${op.id} failed`)
      let attempts = 0
      while (!TERMINAL.includes(status)) {
        if (++attempts > this.pollAttempts) {
          throw new Error(`neon operation ${op.id} did not finish after ${this.pollAttempts} polls (last status: ${status})`)
        }
        await this.sleep(this.pollMs)
        const got = await this.call('GET', `/projects/${projectId}/operations/${op.id}`)
        status = got.operation?.status ?? got.status
        if (status === 'failed') throw new Error(`neon operation ${op.id} failed`)
      }
    }
  }

  async provision(projectName: string): Promise<ResourceHandle> {
    const data = await this.call('POST', '/projects', { project: { name: projectName } })
    const providerRef: NeonRef = {
      neonProjectId: data.project.id,
      defaultBranchId: data.branch.id,
      dbName: data.databases[0].name,
      roleName: data.roles[0].name,
    }
    await this.awaitOps(providerRef.neonProjectId, data.operations)
    return { kind: 'neon', providerRef }
  }

  async destroy(handle: ResourceHandle): Promise<void> {
    const ref = handle.providerRef as NeonRef
    await this.call('DELETE', `/projects/${ref.neonProjectId}`)
  }

  async createBranch(handle: ResourceHandle, name: string, parentRef?: string): Promise<string | null> {
    const ref = handle.providerRef as NeonRef
    const parent_id = parentRef ?? ref.defaultBranchId
    const data = await this.call('POST', `/projects/${ref.neonProjectId}/branches`, {
      branch: { name, parent_id },
      endpoints: [{ type: 'read_write' }],
    })
    await this.awaitOps(ref.neonProjectId, data.operations)
    return data.branch.id as string
  }

  async mintCredentials(handle: ResourceHandle, branchRef?: string): Promise<SecretBundle> {
    const ref = handle.providerRef as NeonRef
    const branchId = branchRef ?? ref.defaultBranchId
    const qs = new URLSearchParams({
      branch_id: branchId,
      database_name: ref.dbName,
      role_name: ref.roleName,
    }).toString()
    const data = await this.call('GET', `/projects/${ref.neonProjectId}/connection_uri?${qs}`)
    return { DATABASE_URL: data.uri }
  }

  async readUsage(_handle: ResourceHandle): Promise<UsageSnapshot> {
    return {} // metering is out of scope for v1 (ARCHITECTURE.md §2)
  }
}

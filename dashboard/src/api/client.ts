import type { Project, ProjectDetail } from '../types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export type Fetcher = typeof fetch

export class Api {
  private refreshing: Promise<boolean> | null = null
  constructor(
    private baseUrl: string,
    private getToken: () => string | null,
    // Wrap global fetch so it's always invoked with the correct receiver. A bare
    // `= fetch` stored on `this.fetcher` and called as `this.fetcher(...)` runs fetch
    // with `this` = the Api instance, which browsers reject ("Illegal invocation").
    private fetcher: Fetcher = (...args: Parameters<typeof fetch>) => fetch(...args),
    private opts: {
      getRefreshToken?: () => string | null
      onTokens?: (t: { token: string; refreshToken: string }) => void
      onAuthLost?: () => void
    } = {},
  ) {}

  private send(method: string, path: string, body?: unknown) {
    const token = this.getToken()
    return this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  // Single-flight: concurrent 401s share one refresh (rotation makes parallel refreshes
  // invalidate each other). Resolves true once the token is rotated + persisted.
  private refreshOnce(): Promise<boolean> {
    if (!this.refreshing) this.refreshing = this.doRefresh().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = this.opts.getRefreshToken?.()
    if (!refreshToken) return false
    const res = await this.fetcher(`${this.baseUrl}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) { this.opts.onAuthLost?.(); return false }
    const data = await res.json()
    this.opts.onTokens?.({ token: data.token, refreshToken: data.refreshToken })
    return true
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    let res = await this.send(method, path, body)
    if (res.status === 401 && this.opts.getRefreshToken?.()) {
      if (await this.refreshOnce()) res = await this.send(method, path, body)
    }
    if (!res.ok) {
      let msg = ''
      try { msg = (await res.json())?.error ?? '' } catch { /* ignore */ }
      throw new ApiError(res.status, msg || `request failed: ${res.status}`)
    }
    return res.json()
  }

  listProjects(): Promise<Project[]> {
    return this.req('GET', '/projects').then((r) => r.projects)
  }

  getProject(id: string): Promise<ProjectDetail> {
    return this.req('GET', `/projects/${id}`)
  }

  createProject(name: string) {
    return this.req('POST', '/projects', { name })
  }

  deleteProject(id: string) {
    return this.req('DELETE', `/projects/${id}`)
  }

  createBranch(projectId: string, name: string, from: string) {
    return this.req('POST', `/projects/${projectId}/branches`, { name, from })
  }

  deleteBranch(projectId: string, branchId: string) {
    return this.req('DELETE', `/projects/${projectId}/branches/${branchId}`)
  }

  getSecrets(projectId: string, branch?: string): Promise<{ secrets?: Record<string, string>; status?: string; approvalId?: string; action?: string }> {
    const q = branch ? `?branch=${encodeURIComponent(branch)}` : ''
    return this.req('GET', `/projects/${projectId}/secrets${q}`)
  }

  listApprovals(projectId: string, status?: string): Promise<Array<{ id: string; action: string; status: string; requested_at: string }>> {
    const q = status ? `?status=${status}` : ''
    return this.req('GET', `/projects/${projectId}/approvals${q}`).then((r) => r.approvals)
  }
  approve(projectId: string, id: string) { return this.req('POST', `/projects/${projectId}/approvals/${id}/approve`) }
  deny(projectId: string, id: string) { return this.req('POST', `/projects/${projectId}/approvals/${id}/deny`) }
}

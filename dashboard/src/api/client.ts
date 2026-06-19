import type { Project, ProjectDetail } from '../types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export type Fetcher = typeof fetch

export class Api {
  constructor(
    private baseUrl: string,
    private getToken: () => string | null,
    // Wrap global fetch so it's always invoked with the correct receiver. A bare
    // `= fetch` stored on `this.fetcher` and called as `this.fetcher(...)` runs fetch
    // with `this` = the Api instance, which browsers reject ("Illegal invocation").
    private fetcher: Fetcher = (...args: Parameters<typeof fetch>) => fetch(...args),
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const token = this.getToken()
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      let msg = ''
      try {
        msg = (await res.json())?.error ?? ''
      } catch {
        /* ignore */
      }
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

  getSecrets(projectId: string, branch?: string): Promise<Record<string, string>> {
    const q = branch ? `?branch=${encodeURIComponent(branch)}` : ''
    return this.req('GET', `/projects/${projectId}/secrets${q}`).then((r) => r.secrets)
  }
}

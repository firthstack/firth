export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<any>; text(): Promise<string> }>

const realFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
  return { status: res.status, json: () => res.json(), text: () => res.text() }
}

export class FirthApi {
  constructor(private apiUrl: string, private token: string, private fetcher: Fetcher = realFetcher) {}

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetcher(`${this.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status < 200 || res.status >= 300) {
      let msg = ''
      try { msg = (await res.json())?.error ?? '' } catch { /* ignore */ }
      throw new Error(`request failed: ${res.status}${msg ? ` ${msg}` : ''}`)
    }
    return res.json()
  }

  createProject(name: string) { return this.req('POST', '/projects', { name }) }
  listProjects() { return this.req('GET', '/projects').then((r) => r.projects as any[]) }
  createBranch(projectId: string, name: string, from: string) {
    return this.req('POST', `/projects/${projectId}/branches`, { name, from })
  }
  listBranches(projectId: string) { return this.req('GET', `/projects/${projectId}/branches`).then((r) => r.branches as any[]) }
  getSecrets(projectId: string, branch?: string) {
    const q = branch ? `?branch=${encodeURIComponent(branch)}` : ''
    return this.req('GET', `/projects/${projectId}/secrets${q}`).then((r) => r.secrets as Record<string, string>)
  }
  deploy(projectId: string, opts: { image: string; from?: string; port?: number; branch?: string }) {
    return this.req('POST', `/projects/${projectId}/deploy`, opts)
  }
  mintDeployToken(projectId: string, opts: { from?: string; branch?: string }): Promise<{ token: string; expirySeconds: number; flyApp: string }> {
    return this.req('POST', `/projects/${projectId}/deploy-token`, opts)
  }
  listEvents(projectId: string, opts: { branch?: string; limit?: number } = {}) {
    const qs = new URLSearchParams()
    if (opts.branch) qs.set('branch', opts.branch)
    if (opts.limit) qs.set('limit', String(opts.limit))
    const q = qs.toString()
    return this.req('GET', `/projects/${projectId}/events${q ? `?${q}` : ''}`).then((r) => r.events as any[])
  }
  postEvents(projectId: string, events: unknown[]): Promise<{ recorded: number; skipped: number }> {
    return this.req('POST', `/projects/${projectId}/events`, { events })
  }
  deleteProject(id: string) { return this.req('DELETE', `/projects/${id}`) }
  deleteBranch(projectId: string, branchId: string) { return this.req('DELETE', `/projects/${projectId}/branches/${branchId}`) }
  login(email: string, password: string): Promise<{ token: string; user: { id: string; email: string } }> {
    return this.req('POST', '/auth/login', { email, password })
  }
}

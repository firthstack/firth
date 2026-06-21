import { expect, test } from 'vitest'
import { FirthApi } from '../src/api.js'

function fetcher(routes: Array<{ match: (u: string, i: any) => boolean; status?: number; body?: any }>) {
  const calls: any[] = []
  const fn = async (url: string, init: any) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init)); if (!r) throw new Error(`unexpected ${init.method} ${url}`)
    return { status: r.status ?? 200, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) }
  }
  return { fn, calls }
}

test('createProject POSTs with Bearer token and returns the body', async () => {
  const { fn, calls } = fetcher([{ match: (u, i) => i.method === 'POST' && u.endsWith('/projects'), status: 201, body: { project: { id: 'p1' } } }])
  const api = new FirthApi('https://cp', 'tok', fn as any)
  const out = await api.createProject('demo')
  expect(out.project.id).toBe('p1')
  expect(calls[0].init.headers.Authorization).toBe('Bearer tok')
  expect(JSON.parse(calls[0].init.body)).toEqual({ name: 'demo' })
})

test('non-2xx throws with the API error string', async () => {
  const { fn } = fetcher([{ match: () => true, status: 401, body: { error: 'unauthorized' } }])
  const api = new FirthApi('https://cp', 'tok', fn as any)
  await expect(api.listProjects()).rejects.toThrow(/401.*unauthorized/)
})

test('deleteProject sends DELETE /projects/:id', async () => {
  const { fn, calls } = fetcher([{ match: (u, i) => i.method === 'DELETE' && u.endsWith('/projects/p1'), body: { project: {}, teardown: { destroyed: [], failed: [] } } }])
  const api = new FirthApi('https://cp', 'tok', fn as any)
  const out = await api.deleteProject('p1')
  expect(calls[0].init.method).toBe('DELETE')
  expect(calls[0].url).toBe('https://cp/projects/p1')
  expect(out.project).toBeDefined()
})

test('deleteBranch sends DELETE /projects/:projectId/branches/:branchId', async () => {
  const { fn, calls } = fetcher([{ match: (u, i) => i.method === 'DELETE' && u.endsWith('/projects/p1/branches/b1'), body: { project: {}, teardown: { destroyed: [], failed: [] } } }])
  const api = new FirthApi('https://cp', 'tok', fn as any)
  const out = await api.deleteBranch('p1', 'b1')
  expect(calls[0].init.method).toBe('DELETE')
  expect(calls[0].url).toBe('https://cp/projects/p1/branches/b1')
  expect(out.project).toBeDefined()
})

function resp(status: number, body: any) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) }
}

test('refreshes once on 401, persists the rotated pair, retries, and returns the result', async () => {
  const seen: Array<{ url: string; auth?: string; body?: any }> = []
  const queue = [
    resp(401, { error: 'unauthorized' }),                         // 1st: GET /projects → expired
    resp(200, { token: 'acc-2', refreshToken: 'ref-2' }),         // 2nd: POST /auth/refresh
    resp(200, { projects: [{ id: 'p1' }] }),                      // 3rd: GET /projects retried
  ]
  const fetcher = (async (url: string, init: any) => {
    seen.push({ url, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined })
    return queue.shift()!
  }) as any
  let persisted: any
  const api = new FirthApi('http://cp', 'acc-1', fetcher, { refreshToken: 'ref-1', onTokens: (t) => { persisted = t } })
  const projects = await api.listProjects()
  expect(projects).toEqual([{ id: 'p1' }])
  expect(seen[1].url).toBe('http://cp/auth/refresh')
  expect(seen[1].body).toEqual({ refreshToken: 'ref-1' })
  expect(persisted).toEqual({ token: 'acc-2', refreshToken: 'ref-2' })
  expect(seen[2].auth).toBe('Bearer acc-2')                       // retry uses the new token
})

test('a 2xx response triggers no refresh', async () => {
  const seen: string[] = []
  const fetcher = (async (url: string) => { seen.push(url); return resp(200, { projects: [] }) }) as any
  const api = new FirthApi('http://cp', 'acc-1', fetcher, { refreshToken: 'ref-1' })
  await api.listProjects()
  expect(seen).toEqual(['http://cp/projects'])                    // no /auth/refresh
})

test('refresh failure surfaces a session-expired error, no retry loop', async () => {
  const queue = [resp(401, { error: 'unauthorized' }), resp(401, { error: 'invalid refresh token' })]
  const fetcher = (async () => queue.shift() ?? resp(500, {})) as any
  const api = new FirthApi('http://cp', 'acc-1', fetcher, { refreshToken: 'ref-1' })
  await expect(api.listProjects()).rejects.toThrow(/firth login/)
})

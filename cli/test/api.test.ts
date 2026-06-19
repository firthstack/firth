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

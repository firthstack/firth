import { describe, it, expect, vi } from 'vitest'
import { Api, ApiError } from './client'

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function resp(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('Api', () => {
  it('listProjects returns the array and sends a Bearer token', async () => {
    const fetcher = vi.fn(async () => jsonRes(200, { projects: [{ id: 'p1', name: 'a', status: 'active' }] }))
    const api = new Api('http://api', () => 'tok-1', fetcher as any)
    const projects = await api.listProjects()
    expect(projects).toEqual([{ id: 'p1', name: 'a', status: 'active' }])
    const [url, init] = fetcher.mock.calls[0] as any
    expect(url).toBe('http://api/projects')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer tok-1')
  })

  it('omits the Authorization header when there is no token', async () => {
    const fetcher = vi.fn(async () => jsonRes(200, { projects: [] }))
    const api = new Api('http://api', () => null, fetcher as any)
    await api.listProjects()
    const [, init] = fetcher.mock.calls[0] as any
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('a non-ok response throws ApiError with status and the server error string', async () => {
    const fetcher = vi.fn(async () => jsonRes(404, { error: 'project not found' }))
    const api = new Api('http://api', () => 'tok-1', fetcher as any)
    await expect(api.getProject('nope')).rejects.toMatchObject({ status: 404, message: 'project not found' })
    await expect(api.getProject('nope')).rejects.toBeInstanceOf(ApiError)
  })

  it('default fetcher wraps global fetch (not the bare reference) to avoid Illegal invocation', () => {
    // A bare `private fetcher = fetch` would make this `toBe(fetch)` and throw
    // "Illegal invocation" in the browser when called as `this.fetcher(...)`.
    const api = new Api('http://api', () => null) as any
    expect(typeof api.fetcher).toBe('function')
    expect(api.fetcher).not.toBe(fetch)
  })

  it('deleteProject hits the DELETE path', async () => {
    const fetcher = vi.fn(async () => jsonRes(200, { teardown: { destroyed: [], failed: [] } }))
    const api = new Api('http://api', () => 'tok-1', fetcher as any)
    await api.deleteProject('p1')
    const [url, init] = fetcher.mock.calls[0] as any
    expect(url).toBe('http://api/projects/p1')
    expect(init.method).toBe('DELETE')
  })

  it('getSecrets with branch hits GET /projects/:id/secrets?branch=... and returns .secrets', async () => {
    const fetcher = vi.fn(async () => jsonRes(200, { secrets: { DATABASE_URL: 'postgres://u:p@h/db' } }))
    const api = new Api('http://api', () => 'tok-1', fetcher as any)
    const secrets = await api.getSecrets('p1', 'b1')
    expect(secrets).toEqual({ DATABASE_URL: 'postgres://u:p@h/db' })
    const [url, init] = fetcher.mock.calls[0] as any
    expect(url).toBe('http://api/projects/p1/secrets?branch=b1')
    expect(init.method).toBe('GET')
  })

  it('getSecrets without branch hits GET /projects/:id/secrets (no query string)', async () => {
    const fetcher = vi.fn(async () => jsonRes(200, { secrets: { AWS_ACCESS_KEY_ID: 'tid_x' } }))
    const api = new Api('http://api', () => 'tok-1', fetcher as any)
    const secrets = await api.getSecrets('p1')
    expect(secrets).toEqual({ AWS_ACCESS_KEY_ID: 'tid_x' })
    const [url] = fetcher.mock.calls[0] as any
    expect(url).toBe('http://api/projects/p1/secrets')
  })

  it('refreshes once on 401, persists the pair, retries, and returns the result', async () => {
    const queue = [resp(401, { error: 'unauthorized' }), resp(200, { token: 't2', refreshToken: 'r2' }), resp(200, { projects: [{ id: 'p1' }] })]
    const seen: string[] = []
    const fetcher = ((url: string) => { seen.push(url); return Promise.resolve(queue.shift()!) }) as unknown as typeof fetch
    let persisted: any
    let token = 't1'
    const api = new Api('http://cp', () => token, fetcher, {
      getRefreshToken: () => 'r1',
      onTokens: (t) => { persisted = t; token = t.token },
    })
    const projects = await api.listProjects()
    expect(projects).toEqual([{ id: 'p1' }])
    expect(seen).toEqual(['http://cp/projects', 'http://cp/auth/refresh', 'http://cp/projects'])
    expect(persisted).toEqual({ token: 't2', refreshToken: 'r2' })
  })

  it('two concurrent 401s trigger only one refresh (single-flight)', async () => {
    let refreshCalls = 0
    let token = 't1'
    const fetcher = ((url: string) => {
      if (url.endsWith('/auth/refresh')) { refreshCalls++; return Promise.resolve(resp(200, { token: 't2', refreshToken: 'r2' })) }
      return Promise.resolve(token === 't1' ? resp(401, {}) : resp(200, { projects: [] }))
    }) as unknown as typeof fetch
    const api = new Api('http://cp', () => token, fetcher, { getRefreshToken: () => 'r1', onTokens: (t) => { token = t.token } })
    await Promise.all([api.listProjects(), api.listProjects()])
    expect(refreshCalls).toBe(1)
  })

  it('refresh failure clears tokens and propagates the 401', async () => {
    const queue = [resp(401, {}), resp(401, { error: 'invalid refresh token' })]
    const fetcher = (() => Promise.resolve(queue.shift() ?? resp(500, {}))) as unknown as typeof fetch
    let cleared = false
    const api = new Api('http://cp', () => 't1', fetcher, { getRefreshToken: () => 'r1', onAuthLost: () => { cleared = true } })
    await expect(api.listProjects()).rejects.toMatchObject({ status: 401 })
    expect(cleared).toBe(true)
  })
})

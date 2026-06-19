import { describe, it, expect, vi } from 'vitest'
import { Api, ApiError } from './client'

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
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
})

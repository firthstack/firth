import { describe, expect, test } from 'vitest'
import { FlyAdapter } from '../../src/adapters/fly.js'
import type { HttpClient } from '../../src/adapters/types.js'

function fakeHttp(routes: Array<{ match: (u: string, i: any) => boolean; status?: number; body?: any }>) {
  const calls: Array<{ url: string; init: any }> = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init))
    if (!r) throw new Error(`unexpected: ${init.method} ${url}`)
    return { status: r.status ?? 200, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) }
  }
  return { http, calls }
}

describe('FlyAdapter', () => {
  test('provision POSTs /apps with app_name + org_slug and returns a providerRef', async () => {
    const { http, calls } = fakeHttp([{ match: (u, i) => i.method === 'POST' && u.endsWith('/apps'), status: 201, body: {} }])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    const handle = await adapter.provision('My App')
    expect(handle.kind).toBe('fly')
    expect((handle.providerRef as any).orgSlug).toBe('firth-org')
    const body = JSON.parse(calls[0].init.body)
    expect(body.org_slug).toBe('firth-org')
    expect(body.app_name).toMatch(/^firth-my-app-[a-z0-9]+$/) // sanitized + unique suffix
    expect(calls[0].init.headers.Authorization).toBe('Bearer fly_tok')
    expect((handle.providerRef as any).flyApp).toBe(body.app_name)
  })

  test('destroy DELETEs /apps/{name} with force=true', async () => {
    const { http, calls } = fakeHttp([{ match: (u, i) => i.method === 'DELETE' && u.includes('/apps/firth-x-abc'), body: {} }])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    await adapter.destroy({ kind: 'fly', providerRef: { flyApp: 'firth-x-abc', orgSlug: 'firth-org' } })
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toContain('/apps/firth-x-abc')
    expect(calls[0].url).toContain('force=true')
  })

  test('non-2xx throws with status only (no token leak)', async () => {
    const { http } = fakeHttp([{ match: (u, i) => i.method === 'POST', status: 422, body: { error: 'taken' } }])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    await expect(adapter.provision('x')).rejects.toThrow(/fly POST \/apps failed: 422/)
    await expect(adapter.provision('x')).rejects.not.toThrow(/fly_tok/)
  })

  test('createBranch returns null; mintCredentials and readUsage are empty', async () => {
    const { http } = fakeHttp([])
    const adapter = new FlyAdapter('fly_tok', 'firth-org', http)
    const h = { kind: 'fly' as const, providerRef: { flyApp: 'a', orgSlug: 'o' } }
    expect(await adapter.createBranch(h, 'b')).toBeNull()
    expect(await adapter.mintCredentials(h)).toEqual({})
    expect(await adapter.readUsage(h)).toEqual({})
  })
})

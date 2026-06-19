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

describe('FlyAdapter.deploy', () => {
  test('creates a machine with image + env, returns machineId + url', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/apps/firth-x-abc/machines'), body: { id: 'm-123', state: 'created' } },
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    const handle = { kind: 'fly' as const, providerRef: { flyApp: 'firth-x-abc', orgSlug: 'org' } }
    const out = await adapter.deploy(handle, { image: 'nginx:alpine', env: { DATABASE_URL: 'postgresql://c' }, port: 80 })
    expect(out).toEqual({ machineId: 'm-123', url: 'https://firth-x-abc.fly.dev' })
    const body = JSON.parse(calls[0].init.body)
    expect(body.config.image).toBe('nginx:alpine')
    expect(body.config.env.DATABASE_URL).toBe('postgresql://c')
    expect(body.config.guest).toEqual({ cpu_kind: 'shared', cpus: 1, memory_mb: 256 })
    expect(body.config.services[0].internal_port).toBe(80)
  })

  test('omits services when no port is given', async () => {
    const { http, calls } = fakeHttp([{ match: (u, i) => i.method === 'POST', body: { id: 'm-1' } }])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'img', env: {} })
    expect(JSON.parse(calls[0].init.body).config.services).toBeUndefined()
  })

  test('non-2xx deploy throws with status only', async () => {
    const { http } = fakeHttp([{ match: (u, i) => i.method === 'POST', status: 422, body: {} }])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await expect(adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'x', env: {} }))
      .rejects.toThrow(/fly POST \/apps\/a\/machines failed: 422/)
  })
})

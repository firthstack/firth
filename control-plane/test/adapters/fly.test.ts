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
  // After a successful deploy the adapter lists machines and destroys the stale ones. A GET /machines
  // route returning only the just-created machine means the replace step finds nothing to destroy.
  const onlyNew = (id: string) => ({ match: (u: string, i: any) => i.method === 'GET' && u.endsWith('/machines'), body: [{ id }] })

  test('creates a machine with image + env, returns machineId + url', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/apps/firth-x-abc/machines'), body: { id: 'm-123', state: 'created' } },
      // exposing a port also ensures public IPs; here they already exist → only the existence query runs
      { match: (u, i) => u.includes('graphql') && i.body.includes('query('), body: { data: { app: { sharedIpAddress: '1.2.3.4', ipAddresses: { nodes: [{ address: '2a09::1', type: 'v6' }] } } } } },
      onlyNew('m-123'),
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    const handle = { kind: 'fly' as const, providerRef: { flyApp: 'firth-x-abc', orgSlug: 'org' } }
    const out = await adapter.deploy(handle, { image: 'nginx:alpine', env: { DATABASE_URL: 'postgresql://c' }, port: 80 })
    expect(out).toEqual({ machineId: 'm-123', url: 'https://firth-x-abc.fly.dev' })
    const body = JSON.parse(calls[0].init.body) // machine create is the first call
    expect(body.config.image).toBe('nginx:alpine')
    expect(body.config.env.DATABASE_URL).toBe('postgresql://c')
    expect(body.config.guest).toEqual({ cpu_kind: 'shared', cpus: 1, memory_mb: 256 })
    expect(body.config.services[0].internal_port).toBe(80)
  })

  test('exposing a port allocates a shared v4 + dedicated v6 when the app has none', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-1' } },
      { match: (u, i) => u.includes('graphql') && i.body.includes('query('), body: { data: { app: { sharedIpAddress: null, ipAddresses: { nodes: [] } } } } },
      { match: (u, i) => u.includes('graphql') && i.body.includes('shared_v4'), body: { data: { allocateIpAddress: { app: { sharedIpAddress: '1.2.3.4' } } } } },
      { match: (u, i) => u.includes('graphql') && i.body.includes('"type":"v6"'), body: { data: { allocateIpAddress: { ipAddress: { address: '2a09::1', type: 'v6' } } } } },
      onlyNew('m-1'),
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'firth-x-abc', orgSlug: 'org' } }, { image: 'img', env: {}, port: 8080 })
    const gql = calls.filter((c) => c.url.includes('graphql'))
    expect(gql.length).toBe(3) // 1 existence query + 2 allocations
    expect(gql.some((c) => c.init.body.includes('shared_v4'))).toBe(true)
    expect(gql.some((c) => c.init.body.includes('"type":"v6"'))).toBe(true)
    expect(gql[0].url).toBe('https://api.fly.io/graphql')
    expect(gql[0].init.headers.Authorization).toBe('Bearer fly_tok') // same token, no leak in error paths
  })

  test('exposing a port does NOT re-allocate IPs that already exist (idempotent)', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-1' } },
      { match: (u, i) => u.includes('graphql') && i.body.includes('query('), body: { data: { app: { sharedIpAddress: '1.2.3.4', ipAddresses: { nodes: [{ address: '2a09::1', type: 'v6' }] } } } } },
      onlyNew('m-1'),
      // NOTE: no allocation routes — if the code tried to allocate, fakeHttp would throw "unexpected"
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'img', env: {}, port: 8080 })
    const gql = calls.filter((c) => c.url.includes('graphql'))
    expect(gql.length).toBe(1) // only the existence query
    expect(gql.some((c) => c.init.body.includes('shared_v4'))).toBe(false)
  })

  test('graphql non-2xx throws with status only (no token leak)', async () => {
    const { http } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-1' } },
      { match: (u) => u.includes('graphql'), status: 500, body: {} },
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    const handle = { kind: 'fly' as const, providerRef: { flyApp: 'a', orgSlug: 'o' } }
    await expect(adapter.deploy(handle, { image: 'img', env: {}, port: 8080 })).rejects.toThrow(/fly graphql failed: 500/)
    await expect(adapter.deploy(handle, { image: 'img', env: {}, port: 8080 })).rejects.not.toThrow(/fly_tok/)
  })

  test('graphql errors[] payload throws the server message, not the token', async () => {
    const { http } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-1' } },
      { match: (u) => u.includes('graphql'), status: 200, body: { errors: [{ message: 'boom' }] } },
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    const handle = { kind: 'fly' as const, providerRef: { flyApp: 'a', orgSlug: 'o' } }
    await expect(adapter.deploy(handle, { image: 'img', env: {}, port: 8080 })).rejects.toThrow(/fly graphql error: boom/)
    await expect(adapter.deploy(handle, { image: 'img', env: {}, port: 8080 })).rejects.not.toThrow(/fly_tok/)
  })

  test('deploy without a port allocates no IPs (no graphql calls)', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-1' } },
      onlyNew('m-1'),
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'img', env: {} })
    expect(calls.some((c) => c.url.includes('graphql'))).toBe(false)
  })

  test('omits services when no port is given', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-1' } },
      onlyNew('m-1'),
    ])
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

  test('deploy destroys other machines on the app (replace, not accumulate)', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-new' } },
      { match: (u, i) => i.method === 'GET' && u.endsWith('/machines'), body: [{ id: 'm-old1' }, { id: 'm-old2' }, { id: 'm-new' }] },
      { match: (u, i) => i.method === 'DELETE' && u.includes('/machines/m-old1'), body: {} },
      { match: (u, i) => i.method === 'DELETE' && u.includes('/machines/m-old2'), body: {} },
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'img', env: {} })
    const deletes = calls.filter((c) => c.init.method === 'DELETE')
    expect(deletes.length).toBe(2)
    expect(deletes.every((c) => c.url.includes('force=true'))).toBe(true)
    expect(deletes.some((c) => c.url.includes('/machines/m-new'))).toBe(false) // never destroys the new machine
    expect(deletes.map((c) => c.url.match(/machines\/(m-old\d)/)![1]).sort()).toEqual(['m-old1', 'm-old2'])
  })

  test('throws and destroys nothing if machine create returns no id', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: {} }, // 200 but no id
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await expect(adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'img', env: {} }))
      .rejects.toThrow(/no id/)
    expect(calls.some((c) => c.init.method === 'DELETE' || c.init.method === 'GET')).toBe(false) // replace loop never ran
  })

  test('deploy destroys nothing when only the new machine exists', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/machines'), body: { id: 'm-new' } },
      { match: (u, i) => i.method === 'GET' && u.endsWith('/machines'), body: [{ id: 'm-new' }] },
    ])
    const adapter = new FlyAdapter('fly_tok', 'org', http)
    await adapter.deploy({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { image: 'img', env: {} })
    expect(calls.some((c) => c.init.method === 'DELETE')).toBe(false)
  })
})

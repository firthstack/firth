import { describe, expect, test } from 'vitest'
import { TigrisAdapter } from '../../src/adapters/tigris.js'
import type { SignedHttp } from '../../src/adapters/signed-http.js'

function fake(routes: Array<{ match: (u: string, i: any) => boolean; status?: number; body?: any }>) {
  const calls: Array<{ url: string; init: any }> = []
  const http: SignedHttp = async (url, init) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init))
    if (!r) throw new Error(`unexpected: ${init.method} ${url}`)
    return { status: r.status ?? 200, json: async () => r.body ?? {}, text: async () => '' }
  }
  return { http, calls }
}

describe('TigrisAdapter provision/destroy', () => {
  test('provision PUTs a bucket at the S3 endpoint and returns a non-secret providerRef', async () => {
    const { http, calls } = fake([{ match: (u, i) => i.method === 'PUT', status: 200 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    const handle = await adapter.provision('My App')
    expect(handle.kind).toBe('s3')
    const ref = handle.providerRef as any
    expect(ref.endpoint).toBe('https://t3.storage.dev')
    expect(ref.region).toBe('auto')
    expect(ref.bucket).toMatch(/^firth-my-app-[a-z0-9]+$/)
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].url).toContain(ref.bucket)
    // providerRef carries NO secret material
    expect(JSON.stringify(handle.providerRef)).not.toMatch(/secret|key/i)
  })

  test('destroy DELETEs the bucket', async () => {
    const { http, calls } = fake([{ match: (u, i) => i.method === 'DELETE', status: 204 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    await adapter.destroy({ kind: 's3', providerRef: { bucket: 'firth-x-abc', endpoint: 'https://t3.storage.dev', region: 'auto' } })
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toContain('firth-x-abc')
  })

  test('non-2xx on provision throws with status', async () => {
    const { http } = fake([{ match: (u, i) => i.method === 'PUT', status: 403 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    await expect(adapter.provision('x')).rejects.toThrow(/tigris PUT .* failed: 403/)
  })

  test('createBranch returns null (shared bucket)', async () => {
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(noop, noop)
    expect(await adapter.createBranch({ kind: 's3', providerRef: {} }, 'b')).toBeNull()
  })
})

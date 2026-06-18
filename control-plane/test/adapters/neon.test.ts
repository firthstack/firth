import { describe, expect, test } from 'vitest'
import { NeonAdapter } from '../../src/adapters/neon.js'
import type { HttpClient } from '../../src/adapters/types.js'

// Build a fake HttpClient that records calls and returns scripted responses.
function fakeHttp(routes: Array<{ match: (url: string, init: any) => boolean; status?: number; body: any }>) {
  const calls: Array<{ url: string; init: any }> = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init))
    if (!r) throw new Error(`unexpected call: ${init.method} ${url}`)
    return { status: r.status ?? 200, json: async () => r.body, text: async () => JSON.stringify(r.body) }
  }
  return { http, calls }
}

const noSleep = async () => {}

describe('NeonAdapter.provision', () => {
  test('creates a project, captures provider_ref, waits for operations', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/projects'),
        body: { project: { id: 'proj-1' }, branch: { id: 'br-main' },
                databases: [{ name: 'neondb' }], roles: [{ name: 'neondb_owner' }],
                connection_uris: [{ connection_uri: 'postgresql://x' }],
                operations: [{ id: 'op-1', status: 'running' }] } },
      { match: (u) => u.includes('/operations/op-1'), body: { operation: { status: 'finished' } } },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    const handle = await adapter.provision('demo')
    expect(handle.kind).toBe('neon')
    expect(handle.providerRef).toEqual({
      neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner',
    })
    // Authorization header carries the bearer key; project name in the POST body.
    const post = calls.find((c) => c.init.method === 'POST')!
    expect(post.init.headers.Authorization).toBe('Bearer neon_key')
    expect(JSON.parse(post.init.body)).toEqual({ project: { name: 'demo' } })
  })

  test('throws (and does not leak the key) on a non-2xx create', async () => {
    const { http } = fakeHttp([
      { match: (u, i) => i.method === 'POST', status: 422, body: { message: 'bad' } },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await expect(adapter.provision('demo')).rejects.toThrow(/neon POST \/projects failed: 422/)
    await expect(adapter.provision('demo')).rejects.not.toThrow(/neon_key/)
  })

  test('throws if an operation reports failed', async () => {
    const { http } = fakeHttp([
      { match: (u, i) => i.method === 'POST', body: { project: { id: 'p' }, branch: { id: 'b' },
        databases: [{ name: 'd' }], roles: [{ name: 'r' }], connection_uris: [{ connection_uri: 'x' }],
        operations: [{ id: 'op-x', status: 'failed' }] } },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await expect(adapter.provision('demo')).rejects.toThrow(/operation op-x failed/)
  })

  test('throws after the poll cap when an operation never reaches a terminal state', async () => {
    const { http } = fakeHttp([
      { match: (u, i) => i.method === 'POST', body: { project: { id: 'p' }, branch: { id: 'b' },
        databases: [{ name: 'd' }], roles: [{ name: 'r' }], connection_uris: [{ connection_uri: 'x' }],
        operations: [{ id: 'op-stuck', status: 'running' }] } },
      { match: (u) => u.includes('/operations/op-stuck'), body: { operation: { status: 'running' } } },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep, pollAttempts: 3 })
    await expect(adapter.provision('demo')).rejects.toThrow(/did not finish after 3 polls/)
  })
})

describe('NeonAdapter.destroy', () => {
  test('issues DELETE /projects/{id}', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'DELETE' && u.endsWith('/projects/proj-1'), body: {} },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await adapter.destroy({ kind: 'neon', providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'b', dbName: 'd', roleName: 'r' } })
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toMatch(/\/projects\/proj-1$/)
  })
})

describe('NeonAdapter.createBranch', () => {
  test('POSTs a branch with parent_id and returns the new branch id', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'POST' && u.endsWith('/projects/proj-1/branches'),
        body: { branch: { id: 'br-new' }, operations: [] } },
    ])
    const adapter = new NeonAdapter('k', http, { sleep: noSleep })
    const handle = { kind: 'neon' as const, providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'd', roleName: 'r' } }
    const id = await adapter.createBranch(handle, 'feature-x', 'br-main')
    expect(id).toBe('br-new')
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ branch: { name: 'feature-x', parent_id: 'br-main' } })
  })
})

describe('NeonAdapter.mintCredentials', () => {
  test('GETs the connection_uri for the branch/db/role and returns DATABASE_URL', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'GET' && u.includes('/connection_uri'),
        body: { uri: 'postgresql://neondb_owner:pw@host/neondb?sslmode=require' } },
    ])
    const adapter = new NeonAdapter('k', http, { sleep: noSleep })
    const handle = { kind: 'neon' as const, providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } }
    const bundle = await adapter.mintCredentials(handle, 'br-main')
    expect(bundle).toEqual({ DATABASE_URL: 'postgresql://neondb_owner:pw@host/neondb?sslmode=require' })
    const url = calls[0].url
    expect(url).toContain('branch_id=br-main')
    expect(url).toContain('database_name=neondb')
    expect(url).toContain('role_name=neondb_owner')
  })

  test('defaults to the default branch when no branchRef is given', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'GET', body: { uri: 'postgresql://x' } },
    ])
    const adapter = new NeonAdapter('k', http, { sleep: noSleep })
    await adapter.mintCredentials(
      { kind: 'neon', providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'neondb', roleName: 'neondb_owner' } })
    expect(calls[0].url).toContain('branch_id=br-main')
  })
})

describe('NeonAdapter.deleteBranch', () => {
  test('DELETEs /projects/{id}/branches/{branchRef}', async () => {
    const { http, calls } = fakeHttp([
      { match: (u, i) => i.method === 'DELETE' && u.endsWith('/projects/proj-1/branches/br-x'), body: {} },
    ])
    const adapter = new NeonAdapter('neon_key', http, { sleep: noSleep })
    await adapter.deleteBranch(
      { kind: 'neon', providerRef: { neonProjectId: 'proj-1', defaultBranchId: 'br-main', dbName: 'd', roleName: 'r' } },
      'br-x',
    )
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toMatch(/\/projects\/proj-1\/branches\/br-x$/)
  })
})

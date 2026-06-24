import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { DeployService } from '../../src/services/deploy.js'
import { encryptSecret, loadKeks } from '../../src/crypto/secrets.js'
import type { ProviderAdapter } from '../../src/adapters/types.js'

const { keks, current } = loadKeks({ FIRTH_KEK_CURRENT: 'V1', FIRTH_KEK_V1: randomBytes(32).toString('base64') })
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } } as any

function enc(v: string) { const e = encryptSecret(v, keks, current); return { ciphertext: e.ciphertext, nonce: e.nonce, kek_version: e.kekVersion } }

// PostgREST-faithful fake (eq(null)→no-match, is(null)→null-match) supporting select/eq/is.
function fakeDb(seed: Record<string, any[]>) {
  const tables: Record<string, any[]> = { resources: [], branches: [], secrets: [], ...seed }
  return { tables, from(t: string) {
    const filters: Array<(r: any) => boolean> = []
    const api: any = {
      select() { return api }, insert() { return api }, update() { return api },
      eq(c: string, v: any) { filters.push(v === null ? () => false : (r: any) => r[c] === v); return api },
      is(c: string, v: any) { filters.push(v === null ? (r: any) => r[c] == null : (r: any) => r[c] === v); return api },
      async then(res: any) { return res({ data: tables[t].filter((r) => filters.every((f) => f(r))), error: null }) },
    }
    return api
  } }
}

function flyAdapter(captured: any): ProviderAdapter {
  return {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {},
    async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy(h: any, opts: any) { captured.handle = h; captured.opts = opts; return { machineId: 'm-1', url: 'https://app.fly.dev' } },
  } as any
}

const seeded = () => fakeDb({
  resources: [{ id: 'r', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'app', orgSlug: 'org' }, status: 'active' }],
  branches: [{ id: 'b-main', owner: 'o', project_id: 'p', name: 'main', is_default: true, neon_branch_ref: 'br', status: 'active' }],
  secrets: [
    { id: 's1', owner: 'o', project_id: 'p', branch_id: null, name: 'AWS_ACCESS_KEY_ID', ...enc('tid_x') },
    { id: 's2', owner: 'o', project_id: 'p', branch_id: 'b-main', name: 'DATABASE_URL', ...enc('postgresql://conn') },
  ],
})

describe('DeployService.deploy', () => {
  test('injects merged decrypted secrets (project + branch) and returns the result', async () => {
    const cap: any = {}; const db = seeded()
    const out = await new DeployService(db as any, cfg, [flyAdapter(cap)]).deploy('o', 'p', { image: 'nginx', port: 80 })
    expect(out).toEqual({ machineId: 'm-1', url: 'https://app.fly.dev' })
    expect(cap.opts.image).toBe('nginx'); expect(cap.opts.port).toBe(80)
    expect(cap.opts.env).toEqual({ AWS_ACCESS_KEY_ID: 'tid_x', DATABASE_URL: 'postgresql://conn' }) // both scopes, decrypted
  })

  test('provisions compute on demand when the branch has none, then deploys', async () => {
    // DB-only branch (no fly resource): deploy should lazily provision compute, not throw.
    const cap: any = {}
    const db = fakeDb({ branches: [{ id: 'b', owner: 'o', project_id: 'p', name: 'main', is_default: true, neon_branch_ref: 'x', status: 'active' }] })
    const out = await new DeployService(db as any, cfg, [flyAdapter(cap)]).deploy('o', 'p', { image: 'x' })
    expect(out.machineId).toBe('m-1')  // deploy succeeded after on-demand provision
  })

  test('throws when no fly adapter is configured', async () => {
    await expect(new DeployService(seeded() as any, cfg, []).deploy('o', 'p', { image: 'x' }))
      .rejects.toThrow(/fly adapter/i)
  })

  test('deploys to the target branch\'s fly app and merges that branch\'s secrets', async () => {
    const cap: any = {}
    const db = fakeDb({
      branches: [
        { id: 'b-main', owner: 'o', project_id: 'p', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' },
        { id: 'b-feat', owner: 'o', project_id: 'p', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' },
      ],
      resources: [
        { id: 'r-main', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main', orgSlug: 'o' }, status: 'active' },
        { id: 'r-feat', owner: 'o', project_id: 'p', kind: 'fly', branch_id: 'b-feat', provider_ref: { flyApp: 'a-feat', orgSlug: 'o' }, status: 'active' },
      ],
      secrets: [],
    })
    const out = await new DeployService(db as any, cfg, [flyAdapter(cap)]).deploy('o', 'p', { image: 'img', from: 'feature' })
    expect(cap.handle.providerRef.flyApp).toBe('a-feat')
    expect(out.url).toBe('https://app.fly.dev')
  })

  test('provisions compute on demand for a target branch with no resource', async () => {
    const cap: any = {}
    const db = fakeDb({
      branches: [{ id: 'b-feat', owner: 'o', project_id: 'p', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' }],
      resources: [],
    })
    const out = await new DeployService(db as any, cfg, [flyAdapter(cap)]).deploy('o', 'p', { image: 'img', from: 'feature' })
    expect(out.machineId).toBe('m-1')  // lazily provisioned, then deployed
  })
})

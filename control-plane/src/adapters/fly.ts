import { randomBytes } from 'node:crypto'
import type { ComputeAdapter, DeployOpts, DeployResult, HttpClient, ResourceHandle, SecretBundle, UsageSnapshot } from './types.js'

const FLY_BASE = 'https://api.machines.dev/v1'
const FLY_GRAPHQL = 'https://api.fly.io/graphql' // IP allocation lives only on the GraphQL API, not the Machines API
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type FlyRef = { flyApp: string; orgSlug: string }

export function mkAppName(projectName: string, rand: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'app'
  return `firth-${slug}-${rand}`
}

export class FlyAdapter implements ComputeAdapter {
  readonly kind = 'fly' as const
  readonly branchModel = 'redeploy' as const
  private baseUrl: string
  private graphqlUrl: string
  private retryMax: number
  private retryBaseMs: number

  constructor(private apiToken: string, private orgSlug: string, private http: HttpClient, opts: { baseUrl?: string; graphqlUrl?: string; retry?: { max?: number; baseMs?: number } } = {}) {
    this.baseUrl = opts.baseUrl ?? FLY_BASE
    this.graphqlUrl = opts.graphqlUrl ?? FLY_GRAPHQL
    this.retryMax = opts.retry?.max ?? 6
    this.retryBaseMs = opts.retry?.baseMs ?? 500
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    let lastStatus = 0
    let lastDetail = ''
    for (let attempt = 1; attempt <= this.retryMax; attempt++) {
      const res = await this.http(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.status >= 200 && res.status < 300) return res.json().catch(() => ({}))
      lastStatus = res.status
      lastDetail = await res.text().catch(() => '')
      // Retry transient Fly errors with exponential backoff: 429 (rate limit), 5xx (capacity/outage),
      // AND the registry-propagation race — a brand-new app's freshly-pushed image 404s as
      // MANIFEST_UNKNOWN on machine-create until the manifest propagates (surfaces as 400/404, not 5xx).
      // Other 4xx (e.g. 422) are caller errors — fail fast, no retry.
      const manifestRace = /MANIFEST_UNKNOWN|manifest unknown|failed to get manifest/i.test(lastDetail)
      if ((res.status === 429 || res.status >= 500 || manifestRace) && attempt < this.retryMax) {
        await sleep(this.retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * this.retryBaseMs))
        continue
      }
      break
    }
    throw new Error(`fly ${method} ${path} failed: ${lastStatus}${lastDetail ? ` ${lastDetail.slice(0, 300)}` : ''}`)
  }

  // Fly IP allocation is only on the GraphQL API, not the Machines API.
  private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    let lastStatus = 0
    for (let attempt = 1; attempt <= this.retryMax; attempt++) {
      const res = await this.http(this.graphqlUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      if (res.status >= 200 && res.status < 300) {
        const out = await res.json().catch(() => ({}))
        if (Array.isArray(out.errors) && out.errors.length > 0) {
          throw new Error(`fly graphql error: ${out.errors[0]?.message ?? 'unknown'}`)
        }
        return out.data ?? {}
      }
      lastStatus = res.status
      // Same transient retry as call(): public-IP allocation runs through GraphQL on a NEW app's first
      // deploy, so an un-retried 429/5xx here is exactly the deploy-500 that still hit brand-new branches.
      if ((res.status === 429 || res.status >= 500) && attempt < this.retryMax) {
        await sleep(this.retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * this.retryBaseMs))
        continue
      }
      break
    }
    throw new Error(`fly graphql failed: ${lastStatus}`)
  }

  // A Fly app is only reachable on the public internet once it has an IP address; the Machines
  // API never allocates one. Ensure a shared IPv4 + dedicated IPv6 exist (idempotent: query first,
  // allocate only what's missing, so repeated deploys don't pile up duplicate addresses).
  private async ensurePublicIps(flyApp: string): Promise<void> {
    const data = await this.graphql(
      'query($name: String!) { app(name: $name) { sharedIpAddress ipAddresses { nodes { address type } } } }',
      { name: flyApp },
    )
    const app = data.app ?? {}
    const nodes: Array<{ type?: string }> = app.ipAddresses?.nodes ?? []
    if (!app.sharedIpAddress) {
      await this.graphql(
        'mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { sharedIpAddress } } }',
        { input: { appId: flyApp, type: 'shared_v4' } },
      )
    }
    if (!nodes.some((n) => String(n.type).toLowerCase() === 'v6')) {
      await this.graphql(
        'mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address type } } }',
        { input: { appId: flyApp, type: 'v6' } },
      )
    }
  }

  async provision(projectName: string): Promise<ResourceHandle> {
    const rand = randomBytes(4).toString('hex')
    const appName = mkAppName(projectName, rand)
    await this.call('POST', '/apps', { app_name: appName, org_slug: this.orgSlug })
    const providerRef: FlyRef = { flyApp: appName, orgSlug: this.orgSlug }
    return { kind: 'fly', providerRef }
  }

  async destroy(handle: ResourceHandle): Promise<void> {
    const ref = handle.providerRef as FlyRef
    await this.call('DELETE', `/apps/${ref.flyApp}?force=true`)
  }

  async createBranch(): Promise<string | null> { return null }
  async deleteBranch(): Promise<void> { /* no per-branch resource: storage shared, compute redeploys */ }
  async mintCredentials(): Promise<SecretBundle> { return {} }
  async readUsage(): Promise<UsageSnapshot> { return {} }

  private async listMachines(flyApp: string): Promise<Array<{ id?: string; state?: string }>> {
    const data = await this.call('GET', `/apps/${flyApp}/machines`)
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.machines)) return data.machines
    return []
  }

  private async destroyMachine(flyApp: string, id: string): Promise<void> {
    await this.call('DELETE', `/apps/${flyApp}/machines/${id}?force=true`)
  }

  // Serverless runtime state for the env: 'running' if any machine is started,
  // 'suspended'/'stopped' when scaled to zero, 'none' if not deployed yet.
  async appState(handle: ResourceHandle): Promise<string> {
    const ref = handle.providerRef as FlyRef
    let states: string[] = []
    try { states = (await this.listMachines(ref.flyApp)).map((m) => (m.state ?? '').toLowerCase()) }
    catch { return 'unknown' }
    if (states.some((x) => x === 'started')) return 'running'
    if (states.some((x) => x === 'suspended')) return 'suspended'
    if (states.some((x) => x === 'stopped' || x === 'created')) return 'stopped'
    return 'none'
  }

  async mintDeployToken(handle: ResourceHandle, opts: { expirySeconds: number }): Promise<{ token: string; expirySeconds: number }> {
    const ref = handle.providerRef as FlyRef
    // Machines API mints an app-scoped deploy token: POST /apps/<app>/deploy_token
    // → { token: "FlyV1 …" } (NOT the GraphQL createLimitedAccessToken mutation —
    // that payload has no `token` field). Mirrors InsForge's compute deploy mint.
    const data = await this.call('POST', `/apps/${ref.flyApp}/deploy_token`, { expiry: `${opts.expirySeconds}s` })
    const token = String(data?.token ?? '').trim()
    // shape-only check — never echo token content (it's credential material).
    if (!token.startsWith('FlyV1 ')) throw new Error(`fly deploy_token returned a malformed token (no FlyV1 prefix; len=${token.length})`)
    return { token, expirySeconds: opts.expirySeconds }
  }

  async deploy(handle: ResourceHandle, opts: DeployOpts): Promise<DeployResult> {
    const ref = handle.providerRef as FlyRef
    const config: Record<string, unknown> = {
      image: opts.image,
      env: opts.env,
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
    }
    if (opts.port) {
      config.services = [{
        protocol: 'tcp',
        internal_port: opts.port,
        // Branch/preview envs scale to zero (suspend snapshots RAM for fast wake) and auto-start on
        // request; the default branch (production) stays always-on. Cuts cost on idle per-branch envs.
        autostop: opts.persistent ? 'off' : 'suspend',
        autostart: true,
        ports: [{ port: 443, handlers: ['tls', 'http'] }, { port: 80, handlers: ['http'] }],
      }]
    }
    const data = await this.call('POST', `/apps/${ref.flyApp}/machines`, { config })
    // Guard before the replace loop: without a new id, `m.id !== data.id` would be true for every
    // machine and we'd destroy them ALL (including the one just created). Fail fast instead.
    if (!data?.id) throw new Error('fly machine create returned no id')
    // Only when we expose a port (and therefore services) does the app need to be publicly reachable.
    if (opts.port) await this.ensurePublicIps(ref.flyApp)
    // Deploy REPLACES, not accumulates: the new machine is up, so destroy every other machine on the
    // app. Without this, each deploy stacks a machine and the Fly proxy round-robins across stale code.
    // A failure here propagates, but the new machine is already serving and a retry is idempotent
    // (it spares the newest machine and destroys the rest).
    for (const m of await this.listMachines(ref.flyApp)) {
      if (m.id && m.id !== data.id) await this.destroyMachine(ref.flyApp, m.id)
    }
    return { machineId: data.id, url: `https://${ref.flyApp}.fly.dev` }
  }
}

import { randomBytes } from 'node:crypto'
import type { ComputeAdapter, DeployOpts, DeployResult, HttpClient, ResourceHandle, SecretBundle, UsageSnapshot } from './types.js'

const FLY_BASE = 'https://api.machines.dev/v1'
const FLY_GRAPHQL = 'https://api.fly.io/graphql' // IP allocation lives only on the GraphQL API, not the Machines API

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

  constructor(private apiToken: string, private orgSlug: string, private http: HttpClient, opts: { baseUrl?: string; graphqlUrl?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? FLY_BASE
    this.graphqlUrl = opts.graphqlUrl ?? FLY_GRAPHQL
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.http(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`fly ${method} ${path} failed: ${res.status}`)
    return res.json().catch(() => ({}))
  }

  // Fly IP allocation is only on the GraphQL API, not the Machines API.
  private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await this.http(this.graphqlUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`fly graphql failed: ${res.status}`)
    const out = await res.json().catch(() => ({}))
    if (Array.isArray(out.errors) && out.errors.length > 0) {
      throw new Error(`fly graphql error: ${out.errors[0]?.message ?? 'unknown'}`)
    }
    return out.data ?? {}
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
        ports: [{ port: 443, handlers: ['tls', 'http'] }, { port: 80, handlers: ['http'] }],
      }]
    }
    const data = await this.call('POST', `/apps/${ref.flyApp}/machines`, { config })
    // Only when we expose a port (and therefore services) does the app need to be publicly reachable.
    if (opts.port) await this.ensurePublicIps(ref.flyApp)
    return { machineId: data.id, url: `https://${ref.flyApp}.fly.dev` }
  }
}

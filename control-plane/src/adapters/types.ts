export type ProviderKind = 'neon' | 's3' | 'fly'
export type SecretBundle = Record<string, string>
export type UsageSnapshot = Record<string, number>
export type ResourceHandle = { kind: ProviderKind; providerRef: Record<string, unknown> }

export type HttpResponse = { status: number; json(): Promise<any>; text(): Promise<string> }
export type HttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>

export interface ProviderAdapter {
  readonly kind: ProviderKind
  readonly branchModel: 'native' | 'shared' | 'redeploy'
  provision(projectName: string): Promise<ResourceHandle>
  destroy(handle: ResourceHandle): Promise<void>
  createBranch(handle: ResourceHandle, name: string, parentRef?: string): Promise<string | null>
  deleteBranch(handle: ResourceHandle, branchRef: string): Promise<void>
  mintCredentials(handle: ResourceHandle, branchRef?: string): Promise<SecretBundle>
  readUsage(handle: ResourceHandle): Promise<UsageSnapshot>
}

export type DeployOpts = { image: string; env: Record<string, string>; port?: number }
export type DeployResult = { machineId: string; url: string }

export interface ComputeAdapter extends ProviderAdapter {
  deploy(handle: ResourceHandle, opts: DeployOpts): Promise<DeployResult>
}

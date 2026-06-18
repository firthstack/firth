import { randomBytes } from 'node:crypto'
import type { ResourceHandle } from './types.js'
import type { SignedHttp } from './signed-http.js'

const S3_ENDPOINT = 'https://t3.storage.dev'
const IAM_ENDPOINT = 'https://iam.storage.dev'
const REGION = 'auto'

export type TigrisRef = { bucket: string; endpoint: string; region: string }
export type TigrisOptions = { s3Endpoint?: string; iamEndpoint?: string; region?: string }

export function mkBucketName(projectName: string, rand: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'bucket'
  return `firth-${slug}-${rand}`
}

export class TigrisAdapter {
  readonly kind = 's3' as const
  readonly branchModel = 'shared' as const
  readonly s3Endpoint: string
  readonly iamEndpoint: string
  readonly region: string

  constructor(private s3: SignedHttp, private iam: SignedHttp, opts: TigrisOptions = {}) {
    this.s3Endpoint = opts.s3Endpoint ?? S3_ENDPOINT
    this.iamEndpoint = opts.iamEndpoint ?? IAM_ENDPOINT
    this.region = opts.region ?? REGION
  }

  async provision(projectName: string): Promise<ResourceHandle> {
    const bucket = mkBucketName(projectName, randomBytes(4).toString('hex'))
    // S3 CreateBucket = PUT to the bucket subresource (path-style against the Tigris endpoint).
    const res = await this.s3(`${this.s3Endpoint}/${bucket}`, { method: 'PUT' })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris PUT /${bucket} failed: ${res.status}`)
    const providerRef: TigrisRef = { bucket, endpoint: this.s3Endpoint, region: this.region }
    return { kind: 's3', providerRef }
  }

  async destroy(handle: ResourceHandle): Promise<void> {
    const ref = handle.providerRef as TigrisRef
    const res = await this.s3(`${this.s3Endpoint}/${ref.bucket}`, { method: 'DELETE' })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris DELETE /${ref.bucket} failed: ${res.status}`)
  }

  async createBranch(): Promise<string | null> { return null }
}

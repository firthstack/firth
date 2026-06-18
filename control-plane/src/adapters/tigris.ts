import { randomBytes } from 'node:crypto'
import type { ProviderAdapter, ResourceHandle, SecretBundle, UsageSnapshot } from './types.js'
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

export class TigrisAdapter implements ProviderAdapter {
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

  async createBranch(_handle: ResourceHandle, _name: string, _parentRef?: string): Promise<string | null> { return null }

  async mintCredentials(handle: ResourceHandle): Promise<SecretBundle> {
    const ref = handle.providerRef as TigrisRef
    // [VERIFY-LIVE] Create a bucket-scoped access key via Tigris IAM. Confirm the exact
    // action/payload + response field names against the live API and adjust here only.
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${ref.bucket}/*`] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${ref.bucket}`] },
      ],
    }
    const res = await this.iam(`${this.iamEndpoint}/v1/access-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `firth-${ref.bucket}`, policy }),
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris create access-key failed: ${res.status}`)
    const data = await res.json()
    const id = data.access_key_id ?? data.AccessKeyId
    const secret = data.secret_access_key ?? data.SecretAccessKey
    if (!id || !secret) throw new Error('tigris access-key response missing credentials')
    return {
      AWS_ACCESS_KEY_ID: id,
      AWS_SECRET_ACCESS_KEY: secret,
      AWS_ENDPOINT_URL_S3: ref.endpoint,
      BUCKET_NAME: ref.bucket,
      AWS_REGION: ref.region,
    }
  }

  async readUsage(): Promise<UsageSnapshot> { return {} }
}

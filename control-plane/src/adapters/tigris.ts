import { randomBytes } from 'node:crypto'
import type { ProviderAdapter, ResourceHandle, SecretBundle, StorageAdapter, UsageSnapshot } from './types.js'
import type { SignedHttp } from './signed-http.js'

const S3_ENDPOINT = 'https://t3.storage.dev'
const IAM_ENDPOINT = 'https://iam.storage.dev'
const REGION = 'auto'

export type TigrisRef = {
  bucket: string
  endpoint: string
  region: string
  accessKeyId?: string
  policyArn?: string
  snapshotEnabled?: boolean
}
export type TigrisOptions = { s3Endpoint?: string; iamEndpoint?: string; region?: string }

export function mkBucketName(projectName: string, rand: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'bucket'
  return `firth-${slug}-${rand}`
}

/** Extract the text content of a single XML tag from a response string. */
function xmlField(text: string, tag: string): string | undefined {
  return text.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1]
}

export class TigrisAdapter implements StorageAdapter {
  readonly kind = 's3' as const
  readonly branchModel = 'fork' as const
  readonly s3Endpoint: string
  readonly iamEndpoint: string
  readonly region: string

  constructor(private s3: SignedHttp, private iam: SignedHttp, opts: TigrisOptions = {}) {
    this.s3Endpoint = opts.s3Endpoint ?? S3_ENDPOINT
    this.iamEndpoint = opts.iamEndpoint ?? IAM_ENDPOINT
    this.region = opts.region ?? REGION
  }

  /** POST an AWS IAM Query-protocol action and return the raw response text. Throws on non-2xx. */
  private async iamAction(params: Record<string, string>): Promise<string> {
    const body = new URLSearchParams({ Version: '2010-05-08', ...params }).toString()
    const res = await this.iam(this.iamEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (res.status < 200 || res.status >= 300) {
      const action = params.Action ?? 'Unknown'
      throw new Error(`${action} failed: ${res.status}`)
    }
    return res.text()
  }

  async provision(projectName: string): Promise<ResourceHandle> {
    const bucket = mkBucketName(projectName, randomBytes(4).toString('hex'))
    // S3 CreateBucket = PUT to the bucket subresource. The Tigris header opts the bucket into
    // snapshots at creation — required for it to be forkable later (cannot be retrofitted).
    const res = await this.s3(`${this.s3Endpoint}/${bucket}`, { method: 'PUT', headers: { 'X-Tigris-Enable-Snapshot': 'true' } })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris PUT /${bucket} failed: ${res.status}`)
    const providerRef: TigrisRef = { bucket, endpoint: this.s3Endpoint, region: this.region, snapshotEnabled: true }
    return { kind: 's3', providerRef }
  }

  async destroy(handle: ResourceHandle): Promise<void> {
    const ref = handle.providerRef as TigrisRef
    const { bucket, accessKeyId, policyArn } = ref

    const errors: Error[] = []

    // --- IAM teardown (only if keys were minted) ---
    if (accessKeyId && policyArn) {
      try {
        await this.iamAction({ Action: 'DetachUserPolicy', UserName: accessKeyId, PolicyArn: policyArn })
      } catch (e) {
        errors.push(e as Error)
      }
    }

    if (policyArn) {
      try {
        await this.iamAction({ Action: 'DeletePolicy', PolicyArn: policyArn })
      } catch (e) {
        errors.push(e as Error)
      }
    }

    if (accessKeyId) {
      try {
        await this.iamAction({ Action: 'DeleteAccessKey', AccessKeyId: accessKeyId, UserName: accessKeyId })
      } catch (e) {
        errors.push(e as Error)
      }
    }

    // --- S3 bucket empty + DELETE (always attempted) ---
    // Use ListObjectVersions (GET /{bucket}?versions) to enumerate ALL versions and delete markers.
    // A plain DELETE on a versioned bucket only writes a delete marker; we must delete each version
    // by versionId to permanently remove it so the bucket can be deleted (else 409).
    try {
      let keyMarker: string | undefined
      let versionIdMarker: string | undefined
      do {
        let listUrl = `${this.s3Endpoint}/${bucket}?versions`
        if (keyMarker) listUrl += `&key-marker=${encodeURIComponent(keyMarker)}`
        if (versionIdMarker) listUrl += `&version-id-marker=${encodeURIComponent(versionIdMarker)}`

        const listRes = await this.s3(listUrl, { method: 'GET' })
        if (listRes.status < 200 || listRes.status >= 300) {
          throw new Error(`tigris ListObjectVersions /${bucket} failed: ${listRes.status}`)
        }
        const listXml = await listRes.text()

        // Extract all Version and DeleteMarker entries from this page
        const entryRegex = /<(?:Version|DeleteMarker)>([\s\S]*?)<\/(?:Version|DeleteMarker)>/g
        let m: RegExpExecArray | null
        while ((m = entryRegex.exec(listXml)) !== null) {
          const block = m[1]
          const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1]
          const versionId = block.match(/<VersionId>([^<]+)<\/VersionId>/)?.[1]
          if (!key || !versionId) continue

          const encodedKey = key.split('/').map(encodeURIComponent).join('/')
          const delUrl = `${this.s3Endpoint}/${bucket}/${encodedKey}?versionId=${encodeURIComponent(versionId)}`
          const delRes = await this.s3(delUrl, { method: 'DELETE' })
          if (delRes.status < 200 || delRes.status >= 300) {
            throw new Error(`tigris DELETE /${bucket}/${encodedKey}?versionId=... failed: ${delRes.status}`)
          }
        }

        // Paginate while truncated
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(listXml)
        if (truncated) {
          keyMarker = listXml.match(/<NextKeyMarker>([^<]+)<\/NextKeyMarker>/)?.[1]
          versionIdMarker = listXml.match(/<NextVersionIdMarker>([^<]+)<\/NextVersionIdMarker>/)?.[1]
        } else {
          keyMarker = undefined
          versionIdMarker = undefined
        }
      } while (keyMarker !== undefined)
    } catch (e) {
      errors.push(e as Error)
    }

    const s3Res = await this.s3(`${this.s3Endpoint}/${bucket}`, { method: 'DELETE' })
    if (s3Res.status < 200 || s3Res.status >= 300) {
      errors.push(new Error(`tigris DELETE /${bucket} failed: ${s3Res.status}`))
    }

    if (errors.length > 0) {
      throw new Error(`tigris destroy had ${errors.length} failure(s): ${errors.map(e => e.message).join('; ')}`)
    }
  }

  async createBranch(_handle: ResourceHandle, _name: string, _parentRef?: string): Promise<string | null> { return null }

  async deleteBranch(): Promise<void> { /* fork buckets are torn down via destroy() on the branch's s3 resource */ }

  async forkBucket(parent: ResourceHandle, name: string): Promise<ResourceHandle> {
    const parentRef = parent.providerRef as TigrisRef
    const bucket = mkBucketName(name, randomBytes(4).toString('hex'))
    // CoW fork: CreateBucket with the fork-source header. Enable snapshots on the fork too so it
    // can itself be forked (grandchild branches). No snapshot version → Tigris snapshots the
    // source at fork time ("fork from now").
    const res = await this.s3(`${this.s3Endpoint}/${bucket}`, {
      method: 'PUT',
      headers: { 'X-Tigris-Enable-Snapshot': 'true', 'X-Tigris-Fork-Source-Bucket': parentRef.bucket },
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`tigris fork PUT /${bucket} failed: ${res.status}`)
    const providerRef: TigrisRef = { bucket, endpoint: this.s3Endpoint, region: this.region, snapshotEnabled: true }
    return { kind: 's3', providerRef }
  }

  async mintCredentials(handle: ResourceHandle): Promise<SecretBundle> {
    const ref = handle.providerRef as TigrisRef

    // 1. CreateAccessKey — returns a standalone key (no UserName needed)
    const createKeyXml = await this.iamAction({ Action: 'CreateAccessKey' })
    const accessKeyId = xmlField(createKeyXml, 'AccessKeyId')
    const secretAccessKey = xmlField(createKeyXml, 'SecretAccessKey')
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('tigris CreateAccessKey response missing AccessKeyId or SecretAccessKey')
    }

    // 2. CreatePolicy — scoped to this bucket
    const policyDocument = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${ref.bucket}/*`] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${ref.bucket}`] },
      ],
    })
    const createPolicyXml = await this.iamAction({
      Action: 'CreatePolicy',
      PolicyName: `firth-${ref.bucket}`,
      PolicyDocument: policyDocument,
    })
    const policyArn = xmlField(createPolicyXml, 'Arn')
    if (!policyArn) {
      throw new Error('tigris CreatePolicy response missing Arn')
    }

    // 3. AttachUserPolicy — bind the policy to the key (key id is the UserName)
    await this.iamAction({ Action: 'AttachUserPolicy', UserName: accessKeyId, PolicyArn: policyArn })

    // Persist the minted handles back into providerRef so destroy can clean up
    ref.accessKeyId = accessKeyId
    ref.policyArn = policyArn

    return {
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_ENDPOINT_URL_S3: ref.endpoint,
      BUCKET_NAME: ref.bucket,
      AWS_REGION: ref.region,
    }
  }

  async readUsage(): Promise<UsageSnapshot> { return {} }
}

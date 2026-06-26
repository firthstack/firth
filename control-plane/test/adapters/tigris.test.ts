import { describe, expect, test } from 'vitest'
import { TigrisAdapter } from '../../src/adapters/tigris.js'
import type { SignedHttp } from '../../src/adapters/signed-http.js'

const EMPTY_LIST_XML = `<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`
const ONE_OBJECT_LIST_XML = `<ListBucketResult><Contents><Key>some/object.txt</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`

function fake(routes: Array<{ match: (u: string, i: any) => boolean; status?: number; body?: any; text?: string }>) {
  const calls: Array<{ url: string; init: any }> = []
  const http: SignedHttp = async (url, init) => {
    calls.push({ url, init })
    const r = routes.find((x) => x.match(url, init))
    if (!r) throw new Error(`unexpected: ${init.method} ${url}`)
    const textVal = r.text ?? ''
    return { status: r.status ?? 200, json: async () => r.body ?? {}, text: async () => textVal }
  }
  return { http, calls }
}

/** Build a fake IAM SignedHttp that switches on Action= in the body and records calls. */
function fakeIam(bucketName: string) {
  const calls: Array<{ action: string; body: string; url: string }> = []

  const xmlResponses: Record<string, string> = {
    CreateAccessKey: `<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><AccessKeyId>tid_test123</AccessKeyId><SecretAccessKey>secret-xyz</SecretAccessKey></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`,
    CreatePolicy: `<CreatePolicyResponse><CreatePolicyResult><Policy><Arn>arn:aws:iam::to_x:policy/firth-${bucketName}</Arn></Policy></CreatePolicyResult></CreatePolicyResponse>`,
    AttachUserPolicy: '',
    DetachUserPolicy: '',
    DeletePolicy: '',
    DeleteAccessKey: '',
  }

  const iam: SignedHttp = async (url, init) => {
    const body = init.body ?? ''
    const actionMatch = body.match(/Action=([^&]+)/)
    const action = actionMatch ? decodeURIComponent(actionMatch[1]) : 'Unknown'
    calls.push({ action, body, url })
    const xml = xmlResponses[action] ?? ''
    return { status: 200, json: async () => ({}), text: async () => xml }
  }

  return { iam, calls }
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

  test('destroy DELETEs the bucket (no accessKeyId — bucket-only teardown, empty bucket)', async () => {
    const { http, calls } = fake([
      { match: (u, i) => i.method === 'GET' && u.includes('list-type=2'), status: 200, text: EMPTY_LIST_XML },
      { match: (u, i) => i.method === 'DELETE', status: 204 },
    ])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    await adapter.destroy({ kind: 's3', providerRef: { bucket: 'firth-x-abc', endpoint: 'https://t3.storage.dev', region: 'auto' } })
    // First call should be the list, last should be bucket DELETE
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].url).toContain('list-type=2')
    expect(calls[calls.length - 1].init.method).toBe('DELETE')
    expect(calls[calls.length - 1].url).toMatch(/firth-x-abc$/)
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

  test('provision enables snapshots (header + providerRef flag) so the bucket is forkable', async () => {
    const { http, calls } = fake([{ match: (u, i) => i.method === 'PUT', status: 200 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    const handle = await adapter.provision('My App')
    expect(calls[0].init.headers?.['X-Tigris-Enable-Snapshot']).toBe('true')
    expect((handle.providerRef as any).snapshotEnabled).toBe(true)
  })

  test('forkBucket creates a CoW fork from the parent bucket (fork-source + enable-snapshot headers)', async () => {
    const { http, calls } = fake([{ match: (u, i) => i.method === 'PUT', status: 200 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    const parent = { kind: 's3' as const, providerRef: { bucket: 'firth-app-parent', endpoint: 'https://t3.storage.dev', region: 'auto', snapshotEnabled: true } }
    const fork = await adapter.forkBucket(parent, 'feature')
    const ref = fork.providerRef as any
    expect(ref.bucket).toMatch(/^firth-feature-[a-z0-9]+$/)
    expect(ref.bucket).not.toBe('firth-app-parent')
    expect(ref.snapshotEnabled).toBe(true)
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].url).toContain(ref.bucket)
    expect(calls[0].init.headers?.['X-Tigris-Fork-Source-Bucket']).toBe('firth-app-parent')
    expect(calls[0].init.headers?.['X-Tigris-Enable-Snapshot']).toBe('true')
  })

  test('forkBucket throws with status on non-2xx', async () => {
    const { http } = fake([{ match: (u, i) => i.method === 'PUT', status: 403 }])
    const noop = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as SignedHttp
    const adapter = new TigrisAdapter(http, noop)
    const parent = { kind: 's3' as const, providerRef: { bucket: 'firth-app-parent', endpoint: 'https://t3.storage.dev', region: 'auto' } }
    await expect(adapter.forkBucket(parent, 'feature')).rejects.toThrow(/tigris fork PUT .* failed: 403/)
  })
})

describe('TigrisAdapter.mintCredentials', () => {
  test('issues CreateAccessKey + CreatePolicy (scoped to bucket ARN) + AttachUserPolicy, returns bundle, mutates providerRef', async () => {
    const bucket = 'firth-x-abc'
    const { iam, calls } = fakeIam(bucket)
    const s3: SignedHttp = async () => ({ status: 200, json: async () => ({}), text: async () => '' })
    const adapter = new TigrisAdapter(s3, iam)
    const handle = { kind: 's3' as const, providerRef: { bucket, endpoint: 'https://t3.storage.dev', region: 'auto' } }

    const bundle = await adapter.mintCredentials(handle)

    // Returned bundle
    expect(bundle).toEqual({
      AWS_ACCESS_KEY_ID: 'tid_test123',
      AWS_SECRET_ACCESS_KEY: 'secret-xyz',
      AWS_ENDPOINT_URL_S3: 'https://t3.storage.dev',
      BUCKET_NAME: bucket,
      AWS_REGION: 'auto',
    })

    // Three IAM calls in order
    expect(calls.map(c => c.action)).toEqual(['CreateAccessKey', 'CreatePolicy', 'AttachUserPolicy'])

    // CreatePolicy body scopes to bucket ARN
    const createPolicyCall = calls.find(c => c.action === 'CreatePolicy')!
    const policyDocRaw = decodeURIComponent(createPolicyCall.body.match(/PolicyDocument=([^&]+)/)?.[1] ?? '')
    expect(policyDocRaw).toContain(`arn:aws:s3:::${bucket}/*`)
    expect(policyDocRaw).toContain(`arn:aws:s3:::${bucket}`)

    // AttachUserPolicy uses the minted key id as UserName
    const attachCall = calls.find(c => c.action === 'AttachUserPolicy')!
    expect(attachCall.body).toContain('UserName=tid_test123')

    // handle.providerRef mutated with minted handles
    const ref = handle.providerRef as any
    expect(ref.accessKeyId).toBe('tid_test123')
    expect(ref.policyArn).toBe(`arn:aws:iam::to_x:policy/firth-${bucket}`)
  })

  test('non-2xx from CreateAccessKey makes mintCredentials throw', async () => {
    const s3: SignedHttp = async () => ({ status: 200, json: async () => ({}), text: async () => '' })
    const iam: SignedHttp = async () => ({ status: 403, json: async () => ({}), text: async () => '<Error/>' })
    const adapter = new TigrisAdapter(s3, iam)
    const handle = { kind: 's3' as const, providerRef: { bucket: 'firth-x', endpoint: 'https://t3.storage.dev', region: 'auto' } }
    await expect(adapter.mintCredentials(handle)).rejects.toThrow(/CreateAccessKey.*403/)
  })
})

describe('TigrisAdapter.destroy (with minted handles)', () => {
  test('destroy with accessKeyId+policyArn issues DetachUserPolicy + DeletePolicy + DeleteAccessKey + lists objects + object DELETE + bucket DELETE', async () => {
    const bucket = 'firth-x-abc'
    const { iam, calls: iamCalls } = fakeIam(bucket)
    const s3Calls: any[] = []
    const s3: SignedHttp = async (url, init) => {
      s3Calls.push({ url, init })
      // list returns one object
      if (init.method === 'GET' && url.includes('list-type=2')) {
        return { status: 200, json: async () => ({}), text: async () => ONE_OBJECT_LIST_XML }
      }
      return { status: 204, json: async () => ({}), text: async () => '' }
    }
    const adapter = new TigrisAdapter(s3, iam)
    const handle = {
      kind: 's3' as const,
      providerRef: {
        bucket,
        endpoint: 'https://t3.storage.dev',
        region: 'auto',
        accessKeyId: 'tid_test123',
        policyArn: `arn:aws:iam::to_x:policy/firth-${bucket}`,
      },
    }

    await adapter.destroy(handle)

    // IAM teardown sequence
    expect(iamCalls.map(c => c.action)).toEqual(['DetachUserPolicy', 'DeletePolicy', 'DeleteAccessKey'])

    // S3 sequence: (a) list, (b) object delete, (c) bucket delete
    expect(s3Calls.length).toBe(3)

    // (a) list objects
    expect(s3Calls[0].init.method).toBe('GET')
    expect(s3Calls[0].url).toContain('list-type=2')
    expect(s3Calls[0].url).toContain(bucket)

    // (b) delete the object — key is some/object.txt, slash preserved, each segment percent-encoded
    expect(s3Calls[1].init.method).toBe('DELETE')
    expect(s3Calls[1].url).toContain(`${bucket}/some/object.txt`)

    // (c) delete the bucket itself
    expect(s3Calls[2].init.method).toBe('DELETE')
    expect(s3Calls[2].url).toMatch(new RegExp(`${bucket}$`))
  })

  test('destroy with no accessKeyId/policyArn still lists+deletes bucket (empty list) and does not throw', async () => {
    const bucket = 'firth-no-mint'
    const iamCalls: any[] = []
    const iam: SignedHttp = async (url, init) => {
      iamCalls.push({ url, init })
      return { status: 200, json: async () => ({}), text: async () => '' }
    }
    const s3Calls: any[] = []
    const s3: SignedHttp = async (url, init) => {
      s3Calls.push({ url, init })
      if (init.method === 'GET' && url.includes('list-type=2')) {
        return { status: 200, json: async () => ({}), text: async () => EMPTY_LIST_XML }
      }
      return { status: 204, json: async () => ({}), text: async () => '' }
    }
    const adapter = new TigrisAdapter(s3, iam)
    const handle = {
      kind: 's3' as const,
      providerRef: { bucket, endpoint: 'https://t3.storage.dev', region: 'auto' },
    }

    await expect(adapter.destroy(handle)).resolves.toBeUndefined()

    // No IAM calls (nothing to detach/delete)
    expect(iamCalls.length).toBe(0)

    // S3: list + bucket DELETE (no object deletes — empty bucket)
    expect(s3Calls.length).toBe(2)
    expect(s3Calls[0].init.method).toBe('GET')
    expect(s3Calls[0].url).toContain('list-type=2')
    expect(s3Calls[1].init.method).toBe('DELETE')
    expect(s3Calls[1].url).toContain(bucket)
  })

  test('destroy collects all step failures and throws aggregated error', async () => {
    const bucket = 'firth-fail'
    let iamCallCount = 0
    const iam: SignedHttp = async () => {
      iamCallCount++
      return { status: 500, json: async () => ({}), text: async () => '<Error/>' }
    }
    const s3: SignedHttp = async (url, init) => {
      if (init.method === 'GET' && url.includes('list-type=2')) {
        return { status: 200, json: async () => ({}), text: async () => EMPTY_LIST_XML }
      }
      return { status: 204, json: async () => ({}), text: async () => '' }
    }
    const adapter = new TigrisAdapter(s3, iam)
    const handle = {
      kind: 's3' as const,
      providerRef: {
        bucket,
        endpoint: 'https://t3.storage.dev',
        region: 'auto',
        accessKeyId: 'tid_abc',
        policyArn: 'arn:aws:iam::x:policy/firth-fail',
      },
    }

    await expect(adapter.destroy(handle)).rejects.toThrow()
    // All three IAM steps were attempted despite failures
    expect(iamCallCount).toBe(3)
  })
})

import { AwsClient } from 'aws4fetch'
import type { HttpResponse } from './types.js'

export type SignedHttp = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>

// Real SigV4-signing client over global fetch. `service` is 's3' or 'iam' (Tigris uses the AWS service names).
export function makeSignedHttp(cfg: {
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: 's3' | 'iam'
}): SignedHttp {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: cfg.service,
  })
  return async (url, init) => {
    const res = await client.fetch(url, { method: init.method, headers: init.headers, body: init.body })
    return { status: res.status, json: () => res.json(), text: () => res.text() }
  }
}

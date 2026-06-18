import type { FirthConfig } from '../config.js'
import { NeonAdapter } from './neon.js'
import { FlyAdapter } from './fly.js'
import { TigrisAdapter } from './tigris.js'
import { makeSignedHttp } from './signed-http.js'
import type { HttpClient, ProviderAdapter } from './types.js'

// Thin adapter over Node's global fetch, matching our HttpClient shape.
export const fetchHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
  return { status: res.status, json: () => res.json(), text: () => res.text() }
}

export function buildAdapters(cfg: FirthConfig, http: HttpClient = fetchHttp): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = []
  if (cfg.neonApiKey) adapters.push(new NeonAdapter(cfg.neonApiKey, http))
  if (cfg.flyApiToken && cfg.flyOrgSlug) adapters.push(new FlyAdapter(cfg.flyApiToken, cfg.flyOrgSlug, http))
  if (cfg.tigrisAccessKeyId && cfg.tigrisSecretAccessKey) {
    const s3 = makeSignedHttp({ accessKeyId: cfg.tigrisAccessKeyId, secretAccessKey: cfg.tigrisSecretAccessKey, region: 'auto', service: 's3' })
    const iam = makeSignedHttp({ accessKeyId: cfg.tigrisAccessKeyId, secretAccessKey: cfg.tigrisSecretAccessKey, region: 'auto', service: 'iam' })
    adapters.push(new TigrisAdapter(s3, iam))
  }
  return adapters
}

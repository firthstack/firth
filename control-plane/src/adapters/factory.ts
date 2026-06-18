import type { FirthConfig } from '../config.js'
import { NeonAdapter } from './neon.js'
import type { HttpClient, ProviderAdapter } from './types.js'

// Thin adapter over Node's global fetch, matching our HttpClient shape.
export const fetchHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
  return { status: res.status, json: () => res.json(), text: () => res.text() }
}

export function buildAdapters(cfg: FirthConfig, http: HttpClient = fetchHttp): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = []
  if (cfg.neonApiKey) adapters.push(new NeonAdapter(cfg.neonApiKey, http))
  return adapters
}

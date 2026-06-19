import { loadKeks } from './crypto/secrets.js'

export type FirthConfig = {
  keks: Map<string, Buffer>
  currentKek: string
  insforge: { baseUrl: string; anonKey: string; adminKey: string }
  neonApiKey?: string
  flyApiToken?: string
  flyOrgSlug?: string
  tigrisAccessKeyId?: string
  tigrisSecretAccessKey?: string
  corsOrigins?: string[]
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (!v) throw new Error(`${key} is required`)
  return v
}

export function loadConfig(env: NodeJS.ProcessEnv): FirthConfig {
  const { keks, current } = loadKeks(env)
  return {
    keks,
    currentKek: current,
    insforge: {
      baseUrl: required(env, 'INSFORGE_BASE_URL'),
      anonKey: required(env, 'INSFORGE_ANON_KEY'),
      adminKey: required(env, 'INSFORGE_ADMIN_KEY'),
    },
    neonApiKey: env.NEON_API_KEY,
    flyApiToken: env.FLY_API_TOKEN,
    flyOrgSlug: env.FLY_ORG_SLUG,
    tigrisAccessKeyId: env.TIGRIS_ACCESS_KEY_ID,
    tigrisSecretAccessKey: env.TIGRIS_SECRET_ACCESS_KEY,
    corsOrigins: env.FIRTH_CORS_ORIGINS ? env.FIRTH_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  }
}

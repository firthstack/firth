import { createClient, createAdminClient } from '@insforge/sdk'
import type { FirthConfig } from './config.js'
import type { DataClient } from './db/types.js'

/**
 * The auth-API subset consumed by Firth's auth middleware.
 * Narrow interface so callers never depend on the full SDK Auth class.
 */
export type AuthApi = { getCurrentUser(): Promise<{ id: string } | null> }

/**
 * Build a privileged client using the project admin API key.
 * Use for trusted server-side operations and token verification.
 * Never expose the returned client or its underlying key to untrusted callers.
 */
export function adminClient(cfg: FirthConfig): { database: DataClient; auth: AuthApi } {
  // createAdminClient accepts { baseUrl, apiKey } — NOT anonKey
  const c = createAdminClient({ baseUrl: cfg.insforge.baseUrl, apiKey: cfg.insforge.adminKey })
  return {
    database: c.database as unknown as DataClient,
    auth: {
      async getCurrentUser() {
        const { data, error } = await c.auth.getCurrentUser()
        if (error) throw error // don't let a network/SDK failure read as "no user"
        return data?.user ? { id: data.user.id } : null
      },
    },
  }
}

/**
 * Build a client bound to a caller's bearer token.
 * PostgREST runs as `authenticated` and RLS policies apply.
 * The token is set via the `accessToken` config field — the SDK's
 * `setSession` / `auth.setSession` does not exist; `accessToken` is
 * the correct per-client token-seeding mechanism.
 */
export function userClient(cfg: FirthConfig, token: string): { database: DataClient } {
  // accessToken in InsForgeConfig seeds the client with a fixed bearer token.
  // This disables automatic refresh (correct for short-lived per-request clients).
  const c = createClient({
    baseUrl: cfg.insforge.baseUrl,
    anonKey: cfg.insforge.anonKey,
    accessToken: token,
  })
  return { database: c.database as unknown as DataClient }
}

import { createClient, createAdminClient } from '@insforge/sdk'
import type { FirthConfig } from './config.js'
import type { DataClient } from './db/types.js'

export type AuthProxy = {
  login(email: string, password: string): Promise<{ token: string; refreshToken: string; user: { id: string; email: string } }>
  refresh(refreshToken: string): Promise<{ token: string; refreshToken: string }>
  signUp(email: string, password: string, name?: string, redirectTo?: string): Promise<{ token: string | null; needsVerification: boolean; user: { id: string; email: string } | null }>
  resendVerification(email: string, redirectTo?: string): Promise<void>
  me(token: string): Promise<{ id: string; email: string } | null>
}

export function authProxy(cfg: FirthConfig, makeClient: typeof createClient = createClient): AuthProxy {
  // Server mode: signInWithPassword returns the refresh token in the body (web mode
  // would stash it in an httpOnly cookie we can't read), and refreshSession({ refreshToken })
  // rotates it. The control plane is a server — it holds + relays these tokens to clients.
  const anon = makeClient({ baseUrl: cfg.insforge.baseUrl, anonKey: cfg.insforge.anonKey, isServerMode: true })
  return {
    async login(email, password) {
      const { data, error } = await anon.auth.signInWithPassword({ email, password })
      if (error) throw error
      if (!data?.accessToken) throw new Error('email not verified')
      return { token: data.accessToken, refreshToken: (data as any).refreshToken, user: { id: data.user.id, email: data.user.email } }
    },
    async refresh(refreshToken) {
      const { data, error } = await anon.auth.refreshSession({ refreshToken })
      if (error) throw error
      if (!data?.accessToken) throw new Error('refresh failed')
      return { token: data.accessToken, refreshToken: (data as any).refreshToken }
    },
    async signUp(email, password, name, redirectTo) {
      const { data, error } = await anon.auth.signUp({ email, password, name, redirectTo })
      if (error) throw error
      if (!data) throw new Error('sign-up failed')
      const token = (data as any).accessToken ?? null
      const needsVerification = !!(data as any).requireEmailVerification || !token
      const user = data.user ? { id: data.user.id, email: data.user.email } : null
      return { token, needsVerification, user }
    },
    async resendVerification(email, redirectTo) {
      const { error } = await anon.auth.resendVerificationEmail({ email, redirectTo })
      if (error) throw error
    },
    async me(token) {
      const c = makeClient({ baseUrl: cfg.insforge.baseUrl, anonKey: cfg.insforge.anonKey, accessToken: token })
      const { data } = await c.auth.getCurrentUser()   // invalid token → no user → null (treated as 401)
      return data?.user ? { id: data.user.id, email: data.user.email } : null
    },
  }
}

/**
 * The auth-API subset consumed by Firth's auth middleware.
 * Narrow interface so callers never depend on the full SDK Auth class.
 */
export type AuthApi = { getCurrentUser(): Promise<{ id: string } | null> }

/**
 * Verify a caller-supplied bearer token by asking the InsForge backend
 * who it belongs to. Uses a per-call client seeded with `accessToken` so
 * the request is authorised as that user, not as the admin key.
 *
 * Returns `{ id }` on success and `null` when the token is invalid/expired
 * (an auth failure, HTTP 401/403) so the caller answers 401 and the client
 * can refresh-and-retry. A genuine network / SDK failure (no auth status)
 * is re-thrown so a transient outage is never silently misread as "no user".
 */
export async function verifyToken(
  cfg: FirthConfig,
  token: string,
  makeClient: typeof createClient = createClient,
): Promise<{ id: string } | null> {
  const c = makeClient({ baseUrl: cfg.insforge.baseUrl, anonKey: cfg.insforge.anonKey, accessToken: token })
  const { data, error } = await c.auth.getCurrentUser()
  if (error) {
    // Invalid/expired token → InsForge replies 401 (or 403). Treat as "no user"
    // → the route returns 401 → CLI/dashboard refresh the token and retry.
    // Any non-auth error (network, 5xx) must still throw → 500, never a false 401.
    const status = (error as { statusCode?: number }).statusCode
    if (status === 401 || status === 403) return null
    throw error
  }
  return data?.user ? { id: data.user.id } : null
}

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

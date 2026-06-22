export type AuthUser = { id: string; email: string }

export interface Auth {
  restore(): Promise<{ user: AuthUser; token: string } | null>
  signIn(email: string, password: string): Promise<{ user: AuthUser; token: string }>
  signUp(email: string, password: string, name?: string): Promise<{ needsVerification: boolean; user?: AuthUser; token?: string }>
  resendVerification(email: string): Promise<void>
  signOut(): Promise<void>
}

const TOKEN_KEY = 'firth_token'
const REFRESH_KEY = 'firth_refresh_token'

export function getStoredToken(): string | null { return localStorage.getItem(TOKEN_KEY) }
export function getStoredRefreshToken(): string | null { return localStorage.getItem(REFRESH_KEY) }
export function setStoredTokens(t: { token: string; refreshToken: string }): void {
  localStorage.setItem(TOKEN_KEY, t.token)
  localStorage.setItem(REFRESH_KEY, t.refreshToken)
}
export function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

export function createControlPlaneAuth(apiUrl: string, fetcher: typeof fetch = (...a) => fetch(...a)): Auth {
  async function call(path: string, init: RequestInit) {
    const res = await fetcher(`${apiUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((body as any)?.error || `request failed: ${res.status}`)
    return body as any
  }

  return {
    async restore() {
      const token = localStorage.getItem(TOKEN_KEY)
      if (!token) return null
      try {
        const { user } = await call('/auth/me', { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
        return user ? { user, token } : null
      } catch {
        // The stored access token is likely expired (15-min TTL). Try a silent refresh
        // with the 7-day refresh token before forcing a re-login — otherwise reopening
        // the dashboard after 15 min always lands on the login screen.
        const refreshToken = localStorage.getItem(REFRESH_KEY)
        if (refreshToken) {
          try {
            const refreshed = await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) })
            if (refreshed?.token) {
              setStoredTokens({ token: refreshed.token, refreshToken: refreshed.refreshToken })
              const { user } = await call('/auth/me', { method: 'GET', headers: { Authorization: `Bearer ${refreshed.token}` } })
              if (user) return { user, token: refreshed.token }
            }
          } catch { /* refresh also failed — refresh token expired/invalid; fall through */ }
        }
        clearStoredTokens()
        return null
      }
    },

    async signIn(email, password) {
      const { token, refreshToken, user } = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      localStorage.setItem(TOKEN_KEY, token)
      if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken)
      return { user, token }
    },

    async signUp(email, password, name) {
      const data = await call('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, name, redirectTo: window.location.origin }),
      })
      if (!data.needsVerification && data.token && data.user) {
        localStorage.setItem(TOKEN_KEY, data.token)
        if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken)
        return { needsVerification: false, user: data.user, token: data.token }
      }
      return { needsVerification: true }
    },

    async resendVerification(email) {
      await call('/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email, redirectTo: window.location.origin }),
      })
    },

    async signOut() {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(REFRESH_KEY)
    },
  }
}

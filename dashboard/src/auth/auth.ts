import { createClient } from '@insforge/sdk'

export type AuthUser = { id: string; email: string }

export interface Auth {
  restore(): Promise<{ user: AuthUser; token: string } | null>
  signIn(email: string, password: string): Promise<{ user: AuthUser; token: string }>
  signUp(email: string, password: string, name?: string): Promise<{ needsVerification: boolean; user?: AuthUser; token?: string }>
  signInWithOAuth(provider: 'google' | 'github'): Promise<void>
  signOut(): Promise<void>
}

const TOKEN_KEY = 'firth_token'

function toUser(u: any): AuthUser {
  return { id: u?.id ?? '', email: u?.email ?? '' }
}

export function createInsforgeAuth(baseUrl: string, anonKey: string): Auth {
  const insforge = createClient({ baseUrl, anonKey })

  function readToken(): string | null {
    // Defensive: SDK token accessor path may vary across versions; fall back to localStorage.
    // Note: tokenManager is private on both InsForgeClient and Auth class in the installed SDK;
    // accessing via (insforge as any).auth?.tokenManager?.getAccessToken?.() reaches Auth's private field.
    const fromSdk = (insforge as any).auth?.tokenManager?.getAccessToken?.()
    return fromSdk ?? localStorage.getItem(TOKEN_KEY)
  }

  return {
    async restore() {
      const { data } = await insforge.auth.getCurrentUser()
      const user = data?.user
      if (!user) return null
      const token = readToken()
      if (!token) return null
      return { user: toUser(user), token }
    },

    async signIn(email, password) {
      const { data, error } = await insforge.auth.signInWithPassword({ email, password })
      if (error || !data?.accessToken) throw new Error(error?.message ?? 'sign-in failed')
      localStorage.setItem(TOKEN_KEY, data.accessToken)
      return { user: toUser(data.user), token: data.accessToken }
    },

    async signUp(email, password, name) {
      const { data, error } = await insforge.auth.signUp({ email, password, name })
      if (error || !data) throw new Error(error?.message ?? 'sign-up failed')
      const needsVerification = !!(data as any).requireEmailVerification || !(data as any).accessToken
      if (!needsVerification && (data as any).accessToken) {
        localStorage.setItem(TOKEN_KEY, (data as any).accessToken)
        return { needsVerification: false, user: toUser((data as any).user), token: (data as any).accessToken }
      }
      return { needsVerification: true }
    },

    async signInWithOAuth(provider) {
      await insforge.auth.signInWithOAuth(provider, { redirectTo: window.location.origin })
    },

    async signOut() {
      await insforge.auth.signOut()
      localStorage.removeItem(TOKEN_KEY)
    },
  }
}

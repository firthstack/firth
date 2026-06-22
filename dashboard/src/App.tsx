import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthScreen } from './views/AuthScreen'
import { Home } from './views/Home'
import { Projects } from './views/Projects'
import { ProjectDetail } from './views/ProjectDetail'
import { Row, TButton } from './ui/Terminal'
import { type Api } from './api/client'
import type { Auth, AuthUser } from './auth/auth'
import { getStoredToken, getStoredRefreshToken, setStoredTokens, clearStoredTokens } from './auth/auth'

type View = { name: 'projects' } | { name: 'detail'; projectId: string }

type RefreshOpts = {
  getRefreshToken?: () => string | null
  onTokens?: (t: { token: string; refreshToken: string }) => void
  onAuthLost?: () => void
}

export default function App({
  auth,
  makeApi,
}: {
  auth: Auth
  makeApi: (getToken: () => string | null, opts?: RefreshOpts) => Api
}) {
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [view, setView] = useState<View>({ name: 'projects' })
  const [ready, setReady] = useState(false)
  const [landing, setLanding] = useState<'home' | 'auth'>('home')

  useEffect(() => {
    let active = true
    void auth.restore().then((s) => {
      if (!active) return
      if (s) { setToken(s.token); setUser(s.user) }
      setReady(true)
    }).catch(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [auth])

  const dropToAuth = useCallback(() => {
    setToken(null); setUser(null); setView({ name: 'projects' }); setLanding('home')
  }, [])

  // Build the Api with refresh-on-401 wiring. getStoredToken is used as the token
  // getter so retries after a silent refresh pick up the freshly-persisted token.
  const api = useMemo(() => {
    const base = makeApi(getStoredToken, {
      getRefreshToken: getStoredRefreshToken,
      onTokens: (t) => { setStoredTokens(t); setToken(t.token) },
      onAuthLost: () => { clearStoredTokens(); dropToAuth() },
    })
    // Wrap the api so any unrecovered 401 from the control plane drops the session
    // back to the auth screen.
    return new Proxy(base, {
      get(target, prop) {
        const orig = (target as any)[prop]
        if (typeof orig !== 'function') return orig
        return (...args: unknown[]) =>
          Promise.resolve(orig.apply(target, args)).catch((err) => {
            if ((err as any)?.status === 401) dropToAuth()
            throw err
          })
      },
    })
  }, [makeApi, dropToAuth])

  const logout = useCallback(async () => {
    try { await auth.signOut() } finally { dropToAuth() }
  }, [auth, dropToAuth])

  if (!ready) return <p className="firth-dim">loading...</p>
  if (!token) {
    if (landing === 'home') return <Home onGetStarted={() => setLanding('auth')} />
    return <div className="firth-app"><AuthScreen auth={auth} onAuthed={(t, u) => { setToken(t); setUser(u) }} onBack={() => setLanding('home')} /></div>
  }
  return (
    <div className="firth-app">
      <header className="firth-app__bar">
        <Row>
          <span className="firth-app__brand" style={{ flex: 1 }}>firth</span>
          <span className="firth-dim">{user?.email}</span>
          <TButton onClick={logout}>[logout]</TButton>
        </Row>
      </header>
      {view.name === 'projects' && <Projects api={api} onOpen={(projectId) => setView({ name: 'detail', projectId })} />}
      {view.name === 'detail' && <ProjectDetail api={api} projectId={view.projectId} onBack={() => setView({ name: 'projects' })} />}
    </div>
  )
}

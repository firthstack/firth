import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthScreen } from './views/AuthScreen'
import { Home } from './views/Home'
import { Projects } from './views/Projects'
import { ProjectDetail } from './views/ProjectDetail'
import { Row, TButton } from './ui/Terminal'
import { type Api } from './api/client'
import type { Auth, AuthUser } from './auth/auth'

type View = { name: 'projects' } | { name: 'detail'; projectId: string }

export default function App({ auth, makeApi }: { auth: Auth; makeApi: (getToken: () => string | null) => Api }) {
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [view, setView] = useState<View>({ name: 'projects' })
  const [ready, setReady] = useState(false)
  const [landing, setLanding] = useState<'home' | 'auth'>('home')
  const tokenRef = useRef<string | null>(null)
  tokenRef.current = token

  useEffect(() => {
    let active = true
    void auth.restore().then((s) => {
      if (!active) return
      if (s) { setToken(s.token); setUser(s.user) }
      setReady(true)
    }).catch(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [auth])

  const dropToAuth = useCallback(() => { setToken(null); setUser(null); setView({ name: 'projects' }); setLanding('home') }, [])

  // Wrap the api so any 401 from the control plane drops the session back to the auth screen.
  const api = useMemo(() => {
    const base = makeApi(() => tokenRef.current)
    return new Proxy(base, {
      get(t, prop) {
        const orig = (t as any)[prop]
        if (typeof orig !== 'function') return orig
        return (...args: unknown[]) =>
          Promise.resolve(orig.apply(t, args)).catch((err) => {
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
    return <AuthScreen auth={auth} onAuthed={(t, u) => { setToken(t); setUser(u) }} onBack={() => setLanding('home')} />
  }
  return (
    <div>
      <Row>
        <span style={{ flex: 1 }}>firth</span>
        <span className="firth-dim">{user?.email}</span>
        <TButton onClick={logout}>[logout]</TButton>
      </Row>
      {view.name === 'projects' && <Projects api={api} onOpen={(projectId) => setView({ name: 'detail', projectId })} />}
      {view.name === 'detail' && <ProjectDetail api={api} projectId={view.projectId} onBack={() => setView({ name: 'projects' })} />}
    </div>
  )
}

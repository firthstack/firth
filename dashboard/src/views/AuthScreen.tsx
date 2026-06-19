import { useState } from 'react'
import { Panel, Row, TButton, TInput } from '../ui/Terminal'
import type { Auth, AuthUser } from '../auth/auth'

export function AuthScreen({ auth, onAuthed, onBack }: { auth: Auth; onAuthed: (token: string, user: AuthUser) => void; onBack?: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null); setNotice(null); setBusy(true)
    try {
      if (mode === 'signin') {
        const { user, token } = await auth.signIn(email, password)
        onAuthed(token, user)
      } else {
        const res = await auth.signUp(email, password)
        if (res.needsVerification || !res.token || !res.user) {
          setNotice('check your email to verify, then sign in')
        } else {
          onAuthed(res.token, res.user)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed')
    } finally {
      setBusy(false)
    }
  }

  async function oauth(provider: 'google' | 'github') {
    setError(null)
    try { await auth.signInWithOAuth(provider) }
    catch (err) { setError(err instanceof Error ? err.message : 'oauth failed') }
  }

  return (
    <Panel title="firth // access">
      {onBack && (
        <Row>
          <TButton onClick={onBack}>[ ← back ]</TButton>
        </Row>
      )}
      <Row>
        <TButton onClick={() => { setMode('signin'); setError(null); setNotice(null) }} disabled={mode === 'signin'}>[sign in]</TButton>
        <TButton onClick={() => { setMode('signup'); setError(null); setNotice(null) }} disabled={mode === 'signup'}>[create account]</TButton>
      </Row>
      <form onSubmit={submit}>
        <Row>
          <label htmlFor="email">email</label>
          <TInput id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Row>
        <Row>
          <label htmlFor="password">password</label>
          <TInput id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Row>
        <Row>
          <TButton type="submit" data-testid="auth-submit" disabled={busy}>[submit]</TButton>
        </Row>
      </form>
      <Row>
        <span className="firth-dim">oauth:</span>
        <TButton onClick={() => oauth('google')}>[google]</TButton>
        <TButton onClick={() => oauth('github')}>[github]</TButton>
      </Row>
      {notice && <p className="firth-dim">{notice}</p>}
      {error && <p className="firth-error">! {error}</p>}
    </Panel>
  )
}

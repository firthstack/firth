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
  const [canResend, setCanResend] = useState(false)
  const [resending, setResending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null); setNotice(null); setCanResend(false); setBusy(true)
    try {
      if (mode === 'signin') {
        const { user, token } = await auth.signIn(email, password)
        onAuthed(token, user)
      } else {
        const res = await auth.signUp(email, password)
        if (res.needsVerification || !res.token || !res.user) {
          setNotice('check your email to verify, then sign in')
          setCanResend(true)
        } else {
          onAuthed(res.token, res.user)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed')
      // A sign-in can fail because the email isn't verified yet — offer to resend the link.
      if (mode === 'signin') setCanResend(true)
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setError(null); setResending(true)
    try {
      await auth.resendVerification(email)
      setNotice(`verification link sent to ${email} — check your inbox (and spam)`)
      setCanResend(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not resend verification email')
    } finally {
      setResending(false)
    }
  }

  async function oauth(provider: 'github' | 'google') {
    if (!auth.oauthStart) return
    setError(null); setNotice(null); setBusy(true)
    try {
      const { url, codeVerifier } = await auth.oauthStart(provider, window.location.origin)
      if (codeVerifier) sessionStorage.setItem('firth_oauth_verifier', codeVerifier)
      window.location.assign(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : `could not start ${provider} sign-in`)
      setBusy(false)
    }
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
      {auth.oauthStart && (
        <>
          <Row>
            <TButton onClick={() => oauth('github')} disabled={busy} data-testid="oauth-github">[ sign in with github ]</TButton>
          </Row>
          <p className="firth-dim">— or with email —</p>
        </>
      )}
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
      {notice && <p className="firth-dim">{notice}</p>}
      {error && <p className="firth-error">! {error}</p>}
      {canResend && email && (
        <Row>
          <span className="firth-dim">email not verified?</span>
          <TButton onClick={resend} disabled={resending} data-testid="resend-verification">[ resend verification link ]</TButton>
        </Row>
      )}
    </Panel>
  )
}

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createControlPlaneAuth } from './auth'

const API_URL = 'http://localhost:8080'

function makeFetcher(responses: Array<{ ok: boolean; body: unknown }>) {
  const queue = [...responses]
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const next = queue.shift()
    if (!next) throw new Error('unexpected fetch call')
    return {
      ok: next.ok,
      json: async () => next.body,
    } as Response
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('createControlPlaneAuth', () => {
  it('signIn POSTs /auth/login and returns + stores the token', async () => {
    const fetcher = makeFetcher([{ ok: true, body: { token: 'tok-abc', user: { id: 'u1', email: 'a@b.co' } } }])
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    const result = await auth.signIn('a@b.co', 'secret')

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${API_URL}/auth/login`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.co', password: 'secret' })

    expect(result).toEqual({ token: 'tok-abc', user: { id: 'u1', email: 'a@b.co' } })
    expect(localStorage.getItem('firth_token')).toBe('tok-abc')
  })

  it('non-ok login response throws with the server error message', async () => {
    const fetcher = makeFetcher([{ ok: false, body: { error: 'invalid credentials' } }])
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    await expect(auth.signIn('a@b.co', 'wrong')).rejects.toThrow('invalid credentials')
  })

  it('restore with a stored token GETs /auth/me and returns the user', async () => {
    localStorage.setItem('firth_token', 'stored-tok')
    const fetcher = makeFetcher([{ ok: true, body: { user: { id: 'u2', email: 'x@y.co' } } }])
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    const result = await auth.restore()

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${API_URL}/auth/me`)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer stored-tok')
    expect(result).toEqual({ user: { id: 'u2', email: 'x@y.co' }, token: 'stored-tok' })
  })

  it('restore with no token returns null without fetching', async () => {
    const fetcher = vi.fn()
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    const result = await auth.restore()

    expect(result).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('restore clears the stored token and returns null when /auth/me returns non-ok', async () => {
    localStorage.setItem('firth_token', 'bad-tok')
    const fetcher = makeFetcher([{ ok: false, body: { error: 'unauthorized' } }])
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    const result = await auth.restore()

    expect(result).toBeNull()
    expect(localStorage.getItem('firth_token')).toBeNull()
  })

  it('signUp returning needsVerification:true does NOT store a token', async () => {
    const fetcher = makeFetcher([{ ok: true, body: { needsVerification: true } }])
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    // jsdom has no window.location.origin; stub it
    Object.defineProperty(window, 'location', { value: { origin: 'http://localhost:5173' }, writable: true })

    const result = await auth.signUp('a@b.co', 'pass')

    expect(result).toEqual({ needsVerification: true })
    expect(localStorage.getItem('firth_token')).toBeNull()
  })

  it('resendVerification POSTs /auth/resend-verification', async () => {
    const fetcher = makeFetcher([{ ok: true, body: { ok: true } }])
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    Object.defineProperty(window, 'location', { value: { origin: 'http://localhost:5173' }, writable: true })

    await auth.resendVerification('a@b.co')

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${API_URL}/auth/resend-verification`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ email: 'a@b.co' })
  })

  it('signOut removes the token from localStorage', async () => {
    localStorage.setItem('firth_token', 'tok-xyz')
    const fetcher = vi.fn()
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)

    await auth.signOut()

    expect(localStorage.getItem('firth_token')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('signIn stores both the access and refresh tokens; signOut clears both', async () => {
    const fetcher = makeFetcher([{ ok: true, body: { token: 'tok-abc', refreshToken: 'ref-abc', user: { id: 'u1', email: 'a@b.co' } } }])
    const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)
    await auth.signIn('a@b.co', 'secret')
    expect(localStorage.getItem('firth_token')).toBe('tok-abc')
    expect(localStorage.getItem('firth_refresh_token')).toBe('ref-abc')
    await auth.signOut()
    expect(localStorage.getItem('firth_token')).toBeNull()
    expect(localStorage.getItem('firth_refresh_token')).toBeNull()
  })
})

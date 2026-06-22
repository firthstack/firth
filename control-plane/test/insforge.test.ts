import { expect, test } from 'vitest'
import { adminClient, userClient, authProxy, verifyToken } from '../src/insforge.js'

const cfg = {
  keks: new Map(), currentKek: 'v1',
  insforge: { baseUrl: 'https://x.insforge.app', anonKey: 'anon', adminKey: 'ik_test' },
}

test('adminClient exposes database + auth', () => {
  const c = adminClient(cfg as any)
  expect(typeof c.database.from).toBe('function')
  expect(typeof c.auth.getCurrentUser).toBe('function')
})

test('userClient exposes a database bound to a token', () => {
  const c = userClient(cfg as any, 'token-abc')
  expect(typeof c.database.from).toBe('function')
})

function fakeMakeClient(calls: any[]) {
  return ((config: any) => {
    calls.push(config)
    return {
      database: { from() { return {} } },
      auth: {
        async signInWithPassword() {
          return { data: { accessToken: 'acc-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } }, error: null }
        },
        async refreshSession(_o: { refreshToken?: string }) {
          return { data: { accessToken: 'acc-2', refreshToken: 'ref-2' }, error: null }
        },
        async getCurrentUser() { return { data: { user: { id: 'u1', email: 'a@b.co' } } } },
        async signUp() { return { data: {}, error: null } },
        async resendVerificationEmail() { return { error: null } },
      },
    }
  }) as any
}

test('authProxy.login returns the refresh token and builds the client in server mode', async () => {
  const calls: any[] = []
  const ap = authProxy(cfg as any, fakeMakeClient(calls))
  const out = await ap.login('a@b.co', 'pw')
  expect(out).toEqual({ token: 'acc-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } })
  expect(calls[0].isServerMode).toBe(true)
})

test('authProxy.refresh rotates the pair via refreshSession', async () => {
  const ap = authProxy(cfg as any, fakeMakeClient([]))
  const out = await ap.refresh('ref-1')
  expect(out).toEqual({ token: 'acc-2', refreshToken: 'ref-2' })
})

// verifyToken: an auth failure (401/403) must read as "no user" (→ the route answers
// 401 so the client refreshes), while a genuine network/SDK error must still throw (→ 500).
function makeClientWithGetCurrentUser(result: { data?: any; error?: any }) {
  return ((_config: any) => ({
    database: { from() { return {} } },
    auth: { async getCurrentUser() { return result } },
  })) as any
}

test('verifyToken returns the user id on success', async () => {
  const mk = makeClientWithGetCurrentUser({ data: { user: { id: 'u9' } }, error: null })
  expect(await verifyToken(cfg as any, 'tok', mk)).toEqual({ id: 'u9' })
})

test('verifyToken returns null on a 401 auth failure (expired/invalid token → 401, client refreshes)', async () => {
  const mk = makeClientWithGetCurrentUser({ data: { user: null }, error: { statusCode: 401, error: 'AUTH_UNAUTHORIZED', message: 'Invalid token' } })
  expect(await verifyToken(cfg as any, 'expired', mk)).toBeNull()
})

test('verifyToken returns null on a 403 auth failure', async () => {
  const mk = makeClientWithGetCurrentUser({ data: { user: null }, error: { statusCode: 403, error: 'FORBIDDEN', message: 'forbidden' } })
  expect(await verifyToken(cfg as any, 'tok', mk)).toBeNull()
})

test('verifyToken re-throws a non-auth (network/5xx) error instead of masking it as no-user', async () => {
  const boom = { statusCode: 503, error: 'UPSTREAM_FAILURE', message: 'backend down' }
  const mk = makeClientWithGetCurrentUser({ data: null, error: boom })
  await expect(verifyToken(cfg as any, 'tok', mk)).rejects.toBe(boom)
})

test('verifyToken re-throws an error with no statusCode (transient/SDK failure)', async () => {
  const boom = new Error('network unreachable')
  const mk = makeClientWithGetCurrentUser({ data: null, error: boom })
  await expect(verifyToken(cfg as any, 'tok', mk)).rejects.toBe(boom)
})

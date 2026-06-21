import { expect, test } from 'vitest'
import { adminClient, userClient, authProxy } from '../src/insforge.js'

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

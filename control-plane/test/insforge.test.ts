import { expect, test } from 'vitest'
import { adminClient, userClient } from '../src/insforge.js'

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

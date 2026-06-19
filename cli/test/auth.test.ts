import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { login, logout } from '../src/commands/auth.js'
import { readConfig } from '../src/config.js'

function deps(home: string, api: any, over: Record<string, unknown> = {}) {
  const out: string[] = []
  return {
    print: (s: string) => out.push(s), out, home, cwd: home,
    env: { FIRTH_EMAIL: 'a@b.co', FIRTH_PASSWORD: 'pw' },
    makeApi: () => api,
    ...over,
  }
}

test('login calls api with creds and stores the token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const calls: [string, string][] = []
  const api = { login: async (email: string, password: string) => { calls.push([email, password]); return { token: 'tok-1', user: { id: 'u1', email } } } }
  const d = deps(home, api)
  const code = await login([], d as any)
  expect(code).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual(['a@b.co', 'pw'])
  const cfg = readConfig(home, {})
  expect(cfg.token).toBe('tok-1')
  expect((cfg as any).insforge).toBeUndefined()
  expect(d.out.join('\n')).toMatch(/signed in/i)
  expect(d.out.join('\n')).not.toContain('tok-1')
})

test('login --api-url sets and persists the control-plane host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { login: async (email: string) => ({ token: 'tok-1', user: { id: 'u1', email } }) }
  const d = deps(home, api)
  const code = await login(['--api-url', 'https://api.firth.dev'], d as any)
  expect(code).toBe(0)
  const cfg = readConfig(home, {})
  expect(cfg.apiUrl).toBe('https://api.firth.dev')
  expect(cfg.token).toBe('tok-1')
  expect(d.out.join('\n')).toMatch(/control plane: https:\/\/api\.firth\.dev/)
})

test('login fails cleanly when the api throws', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { login: async () => { throw new Error('invalid credentials') } }
  const d = deps(home, api)
  expect(await login([], d as any)).toBe(1)
  expect(readConfig(home, {}).token).toBeUndefined()
  expect(d.out.join('\n')).toMatch(/login failed: invalid credentials/i)
})

test('login returns 1 and prints usage when --email is missing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { login: async () => ({ token: 'tok', user: { id: 'u', email: 'x' } }) }
  const d = deps(home, api, { env: { FIRTH_PASSWORD: 'pw' } })
  expect(await login([], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/--email.*--password|--password.*--email/i)
})

test('login returns 1 and prints usage when --password is missing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { login: async () => ({ token: 'tok', user: { id: 'u', email: 'x' } }) }
  const d = deps(home, api, { env: { FIRTH_EMAIL: 'a@b.co' } })
  expect(await login([], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/--email.*--password|--password.*--email/i)
})

test('logout clears the token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { login: async (email: string) => ({ token: 't', user: { id: 'u', email } }) }
  const d = deps(home, api)
  await login([], d as any)
  expect(readConfig(home, {}).token).toBe('t')
  await logout([], d as any)
  expect(readConfig(home, {}).token).toBeUndefined()
})

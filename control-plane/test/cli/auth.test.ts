import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { login, logout } from '../../src/cli/commands/auth.js'
import { readConfig } from '../../src/cli/config.js'

function deps(home: string, over = {}) {
  const out: string[] = []
  return { print: (s: string) => out.push(s), out, home, cwd: home,
    env: { FIRTH_EMAIL: 'a@b.co', FIRTH_PASSWORD: 'pw', INSFORGE_BASE_URL: 'https://x.insforge.app', INSFORGE_ANON_KEY: 'anon' }, ...over }
}

test('login stores the token and never prints it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const signIn = async () => ({ accessToken: 'secret-token-xyz' })
  const d = deps(home, { signIn })
  const code = await login([], d as any)
  expect(code).toBe(0)
  expect(readConfig(home, {}).token).toBe('secret-token-xyz')
  expect(d.out.join('\n')).not.toContain('secret-token-xyz')
  expect(d.out.join('\n')).toMatch(/signed in/i)
})

test('login fails cleanly when the backend rejects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const signIn = async () => { throw new Error('invalid credentials') }
  const d = deps(home, { signIn })
  expect(await login([], d as any)).toBe(1)
  expect(readConfig(home, {}).token).toBeUndefined()
})

test('logout clears the token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  const d = deps(home, { signIn: async () => ({ accessToken: 't' }) })
  await login([], d as any)
  await logout([], d as any)
  expect(readConfig(home, {}).token).toBeUndefined()
})

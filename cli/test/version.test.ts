import { expect, test } from 'vitest'
import { route } from '../src/index.js'

function deps() {
  const out: string[] = []
  return {
    print: (s: string) => out.push(s),
    out,
    home: '/tmp',
    cwd: '/tmp',
    env: {},
  }
}

test('--version returns 0 and prints a semver string', async () => {
  const d = deps()
  const code = await route(['--version'], d as any)
  expect(code).toBe(0)
  expect(d.out.length).toBeGreaterThan(0)
  expect(d.out[0]).toMatch(/^\d+\.\d+\.\d+/)
})

test('-v returns 0 and prints a semver string', async () => {
  const d = deps()
  const code = await route(['-v'], d as any)
  expect(code).toBe(0)
  expect(d.out.length).toBeGreaterThan(0)
  expect(d.out[0]).toMatch(/^\d+\.\d+\.\d+/)
})

import { expect, test } from 'vitest'
import { route } from '../src/index.js'

function deps(over = {}) {
  const out: string[] = []
  return { print: (s: string) => out.push(s), out, home: '/tmp/none', cwd: '/tmp/none', env: {}, ...over }
}

test('--help prints usage and exits 0', async () => {
  const d = deps()
  const code = await route(['--help'], d as any)
  expect(code).toBe(0)
  expect(d.out.join('\n')).toMatch(/firth <command>/i)
})

test('unknown command prints usage and exits 1', async () => {
  const d = deps()
  const code = await route(['frobnicate'], d as any)
  expect(code).toBe(1)
  expect(d.out.join('\n')).toMatch(/unknown command/i)
})

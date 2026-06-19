import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { deploy } from '../src/commands/deploy.js'
import { writeProjectLink, setCurrentBranch } from '../src/config.js'

function deps(dir: string, api: any) {
  const out: string[] = []
  return { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
}

test('deploy posts the image + port and prints the url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { deploy: async (pid: string, o: any) => { calls.push([pid, o]); return { machineId: 'm1', url: 'https://app.fly.dev' } } }
  const d = deps(dir, api)
  expect(await deploy(['--image', 'nginx:alpine', '--port', '80'], d as any)).toBe(0)
  expect(calls[0][0]).toBe('p1')
  expect(calls[0][1]).toEqual({ image: 'nginx:alpine', from: undefined, port: 80 })
  expect(d.out.join('\n')).toMatch(/app\.fly\.dev/)
})

test('deploy requires --image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const d = deps(dir, {})
  expect(await deploy([], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/--image/)
})

test('deploy errors when not linked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const d = deps(dir, {})
  expect(await deploy(['--image', 'x'], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/not linked|project link/i)
})

test('sends the current branch from the link as branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeProjectLink('p1', dir)
  setCurrentBranch({ id: 'b-feat', name: 'feature' }, dir)
  const captured: any = {}
  const api = { deploy: async (_id: string, opts: any) => { captured.opts = opts; return { machineId: 'm', url: 'u' } } }
  const d = deps(dir, api)
  const code = await deploy(['--image', 'img'], d as any)
  expect(code).toBe(0)
  expect(captured.opts.branch).toBe('b-feat')
})

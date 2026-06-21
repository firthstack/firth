import { mkdtempSync, writeFileSync as writeFile } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { deploy } from '../src/commands/deploy.js'
import { writeProjectLink, setCurrentBranch } from '../src/config.js'
import type { BuildRunner } from '../src/flyctl-build.js'

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

const MANIFEST = 'pushing manifest for registry.fly.io/a-main:cli-1@sha256:deadbeef 0.1s done'

test('source mode: mints a token, builds via flyctl, then deploys the digest image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  setCurrentBranch({ id: 'b-main', name: 'main' }, dir)
  writeFile(join(dir, 'Dockerfile'), 'FROM nginx\n')
  const calls: any[] = []
  const api = {
    mintDeployToken: async (pid: string, opts: any) => { calls.push({ mint: { pid, opts } }); return { token: 'FlyV1 tok', expirySeconds: 1200, flyApp: 'a-main' } },
    deploy: async (pid: string, opts: any) => { calls.push({ deploy: { pid, opts } }); return { machineId: 'm-9', url: 'https://a-main.fly.dev' } },
  }
  let built: any
  const buildRunner: BuildRunner = async (cmd, args, o) => { built = { cmd, args, env: o.env }; return { code: 0, output: MANIFEST } }
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => api, buildRunner }
  expect(await deploy(['.'], d as any)).toBe(0)
  // minted for the current branch
  expect(calls[0].mint.opts).toEqual({ from: undefined, branch: 'b-main' })
  // flyctl invoked with the minted token
  expect(built.cmd).toBe('flyctl')
  expect(built.env.FLY_API_TOKEN).toBe('FlyV1 tok')
  // launched with the digest-pinned image
  expect(calls[1].deploy.opts).toMatchObject({ image: 'registry.fly.io/a-main@sha256:deadbeef', from: undefined, branch: 'b-main', port: 8080 })
  expect(out.join('\n')).toMatch(/a-main\.fly\.dev/)
})

test('source mode: no Dockerfile → error, exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => ({}) }
  expect(await deploy(['.'], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/Dockerfile/)
})

test('error when both <dir> and --image are given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => ({}) }
  expect(await deploy(['.', '--image', 'nginx'], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/one mode|both/i)
})

test('error when neither <dir> nor --image is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => ({}) }
  expect(await deploy([], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/usage|provide/i)
})

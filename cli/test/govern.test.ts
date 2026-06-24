import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { approvals, approve, deny, policy } from '../src/commands/govern.js'
import { writeProjectLink } from '../src/config.js'

function deps(dir: string, api: any) {
  const out: string[] = []
  return { d: { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }, out }
}

test('approvals lists pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { listApprovals: async (projectId: string, status: string) => { calls.push([projectId, status]); return [{ id: 'a1', action: 'project.delete', requested_at: 'now' }] } }
  const { d, out } = deps(dir, api)
  expect(await approvals([], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'pending'])
  expect(out.join('\n')).toMatch(/a1/)
  expect(out.join('\n')).toMatch(/project\.delete/)
})

test('approvals returns 0 and prints "no pending approvals" when api returns null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { listApprovals: async () => null }
  const { d, out } = deps(dir, api)
  expect(await approvals([], d as any)).toBe(0)
  expect(out.join('\n')).toMatch(/no pending approvals/)
})

test('approve calls the api', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { approve: async (pid: string, id: string) => { calls.push([pid, id]); return { id, status: 'granted' } } }
  const { d } = deps(dir, api)
  expect(await approve(['a1'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'a1'])
})

test('approve --always passes always=true and reports the policy it set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { approve: async (pid: string, id: string, always: boolean) => { calls.push([pid, id, always]); return { id, status: 'granted', action: 'secrets.read' } } }
  const { d, out } = deps(dir, api)
  expect(await approve(['a1', '--always'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'a1', true])
  expect(out.join('\n')).toMatch(/secrets\.read.*allow/)
})

test('approve (no flag) passes always=false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { approve: async (pid: string, id: string, always: boolean) => { calls.push([pid, id, always]); return { id, status: 'granted' } } }
  const { d } = deps(dir, api)
  expect(await approve(['a1'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'a1', false])
})

test('deny calls the api', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { deny: async (pid: string, id: string) => { calls.push([pid, id]); return { id, status: 'denied' } } }
  const { d } = deps(dir, api)
  expect(await deny(['a1'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'a1'])
})

test('policy set calls the api with action + decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { setPolicy: async (pid: string, a: string, dcn: string) => { calls.push([pid, a, dcn]); return { deploy: dcn } } }
  const { d } = deps(dir, api)
  expect(await policy(['set', 'deploy', 'approve'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'deploy', 'approve'])
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { branchCreate, branchList } from '../../src/cli/commands/branch.js'
import { writeProjectLink } from '../../src/cli/config.js'

function deps(dir: string, api: any) {
  const out: string[] = []
  return { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
}

test('branch create uses the linked project + --from, prints the branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const calls: any[] = []
  const api = { createBranch: async (pid: string, name: string, from: string) => { calls.push([pid, name, from]); return { branch: { id: 'b2', name } } } }
  const d = deps(dir, api)
  expect(await branchCreate(['feat', '--from', 'main'], d as any)).toBe(0)
  expect(calls[0]).toEqual(['p1', 'feat', 'main'])
  expect(d.out.join('\n')).toMatch(/feat/)
})

test('branch create errors when no project is linked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const d = deps(dir, {})
  expect(await branchCreate(['feat'], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/not linked|project link/i)
})

test('branch list prints names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { listBranches: async () => [{ id: 'b1', name: 'main' }, { id: 'b2', name: 'feat' }] }
  const d = deps(dir, api)
  expect(await branchList([], d as any)).toBe(0)
  expect(d.out.join('\n')).toMatch(/main.*feat/s)
})

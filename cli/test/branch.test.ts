import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { branchCreate, branchList, branchSwitch, branchDelete } from '../src/commands/branch.js'
import { writeProjectLink, readProjectLink, setCurrentBranch } from '../src/config.js'

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

test('branch switch stores current branch in link file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { listBranches: async () => [{ id: 'b1', name: 'main', is_default: true }, { id: 'b2', name: 'feat' }] }
  const d = deps(dir, api)
  expect(await branchSwitch(['feat'], d as any)).toBe(0)
  const link = readProjectLink(dir)
  expect(link?.branch?.id).toBe('b2')
  expect(link?.branch?.name).toBe('feat')
})

test('branch switch errors on unknown name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { listBranches: async () => [{ id: 'b1', name: 'main', is_default: true }, { id: 'b2', name: 'feat' }] }
  const d = deps(dir, api)
  expect(await branchSwitch(['nonexistent'], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/not found/i)
})

test('branch delete without --yes returns 1 and does not call deleteBranch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  let deleteCalled = false
  const api = {
    listBranches: async () => [{ id: 'b1', name: 'main', is_default: true }, { id: 'b2', name: 'feat' }],
    deleteBranch: async () => { deleteCalled = true; return {} }
  }
  const d = deps(dir, api)
  expect(await branchDelete(['feat'], d as any)).toBe(1)
  expect(deleteCalled).toBe(false)
})

test('branch delete with --yes deletes and clears current branch if matched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  setCurrentBranch({ id: 'b2', name: 'feat' }, dir)
  const deleteCalls: any[] = []
  const api = {
    listBranches: async () => [{ id: 'b1', name: 'main', is_default: true }, { id: 'b2', name: 'feat' }],
    deleteBranch: async (pid: string, bid: string) => { deleteCalls.push([pid, bid]); return { branch: {}, teardown: { destroyed: ['neon'], failed: [] } } }
  }
  const d = deps(dir, api)
  expect(await branchDelete(['feat', '--yes'], d as any)).toBe(0)
  expect(deleteCalls[0]).toEqual(['p1', 'b2'])
  expect(readProjectLink(dir)?.branch).toBeUndefined()
})

test('branch delete rejects default branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = {
    listBranches: async () => [{ id: 'b1', name: 'main', is_default: true }, { id: 'b2', name: 'feat' }],
    deleteBranch: async () => ({})
  }
  const d = deps(dir, api)
  expect(await branchDelete(['main'], d as any)).toBe(1)
  expect(d.out.join('\n')).toMatch(/cannot delete the default branch/i)
})

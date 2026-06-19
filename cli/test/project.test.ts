import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { projectCreate, projectLink, projectList, projectDelete } from '../src/commands/project.js'
import { readProjectLink, writeProjectLink } from '../src/config.js'
import { FirthApi } from '../src/api.js'

function depsWith(api: FirthApi, dir: string) {
  const out: string[] = []
  return { print: (s: string) => out.push(s), out, home: dir, cwd: dir,
    env: {}, _api: api, makeApi: () => api }
}

test('project create POSTs, links the dir, prints the id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { createProject: async (n: string) => ({ project: { id: 'p9', name: n }, defaultBranch: { id: 'b', name: 'main' }, resources: [] }) } as any
  const d = depsWith(api, dir)
  const code = await projectCreate(['my-app'], d as any)
  expect(code).toBe(0)
  expect(readProjectLink(dir)?.projectId).toBe('p9')
  expect(readProjectLink(dir)?.branch).toEqual({ id: 'b', name: 'main' }) // auto-switched to the default branch
  expect(d.out.join('\n')).toMatch(/p9/)
  expect(d.out.join('\n')).toMatch(/on branch main/)
})

test('project link auto-switches to the default branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { listBranches: async (_id: string) => [{ id: 'bm', name: 'main', is_default: true }, { id: 'bd', name: 'dev', is_default: false }] } as any
  const d = depsWith(api, dir)
  expect(await projectLink(['p7'], d as any)).toBe(0)
  expect(readProjectLink(dir)?.projectId).toBe('p7')
  expect(readProjectLink(dir)?.branch).toEqual({ id: 'bm', name: 'main' })
  expect(d.out.join('\n')).toMatch(/on branch main/)
})

test('project link still links the id when the branch lookup fails (offline / not logged in)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { listBranches: async () => { throw new Error('not logged in') } } as any
  const d = depsWith(api, dir)
  expect(await projectLink(['p7'], d as any)).toBe(0)
  expect(readProjectLink(dir)?.projectId).toBe('p7')
  expect(readProjectLink(dir)?.branch).toBeUndefined()
})

test('project list prints names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { listProjects: async () => [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }] } as any
  const d = depsWith(api, dir)
  expect(await projectList([], d as any)).toBe(0)
  expect(d.out.join('\n')).toMatch(/a.*b/s)
})

test('project delete without --yes returns 1 and does not call deleteProject', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeProjectLink('p1', dir)
  let called = false
  const api = { deleteProject: async (_id: string) => { called = true; return {} } } as any
  const d = depsWith(api, dir)
  const code = await projectDelete([], d as any)
  expect(code).toBe(1)
  expect(called).toBe(false)
  expect(d.out.join('\n')).toMatch(/destroy|confirm/i)
})

test('project delete with --yes calls deleteProject and clears link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeProjectLink('p1', dir)
  const calls: string[] = []
  const api = {
    deleteProject: async (id: string) => {
      calls.push(id)
      return { project: {}, teardown: { destroyed: ['neon', 'fly'], failed: [] } }
    }
  } as any
  const d = depsWith(api, dir)
  const code = await projectDelete(['--yes'], d as any)
  expect(code).toBe(0)
  expect(calls).toEqual(['p1'])
  expect(readProjectLink(dir)).toBeNull()
  const output = d.out.join('\n')
  expect(output).toMatch(/deleted project p1/)
  expect(output).toMatch(/neon/)
})

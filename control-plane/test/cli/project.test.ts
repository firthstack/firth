import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { projectCreate, projectList } from '../../src/cli/commands/project.js'
import { readProjectLink } from '../../src/cli/config.js'
import { FirthApi } from '../../src/cli/api.js'

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
  expect(d.out.join('\n')).toMatch(/p9/)
})

test('project list prints names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { listProjects: async () => [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }] } as any
  const d = depsWith(api, dir)
  expect(await projectList([], d as any)).toBe(0)
  expect(d.out.join('\n')).toMatch(/a.*b/s)
})

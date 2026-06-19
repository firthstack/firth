import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ensureSkills } from '../src/ensure-skills.js'
import { writeProjectLink, readProjectLink, markSkillsInstalled } from '../src/config.js'

function fakeRun() {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const run = async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { ok: true } }
  return { calls, run }
}

test('ensureSkills installs the three skills once for a linked project and marks done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const { calls, run } = fakeRun()
  await ensureSkills({ print: (s) => out.push(s), cwd: dir, run })
  expect(calls.map((c) => c.cmd)).toEqual(['npx', 'npx', 'npx'])
  expect(calls.map((c) => c.args.join(' '))).toEqual([
    'skills add neondatabase/agent-skills -s neon-postgres',
    'skills add tigrisdata/skills',
    'skills add firthstack/firth --skill firth',
  ])
  expect(readProjectLink(dir)?.skillsInstalled).toBe(true)
  expect(out.join('\n')).toMatch(/neon-postgres ✓/)
})

test('ensureSkills is a no-op when skills are already installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir); markSkillsInstalled(dir)
  const { calls, run } = fakeRun()
  await ensureSkills({ print: () => {}, cwd: dir, run })
  expect(calls).toHaveLength(0)
})

test('ensureSkills is a no-op without a runner (so tests never spawn npx)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  await ensureSkills({ print: (s) => out.push(s), cwd: dir }) // no run
  expect(out).toHaveLength(0)
  expect(readProjectLink(dir)?.skillsInstalled).toBeUndefined()
})

test('ensureSkills is a no-op when the directory is not linked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')) // no writeProjectLink
  const { calls, run } = fakeRun()
  await ensureSkills({ print: () => {}, cwd: dir, run })
  expect(calls).toHaveLength(0)
})

test('a failed skill add still marks done (no re-run) and reports it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const run = async (_cmd: string, args: string[]) => ({ ok: !args.includes('tigrisdata/skills') })
  await ensureSkills({ print: (s) => out.push(s), cwd: dir, run })
  expect(readProjectLink(dir)?.skillsInstalled).toBe(true)
  expect(out.join('\n')).toMatch(/tigris failed/)
})

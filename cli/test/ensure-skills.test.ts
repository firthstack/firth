import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ensureSkills } from '../src/ensure-skills.js'
import { writeProjectLink, readProjectLink, markSkillsInstalled, ensureGitignore } from '../src/config.js'

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
    'skills add neondatabase/agent-skills -s neon-postgres -a claude-code -a codex -y --copy',
    'skills add tigrisdata/skills -s tigris-object-operations -s file-storage -s tigris-sdk-guide -s tigris-security-access-control -s tigris-image-optimization -s tigris-s3-migration -s tigris-static-assets -s tigris-agent-kit -a claude-code -a codex -y --copy',
    'skills add firthstack/firth -s firth -a claude-code -a codex -y --copy',
  ])
  // non-interactive: every invocation pins the agents (claude-code + codex) + skip-prompt flags
  for (const c of calls) {
    expect(c.args).toContain('-y')
    expect(c.args.join(' ')).toMatch(/-a claude-code/)
    expect(c.args.join(' ')).toMatch(/-a codex/)
  }
  expect(readProjectLink(dir)?.skillsInstalled).toBe(true)
  expect(out.join('\n')).toMatch(/neon-postgres ✓/)
  // the installed skill dirs are gitignored
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  expect(gi).toMatch(/\.claude\/skills\//)
  expect(gi).toMatch(/\.agents\/skills\//)
  expect(gi).toMatch(/\.github\/skills\//)
})

test('ensureGitignore appends missing entries idempotently, preserving existing content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n.env\n')
  const added1 = ensureGitignore(dir, ['.claude/skills/', '.env']) // .env already present
  expect(added1).toEqual(['.claude/skills/'])
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  expect(gi).toMatch(/^node_modules$/m)
  expect(gi).toMatch(/^\.env$/m)
  expect((gi.match(/\.env/g) || []).length).toBe(1) // not duplicated
  // re-running adds nothing
  expect(ensureGitignore(dir, ['.claude/skills/', '.env'])).toEqual([])
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

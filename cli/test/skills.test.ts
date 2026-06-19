import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { skillsPull } from '../src/commands/skills.js'

test('skills pull installs the firth SKILL.md into ./.claude/skills/firth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {} }
  expect(await skillsPull([], d as any)).toBe(0)
  const p = join(dir, '.claude', 'skills', 'firth', 'SKILL.md')
  expect(existsSync(p)).toBe(true)
  expect(readFileSync(p, 'utf8')).toMatch(/firth/i)
})

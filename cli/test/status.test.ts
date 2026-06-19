import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { status } from '../src/commands/status.js'
import { writeConfig, writeProjectLink, setCurrentBranch } from '../src/config.js'

function deps(dir: string) {
  const out: string[] = []
  return { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {} }
}

test('status prints all four lines when linked with current branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeConfig({ apiUrl: 'https://api.example', token: 'tok' }, dir)
  writeProjectLink('proj-abc', dir)
  setCurrentBranch({ id: 'b99', name: 'staging' }, dir)
  const d = deps(dir)
  expect(await status([], d as any)).toBe(0)
  const output = d.out.join('\n')
  expect(output).toMatch(/api:\s+https:\/\/api\.example/)
  expect(output).toMatch(/auth:\s+signed in/)
  expect(output).toMatch(/project:\s+proj-abc/)
  expect(output).toMatch(/branch:\s+staging \(b99\)/)
})

test('status shows not linked and not signed in when no config or link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const d = deps(dir)
  expect(await status([], d as any)).toBe(0)
  const output = d.out.join('\n')
  expect(output).toMatch(/auth:\s+not signed in/)
  expect(output).toMatch(/project:\s+\(not linked\)/)
  expect(output).toMatch(/branch:\s+\(default\)/)
})

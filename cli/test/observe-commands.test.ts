import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeReport, observeUninstall } from '../src/commands/observe.js'

test('observe report renders the local audit log', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.firth'), { recursive: true })
  writeFileSync(join(cwd, '.firth', 'audit.jsonl'),
    '{"kind":"exposure","severity":"high","sink":"network","detector":"github_token","fingerprint":"gh:••••e5f6:#1","note":"n","surface":"Bash:input.command","tool":"Bash","ts":"2026-06-25T10:00:00Z"}\n')
  const out: string[] = []
  expect(await observeReport([], { print: (s: string) => out.push(s), cwd, home: cwd, env: {} } as any)).toBe(0)
  expect(out.join('\n')).toMatch(/EXPOSURES/)
})

test('observe report with no log is a friendly no-op', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const out: string[] = []
  expect(await observeReport([], { print: (s: string) => out.push(s), cwd, home: cwd, env: {} } as any)).toBe(0)
  expect(out.join('\n')).toMatch(/no audit log|empty|nothing/i)
})

test('observe uninstall is a safe no-op when nothing is installed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const out: string[] = []
  expect(await observeUninstall([], { print: (s: string) => out.push(s), cwd, home: cwd, env: {} } as any)).toBe(0)
})

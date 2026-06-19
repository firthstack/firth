import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeSync } from '../../src/cli/commands/observe.js'
import { writeProjectLink } from '../../src/cli/config.js'

test('observe sync uploads redacted audit lines as agent events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), '{"sink":"network","secret":"gh ••••e5f6"}\n{"sink":"git"}\n')
  const posted: any[] = []
  const api = { postEvents: async (_pid: string, evs: any[]) => { posted.push(...evs); return { recorded: evs.length } } }
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await observeSync([], d as any)).toBe(0)
  expect(posted).toHaveLength(2)
  expect(posted[0]).toMatchObject({ source: 'agent', kind: 'agent.network' })
  expect(out.join('\n')).toMatch(/2/)
})

test('observe sync with no audit log is a friendly no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => ({ postEvents: async () => ({ recorded: 0 }) }) }
  expect(await observeSync([], d as any)).toBe(0)
})

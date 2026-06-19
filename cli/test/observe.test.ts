import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeSync } from '../src/commands/observe.js'
import { writeProjectLink } from '../src/config.js'
import { readAuditOffset } from '../src/sync-state.js'

function fakeApi(posted: any[]) {
  return { postEvents: async (_pid: string, evs: any[]) => { posted.push(...evs); return { recorded: evs.length, skipped: 0 } } }
}

test('first sync uploads all lines as agent events with a dedup_key and advances the watermark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  const log = '{"sink":"network","x":1}\n{"sink":"git"}\n'
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), log)
  const posted: any[] = []
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  expect(await observeSync([], d as any)).toBe(0)
  expect(posted).toHaveLength(2)
  expect(posted[0]).toMatchObject({ source: 'agent', kind: 'agent.network' })
  expect(typeof posted[0].dedup_key).toBe('string')
  expect(posted[0].dedup_key).toHaveLength(64) // sha256 hex
  expect(out.join('\n')).toMatch(/synced 2 new/)
  expect(readAuditOffset(dir)).toBe(Buffer.byteLength(log, 'utf8'))
})

test('second sync with no new lines is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), '{"sink":"git"}\n')
  const posted: any[] = []
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  await observeSync([], d as any)
  posted.length = 0
  const out: string[] = []
  const d2 = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  expect(await observeSync([], d2 as any)).toBe(0)
  expect(posted).toHaveLength(0)
  expect(out.join('\n')).toMatch(/nothing new/)
})

test('appended lines: the next sync uploads only the new ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  const p = join(dir, '.firth', 'audit.jsonl')
  writeFileSync(p, '{"sink":"git"}\n')
  const posted: any[] = []
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  await observeSync([], d as any)
  posted.length = 0
  appendFileSync(p, '{"sink":"network"}\n')
  await observeSync([], d as any)
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ kind: 'agent.network' })
})

test('--all re-sends the whole log regardless of the watermark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'audit.jsonl'), '{"sink":"git"}\n{"sink":"network"}\n')
  const posted: any[] = []
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi(posted) }
  await observeSync([], d as any)        // first: uploads 2
  posted.length = 0
  await observeSync(['--all'], d as any) // --all: re-reads all 2
  expect(posted).toHaveLength(2)
})

test('not linked → error, exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => fakeApi([]) }
  expect(await observeSync([], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/not linked/)
})

test('no audit log is a friendly no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => fakeApi([]) }
  expect(await observeSync([], d as any)).toBe(0)
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { events } from '../../src/cli/commands/events.js'
import { writeProjectLink } from '../../src/cli/config.js'

test('events prints the timeline for the linked project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const api = { listEvents: async () => [
    { id: 'e1', created_at: '2026-06-18T10:00:00Z', source: 'resource', kind: 'deploy', payload: { url: 'https://a.fly.dev' } },
    { id: 'e2', created_at: '2026-06-18T09:00:00Z', source: 'agent', kind: 'agent.network', payload: {} },
  ] }
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await events([], d as any)).toBe(0)
  expect(out.join('\n')).toMatch(/deploy/)
  expect(out.join('\n')).toMatch(/agent\.network/)
})

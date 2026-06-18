import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { secrets } from '../../src/cli/commands/secrets.js'
import { writeProjectLink } from '../../src/cli/config.js'

test('secrets merges project + branch scoped secrets into .env, never printing values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const api = {
    listBranches: async () => [{ id: 'b-main', name: 'main', is_default: true }],
    // seam is either/or: no branch → project-scoped (AWS_*); branch id → that branch's DATABASE_URL
    getSecrets: async (_pid: string, branch?: string) =>
      branch === 'b-main' ? { DATABASE_URL: 'postgresql://secret' } : { AWS_ACCESS_KEY_ID: 'tid_x' },
  }
  const d = { print: (s: string) => out.push(s), out, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await secrets([], d as any)).toBe(0)
  const env = readFileSync(join(dir, '.env'), 'utf8')
  expect(env).toContain('DATABASE_URL=postgresql://secret') // branch-scoped
  expect(env).toContain('AWS_ACCESS_KEY_ID=tid_x')          // project-scoped
  expect(out.join('\n')).not.toContain('postgresql://secret')
  expect(out.join('\n')).toMatch(/2 secrets.*\.env/s)
})

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { secrets } from '../src/commands/secrets.js'
import { writeProjectLink, setCurrentBranch } from '../src/config.js'

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

test('secrets uses current branch when set and no --branch flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeProjectLink('p1', dir)
  setCurrentBranch({ id: 'b99', name: 'staging' }, dir)
  const api = {
    listBranches: async () => [
      { id: 'b-main', name: 'main', is_default: true },
      { id: 'b99', name: 'staging' },
    ],
    getSecrets: async (_pid: string, branch?: string) =>
      branch === 'b99' ? { STAGING_URL: 'https://staging.example' } : { AWS_KEY: 'aws-val' },
  }
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await secrets([], d as any)).toBe(0)
  const env = readFileSync(join(dir, '.env'), 'utf8')
  expect(env).toContain('STAGING_URL=https://staging.example')
})

test('secrets preserves user-added .env lines and updates stale Firth keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  // Pre-existing .env with a user var, a comment, and a stale Firth-managed key.
  writeFileSync(join(dir, '.env'), '# my app config\nAPP_FEATURE_FLAG=on\nDATABASE_URL=postgresql://OLD\n')
  const api = {
    listBranches: async () => [{ id: 'b-main', name: 'main', is_default: true }],
    getSecrets: async (_pid: string, branch?: string) =>
      branch === 'b-main' ? { DATABASE_URL: 'postgresql://NEW' } : { AWS_ACCESS_KEY_ID: 'tid_x' },
  }
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await secrets([], d as any)).toBe(0)
  const env = readFileSync(join(dir, '.env'), 'utf8')
  expect(env).toContain('# my app config')          // comment preserved
  expect(env).toContain('APP_FEATURE_FLAG=on')       // user var preserved
  expect(env).toContain('DATABASE_URL=postgresql://NEW') // stale Firth key updated
  expect(env).not.toContain('postgresql://OLD')      // old value gone
  expect(env).toContain('AWS_ACCESS_KEY_ID=tid_x')
})

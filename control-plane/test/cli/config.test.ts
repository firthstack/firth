import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readConfig, writeConfig, readProjectLink, writeProjectLink } from '../../src/cli/config.js'

test('apiUrl precedence: env > file > default', () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  expect(readConfig(home, {}).apiUrl).toBe('http://localhost:8080')
  writeConfig({ apiUrl: 'https://cp.example' }, home)
  expect(readConfig(home, {}).apiUrl).toBe('https://cp.example')
  expect(readConfig(home, { FIRTH_API_URL: 'https://env.example' }).apiUrl).toBe('https://env.example')
})

test('writeConfig round-trips token + insforge', () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  writeConfig({ apiUrl: 'x', token: 't', insforge: { baseUrl: 'b', anonKey: 'a' } }, home)
  const c = readConfig(home, {})
  expect(c.token).toBe('t'); expect(c.insforge?.anonKey).toBe('a')
})

test('project link round-trips', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-proj-'))
  expect(readProjectLink(cwd)).toBeNull()
  writeProjectLink('proj-123', cwd)
  expect(readProjectLink(cwd)?.projectId).toBe('proj-123')
})

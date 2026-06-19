import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readConfig, writeConfig, readProjectLink, writeProjectLink, setCurrentBranch, clearProjectLink } from '../src/config.js'

test('apiUrl precedence: env > file > default', () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  expect(readConfig(home, {}).apiUrl).toBe('https://firth-control-plane-0662c2ef-202a-4feb-8267-5501b3b60037.fly.dev')
  writeConfig({ apiUrl: 'https://cp.example' }, home)
  expect(readConfig(home, {}).apiUrl).toBe('https://cp.example')
  expect(readConfig(home, { FIRTH_API_URL: 'https://env.example' }).apiUrl).toBe('https://env.example')
})

test('writeConfig round-trips token', () => {
  const home = mkdtempSync(join(tmpdir(), 'firth-'))
  writeConfig({ apiUrl: 'x', token: 't' }, home)
  const c = readConfig(home, {})
  expect(c.token).toBe('t')
})

test('project link round-trips', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-proj-'))
  expect(readProjectLink(cwd)).toBeNull()
  writeProjectLink('proj-123', cwd)
  expect(readProjectLink(cwd)?.projectId).toBe('proj-123')
})

test('setCurrentBranch preserves projectId + adds branch', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-proj-'))
  writeProjectLink('proj-abc', cwd)
  setCurrentBranch({ id: 'br-1', name: 'feature/x' }, cwd)
  const link = readProjectLink(cwd)
  expect(link?.projectId).toBe('proj-abc')
  expect(link?.branch?.id).toBe('br-1')
  expect(link?.branch?.name).toBe('feature/x')
})

test('setCurrentBranch(null) removes branch key', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-proj-'))
  writeProjectLink('proj-abc', cwd)
  setCurrentBranch({ id: 'br-1', name: 'feature/x' }, cwd)
  setCurrentBranch(null, cwd)
  const link = readProjectLink(cwd)
  expect(link?.projectId).toBe('proj-abc')
  expect(link?.branch).toBeUndefined()
})

test('readProjectLink returns branch after setCurrentBranch', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-proj-'))
  writeProjectLink('proj-xyz', cwd)
  setCurrentBranch({ id: 'br-99', name: 'main' }, cwd)
  const link = readProjectLink(cwd)
  expect(link?.branch).toEqual({ id: 'br-99', name: 'main' })
})

test('clearProjectLink removes the file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-proj-'))
  writeProjectLink('proj-del', cwd)
  clearProjectLink(cwd)
  expect(readProjectLink(cwd)).toBeNull()
  expect(existsSync(join(cwd, '.firth', 'project.json'))).toBe(false)
})

test('writeProjectLink resets (drops branch) after setCurrentBranch was called', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-proj-'))
  writeProjectLink('proj-reset', cwd)
  setCurrentBranch({ id: 'br-old', name: 'old-branch' }, cwd)
  writeProjectLink('proj-reset', cwd)
  const link = readProjectLink(cwd)
  expect(link?.projectId).toBe('proj-reset')
  expect(link?.branch).toBeUndefined()
})

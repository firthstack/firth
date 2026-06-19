import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readAuditOffset, writeAuditOffset, readNewAuditLines } from '../src/sync-state.js'

test('readAuditOffset: missing file → 0; round-trips a written offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  expect(readAuditOffset(dir)).toBe(0)
  writeAuditOffset(dir, 42, '2026-06-19T00:00:00.000Z')
  expect(readAuditOffset(dir)).toBe(42)
  expect(JSON.parse(readFileSync(join(dir, '.firth', 'sync-state.json'), 'utf8')).audit.syncedAt).toBe('2026-06-19T00:00:00.000Z')
})

test('readAuditOffset: malformed JSON → 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(dir, '.firth'), { recursive: true })
  writeFileSync(join(dir, '.firth', 'sync-state.json'), 'not json')
  expect(readAuditOffset(dir)).toBe(0)
})

test('readNewAuditLines: reads all complete lines from offset 0', () => {
  const r = readNewAuditLines('a\nbb\n', 0)
  expect(r.lines).toEqual(['a', 'bb'])
  expect(r.ends).toEqual([2, 5])
  expect(r.newOffset).toBe(5)
})

test('readNewAuditLines: offset at EOF → nothing new', () => {
  expect(readNewAuditLines('a\nbb\n', 5)).toEqual({ lines: [], ends: [], newOffset: 5 })
})

test('readNewAuditLines: resumes from a mid-file offset', () => {
  const r = readNewAuditLines('a\nbb\n', 2)
  expect(r.lines).toEqual(['bb'])
  expect(r.ends).toEqual([5])
  expect(r.newOffset).toBe(5)
})

test('readNewAuditLines: excludes a trailing partial line', () => {
  const r = readNewAuditLines('a\nb', 0)
  expect(r.lines).toEqual(['a'])
  expect(r.newOffset).toBe(2)
})

test('readNewAuditLines: truncation (offset > length) restarts from 0', () => {
  const r = readNewAuditLines('a\n', 100)
  expect(r.lines).toEqual(['a'])
  expect(r.newOffset).toBe(2)
})

test('readNewAuditLines: counts bytes, not chars, for multibyte lines', () => {
  const r = readNewAuditLines('✓\n', 0) // ✓ is 3 UTF-8 bytes + newline = 4
  expect(r.lines).toEqual(['✓'])
  expect(r.ends).toEqual([4])
  expect(r.newOffset).toBe(4)
})

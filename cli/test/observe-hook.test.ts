import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { recordFindings } from '../src/observe/hook.js'

const AKIA = 'AKIA' + 'Q'.repeat(16)

test('records a redacted finding line to .firth/audit.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const n = recordFindings({ tool_name: 'Write', tool_input: { file_path: '/a/src/c.ts', content: `k='${AKIA}'` },
    session_id: 's1', cwd: dir }, dir)
  expect(n).toBe(1)
  const log = readFileSync(join(dir, '.firth', 'audit.jsonl'), 'utf8').trim()
  const rec = JSON.parse(log)
  expect(rec).toMatchObject({ kind: 'exposure', sink: 'nonsecret_file', tool: 'Write', session_id: 's1' })
  expect(typeof rec.ts).toBe('string')
  expect(log).not.toContain(AKIA) // redaction invariant in the persisted log
})

test('no findings → no file written, returns 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  expect(recordFindings({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, dir)).toBe(0)
  expect(existsSync(join(dir, '.firth', 'audit.jsonl'))).toBe(false)
})

test('ignores secrets in paths under the project .firth/ dir (self-writes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const n = recordFindings({ tool_name: 'Write',
    tool_input: { file_path: join(dir, '.firth', 'audit.jsonl'), content: AKIA } }, dir)
  expect(n).toBe(0)
})

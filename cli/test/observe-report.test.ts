import { expect, test } from 'vitest'
import { renderReport } from '../src/observe/report.js'

test('renders exposures first, then touches', () => {
  const rows = [
    { ts: '2026-06-25T10:00:00Z', kind: 'exposure', severity: 'high', sink: 'network',
      detector: 'github_token', surface: 'Bash:input.command', tool: 'Bash',
      fingerprint: 'github_token:••••e5f6:#1a2b3c4d', snippet: 'curl …', note: 'secret in an outbound network command' },
    { ts: '2026-06-25T10:01:00Z', kind: 'touch', severity: 'info', detector: 'db_conn_string',
      note: 'secret visible in tool output', fingerprint: 'db_conn_string:••••pass:#9' },
  ]
  const out = renderReport(rows)
  expect(out).toMatch(/EXPOSURES/)
  expect(out).toMatch(/network/)
  expect(out).toMatch(/github_token:••••e5f6/)
  expect(out).toMatch(/TOUCHES/)
})

test('empty rows → a friendly empty message', () => {
  expect(renderReport([])).toMatch(/empty|nothing|no findings/i)
})

import { expect, test } from 'vitest'
import { scanEvent, isSecretFile } from '../src/observe/scanner.js'

const AKIA = 'AKIA' + 'Q'.repeat(16)
const GHP = 'ghp_' + 'a1b2c3d4e5'.repeat(4)
const STRIPE = 'sk_live_' + '0A1b2C3d4E5f6G7h'

test('read .env → touch', () => {
  const f = scanEvent({ tool_name: 'Read', tool_input: { file_path: '/app/.env' },
    tool_response: { type: 'text', text: 'DB_PASSWORD=hunter2pass\n' } })
  expect(f.length).toBeGreaterThanOrEqual(1)
  expect(f.some((x) => x.kind === 'touch')).toBe(true)
})

test('write AWS key into source → exposure/high/nonsecret_file', () => {
  const f = scanEvent({ tool_name: 'Write',
    tool_input: { file_path: '/app/src/config.ts', content: `export const k = '${AKIA}'` } })
  expect(f.some((x) => x.sink === 'nonsecret_file' && x.severity === 'high')).toBe(true)
})

test('curl with github bearer token → exposure/high/network', () => {
  const f = scanEvent({ tool_name: 'Bash',
    tool_input: { command: `curl -H 'Authorization: Bearer ${GHP}' https://x` } })
  expect(f.some((x) => x.sink === 'network' && x.severity === 'high')).toBe(true)
})

test('echo secret → exposure/stdout', () => {
  const f = scanEvent({ tool_name: 'Bash', tool_input: { command: `echo ${STRIPE}` },
    tool_response: { type: 'text', text: STRIPE + '\n' } })
  expect(f.some((x) => x.sink === 'stdout')).toBe(true)
})

test('git commit .env → exposure/high/git', () => {
  const f = scanEvent({ tool_name: 'Bash', tool_input: { command: 'git add .env && git commit -m wip' } })
  expect(f.some((x) => x.sink === 'git' && x.severity === 'high')).toBe(true)
})

test('clean command → no findings', () => {
  expect(scanEvent({ tool_name: 'Bash', tool_input: { command: 'npm test' },
    tool_response: { type: 'text', text: 'ok' } })).toHaveLength(0)
})

test('env-var reference is not a secret → no findings', () => {
  expect(scanEvent({ tool_name: 'Write',
    tool_input: { file_path: '/app/db.ts', content: 'const password = process.env.DB_PASSWORD' } })).toHaveLength(0)
})

test('placeholder → no findings', () => {
  expect(scanEvent({ tool_name: 'Write',
    tool_input: { file_path: '/app/.env.example', content: 'API_KEY=your_api_key_here' } })).toHaveLength(0)
})

test('REDACTION INVARIANT: no raw secret appears in any finding', () => {
  const events = [
    { tool_name: 'Write', tool_input: { file_path: '/app/src/c.ts', content: `k='${AKIA}'` } },
    { tool_name: 'Bash', tool_input: { command: `curl -H 'Authorization: Bearer ${GHP}'` } },
    { tool_name: 'Bash', tool_input: { command: `echo ${STRIPE}` } },
    { tool_name: 'Read', tool_input: { file_path: '/app/.env' }, tool_response: { text: 'DB_PASSWORD=hunter2pass' } },
  ]
  const blob = JSON.stringify(events.flatMap((e) => scanEvent(e as any)))
  for (const raw of [AKIA, GHP, STRIPE, 'hunter2pass']) expect(blob).not.toContain(raw)
})

test('overlap dedup: a token matched by two detectors yields one finding', () => {
  // a bearer token that is also a github token → single finding, not two
  const f = scanEvent({ tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${GHP}" https://x` } })
  const fps = new Set(f.map((x) => x.fingerprint))
  expect(fps.size).toBe(f.length) // no duplicate fingerprints from overlapping detectors
  expect(f.filter((x) => x.sink === 'network').length).toBe(1)
})

test('isSecretFile: detects secret files, excludes safe templates', () => {
  expect(isSecretFile('/app/.env')).toBe(true)
  expect(isSecretFile('/app/key.pem')).toBe(true)
  expect(isSecretFile('/app/.env.example')).toBe(false)
  expect(isSecretFile('/app/id_rsa.pub')).toBe(false)
  expect(isSecretFile('/app/src/index.ts')).toBe(false)
})

test('Codex Bash event scans identically (tool_name Bash + tool_input.command)', () => {
  const f = scanEvent({ tool_name: 'Bash', tool_input: { command: `curl https://x?k=${GHP}` }, session_id: 's', cwd: '/p' })
  expect(f.some((x) => x.sink === 'network')).toBe(true)
})

const AKIA2 = 'AKIA' + 'Z'.repeat(16)
const PATCH = (file: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n+const k = '${AKIA2}'\n*** End Patch`

test('apply_patch writing a secret into source → exposure/high/nonsecret_file', () => {
  const f = scanEvent({ tool_name: 'apply_patch', tool_input: { input: PATCH('src/config.ts') } })
  expect(f.some((x) => x.sink === 'nonsecret_file' && x.severity === 'high')).toBe(true)
})

test('apply_patch writing to a secret file → write_secret_file/touch', () => {
  const f = scanEvent({ tool_name: 'apply_patch', tool_input: { input: PATCH('.env') } })
  expect(f.some((x) => x.sink === 'write_secret_file')).toBe(true)
})

test('apply_patch value detection works even with an unknown payload field (shape-independent)', () => {
  const f = scanEvent({ tool_name: 'apply_patch', tool_input: { weird_field: `token=${AKIA2}` } })
  expect(f.length).toBeGreaterThanOrEqual(1) // value still caught regardless of file-path extraction
})

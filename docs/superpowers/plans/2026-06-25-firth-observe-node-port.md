# Observe Hook → Node Port + Auto-Install (Claude Code + Codex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python Observe hook with a TypeScript port that ships in the `firth` npm package, runs on Node, and auto-installs into both Claude Code (`.claude/settings.json`) and Codex (`.codex/hooks.json`) at `firth project link`/`create`.

**Architecture:** A pure detection core (`scanner.ts`, single source of truth) + a thin stdin entry (`hook.ts`) materialized into `.firth/observe/` and invoked via `node`. An installer (`install.ts`) upserts a `PostToolUse` entry into both harness config files by a `_firth` marker (migrating the old Python entry away). `ensure-observe.ts` mirrors `ensure-skills.ts` to wire it into the link flow. The local redacted-log + explicit `firth observe sync` upload path is unchanged.

**Tech Stack:** Node 20 + TypeScript (ESM, `target/module ES2022`, `moduleResolution: bundler`), `vitest`. No new dependencies (`node:crypto/fs/path/url` only). Spec: [docs/superpowers/specs/2026-06-25-firth-observe-node-port-design.md](../specs/2026-06-25-firth-observe-node-port-design.md).

## Global Constraints

- **Trust model (invariant):** a `Finding` never contains a raw secret — only a fingerprint (`detector:••••last4:#hash`) and a redacted snippet. The hook **always exits 0 and writes nothing to stdout** (never blocks/alters a tool). Nothing leaves the machine; upload stays the existing, explicit `firth observe sync`.
- **ESM with `.js` import specifiers:** relative imports use the `.js` extension in source (e.g. `import { scanEvent } from './scanner.js'`), matching the existing CLI.
- **`hook.ts` self-containment:** `hook.ts` imports only `./scanner.js` and `node:*` builtins — no other CLI module — so the materialized two-file copy runs standalone.
- **Harness configs are the user's files:** only `.firth/` is gitignored (already, by `writeProjectLink`). Never gitignore `.claude/` or `.codex/`.
- **Both harnesses, always:** install writes both `.claude/settings.json` and `.codex/hooks.json`; a failure on one must not abort the other.
- **No new deps; keep `cli/package.json` `files: ["dist","README.md"]`** — the port ships automatically because it compiles under `src/` → `dist/`.

---

### Task 1: `scanner.ts` — detection core (port of `observe/scanner.py`)

**Files:**
- Create: `cli/src/observe/scanner.ts`
- Test: `cli/test/observe-scanner.test.ts`

**Interfaces:**
- Produces:
  - `type ToolEvent = { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; [k: string]: unknown }`
  - `type Finding = { kind: 'touch'|'exposure'; severity: 'info'|'warn'|'high'; detector: string; surface: string; sink: string; fingerprint: string; snippet: string; note: string }`
  - `function scanEvent(event: ToolEvent, opts?: { ignorePath?: (p: string) => boolean }): Finding[]`
  - `function isSecretFile(path?: string): boolean`

- [ ] **Step 1: Write the failing test** — `cli/test/observe-scanner.test.ts`

```typescript
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
```

- [ ] **Step 2: Run to verify it fails** — `cd cli && npx vitest run test/observe-scanner.test.ts`. Expected: FAIL (`Cannot find module './observe/scanner.js'`).

- [ ] **Step 3: Implement `cli/src/observe/scanner.ts`** (faithful port; regex `(?i)`→`/i`, all detectors get `g`+`d` flags so we can read capture-group spans via `match.indices`)

```typescript
import { createHash } from 'node:crypto'

export type ToolEvent = {
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  [k: string]: unknown
}

export type Finding = {
  kind: 'touch' | 'exposure'
  severity: 'info' | 'warn' | 'high'
  detector: string
  surface: string
  sink: string
  fingerprint: string
  snippet: string
  note: string
}

// (name, regex, group) — group:true ⇒ the secret is capture group 1, else the whole match.
// Specific detectors first; on an equal span the earlier one wins (stable sort + overlap drop).
type Detector = { name: string; rx: RegExp; group: boolean }
const DETECTORS: Detector[] = [
  { name: 'aws_access_key_id', rx: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/gd, group: false },
  { name: 'aws_secret_access_key', rx: /aws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+]{40})/gid, group: true },
  { name: 'github_token', rx: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gd, group: false },
  { name: 'github_pat', rx: /\bgithub_pat_[A-Za-z0-9_]{82}\b/gd, group: false },
  { name: 'slack_token', rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gd, group: false },
  { name: 'stripe_secret_key', rx: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/gd, group: false },
  { name: 'llm_api_key', rx: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/gd, group: false },
  { name: 'google_api_key', rx: /\bAIza[0-9A-Za-z_-]{35}\b/gd, group: false },
  { name: 'private_key_block', rx: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/gd, group: false },
  { name: 'jwt', rx: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gd, group: false },
  { name: 'db_conn_string', rx: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s/]+@[^\s'"]+/gd, group: false },
  { name: 'bearer_token', rx: /\bbearer\s+([A-Za-z0-9._-]{20,})/gid, group: true },
  { name: 'generic_secret_assignment', rx: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"]?([^\s'"]{8,})/gid, group: true },
]

const PLACEHOLDER = /^(?:your[_-]|example|changeme|placeholder|dummy|sample|redacted|secret|x{4,}|<.+>|\.\.\.|0{6,}|1234567|test[_-]?(?:key|token|secret))/i
const REFERENCE = /(process\.env|os\.environ|getenv|import\.meta|\$\{|\$[A-Za-z_]|config\.|settings\.|^env\.|^[A-Z][A-Z0-9_]{3,}$)/

const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.[A-Za-z0-9_]+)?|\.aws\/credentials|\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.kube\/config|kubeconfig|\.docker(?:cfg|\/config\.json)|credentials\.json|service-account[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/i
const SECRET_FILE_SAFE = /\.(?:example|sample|template|dist)$|\.pub$/i

const NETWORK = /\b(?:curl|wget|httpie|http|nc|ncat|netcat|scp|sftp|ssh|telnet|rsync)\b/i
const PRINT = /\b(?:echo|printf|cat|print|less|more|head|tail|xxd|base64|env|printenv|set)\b/i
const GIT_WRITE = /\bgit\s+(?:add|commit|push|stash)\b/i

export function isSecretFile(path?: string): boolean {
  if (!path) return false
  if (SECRET_FILE_SAFE.test(path)) return false
  return SECRET_FILE.test(path)
}

function fingerprint(secret: string, detector: string): string {
  const h = createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8)
  const last4 = secret.length >= 8 ? secret.slice(-4) : ''
  const tail = last4 ? '••••' + last4 : '••••'
  return `${detector}:${tail}:#${h}`
}

function snippet(text: string, span: [number, number], fp: string): string {
  const [s, e] = span
  const redacted = text.slice(0, s) + '«' + fp + '»' + text.slice(e)
  const marker = '«' + fp + '»'
  const i = redacted.indexOf(marker)
  const start = Math.max(0, i - 36)
  const end = Math.min(redacted.length, i + marker.length + 36)
  let out = redacted.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) out = '…' + out
  if (end < redacted.length) out = out + '…'
  return out.slice(0, 160)
}

function leaves(obj: unknown, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (o: unknown, p: string): void => {
    if (typeof o === 'string') out.push([p, o])
    else if (Array.isArray(o)) o.forEach((v, idx) => walk(v, `${p}[${idx}]`))
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`)
  }
  walk(obj, prefix)
  return out
}

function scanText(text: string): Array<[number, number, string, string]> {
  const hits: Array<[number, number, string, string]> = []
  for (const { name, rx, group } of DETECTORS) {
    rx.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rx.exec(text)) !== null) {
      if (m.index === rx.lastIndex) rx.lastIndex++ // zero-width guard
      const gi = group ? 1 : 0
      const secret = m[gi]
      const span = (m as RegExpExecArray & { indices?: Array<[number, number]> }).indices?.[gi]
      if (!secret || !span) continue
      if (PLACEHOLDER.test(secret)) continue
      if (name === 'generic_secret_assignment' && REFERENCE.test(secret)) continue
      hits.push([span[0], span[1], name, secret])
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // stable: earlier detector wins an equal span
  const kept: Array<[number, number, string, string]> = []
  for (const r of hits) {
    if (kept.some((k) => !(r[1] <= k[0] || r[0] >= k[1]))) continue
    kept.push(r)
  }
  return kept
}

function classify(
  tool: string, side: 'input' | 'output', command: string, filePath: string, secretFileTarget: boolean,
): [Finding['kind'], Finding['severity'], string, string] {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && side === 'input') {
    if (secretFileTarget) return ['touch', 'info', 'write_secret_file', `secret written to secret file ${filePath}`]
    return ['exposure', 'high', 'nonsecret_file', `secret written into ${filePath || 'a non-secret file'}`]
  }
  if (tool === 'Bash' && side === 'input') {
    if (NETWORK.test(command)) return ['exposure', 'high', 'network', 'secret in an outbound network command']
    if (GIT_WRITE.test(command)) return ['exposure', 'high', 'git', 'secret in a git write command']
    if (PRINT.test(command)) return ['exposure', 'warn', 'stdout', 'secret printed to stdout']
    return ['touch', 'info', 'shell', 'secret present in a shell command']
  }
  if (side === 'output') {
    if (tool === 'Bash') return ['exposure', 'warn', 'stdout', 'secret appeared in command output']
    return ['touch', 'info', 'read', 'secret visible in tool output']
  }
  return ['touch', 'info', 'other', 'secret handled by agent']
}

export function scanEvent(event: ToolEvent, opts: { ignorePath?: (p: string) => boolean } = {}): Finding[] {
  const tool = event.tool_name || '?'
  const ti = (event.tool_input as Record<string, unknown>) || {}
  const tr = event.tool_response ?? {}
  const filePath = (ti.file_path as string) || ''
  const command = (ti.command as string) || ''

  if (opts.ignorePath && filePath && opts.ignorePath(filePath)) return []

  const findings: Finding[] = []
  const seen = new Set<string>()
  const add = (
    kind: Finding['kind'], sev: Finding['severity'], detector: string,
    surface: string, sink: string, fp: string, snip: string, note: string,
  ): void => {
    const key = [kind, detector, surface, fp, sink].join('|')
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ kind, severity: sev, detector, surface, sink, fingerprint: fp, snippet: snip, note })
  }

  // Path-based rules (fire even without a value match).
  if (isSecretFile(filePath)) {
    const base = filePath.split('/').pop() ?? filePath
    if (tool === 'Read') add('touch', 'info', 'secret_file', `${tool}.file_path`, 'read', `file:${base}`, filePath, `agent read secret file ${filePath}`)
    else if (['Write', 'Edit', 'MultiEdit'].includes(tool)) add('touch', 'info', 'secret_file', `${tool}.file_path`, 'write_secret_file', `file:${base}`, filePath, `agent wrote secret file ${filePath}`)
  }
  if (command && GIT_WRITE.test(command)) {
    for (const tok of command.match(/[^\s'"]+/g) ?? []) {
      if (isSecretFile(tok)) {
        const base = tok.split('/').pop() ?? tok
        add('exposure', 'high', 'secret_file', 'Bash.command', 'git', `file:${base}`, `git ... ${tok}`, `secret file ${tok} staged/committed via git`)
      }
    }
  }

  // Value-based rules: scan every string surface of input and output.
  const secretFileTarget = isSecretFile(filePath)
  for (const [surface, text] of [...leaves(ti, 'input'), ...leaves(tr, 'output')]) {
    if (!text || text.length > 1_000_000) continue
    const side: 'input' | 'output' = surface.startsWith('input') ? 'input' : 'output'
    for (const [start, end, detector, secret] of scanText(text)) {
      const fp = fingerprint(secret, detector)
      const [kind, sev, sink, note] = classify(tool, side, command, filePath, secretFileTarget)
      add(kind, sev, detector, `${tool}:${surface}`, sink, fp, snippet(text, [start, end], fp), note)
    }
  }
  return findings
}
```

- [ ] **Step 4: Run to verify it passes** — `cd cli && npx vitest run test/observe-scanner.test.ts`. Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add cli/src/observe/scanner.ts cli/test/observe-scanner.test.ts
git commit -m "feat(observe): port detection core to TypeScript (scanner.ts)"
```

---

### Task 2: `hook.ts` — stdin entry + `recordFindings`

**Files:**
- Create: `cli/src/observe/hook.ts`
- Test: `cli/test/observe-hook.test.ts`

**Interfaces:**
- Consumes: `scanEvent`, `ToolEvent` from `./scanner.js`.
- Produces:
  - `function recordFindings(event: ToolEvent, baseDir: string): number` — scans (ignoring paths under `baseDir/.firth` and the hook's own dir), appends one redacted JSON line per finding to `baseDir/.firth/audit.jsonl`, returns the count written.
  - `async function main(): Promise<void>` — reads stdin JSON, picks base dir from `CLAUDE_PROJECT_DIR` ?? event `cwd` ?? `.`, calls `recordFindings`, always exits 0. Runs only when the file is the process entry.

- [ ] **Step 1: Write the failing test** — `cli/test/observe-hook.test.ts`

```typescript
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
```

- [ ] **Step 2: Run to verify it fails** — `cd cli && npx vitest run test/observe-hook.test.ts`. Expected: FAIL (`Cannot find module './observe/hook.js'`).

- [ ] **Step 3: Implement `cli/src/observe/hook.ts`**

```typescript
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanEvent, type ToolEvent } from './scanner.js'

export function recordFindings(event: ToolEvent, baseDir: string): number {
  const firthDir = join(baseDir, '.firth')
  const firthAbs = resolve(firthDir)
  const selfDir = dirname(fileURLToPath(import.meta.url))
  const ignore = (p: string): boolean => {
    let ap: string
    try { ap = resolve(p) } catch { return false }
    return ap.startsWith(firthAbs) || ap.startsWith(selfDir)
  }
  const findings = scanEvent(event, { ignorePath: ignore })
  if (findings.length === 0) return 0
  const common = {
    ts: new Date().toISOString(),
    session_id: event.session_id ?? null,
    tool: event.tool_name ?? null,
    cwd: event.cwd ?? null,
  }
  mkdirSync(firthDir, { recursive: true })
  const lines = findings.map((f) => JSON.stringify({ ...common, ...f })).join('\n') + '\n'
  appendFileSync(join(firthDir, 'audit.jsonl'), lines, 'utf8')
  return findings.length
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function main(): Promise<void> {
  let event: ToolEvent
  try { event = JSON.parse(await readStdin()) } catch { process.exit(0) }
  const base = process.env.CLAUDE_PROJECT_DIR || (event.cwd as string) || '.'
  try { recordFindings(event, base) } catch (e) { process.stderr.write(`firth-observe: ${e instanceof Error ? e.message : e}\n`) }
  process.exit(0)
}

// Run only when executed directly (the materialized .firth/observe/hook.js entry).
// Imported by tests → guard is false → main() does not run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
```

- [ ] **Step 4: Run to verify it passes** — `cd cli && npx vitest run test/observe-hook.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/observe/hook.ts cli/test/observe-hook.test.ts
git commit -m "feat(observe): node stdin hook entry (hook.ts) + recordFindings"
```

---

### Task 3: `report.ts` — local audit report (port of `observe/summary.py`)

**Files:**
- Create: `cli/src/observe/report.ts`
- Test: `cli/test/observe-report.test.ts`

**Interfaces:**
- Produces: `function renderReport(rows: Array<Record<string, unknown>>): string` — pure; renders the exposures-first / touches summary from parsed audit rows.

- [ ] **Step 1: Write the failing test** — `cli/test/observe-report.test.ts`

```typescript
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
```

- [ ] **Step 2: Run to verify it fails** — `cd cli && npx vitest run test/observe-report.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `cli/src/observe/report.ts`**

```typescript
const SEV_LABEL: Record<string, string> = { high: 'HIGH', warn: 'warn', info: 'info' }
const SINK_ORDER = ['network', 'git', 'nonsecret_file', 'stdout']

export function renderReport(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return 'Audit log is empty — nothing recorded yet (install the hook and let an agent run).'

  const exposures = rows.filter((r) => r.kind === 'exposure')
  const touches = rows.filter((r) => r.kind === 'touch')
  const ts = rows.map((r) => String(r.ts ?? '')).filter(Boolean).sort()
  const span = ts.length ? `${ts[0].slice(0, 19)}  →  ${ts[ts.length - 1].slice(0, 19)}` : 'unknown'
  const uniqueSecrets = new Set(rows.map((r) => r.fingerprint))

  const L: string[] = []
  L.push('='.repeat(64))
  L.push(' Firth Observe — what your agents did to your credentials')
  L.push('='.repeat(64))
  L.push(` window      : ${span}`)
  L.push(` events      : ${rows.length} findings across ${uniqueSecrets.size} distinct secrets`)
  L.push(` exposures   : ${exposures.length}  (secrets that left a safe place)`)
  L.push(` touches     : ${touches.length}  (secrets the agent handled)`)
  L.push('='.repeat(64))

  if (exposures.length) {
    L.push('\n⚠  EXPOSURES (look at these first)\n')
    const bySink = new Map<string, Array<Record<string, unknown>>>()
    for (const r of exposures) {
      const k = String(r.sink ?? '?')
      ;(bySink.get(k) ?? bySink.set(k, []).get(k)!).push(r)
    }
    const sinks = [...SINK_ORDER, ...[...bySink.keys()].filter((s) => !SINK_ORDER.includes(s))]
    for (const sink of sinks) {
      const group = bySink.get(sink)
      if (!group) continue
      L.push(`  ┌─ sink: ${sink}  (${group.length} finding(s))`)
      for (const r of group) {
        L.push(`  │  [${SEV_LABEL[String(r.severity)] ?? '?'}] ${r.note ?? ''}`)
        L.push(`  │     secret : ${r.fingerprint}`)
        L.push(`  │     where  : ${r.surface}  (tool ${r.tool})`)
        L.push(`  │     when   : ${String(r.ts ?? '').slice(0, 19)}`)
        if (r.snippet) L.push(`  │     context: ${r.snippet}`)
      }
      L.push('  └─')
    }
  } else {
    L.push('\n✓ No exposures recorded.\n')
  }

  if (touches.length) {
    L.push('\n·  TOUCHES (informational)\n')
    const counter = new Map<string, number>()
    for (const r of touches) {
      const k = `${r.detector} ${r.note}`
      counter.set(k, (counter.get(k) ?? 0) + 1)
    }
    for (const [k, count] of [...counter.entries()].sort((a, b) => b[1] - a[1])) {
      const [detector, note] = k.split(' ')
      L.push(`   ${String(count).padStart(3)}×  ${detector}  — ${note}`)
    }
  }

  L.push('\n(local audit only — nothing in this report has left your machine)')
  return L.join('\n')
}
```

- [ ] **Step 4: Run to verify it passes** — `cd cli && npx vitest run test/observe-report.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/observe/report.ts cli/test/observe-report.test.ts
git commit -m "feat(observe): local audit report renderer (report.ts)"
```

---

### Task 4: `install.ts` — materialize hook + dual-harness register/unregister

**Files:**
- Create: `cli/src/observe/install.ts`
- Test: `cli/test/observe-install.test.ts`

**Interfaces:**
- Produces:
  - `function installObserve(opts: { cwd: string; assetDir?: string }): { claude: boolean; codex: boolean }` — materializes `hook.js`+`scanner.js`+`package.json`+`VERSION` into `cwd/.firth/observe/` (throws if assets missing), then upserts the `PostToolUse` entry into `.claude/settings.json` and `.codex/hooks.json` (each independent; a malformed config skips that one target and returns `false` for it).
  - `function uninstallObserve(cwd: string): void` — removes all `_firth`-marked entries from both config files.
- Default asset dir: `dirname(fileURLToPath(import.meta.url))` (at runtime `cli/dist/observe`, where `hook.js`/`scanner.js` sit beside `install.js`).

- [ ] **Step 1: Write the failing test** — `cli/test/observe-install.test.ts`

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { installObserve, uninstallObserve } from '../src/observe/install.js'

function fakeAssets(): string {
  const a = mkdtempSync(join(tmpdir(), 'assets-'))
  writeFileSync(join(a, 'hook.js'), '// hook')
  writeFileSync(join(a, 'scanner.js'), '// scanner')
  return a
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

test('materializes the hook and registers both harnesses', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const res = installObserve({ cwd, assetDir: fakeAssets() })
  expect(res).toEqual({ claude: true, codex: true })
  expect(readFileSync(join(cwd, '.firth', 'observe', 'hook.js'), 'utf8')).toBe('// hook')
  expect(readFileSync(join(cwd, '.firth', 'observe', 'scanner.js'), 'utf8')).toBe('// scanner')
  expect(readJson(join(cwd, '.firth', 'observe', 'package.json')).type).toBe('module')

  const claude = readJson(join(cwd, '.claude', 'settings.json'))
  const cHook = claude.hooks.PostToolUse[0].hooks[0]
  expect(cHook).toMatchObject({ command: 'node', _firth: 'firth-observe' })
  expect(cHook.args[0]).toContain('.firth/observe/hook.js')

  const codex = readJson(join(cwd, '.codex', 'hooks.json'))
  const xHook = codex.hooks.PostToolUse[0].hooks[0]
  expect(xHook.args).toBeUndefined()                      // Codex: single command string, no args
  expect(xHook.command).toMatch(/^node .*\.firth\/observe\/hook\.js/)
  expect(xHook._firth).toBe('firth-observe')
})

test('upsert migrates an old python firth entry (no duplicate)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: '*', hooks: [{ type: 'command', command: 'python3', args: ['${CLAUDE_PROJECT_DIR}/observe/hook.py'], _firth: 'firth-observe' }] },
  ] } }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const post = readJson(join(cwd, '.claude', 'settings.json')).hooks.PostToolUse
  const firthHooks = post.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')
  expect(firthHooks).toHaveLength(1)
  expect(firthHooks[0].command).toBe('node') // the new entry, python one gone
})

test('install is idempotent (one firth entry per harness after two installs)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const assets = fakeAssets()
  installObserve({ cwd, assetDir: assets })
  installObserve({ cwd, assetDir: assets })
  const post = readJson(join(cwd, '.claude', 'settings.json')).hooks.PostToolUse
  expect(post.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(1)
})

test('preserves the user’s non-firth hooks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'mylinter' }] },
  ] } }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const post = readJson(join(cwd, '.claude', 'settings.json')).hooks.PostToolUse
  expect(post.flatMap((g: any) => g.hooks).some((h: any) => h.command === 'mylinter')).toBe(true)
})

test('a malformed config on one harness is skipped without aborting the other', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.codex'), { recursive: true })
  writeFileSync(join(cwd, '.codex', 'hooks.json'), '{ this is not json')
  const res = installObserve({ cwd, assetDir: fakeAssets() })
  expect(res).toEqual({ claude: true, codex: false })
  expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(true)
})

test('uninstall removes firth entries from both harnesses', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  installObserve({ cwd, assetDir: fakeAssets() })
  uninstallObserve(cwd)
  const claude = readJson(join(cwd, '.claude', 'settings.json'))
  const codex = readJson(join(cwd, '.codex', 'hooks.json'))
  expect(claude.hooks.PostToolUse.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(0)
  expect(codex.hooks.PostToolUse.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(0)
})
```

- [ ] **Step 2: Run to verify it fails** — `cd cli && npx vitest run test/observe-install.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `cli/src/observe/install.ts`**

```typescript
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = 'firth-observe'
const DEFAULT_ASSET_DIR = dirname(fileURLToPath(import.meta.url)) // built: cli/dist/observe

function cliVersion(): string {
  try { return JSON.parse(readFileSync(join(DEFAULT_ASSET_DIR, '..', '..', 'package.json'), 'utf8')).version ?? '0.0.0' }
  catch { return '0.0.0' }
}

function isFirthHook(h: { _firth?: string; command?: string; args?: string[] }): boolean {
  if (h._firth === MARKER) return true
  const blob = `${h.command ?? ''} ${(h.args ?? []).join(' ')}`
  return blob.includes('observe/hook') // matches old observe/hook.py and new .firth/observe/hook.js
}

type Group = { matcher?: string; hooks?: Array<Record<string, unknown>> }

function upsert(root: any, entry: Group): void {
  root.hooks ??= {}
  const post: Group[] = Array.isArray(root.hooks.PostToolUse) ? root.hooks.PostToolUse : []
  for (const g of post) g.hooks = (g.hooks ?? []).filter((h) => !isFirthHook(h))
  const pruned = post.filter((g) => (g.hooks ?? []).length > 0)
  pruned.push(entry)
  root.hooks.PostToolUse = pruned
}

function registerHarness(filePath: string, entry: Group): void {
  const root = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : {}
  upsert(root, entry)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(root, null, 2) + '\n')
}

function unregisterHarness(filePath: string): void {
  if (!existsSync(filePath)) return
  const root = JSON.parse(readFileSync(filePath, 'utf8'))
  const post: Group[] | undefined = root?.hooks?.PostToolUse
  if (!Array.isArray(post)) return
  for (const g of post) g.hooks = (g.hooks ?? []).filter((h) => !isFirthHook(h))
  root.hooks.PostToolUse = post.filter((g) => (g.hooks ?? []).length > 0)
  writeFileSync(filePath, JSON.stringify(root, null, 2) + '\n')
}

function materialize(cwd: string, assetDir: string): void {
  const dest = join(cwd, '.firth', 'observe')
  mkdirSync(dest, { recursive: true })
  copyFileSync(join(assetDir, 'hook.js'), join(dest, 'hook.js'))     // throws if assets missing
  copyFileSync(join(assetDir, 'scanner.js'), join(dest, 'scanner.js'))
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n') // run .js as ESM
  writeFileSync(join(dest, 'VERSION'), cliVersion() + '\n')
}

function claudeEntry(): Group {
  return { matcher: '*', hooks: [{ type: 'command', command: 'node',
    args: ['${CLAUDE_PROJECT_DIR}/.firth/observe/hook.js'], timeout: 15, _firth: MARKER }] }
}
function codexEntry(cwd: string): Group {
  const abs = join(cwd, '.firth', 'observe', 'hook.js') // Codex doesn't expand ${CLAUDE_PROJECT_DIR}; use an absolute path
  return { matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(abs)}`, timeout: 15, _firth: MARKER }] }
}

export function installObserve(opts: { cwd: string; assetDir?: string }): { claude: boolean; codex: boolean } {
  materialize(opts.cwd, opts.assetDir ?? DEFAULT_ASSET_DIR) // hook required → let a missing asset throw to the caller
  let claude = false
  let codex = false
  try { registerHarness(join(opts.cwd, '.claude', 'settings.json'), claudeEntry()); claude = true } catch { /* skip malformed */ }
  try { registerHarness(join(opts.cwd, '.codex', 'hooks.json'), codexEntry(opts.cwd)); codex = true } catch { /* skip malformed */ }
  return { claude, codex }
}

export function uninstallObserve(cwd: string): void {
  try { unregisterHarness(join(cwd, '.claude', 'settings.json')) } catch { /* skip */ }
  try { unregisterHarness(join(cwd, '.codex', 'hooks.json')) } catch { /* skip */ }
}
```

- [ ] **Step 4: Run to verify it passes** — `cd cli && npx vitest run test/observe-install.test.ts`. Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add cli/src/observe/install.ts cli/test/observe-install.test.ts
git commit -m "feat(observe): materialize hook + dual-harness register/uninstall (install.ts)"
```

---

### Task 5: `ensure-observe.ts` + config marker + wire into the link flow

**Files:**
- Create: `cli/src/ensure-observe.ts`
- Modify: `cli/src/config.ts` (add `observeInstalled` to `ProjectLink`, add `markObserveInstalled`)
- Modify: `cli/src/commands/project.ts` (call `ensureObserveHook` after `ensureSkills` in `projectCreate` + `projectLink`)
- Test: `cli/test/ensure-observe.test.ts`

**Interfaces:**
- Consumes: `installObserve` from `./observe/install.js`; `readProjectLink`, `markObserveInstalled` from `./config.js`.
- Produces: `async function ensureObserveHook(deps: { print: (s: string) => void; cwd: string }, assetDir?: string): Promise<void>` — when the dir is linked: materialize + register both harnesses (idempotent, always refreshes); print the install notice + Codex trust note **once** (gated by `observeInstalled`); never throws.

- [ ] **Step 1: Write the failing test** — `cli/test/ensure-observe.test.ts`

```typescript
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ensureObserveHook } from '../src/ensure-observe.js'
import { writeProjectLink, readProjectLink } from '../src/config.js'

function fakeAssets(): string {
  const a = mkdtempSync(join(tmpdir(), 'assets-'))
  writeFileSync(join(a, 'hook.js'), '// hook'); writeFileSync(join(a, 'scanner.js'), '// scanner')
  return a
}

test('first call installs both harnesses and prints the notice once; sets the marker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', cwd)
  const out: string[] = []
  await ensureObserveHook({ print: (s) => out.push(s), cwd }, fakeAssets())
  expect(existsSync(join(cwd, '.firth', 'observe', 'hook.js'))).toBe(true)
  expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(true)
  expect(existsSync(join(cwd, '.codex', 'hooks.json'))).toBe(true)
  expect(out.join('\n')).toMatch(/observe hook/)
  expect(out.join('\n')).toMatch(/Codex/)
  expect(readProjectLink(cwd)?.observeInstalled).toBe(true)
})

test('second call refreshes silently (no duplicate notice, no duplicate entry)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', cwd)
  const assets = fakeAssets()
  await ensureObserveHook({ print: () => {}, cwd }, assets)
  const out: string[] = []
  await ensureObserveHook({ print: (s) => out.push(s), cwd }, assets)
  expect(out.join('\n')).not.toMatch(/observe hook/) // notice gated by the marker
  const post = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUse
  expect(post.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(1)
})

test('not linked → no-op, never throws', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  await ensureObserveHook({ print: () => {}, cwd }, fakeAssets())
  expect(existsSync(join(cwd, '.firth', 'observe'))).toBe(false)
})

test('missing assets → swallowed, never throws', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', cwd)
  await expect(ensureObserveHook({ print: () => {}, cwd }, join(tmpdir(), 'does-not-exist'))).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails** — `cd cli && npx vitest run test/ensure-observe.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Add the marker to `cli/src/config.ts`** — extend `ProjectLink` and add `markObserveInstalled` (mirrors `markSkillsInstalled`):

```typescript
export type ProjectLink = { projectId: string; branch?: { id: string; name: string }; skillsInstalled?: boolean; observeInstalled?: boolean }
```

```typescript
// One-time marker so the observe-hook install notice prints once per linked project.
export function markObserveInstalled(cwd = process.cwd()): void {
  const link = readProjectLink(cwd)
  if (!link) return
  link.observeInstalled = true
  writeFileSync(lpath(cwd), JSON.stringify(link, null, 2))
}
```

- [ ] **Step 4: Implement `cli/src/ensure-observe.ts`**

```typescript
import { readProjectLink, markObserveInstalled } from './config.js'
import { installObserve } from './observe/install.js'

type ObserveDeps = { print: (s: string) => void; cwd: string }

// Install the observe hook into both harnesses once per linked project. Convenience
// only — wrapped so it never blocks or fails the host command (mirrors ensure-skills).
export async function ensureObserveHook(deps: ObserveDeps, assetDir?: string): Promise<void> {
  try {
    const link = readProjectLink(deps.cwd)
    if (!link) return
    installObserve({ cwd: deps.cwd, assetDir }) // idempotent refresh of files + both harness entries
    if (!link.observeInstalled) {
      deps.print('installed Firth observe hook → .claude/settings.json + .codex/hooks.json (local, read-only audit; nothing leaves your machine until you run `firth observe sync`)')
      deps.print('  (Codex: trust this project’s .codex/ layer in Codex to activate the hook)')
      markObserveInstalled(deps.cwd)
    }
  } catch {
    /* convenience only — never block the command */
  }
}
```

- [ ] **Step 5: Wire into `cli/src/commands/project.ts`** — add the import and a call after each `await ensureSkills(deps)`:

```typescript
import { ensureObserveHook } from '../ensure-observe.js'
```

In `projectCreate`, immediately after `await ensureSkills(deps)`:

```typescript
  await ensureObserveHook(deps)
```

In `projectLink`, immediately after `await ensureSkills(deps)`:

```typescript
  await ensureObserveHook(deps)
```

- [ ] **Step 6: Run tests + full suite** — `cd cli && npx vitest run test/ensure-observe.test.ts test/project*.test.ts && npm test`. Expected: PASS (project tests unaffected — `ensureObserveHook` no-ops there because the compiled assets aren't beside the source).

- [ ] **Step 7: Commit**

```bash
git add cli/src/ensure-observe.ts cli/src/config.ts cli/src/commands/project.ts cli/test/ensure-observe.test.ts
git commit -m "feat(observe): auto-install the hook (both harnesses) at project link/create"
```

---

### Task 6: CLI commands — `firth observe install | uninstall | report`

**Files:**
- Modify: `cli/src/commands/observe.ts` (add `observeInstall`, `observeUninstall`, `observeReport`)
- Modify: `cli/src/index.ts` (import + register + USAGE)
- Test: `cli/test/observe-commands.test.ts`

**Interfaces:**
- Consumes: `installObserve`, `uninstallObserve` from `../observe/install.js`; `renderReport` from `../observe/report.js`.
- Produces (all `(argv, deps) => Promise<number>`): `observeInstall`, `observeUninstall`, `observeReport`.

- [ ] **Step 1: Write the failing test** — `cli/test/observe-commands.test.ts`

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeReport, observeUninstall } from '../src/commands/observe.js'

test('observe report renders the local audit log', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.firth'), { recursive: true })
  writeFileSync(join(cwd, '.firth', 'audit.jsonl'),
    '{"kind":"exposure","severity":"high","sink":"network","detector":"github_token","fingerprint":"gh:••••e5f6:#1","note":"n","surface":"Bash:input.command","tool":"Bash","ts":"2026-06-25T10:00:00Z"}\n')
  const out: string[] = []
  expect(await observeReport([], { print: (s: string) => out.push(s), cwd, home: cwd, env: {} } as any)).toBe(0)
  expect(out.join('\n')).toMatch(/EXPOSURES/)
})

test('observe report with no log is a friendly no-op', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const out: string[] = []
  expect(await observeReport([], { print: (s: string) => out.push(s), cwd, home: cwd, env: {} } as any)).toBe(0)
  expect(out.join('\n')).toMatch(/no audit log|empty|nothing/i)
})

test('observe uninstall is a safe no-op when nothing is installed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const out: string[] = []
  expect(await observeUninstall([], { print: (s: string) => out.push(s), cwd, home: cwd, env: {} } as any)).toBe(0)
})
```

- [ ] **Step 2: Run to verify it fails** — `cd cli && npx vitest run test/observe-commands.test.ts`. Expected: FAIL (`observeReport`/`observeUninstall` not exported).

- [ ] **Step 3: Add the commands to `cli/src/commands/observe.ts`** (append; keep the existing `observeSync`). Add these imports at the top of the file:

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { installObserve, uninstallObserve } from '../observe/install.js'
import { renderReport } from '../observe/report.js'
```

(`join` is already imported in this file.) Then append:

```typescript
export async function observeInstall(_argv: string[], deps: CliDeps): Promise<number> {
  const res = installObserve({ cwd: deps.cwd })
  const targets = [res.claude && '.claude/settings.json', res.codex && '.codex/hooks.json'].filter(Boolean).join(' + ')
  deps.print(`installed Firth observe hook → ${targets || '(no harness config written)'}`)
  deps.print('local, read-only audit — nothing leaves your machine until you run `firth observe sync`')
  return 0
}

export async function observeUninstall(_argv: string[], deps: CliDeps): Promise<number> {
  uninstallObserve(deps.cwd)
  deps.print('removed the Firth observe hook from .claude/settings.json + .codex/hooks.json')
  return 0
}

export async function observeReport(_argv: string[], deps: CliDeps): Promise<number> {
  const path = join(deps.cwd, '.firth', 'audit.jsonl')
  if (!existsSync(path)) { deps.print('no audit log at .firth/audit.jsonl — nothing recorded yet (is the observe hook installed?)'); return 0 }
  const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
    try { return [JSON.parse(l)] } catch { return [] }
  })
  deps.print(renderReport(rows))
  return 0
}
```

- [ ] **Step 4: Register in `cli/src/index.ts`** — extend the import and command map, and add USAGE lines.

Change the observe import:

```typescript
import { observeSync, observeInstall, observeUninstall, observeReport } from './commands/observe.js'
```

Add to the command map (next to `COMMANDS['observe sync']`):

```typescript
COMMANDS['observe install'] = observeInstall
COMMANDS['observe uninstall'] = observeUninstall
COMMANDS['observe report'] = observeReport
```

Add to the `USAGE` string after the `observe sync` line:

```
  observe install           Install the local read-only audit hook (Claude Code + Codex)
  observe uninstall         Remove the audit hook from both harnesses
  observe report            Print the local credential-audit report (.firth/audit.jsonl)
```

- [ ] **Step 5: Run tests + full suite + build** — `cd cli && npx vitest run test/observe-commands.test.ts && npm test && npm run build`. Expected: all PASS; build emits `dist/observe/{scanner,hook,report,install}.js`.

- [ ] **Step 6: Verify the materialized hook actually runs (real end-to-end smoke, Claude path)** — after the build:

```bash
cd /tmp && rm -rf obs-smoke && mkdir obs-smoke && cd obs-smoke
node <repo>/cli/dist/index.js observe install || true   # not linked is fine; run install logic directly:
node -e "require('node:child_process'); const {installObserve}=await import('<repo>/cli/dist/observe/install.js'); installObserve({cwd:process.cwd()})" 2>/dev/null || \
  node --input-type=module -e "import('<repo>/cli/dist/observe/install.js').then(m=>m.installObserve({cwd:process.cwd()}))"
printf '{"tool_name":"Bash","tool_input":{"command":"curl https://x?k=ghp_%s"},"cwd":"%s"}' "$(printf 'a1b2c3d4e5%.0s' 1 2 3 4)" "$PWD" \
  | node .firth/observe/hook.js
cat .firth/audit.jsonl   # expect one redacted "network" exposure line; the raw token must NOT appear
```

Expected: `.firth/observe/hook.js` runs as ESM (the materialized `package.json` `{"type":"module"}` makes Node treat `.js` as ESM), one redacted line is appended, exit 0.

- [ ] **Step 7: Commit**

```bash
git add cli/src/commands/observe.ts cli/src/index.ts cli/test/observe-commands.test.ts
git commit -m "feat(observe): firth observe install|uninstall|report commands"
```

---

### Task 7: Codex `apply_patch` path classification (gated on a real-Codex smoke test)

**Files:**
- Modify: `cli/src/observe/scanner.ts` (recognize `apply_patch`; extract target paths from the patch envelope)
- Test: `cli/test/observe-scanner.test.ts` (add `apply_patch` cases)

**Interfaces:**
- No new exports. `scanEvent` gains `apply_patch` awareness; the value-detection path is already harness-independent (Task 1), so this only adds file-target sink classification.

- [ ] **Step 1: Manual smoke test against a real Codex install (no code — record findings)** — install the hook (`firth observe install`) in a Codex-trusted project, then have Codex edit a file writing a fake secret (e.g. `AKIA` + 16 chars into `src/config.ts`). Inspect `.firth/audit.jsonl` and the raw stdin Codex passed (temporarily log it). **Record:** (a) does `PostToolUse` fire for `apply_patch` at all (codex#16732)? (b) the exact `tool_name` string (`apply_patch` vs `ApplyPatch`)? (c) does `tool_input` carry the patch text, and under what field? Adjust the constant + extractor below to match what you observed. If it does NOT fire, leave value detection as-is and note the limitation in the docs (Task 8) — do not fake coverage.

- [ ] **Step 2: Write the failing test** — append to `cli/test/observe-scanner.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run to verify it fails** — `cd cli && npx vitest run test/observe-scanner.test.ts -t apply_patch`. Expected: FAIL (apply_patch classifies as `other`, not a file-write sink).

- [ ] **Step 4: Implement in `cli/src/observe/scanner.ts`** — add the patch-path extractor (format-based, so it does not depend on the field name), include `apply_patch` in the write branch, and compute the secret-file target from the extracted paths.

Add near the other regexes:

```typescript
// apply_patch envelope markers (Codex). Format-based, so extraction is field-name-independent.
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete|Move) File: (.+?)\s*$/gim
```

Add a helper (after `leaves`):

```typescript
function applyPatchPaths(ti: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const [, text] of leaves(ti, 'input')) {
    PATCH_FILE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATCH_FILE.exec(text)) !== null) paths.push(m[1])
  }
  return paths
}
```

In `classify`, add `'apply_patch'` to the file-write tool list:

```typescript
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(tool) && side === 'input') {
```

In `scanEvent`, after computing `secretFileTarget`, fold in the patch paths and add the file-level path rule for `apply_patch`:

```typescript
  const patchPaths = tool === 'apply_patch' ? applyPatchPaths(ti) : []
  const secretFileTarget = isSecretFile(filePath) || patchPaths.some((p) => isSecretFile(p))
  for (const p of patchPaths) {
    if (isSecretFile(p)) {
      const base = p.split('/').pop() ?? p
      add('touch', 'info', 'secret_file', 'apply_patch.input', 'write_secret_file', `file:${base}`, p, `agent wrote secret file ${p} via apply_patch`)
    }
  }
```

(The existing value-scan loop then classifies any secret value in the patch as `nonsecret_file`/`write_secret_file` via the updated `classify` + `secretFileTarget`.)

- [ ] **Step 5: Run to verify it passes** — `cd cli && npx vitest run test/observe-scanner.test.ts`. Expected: PASS (all, including the original cases — `apply_patch` changes don't affect `Write`/`Bash`/`Read`).

- [ ] **Step 6: Commit**

```bash
git add cli/src/observe/scanner.ts cli/test/observe-scanner.test.ts
git commit -m "feat(observe): classify Codex apply_patch file-write sinks (value path already covered)"
```

---

### Task 8: Delete Python `observe/` + sync docs

**Files:**
- Delete: `observe/` (entire directory)
- Modify: `README.md`, `ARCHITECTURE.md`, and any doc referencing `python3 observe/…`

- [ ] **Step 1: Find every reference to the Python layout**

```bash
cd <repo> && grep -rn "python3 observe\|observe/hook.py\|observe/install.py\|observe/summary.py\|observe/scanner.py\|observe/selftest.py" \
  --include="*.md" . | grep -v docs/superpowers/
```

Expected: a handful of hits in `README.md`, `ARCHITECTURE.md`, and `skills/firth/*` (the spec/plan files under `docs/superpowers/` are historical — leave them).

- [ ] **Step 2: Delete the directory**

```bash
git rm -r observe/
```

- [ ] **Step 3: Update `README.md`** — in the repository-layout table, change the `observe/` row to the new home and command surface:

Replace the `[`observe/`](./observe/) | The agent-action observability hook.` row with:

```
| [`cli/src/observe/`](./cli/src/observe/) | The Node credential-audit hook (auto-installed at `firth project link`; `firth observe install`/`report`). |
```

- [ ] **Step 4: Update `ARCHITECTURE.md`** — §4 "Subsystem → InsForge primitive" table row for Observability, and §10. Change `observe/` hook ingest` wording to the Node hook. Replace:

```
| Observability | InsForge **logs** + Postgres tables | `observe/` hook ingest + correlation |
```

with:

```
| Observability | InsForge **logs** + Postgres tables | Node observe hook (`cli/src/observe`, Claude Code + Codex) + correlation |
```

And in §10, change "from the `observe/` hook (what the agent did…)" to "from the Node observe hook (Claude Code + Codex `PostToolUse`; what the agent did…)".

- [ ] **Step 5: Update `skills/firth/` references** — for each hit from Step 1 in `skills/firth/SKILL.md` / `cli-reference.md`, replace `python3 observe/install.py` → `firth observe install`, `python3 observe/summary.py` → `firth observe report`. If a hit documents the hook as Claude-only, note it now covers Codex too. (Edit each occurrence to match the surrounding doc style.)

- [ ] **Step 6: Verify nothing still points at the deleted dir + suite green**

```bash
cd <repo> && grep -rn "python3 observe\|observe/hook.py" --include="*.md" . | grep -v docs/superpowers/ || echo "clean"
cd cli && npm test && npm run build
```

Expected: `clean`; full suite PASS; build OK.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(observe): remove Python observe/ (replaced by Node hook); sync README + ARCHITECTURE + skill docs"
```

---

## Self-Review

**Spec coverage:**
- Node port, ships in `dist`, no packaging change → Tasks 1–3 (`src/observe/*` compile into `dist`). ✓
- Trust model (redacted-only, exit 0, no stdout, manual sync) → Task 1 redaction-invariant test + Task 2 `main()` exits 0 / no stdout; sync untouched. ✓
- Materialize + `node` invocation + `package.json` ESM shim → Task 4 `materialize` + Task 6 Step 6 smoke. ✓
- Upsert-by-marker + Python-entry migration → Task 4 (migration test). ✓
- Dual harness (Claude `.claude/settings.json` + Codex `.codex/hooks.json`; Codex single command string + absolute path) → Task 4 (both entries, distinct shapes). ✓
- Auto-install at link/create, once, never blocks → Task 5. ✓
- `firth observe install|uninstall|report` → Task 6. ✓
- `apply_patch` mapping, shape-independent value path + best-effort path classification, gated on smoke test → Task 7. ✓
- Delete Python + doc sync → Task 8. ✓
- `summary.py` → `firth observe report` → Tasks 3 + 6. ✓

**Placeholder scan:** Task 7 Step 1 is an explicit manual smoke test (not a code placeholder) that pins the `apply_patch` `tool_name`/payload before the code is trusted — the code in Step 4 uses concrete, format-based extraction that works for the documented envelope and degrades safely. No `TBD`/`TODO` in code steps; every code step shows full content. The Codex command path is a concrete absolute path (not the spec's `${cwd}` placeholder).

**Type consistency:** `Finding`/`ToolEvent` defined in Task 1, consumed by `hook.ts` (Task 2) and `report.ts` rows (shape-compatible). `installObserve({cwd, assetDir?}) → {claude, codex}` defined in Task 4, called identically in Task 5 (`ensure-observe`) and Task 6 (`observeInstall`). `uninstallObserve(cwd)` defined Task 4, called Task 6. `renderReport(rows)` defined Task 3, called Task 6. `ProjectLink.observeInstalled` + `markObserveInstalled` defined Task 5 config edit, read in `ensure-observe`. `_firth` marker constant (`'firth-observe'`) is the same string in `install.ts` and every test. Command handlers are `(argv, deps) => Promise<number>` matching the `COMMANDS` map signature.

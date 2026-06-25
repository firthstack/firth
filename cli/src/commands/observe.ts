import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { readAuditOffset, writeAuditOffset, readNewAuditLines } from '../sync-state.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'
import { installObserve, uninstallObserve } from '../observe/install.js'
import { renderReport } from '../observe/report.js'

const BATCH = 500

export async function observeSync(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { all: { type: 'boolean' } }, allowPositionals: true })
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const path = join(deps.cwd, '.firth', 'audit.jsonl')
  if (!existsSync(path)) { deps.print('no audit log found at .firth/audit.jsonl (is the observe hook installed?)'); return 0 }

  const content = readFileSync(path, 'utf8')
  const offset = values.all ? 0 : readAuditOffset(deps.cwd)
  const { lines, ends } = readNewAuditLines(content, offset)
  if (lines.length === 0) { deps.print('nothing new to sync'); return 0 }

  const api = apiFromDeps(deps)
  const events = lines.map((line) => {
    let parsed: any = {}
    try { parsed = JSON.parse(line) } catch { parsed = { raw: line } }
    return {
      source: 'agent' as const,
      kind: `agent.${parsed.sink ?? parsed.kind ?? 'action'}`,
      payload: parsed,
      dedup_key: createHash('sha256').update(line).digest('hex'),
    }
  })

  let recorded = 0, skipped = 0
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH)
    const res = await api.postEvents(link.projectId, batch)
    recorded += res.recorded
    skipped += res.skipped ?? 0
    writeAuditOffset(deps.cwd, ends[i + batch.length - 1], new Date().toISOString())
  }

  let msg = `synced ${recorded} new finding(s)`
  if (skipped > 0) msg += ` (${skipped} already uploaded)`
  deps.print(msg)
  return 0
}

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

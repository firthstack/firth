import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function observeSync(_argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const path = join(deps.cwd, '.firth', 'audit.jsonl')
  if (!existsSync(path)) { deps.print('no audit log found at .firth/audit.jsonl (is the observe hook installed?)'); return 0 }
  const events = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((line) => {
    let parsed: any = {}
    try { parsed = JSON.parse(line) } catch { parsed = { raw: line } }
    return { source: 'agent' as const, kind: `agent.${parsed.sink ?? parsed.kind ?? 'action'}`, payload: parsed }
  })
  if (events.length === 0) { deps.print('audit log is empty — nothing to sync'); return 0 }
  const res = await apiFromDeps(deps).postEvents(link.projectId, events)
  deps.print(`synced ${res.recorded} agent events to the timeline`)
  return 0
}

import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function events(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { branch: { type: 'string' }, limit: { type: 'string' } }, allowPositionals: false })
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const effectiveBranch = values.branch ?? link.branch?.id
  const rows = await apiFromDeps(deps).listEvents(link.projectId, { branch: effectiveBranch, limit: values.limit ? Number(values.limit) : undefined })
  if (rows.length === 0) deps.print('(no events yet)')
  for (const e of rows) {
    const summary = e.payload?.url ?? e.payload?.name ?? e.payload?.machineId ?? ''
    deps.print(`${e.created_at}  ${e.source.padEnd(8)}  ${e.kind}${summary ? `  ${summary}` : ''}`)
  }
  return 0
}

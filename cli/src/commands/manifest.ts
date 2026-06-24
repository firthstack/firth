import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

// `firth manifest` — print the project's env manifest: each environment's
// databases / storage / compute and how they wire. The agent-legible view.
export async function manifest(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const m = await apiFromDeps(deps).getManifest(link.projectId)
  if (argv.includes('--json')) { deps.print(JSON.stringify(m, null, 2)); return 0 }
  deps.print(`project: ${m.project}`)
  for (const e of m.environments as any[]) {
    const clone = e.cloneOf ? ` ← clone of ${e.cloneOf}` : ''
    deps.print(`\n● ${e.name}${e.default ? ' (default)' : ''}${clone}`)
    for (const d of e.databases) deps.print(`    db       ${d.name}  ${d.engine}  -> ${d.env}`)
    for (const s of e.storage) deps.print(`    storage  ${s.name}  ${s.engine}${s.shared ? ' (shared)' : ''}  ${s.bucket}`)
    for (const c of e.compute) deps.print(`    compute  ${c.name}  [${c.state}]  ${c.url}  uses(${c.uses.join(', ')})`)
    if (!e.compute.length) deps.print('    compute  (none — deploy to spin one up)')
  }
  deps.print('\nwiring: public-url  (resources reference each other by env var / url)')
  return 0
}

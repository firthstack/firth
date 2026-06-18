import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

function linkedProject(deps: CliDeps): string {
  const link = readProjectLink(deps.cwd)
  if (!link) throw new Error('this directory is not linked — run `firth project link <id>` or `firth project create`')
  return link.projectId
}

export async function branchCreate(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { from: { type: 'string' } }, allowPositionals: true })
    const name = positionals[0]
    if (!name) { deps.print('usage: firth branch create <name> [--from <parent>]'); return 1 }
    const projectId = linkedProject(deps)
    const out = await apiFromDeps(deps).createBranch(projectId, name, values.from ?? 'main')
    deps.print(`created branch ${out.branch.name} (${out.branch.id})`)
    return 0
  } catch (e) {
    deps.print(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

export async function branchList(_argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  try {
    const projectId = linkedProject(deps)
    const branches = await apiFromDeps(deps).listBranches(projectId)
    for (const b of branches) deps.print(`${b.id}  ${b.name}`)
    return 0
  } catch (e) {
    deps.print(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

import { parseArgs } from 'node:util'
import { readProjectLink, setCurrentBranch } from '../config.js'
import { apiFromDeps } from './project.js'
import { formatTeardown } from './util.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'
import { ensureFlyctl } from '../fly.js'

function linkedProject(deps: CliDeps): string {
  const link = readProjectLink(deps.cwd)
  if (!link) throw new Error('this directory is not linked — run `firth project link <id>` or `firth project create`')
  return link.projectId
}

export async function branchCreate(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  await ensureFlyctl(deps)
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

export async function branchSwitch(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  await ensureFlyctl(deps)
  try {
    const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true })
    const name = positionals[0]
    if (!name) { deps.print('usage: firth branch switch <name>'); return 1 }
    const projectId = linkedProject(deps)
    const branches = await apiFromDeps(deps).listBranches(projectId)
    const target = branches.find((b: any) => b.name === name || b.id === name)
    if (!target) {
      deps.print(`branch "${name}" not found; available: ${branches.map((b: any) => b.name).join(', ')}`)
      return 1
    }
    setCurrentBranch({ id: target.id, name: target.name }, deps.cwd)
    deps.print(`switched to branch ${target.name} (${target.id}) — run \`firth secrets\` to refresh .env`)
    return 0
  } catch (e) {
    deps.print(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

export async function branchDelete(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { yes: { type: 'boolean' } }, allowPositionals: true })
    const name = positionals[0]
    if (!name) { deps.print('usage: firth branch delete <name>'); return 1 }
    const projectId = linkedProject(deps)
    const branches = await apiFromDeps(deps).listBranches(projectId)
    const target = branches.find((b: any) => b.name === name || b.id === name)
    if (!target) {
      deps.print(`branch "${name}" not found; available: ${branches.map((b: any) => b.name).join(', ')}`)
      return 1
    }
    if (target.is_default) {
      deps.print('cannot delete the default branch')
      return 1
    }
    if (!values.yes) {
      deps.print(`this destroys branch "${name}" (its Neon branch). re-run with --yes to confirm.`)
      return 1
    }
    const out = await apiFromDeps(deps).deleteBranch(projectId, target.id)
    // If the deleted branch is the current one, clear it
    const link = readProjectLink(deps.cwd)
    if (link?.branch?.id === target.id) {
      setCurrentBranch(null, deps.cwd)
    }
    deps.print(`deleted branch ${target.name}${formatTeardown(out.teardown ?? {})}`)
    return 0
  } catch (e) {
    deps.print(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

import { parseArgs } from 'node:util'
import { readConfig, writeConfig, writeProjectLink, readProjectLink, clearProjectLink, setCurrentBranch } from '../config.js'
import { FirthApi } from '../api.js'
import type { CliDeps } from '../index.js'
import { formatTeardown } from './util.js'
import { ensureFlyctl } from '../fly.js'
import { ensureSkills } from '../ensure-skills.js'
import { ensureObserveHook } from '../ensure-observe.js'
import { reportIfGated } from './govern.js'

// Build a FirthApi from stored config; tests can override via deps.makeApi.
export function apiFromDeps(deps: CliDeps & { makeApi?: () => FirthApi }): FirthApi {
  if (deps.makeApi) return deps.makeApi()
  const cfg = readConfig(deps.home, deps.env)
  if (!cfg.token) throw new Error('not logged in — run `firth login`')
  return new FirthApi(cfg.apiUrl, cfg.token, undefined, {
    refreshToken: cfg.refreshToken,
    onTokens: ({ token, refreshToken }) => writeConfig({ ...cfg, token, refreshToken }, deps.home),
  })
}

export async function projectCreate(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  await ensureFlyctl(deps)
  const name = argv[0]
  if (!name) { deps.print('usage: firth project create <name>'); return 1 }
  const out = await apiFromDeps(deps).createProject(name)
  writeProjectLink(out.project.id, deps.cwd)
  // start on the project's default branch so later commands target it without a manual `branch switch`
  setCurrentBranch({ id: out.defaultBranch.id, name: out.defaultBranch.name }, deps.cwd)
  deps.print(`created project ${out.project.name} (${out.project.id}); linked + on branch ${out.defaultBranch.name}`)
  await ensureSkills(deps)
  await ensureObserveHook(deps)
  return 0
}

export async function projectLink(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  await ensureFlyctl(deps)
  const id = argv[0]
  if (!id) { deps.print('usage: firth project link <id>'); return 1 }
  writeProjectLink(id, deps.cwd)
  // best-effort: switch to the project's default branch so later commands target main without a manual
  // `branch switch`. If we can't reach the API (not logged in / offline / no access), the id is still linked.
  let on = ''
  try {
    const branches = await apiFromDeps(deps).listBranches(id)
    const def = branches.find((b: any) => b.is_default) ?? branches[0]
    if (def) { setCurrentBranch({ id: def.id, name: def.name }, deps.cwd); on = ` on branch ${def.name}` }
  } catch { /* the id is still linked; secrets/events fall back to the default branch */ }
  deps.print(`linked this directory to project ${id}${on}`)
  await ensureSkills(deps)
  await ensureObserveHook(deps)
  return 0
}

export async function projectList(_argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const projects = await apiFromDeps(deps).listProjects()
  if (projects.length === 0) deps.print('(no projects)')
  for (const p of projects) deps.print(`${p.id}  ${p.name}`)
  return 0
}

export async function projectDelete(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { yes: { type: 'boolean' } }, allowPositionals: false })
    const link = readProjectLink(deps.cwd)
    if (!link) { deps.print('this directory is not linked — run `firth project link <id>` or `firth project create`'); return 1 }
    if (!values.yes) {
      deps.print(`this permanently destroys the project's Neon DB, Fly app, and storage bucket. re-run with --yes to confirm.`)
      return 1
    }
    const out = await apiFromDeps(deps).deleteProject(link.projectId)
    if (reportIfGated(out, deps)) return 1
    clearProjectLink(deps.cwd)
    deps.print(`deleted project ${link.projectId}${formatTeardown(out.teardown ?? {})}; unlinked ./.firth/project.json`)
    return 0
  } catch (e) {
    deps.print(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

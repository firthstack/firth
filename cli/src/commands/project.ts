import { parseArgs } from 'node:util'
import { readConfig, writeProjectLink, readProjectLink, clearProjectLink } from '../config.js'
import { FirthApi } from '../api.js'
import type { CliDeps } from '../index.js'
import { formatTeardown } from './util.js'
import { ensureFlyctl } from '../fly.js'

// Build a FirthApi from stored config; tests can override via deps.makeApi.
export function apiFromDeps(deps: CliDeps & { makeApi?: () => FirthApi }): FirthApi {
  if (deps.makeApi) return deps.makeApi()
  const cfg = readConfig(deps.home, deps.env)
  if (!cfg.token) throw new Error('not logged in — run `firth login`')
  return new FirthApi(cfg.apiUrl, cfg.token)
}

export async function projectCreate(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  await ensureFlyctl(deps)
  const name = argv[0]
  if (!name) { deps.print('usage: firth project create <name>'); return 1 }
  const out = await apiFromDeps(deps).createProject(name)
  writeProjectLink(out.project.id, deps.cwd)
  deps.print(`created project ${out.project.name} (${out.project.id}); linked ./.firth/project.json`)
  return 0
}

export async function projectLink(argv: string[], deps: CliDeps): Promise<number> {
  await ensureFlyctl(deps)
  const id = argv[0]
  if (!id) { deps.print('usage: firth project link <id>'); return 1 }
  writeProjectLink(id, deps.cwd)
  deps.print(`linked this directory to project ${id}`)
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
    clearProjectLink(deps.cwd)
    deps.print(`deleted project ${link.projectId}${formatTeardown(out.teardown ?? {})}; unlinked ./.firth/project.json`)
    return 0
  } catch (e) {
    deps.print(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

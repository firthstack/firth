import { readConfig, writeProjectLink, readProjectLink } from '../config.js'
import { FirthApi } from '../api.js'
import type { CliDeps } from '../index.js'

// Build a FirthApi from stored config; tests can override via deps.makeApi.
export function apiFromDeps(deps: CliDeps & { makeApi?: () => FirthApi }): FirthApi {
  if (deps.makeApi) return deps.makeApi()
  const cfg = readConfig(deps.home, deps.env)
  if (!cfg.token) throw new Error('not logged in — run `firth login`')
  return new FirthApi(cfg.apiUrl, cfg.token)
}

export async function projectCreate(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const name = argv[0]
  if (!name) { deps.print('usage: firth project create <name>'); return 1 }
  const out = await apiFromDeps(deps).createProject(name)
  writeProjectLink(out.project.id, deps.cwd)
  deps.print(`created project ${out.project.name} (${out.project.id}); linked ./.firth/project.json`)
  return 0
}

export async function projectLink(argv: string[], deps: CliDeps): Promise<number> {
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

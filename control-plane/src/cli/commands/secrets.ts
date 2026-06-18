import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function secrets(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { branch: { type: 'string' } }, allowPositionals: false })
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const api = apiFromDeps(deps)
  // Resolve the target branch (by name/id, default = the project's default branch).
  const branches = await api.listBranches(link.projectId)
  const target = values.branch
    ? branches.find((b: any) => b.name === values.branch || b.id === values.branch)
    : (branches.find((b: any) => b.is_default) ?? branches[0])
  if (!target) { deps.print(`branch "${values.branch ?? '(default)'}" not found`); return 1 }
  // The seam returns EITHER project-scoped (no branch) OR branch-scoped; merge both for a complete .env.
  const project = await api.getSecrets(link.projectId)
  const branch = await api.getSecrets(link.projectId, target.id)
  const bundle = { ...project, ...branch }
  const lines = Object.entries(bundle).map(([k, v]) => `${k}=${v}`)
  const path = join(deps.cwd, '.env')
  writeFileSync(path, lines.length ? lines.join('\n') + '\n' : '')
  deps.print(`wrote ${lines.length} secrets to ${path}`) // values never printed
  return 0
}

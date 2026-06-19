import { readConfig, readProjectLink } from '../config.js'
import type { CliDeps } from '../index.js'

export async function status(_argv: string[], deps: CliDeps): Promise<number> {
  const cfg = readConfig(deps.home, deps.env)
  const link = readProjectLink(deps.cwd)
  deps.print(`api:     ${cfg.apiUrl}`)
  deps.print(`auth:    ${cfg.token ? 'signed in' : 'not signed in (run `firth login`)'}`)
  deps.print(`project: ${link ? link.projectId : '(not linked)'}`)
  const branchLabel = link?.branch ? `${link.branch.name} (${link.branch.id})` : '(default)'
  deps.print(`branch:  ${branchLabel}`)
  return 0
}

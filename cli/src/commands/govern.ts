import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

type Deps = CliDeps & { makeApi?: () => FirthApi }

// If a gated control-plane action returned `approval_required`, print the guidance and signal "not done".
export function reportIfGated(res: any, deps: { print: (s: string) => void }): boolean {
  if (res && res.status === 'approval_required') {
    deps.print(`⛔ ${res.action} requires approval (id ${res.approvalId}) — have a human run \`firth approve ${res.approvalId}\`, then re-run.`)
    return true
  }
  return false
}

function linkedProjectId(deps: Deps): string | null {
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return null }
  return link.projectId
}

export async function approvals(_argv: string[], deps: Deps): Promise<number> {
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  const list = await apiFromDeps(deps).listApprovals(projectId, 'pending')
  if (!list || list.length === 0) { deps.print('no pending approvals'); return 0 }
  for (const a of list) deps.print(`${a.id}  ${a.action}  (requested ${a.requested_at})`)
  return 0
}

export async function approve(argv: string[], deps: Deps): Promise<number> {
  const always = argv.includes('--always')
  const id = argv.find((a) => !a.startsWith('-'))
  if (!id) { deps.print('usage: firth approve <id> [--always]'); return 1 }
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  const approval = await apiFromDeps(deps).approve(projectId, id, always)
  if (always) deps.print(`approved ${id} — and set policy '${approval?.action ?? 'action'}: allow' (won't ask again)`)
  else deps.print(`approved ${id}`)
  return 0
}

export async function deny(argv: string[], deps: Deps): Promise<number> {
  const id = argv[0]; if (!id) { deps.print('usage: firth deny <id>'); return 1 }
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  await apiFromDeps(deps).deny(projectId, id)
  deps.print(`denied ${id}`)
  return 0
}

export async function policy(argv: string[], deps: Deps): Promise<number> {
  const projectId = linkedProjectId(deps); if (!projectId) return 1
  const api = apiFromDeps(deps)
  if (argv[0] === 'set') {
    const [, action, decision] = argv
    if (!action || !decision) { deps.print('usage: firth policy set <action> <allow|deny|approve>'); return 1 }
    const p = await api.setPolicy(projectId, action, decision)
    for (const [a, d] of Object.entries(p)) deps.print(`${a}: ${d}`)
    return 0
  }
  const p = await api.getPolicy(projectId)
  for (const [a, d] of Object.entries(p)) deps.print(`${a}: ${d}`)
  return 0
}

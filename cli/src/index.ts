#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { login, logout } from './commands/auth.js'
import { projectCreate, projectLink, projectList, projectDelete } from './commands/project.js'
import { branchCreate, branchList, branchSwitch, branchDelete } from './commands/branch.js'
import { secrets } from './commands/secrets.js'
import { skillsPull } from './commands/skills.js'
import { deploy } from './commands/deploy.js'
import { events } from './commands/events.js'
import { observeSync, observeInstall, observeUninstall, observeReport } from './commands/observe.js'
import { status } from './commands/status.js'
import { manifest } from './commands/manifest.js'
import { approvals, approve, deny, policy } from './commands/govern.js'
import { defaultRunner, type Runner } from './fly.js'
import { defaultBuildRunner, type BuildRunner } from './flyctl-build.js'

export type CliDeps = {
  print: (s: string) => void
  home: string
  cwd: string
  env: NodeJS.ProcessEnv
  run?: Runner
  buildRunner?: BuildRunner
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch { return '0.0.0' }
}

const USAGE = `firth <command>

Commands:
  login                     Sign in (--email, --password; --api-url <url> sets the control-plane host)
  logout                    Clear stored credentials
  project create <name>     Create + link a project
  project link <id>         Link this directory to a project
  project list              List your projects
  branch create <name>      Create a branch (--from <parent>, default main)
  branch list               List the linked project's branches
  secrets                   Fetch the linked project's secrets into .env (--branch <id>)
  skills pull               Install the firth skill into ./.claude/skills
  deploy <dir>|--image <url> Deploy from a source dir (Dockerfile) or a pre-built image (--from, --port)
  events                    Show the project's action↔side-effect timeline (--branch, --limit)
  observe sync              Upload local observe-hook findings (.firth/audit.jsonl) to the timeline
  observe install           Install the local read-only audit hook (Claude Code + Codex)
  observe uninstall         Remove the audit hook from both harnesses
  observe report            Print the local credential-audit report (.firth/audit.jsonl)
  status                    Show login, linked project, and current branch
  manifest                  Show the env manifest (databases/storage/compute per env) [--json]
  project delete            Delete the linked project + all resources (--yes)
  branch switch <name>      Set the current branch (secrets/events default to it)
  branch delete <name>      Delete a branch + its Neon branch (--yes)
  approvals                 List pending approvals
  approve <id> [--always]   Approve a request (--always: set policy to allow, stop asking)
  deny <id>                 Deny a pending request
  policy [set <a> <d>]      Show or set the project's govern policy
  --help                    Show this help
  --version, -v             Print the CLI version`

// Command handlers registered by later tasks. Each: (argv, deps) => Promise<number>.
export const COMMANDS: Record<string, (argv: string[], deps: CliDeps) => Promise<number>> = {}

COMMANDS['login'] = login
COMMANDS['logout'] = logout
COMMANDS['project create'] = projectCreate
COMMANDS['project link'] = projectLink
COMMANDS['project list'] = projectList
COMMANDS['branch create'] = branchCreate
COMMANDS['branch list'] = branchList
COMMANDS['secrets'] = secrets
COMMANDS['skills pull'] = skillsPull
COMMANDS['deploy'] = deploy
COMMANDS['events'] = events
COMMANDS['observe sync'] = observeSync
COMMANDS['observe install'] = observeInstall
COMMANDS['observe uninstall'] = observeUninstall
COMMANDS['observe report'] = observeReport
COMMANDS['branch switch'] = branchSwitch
COMMANDS['branch delete'] = branchDelete
COMMANDS['project delete'] = projectDelete
COMMANDS['status'] = status
COMMANDS['manifest'] = manifest
COMMANDS['approvals'] = approvals
COMMANDS['approve'] = approve
COMMANDS['deny'] = deny
COMMANDS['policy'] = policy

export async function route(argv: string[], deps: CliDeps): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    deps.print(USAGE)
    return 0
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    deps.print(readVersion())
    return 0
  }
  // Support two-word commands ("project create") and one-word ("login").
  const key2 = argv.length >= 2 ? `${argv[0]} ${argv[1]}` : ''
  const handler = COMMANDS[key2] ?? COMMANDS[argv[0]]
  if (!handler) {
    deps.print(`unknown command: ${argv.join(' ')}\n\n${USAGE}`)
    return 1
  }
  const rest = COMMANDS[key2] ? argv.slice(2) : argv.slice(1)
  try {
    return await handler(rest, deps)
  } catch (e) {
    deps.print(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

export async function main(): Promise<void> {
  const code = await route(process.argv.slice(2), {
    print: (s) => console.log(s), home: homedir(), cwd: process.cwd(), env: process.env,
    run: defaultRunner, buildRunner: defaultBuildRunner,
  })
  process.exit(code)
}

if (process.env.NODE_ENV !== 'test') {
  void main()
}

import { homedir } from 'node:os'
import { login, logout } from './commands/auth.js'

export type CliDeps = {
  print: (s: string) => void
  home: string
  cwd: string
  env: NodeJS.ProcessEnv
}

const USAGE = `firth <command>

Commands:
  login                     Sign in (email/password)
  logout                    Clear stored credentials
  project create <name>     Create + link a project
  project link <id>         Link this directory to a project
  project list              List your projects
  branch create <name>      Create a branch (--from <parent>, default main)
  branch list               List the linked project's branches
  secrets                   Fetch the linked project's secrets into .env (--branch <id>)
  skills pull               Install the firth skill into ./.claude/skills
  --help                    Show this help`

// Command handlers registered by later tasks. Each: (argv, deps) => Promise<number>.
export const COMMANDS: Record<string, (argv: string[], deps: CliDeps) => Promise<number>> = {}

COMMANDS['login'] = login
COMMANDS['logout'] = logout

export async function route(argv: string[], deps: CliDeps): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    deps.print(USAGE)
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
  })
  process.exit(code)
}

if (process.env.NODE_ENV !== 'test') {
  void main()
}

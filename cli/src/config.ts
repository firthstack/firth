import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type CliConfig = { apiUrl: string; token?: string }

// Production control plane (InsForge compute). Override with `firth login --api-url`
// or FIRTH_API_URL=… for local dev against http://localhost:8080.
const DEFAULT_API = 'https://firth-control-plane-0662c2ef-202a-4feb-8267-5501b3b60037.fly.dev'
const gpath = (home: string) => join(home, '.firth', 'config.json')
const lpath = (cwd: string) => join(cwd, '.firth', 'project.json')

export function readConfig(home = homedir(), env: NodeJS.ProcessEnv = process.env): CliConfig {
  let file: Partial<CliConfig> = {}
  const p = gpath(home)
  if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'))
  return { ...file, apiUrl: env.FIRTH_API_URL ?? file.apiUrl ?? DEFAULT_API }
}

export function writeConfig(cfg: CliConfig, home = homedir()): void {
  mkdirSync(join(home, '.firth'), { recursive: true })
  writeFileSync(gpath(home), JSON.stringify(cfg, null, 2))
}

export type ProjectLink = { projectId: string; branch?: { id: string; name: string }; skillsInstalled?: boolean }

export function readProjectLink(cwd = process.cwd()): ProjectLink | null {
  const p = lpath(cwd)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

// One-time marker so related-skill installation runs once per linked project, not on every command.
export function markSkillsInstalled(cwd = process.cwd()): void {
  const link = readProjectLink(cwd)
  if (!link) return
  link.skillsInstalled = true
  writeFileSync(lpath(cwd), JSON.stringify(link, null, 2))
}

export function writeProjectLink(projectId: string, cwd = process.cwd()): void {
  mkdirSync(join(cwd, '.firth'), { recursive: true })
  writeFileSync(lpath(cwd), JSON.stringify({ projectId }, null, 2))
}

export function setCurrentBranch(branch: { id: string; name: string } | null, cwd = process.cwd()): void {
  const link = readProjectLink(cwd)
  if (!link) throw new Error('not linked')
  if (branch !== null) {
    link.branch = branch
  } else {
    delete link.branch
  }
  writeFileSync(lpath(cwd), JSON.stringify(link, null, 2))
}

export function clearProjectLink(cwd = process.cwd()): void {
  const p = lpath(cwd)
  if (existsSync(p)) unlinkSync(p)
}

// Append any missing entries to the project's ./.gitignore (creating it if absent).
// Idempotent: entries already present are left alone. Returns the entries it added.
export function ensureGitignore(cwd: string, entries: string[]): string[] {
  const p = join(cwd, '.gitignore')
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const have = new Set(existing.split('\n').map((l) => l.trim()))
  const missing = entries.filter((e) => !have.has(e))
  if (missing.length === 0) return []
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  const block = `${prefix}\n# Firth: agent skills installed by \`firth\` / \`npx skills add\` (regenerable, not source)\n${missing.join('\n')}\n`
  writeFileSync(p, existing + block)
  return missing
}

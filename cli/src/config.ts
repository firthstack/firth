import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type CliConfig = { apiUrl: string; insforge?: { baseUrl: string; anonKey: string }; token?: string }

const DEFAULT_API = 'http://localhost:8080'
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

export function readProjectLink(cwd = process.cwd()): { projectId: string; branch?: { id: string; name: string } } | null {
  const p = lpath(cwd)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
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

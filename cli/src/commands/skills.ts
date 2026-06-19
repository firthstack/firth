import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliDeps } from '../index.js'

export async function skillsPull(_argv: string[], deps: CliDeps): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url))
  // built run: cli/dist/commands -> cli/dist/skills (build copies the top-level skills/ in)
  // source run: cli/src/commands -> <repo-root>/skills
  const candidates = [
    join(here, '..', 'skills', 'firth', 'SKILL.md'),
    join(here, '..', '..', '..', 'skills', 'firth', 'SKILL.md'),
  ]
  const src = candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1]
  const destDir = join(deps.cwd, '.claude', 'skills', 'firth')
  mkdirSync(destDir, { recursive: true })
  copyFileSync(src, join(destDir, 'SKILL.md'))
  deps.print(`installed firth skill → ${join('.claude', 'skills', 'firth', 'SKILL.md')}`)
  return 0
}

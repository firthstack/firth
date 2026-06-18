import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliDeps } from '../index.js'

export async function skillsPull(_argv: string[], deps: CliDeps): Promise<number> {
  // bundled skill ships beside the compiled CLI
  // __dirname equivalent: .../cli/commands/ (both test-run from src/ and built-run from dist/src/)
  // → go up one level to cli/, then into skills/firth/SKILL.md
  const here = dirname(fileURLToPath(import.meta.url))
  const src = join(here, '..', 'skills', 'firth', 'SKILL.md')
  const destDir = join(deps.cwd, '.claude', 'skills', 'firth')
  mkdirSync(destDir, { recursive: true })
  copyFileSync(src, join(destDir, 'SKILL.md'))
  deps.print(`installed firth skill → ${join('.claude', 'skills', 'firth', 'SKILL.md')}`)
  return 0
}

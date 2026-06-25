import { readProjectLink, markObserveInstalled } from './config.js'
import { installObserve } from './observe/install.js'

type ObserveDeps = { print: (s: string) => void; cwd: string }

// Install the observe hook into both harnesses once per linked project. Convenience
// only — wrapped so it never blocks or fails the host command (mirrors ensure-skills).
export async function ensureObserveHook(deps: ObserveDeps, assetDir?: string): Promise<void> {
  try {
    const link = readProjectLink(deps.cwd)
    if (!link) return
    installObserve({ cwd: deps.cwd, assetDir }) // idempotent refresh of files + both harness entries
    if (!link.observeInstalled) {
      deps.print('installed Firth observe hook → .claude/settings.json + .codex/hooks.json (local, read-only audit; nothing leaves your machine until you run `firth observe sync`)')
      deps.print('  (Codex: trust this project\'s .codex/ layer in Codex to activate the hook)')
      markObserveInstalled(deps.cwd)
    }
  } catch {
    /* convenience only — never block the command */
  }
}

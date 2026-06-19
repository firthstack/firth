import { spawn } from 'node:child_process'

// Injectable command runner. inherit=true streams child stdio to the user (for the brew install).
export type Runner = (cmd: string, args: string[], inherit?: boolean) => Promise<{ ok: boolean }>

export const defaultRunner: Runner = (cmd, args, inherit = false) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: inherit ? 'inherit' : 'ignore' })
    p.on('error', () => resolve({ ok: false }))   // ENOENT etc.
    p.on('close', (code) => resolve({ ok: code === 0 }))
  })

// Minimal surface of CliDeps that ensureFlyctl needs. Avoids a circular import with index.ts.
type FlyDeps = {
  print: (s: string) => void
  run?: Runner
}

// Ensure flyctl is installed. No-op unless deps.run is set (production wires defaultRunner;
// tests inject a fake; other command tests omit it → this is a no-op so nothing is spawned).
export async function ensureFlyctl(deps: FlyDeps): Promise<void> {
  const run = deps.run
  if (!run) return
  try {
    if ((await run('flyctl', ['version'])).ok) return                 // already installed
    if (!(await run('brew', ['--version'])).ok) {                     // no Homebrew → just hint
      deps.print('note: flyctl (fly CLI) not found and Homebrew is unavailable — install it: https://fly.io/docs/flyctl/install/')
      return
    }
    deps.print('flyctl not found — installing with `brew install flyctl` (one-time)…')
    const r = await run('brew', ['install', 'flyctl'], true)
    deps.print(r.ok ? 'flyctl installed ✓' : 'flyctl install failed — install manually: https://fly.io/docs/flyctl/install/')
  } catch { /* convenience only — never block the command */ }
}

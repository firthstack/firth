import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ensureFlyctl, type Runner } from '../src/fly.js'
import { projectLink } from '../src/commands/project.js'
import type { CliDeps } from '../src/index.js'

function makeDeps(dir: string, run?: Runner) {
  const out: string[] = []
  const d: CliDeps & { out: string[]; run?: Runner } = {
    print: (s: string) => out.push(s),
    out,
    home: dir,
    cwd: dir,
    env: {},
    ...(run !== undefined ? { run } : {}),
  }
  return d
}

// ---- ensureFlyctl unit tests ----

test('flyctl present: no brew calls, nothing printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const calls: [string, string[], boolean?][] = []
  const run: Runner = async (cmd, args, inherit) => {
    calls.push([cmd, args, inherit])
    if (cmd === 'flyctl') return { ok: true }
    return { ok: false }
  }
  const d = makeDeps(dir, run)
  await ensureFlyctl(d)
  // Only flyctl version should be called
  expect(calls.length).toBe(1)
  expect(calls[0][0]).toBe('flyctl')
  expect(d.out.length).toBe(0)
})

test('flyctl missing + brew present + install succeeds: prints installing + installed messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const calls: [string, string[], boolean?][] = []
  const run: Runner = async (cmd, args, inherit) => {
    calls.push([cmd, args, inherit])
    if (cmd === 'flyctl') return { ok: false }
    if (cmd === 'brew' && args[0] === '--version') return { ok: true }
    if (cmd === 'brew' && args[0] === 'install') return { ok: true }
    return { ok: false }
  }
  const d = makeDeps(dir, run)
  await ensureFlyctl(d)
  const output = d.out.join('\n')
  expect(output).toMatch(/installing/i)
  expect(output).toMatch(/installed/i)
  // Must have called brew install flyctl with inherit=true
  const installCall = calls.find(([cmd, args]) => cmd === 'brew' && args[0] === 'install')
  expect(installCall).toBeDefined()
  expect(installCall![2]).toBe(true)
})

test('flyctl missing + brew missing: prints manual install hint, no brew install call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const calls: [string, string[], boolean?][] = []
  const run: Runner = async (cmd, args, inherit) => {
    calls.push([cmd, args, inherit])
    return { ok: false }
  }
  const d = makeDeps(dir, run)
  await ensureFlyctl(d)
  const output = d.out.join('\n')
  expect(output).toMatch(/fly\.io\/docs\/flyctl\/install/)
  // No brew install call
  const installCall = calls.find(([cmd, args]) => cmd === 'brew' && args[0] === 'install')
  expect(installCall).toBeUndefined()
})

test('brew install fails: prints failure hint, does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const run: Runner = async (cmd, args) => {
    if (cmd === 'flyctl') return { ok: false }
    if (cmd === 'brew' && args[0] === '--version') return { ok: true }
    if (cmd === 'brew' && args[0] === 'install') return { ok: false }
    return { ok: false }
  }
  const d = makeDeps(dir, run)
  // Must not throw
  await expect(ensureFlyctl(d)).resolves.toBeUndefined()
  const output = d.out.join('\n')
  expect(output).toMatch(/install.*failed|failed.*install/i)
})

test('deps.run undefined: ensureFlyctl is a no-op — nothing printed, no calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  // No run property
  const d = makeDeps(dir)
  await ensureFlyctl(d)
  expect(d.out.length).toBe(0)
})

// ---- Integration: projectLink wires ensureFlyctl ----

test('projectLink with fake run consults flyctl version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const calls: [string, string[]][] = []
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, args])
    return { ok: true } // flyctl present — no install attempt
  }
  const d = makeDeps(dir, run)
  await projectLink(['p1'], d)
  const flyctlCall = calls.find(([cmd, args]) => cmd === 'flyctl' && args[0] === 'version')
  expect(flyctlCall).toBeDefined()
})

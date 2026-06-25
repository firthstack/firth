import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { installObserve, uninstallObserve } from '../src/observe/install.js'

function fakeAssets(): string {
  const a = mkdtempSync(join(tmpdir(), 'assets-'))
  writeFileSync(join(a, 'hook.js'), '// hook')
  writeFileSync(join(a, 'scanner.js'), '// scanner')
  return a
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

test('materializes the hook and registers both harnesses', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const res = installObserve({ cwd, assetDir: fakeAssets() })
  expect(res).toEqual({ claude: true, codex: true })
  expect(readFileSync(join(cwd, '.firth', 'observe', 'hook.js'), 'utf8')).toBe('// hook')
  expect(readFileSync(join(cwd, '.firth', 'observe', 'scanner.js'), 'utf8')).toBe('// scanner')
  expect(readJson(join(cwd, '.firth', 'observe', 'package.json')).type).toBe('module')

  const claude = readJson(join(cwd, '.claude', 'settings.json'))
  const cHook = claude.hooks.PostToolUse[0].hooks[0]
  expect(cHook).toMatchObject({ command: 'node', _firth: 'firth-observe' })
  expect(cHook.args[0]).toContain('.firth/observe/hook.js')

  const codex = readJson(join(cwd, '.codex', 'hooks.json'))
  const xHook = codex.hooks.PostToolUse[0].hooks[0]
  expect(xHook.args).toBeUndefined()                      // Codex: single command string, no args
  expect(xHook.command).toMatch(/^node .*\.firth\/observe\/hook\.js/)
  expect(xHook._firth).toBe('firth-observe')
})

test('upsert migrates an old python firth entry (no duplicate)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: '*', hooks: [{ type: 'command', command: 'python3', args: ['${CLAUDE_PROJECT_DIR}/observe/hook.py'], _firth: 'firth-observe' }] },
  ] } }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const post = readJson(join(cwd, '.claude', 'settings.json')).hooks.PostToolUse
  const firthHooks = post.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')
  expect(firthHooks).toHaveLength(1)
  expect(firthHooks[0].command).toBe('node') // the new entry, python one gone
})

test('install is idempotent (one firth entry per harness after two installs)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  const assets = fakeAssets()
  installObserve({ cwd, assetDir: assets })
  installObserve({ cwd, assetDir: assets })
  const post = readJson(join(cwd, '.claude', 'settings.json')).hooks.PostToolUse
  expect(post.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(1)
})

test('preserves the user\'s non-firth hooks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'mylinter' }] },
  ] } }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const post = readJson(join(cwd, '.claude', 'settings.json')).hooks.PostToolUse
  expect(post.flatMap((g: any) => g.hooks).some((h: any) => h.command === 'mylinter')).toBe(true)
})

test('a malformed config on one harness is skipped without aborting the other', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.codex'), { recursive: true })
  writeFileSync(join(cwd, '.codex', 'hooks.json'), '{ this is not json')
  const res = installObserve({ cwd, assetDir: fakeAssets() })
  expect(res).toEqual({ claude: true, codex: false })
  expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(true)
})

test('user hook whose args contain observe/hook substring (no dot) is NOT clobbered', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['scripts/observe/hooks-report.sh'] }] },
  ] } }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const post = readJson(join(cwd, '.claude', 'settings.json')).hooks.PostToolUse
  const allHooks = post.flatMap((g: any) => g.hooks)
  // user's hook must still be present
  expect(allHooks.some((h: any) => Array.isArray(h.args) && h.args.includes('scripts/observe/hooks-report.sh'))).toBe(true)
  // exactly one firth-observe entry
  expect(allHooks.filter((h: any) => h._firth === 'firth-observe')).toHaveLength(1)
})

test('uninstall removes firth entries from both harnesses', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  installObserve({ cwd, assetDir: fakeAssets() })
  uninstallObserve(cwd)
  const claude = readJson(join(cwd, '.claude', 'settings.json'))
  const codex = readJson(join(cwd, '.codex', 'hooks.json'))
  expect(claude.hooks.PostToolUse.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(0)
  expect(codex.hooks.PostToolUse.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(0)
})

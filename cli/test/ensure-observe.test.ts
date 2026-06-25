import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ensureObserveHook } from '../src/ensure-observe.js'
import { writeProjectLink, readProjectLink } from '../src/config.js'

function fakeAssets(): string {
  const a = mkdtempSync(join(tmpdir(), 'assets-'))
  writeFileSync(join(a, 'hook.js'), '// hook'); writeFileSync(join(a, 'scanner.js'), '// scanner')
  return a
}

test('first call installs both harnesses and prints the notice once; sets the marker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', cwd)
  const out: string[] = []
  await ensureObserveHook({ print: (s) => out.push(s), cwd }, fakeAssets())
  expect(existsSync(join(cwd, '.firth', 'observe', 'hook.js'))).toBe(true)
  expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(true)
  expect(existsSync(join(cwd, '.codex', 'hooks.json'))).toBe(true)
  expect(out.join('\n')).toMatch(/observe hook/)
  expect(out.join('\n')).toMatch(/Codex/)
  expect(readProjectLink(cwd)?.observeInstalled).toBe(true)
})

test('second call refreshes silently (no duplicate notice, no duplicate entry)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', cwd)
  const assets = fakeAssets()
  await ensureObserveHook({ print: () => {}, cwd }, assets)
  const out: string[] = []
  await ensureObserveHook({ print: (s) => out.push(s), cwd }, assets)
  expect(out.join('\n')).not.toMatch(/observe hook/) // notice gated by the marker
  const post = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUse
  expect(post.flatMap((g: any) => g.hooks).filter((h: any) => h._firth === 'firth-observe')).toHaveLength(1)
})

test('not linked → no-op, never throws', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-'))
  await ensureObserveHook({ print: () => {}, cwd }, fakeAssets())
  expect(existsSync(join(cwd, '.firth', 'observe'))).toBe(false)
})

test('missing assets → swallowed, never throws', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', cwd)
  await expect(ensureObserveHook({ print: () => {}, cwd }, join(tmpdir(), 'does-not-exist'))).resolves.toBeUndefined()
})

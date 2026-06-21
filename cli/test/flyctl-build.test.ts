import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseImageDigest, flyctlBuildAndPush, type BuildRunner } from '../src/flyctl-build.js'

const MANIFEST = 'pushing manifest for registry.fly.io/firth-x-ab12:cli-123@sha256:abc123def456 0.1s done'

test('parseImageDigest extracts the digest-pinned ref', () => {
  expect(parseImageDigest(MANIFEST, 'firth-x-ab12')).toBe('registry.fly.io/firth-x-ab12@sha256:abc123def456')
})

test('parseImageDigest returns null when no manifest line is present', () => {
  expect(parseImageDigest('built and done, no manifest', 'firth-x-ab12')).toBeNull()
})

test('flyctlBuildAndPush writes a stub fly.toml, runs flyctl with the token, returns the digest, and cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  let seen: any
  const run: BuildRunner = async (cmd, args, opts) => {
    seen = { cmd, args, opts, hadFlyToml: existsSync(join(dir, 'fly.toml')) }
    return { code: 0, output: MANIFEST }
  }
  const { imageRef } = await flyctlBuildAndPush({ dir, flyApp: 'firth-x-ab12', imageLabel: 'cli-123', token: 'FlyV1 tok', port: 8080 }, run)
  expect(imageRef).toBe('registry.fly.io/firth-x-ab12@sha256:abc123def456')
  expect(seen.cmd).toBe('flyctl')
  expect(seen.args).toEqual(['deploy', '--remote-only', '--build-only', '--push', '--app', 'firth-x-ab12', '--image-label', 'cli-123', '--no-cache'])
  expect(seen.opts.env.FLY_API_TOKEN).toBe('FlyV1 tok')
  expect(seen.opts.cwd).toBe(dir)
  expect(seen.hadFlyToml).toBe(true)              // stub present during the build
  expect(existsSync(join(dir, 'fly.toml'))).toBe(false) // removed after
})

test('flyctlBuildAndPush leaves a user-provided fly.toml untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeFileSync(join(dir, 'fly.toml'), 'app = "mine"\n')
  const run: BuildRunner = async () => ({ code: 0, output: MANIFEST })
  await flyctlBuildAndPush({ dir, flyApp: 'firth-x-ab12', imageLabel: 'cli-123', token: 't', port: 8080 }, run)
  expect(readFileSync(join(dir, 'fly.toml'), 'utf8')).toBe('app = "mine"\n') // not overwritten, not deleted
})

test('flyctlBuildAndPush throws on non-zero exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const run: BuildRunner = async () => ({ code: 1, output: 'boom' })
  await expect(flyctlBuildAndPush({ dir, flyApp: 'a', imageLabel: 'l', token: 't', port: 8080 }, run)).rejects.toThrow(/exit 1/)
  expect(existsSync(join(dir, 'fly.toml'))).toBe(false) // stub cleaned up even on failure
})

test('flyctlBuildAndPush throws when the manifest digest line is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const run: BuildRunner = async () => ({ code: 0, output: 'built, but no manifest line' })
  await expect(flyctlBuildAndPush({ dir, flyApp: 'a', imageLabel: 'l', token: 't', port: 8080 }, run)).rejects.toThrow(/manifest/i)
})

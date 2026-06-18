import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  FIRTH_KEK_CURRENT: 'v1',
  FIRTH_KEK_v1: randomBytes(32).toString('base64'),
  INSFORGE_BASE_URL: 'https://u4vrn3sx.us-east.insforge.app',
  INSFORGE_ANON_KEY: 'anon',
  INSFORGE_ADMIN_KEY: 'ik_test',
}

test('loads a complete config', () => {
  const cfg = loadConfig(base)
  expect(cfg.currentKek).toBe('v1')
  expect(cfg.insforge.baseUrl).toContain('insforge.app')
})

test('throws when a required InsForge var is missing', () => {
  const { INSFORGE_ADMIN_KEY, ...rest } = base
  expect(() => loadConfig(rest)).toThrow(/INSFORGE_ADMIN_KEY/)
})

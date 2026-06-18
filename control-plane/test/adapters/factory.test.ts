import { expect, test } from 'vitest'
import { buildAdapters } from '../../src/adapters/factory.js'

const baseCfg = { keks: new Map(), currentKek: 'V1', insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } }
const http = async () => ({ status: 200, json: async () => ({}), text: async () => '' })

test('builds a NeonAdapter when neonApiKey is present', () => {
  const adapters = buildAdapters({ ...baseCfg, neonApiKey: 'neon_k' } as any, http)
  expect(adapters.map((a) => a.kind)).toEqual(['neon'])
})

test('builds no adapters when neonApiKey is absent', () => {
  expect(buildAdapters(baseCfg as any, http)).toEqual([])
})

test('builds FlyAdapter when flyApiToken and flyOrgSlug are present', () => {
  const adapters = buildAdapters({ ...baseCfg, flyApiToken: 'tok', flyOrgSlug: 'myorg' } as any, http)
  expect(adapters.map((a) => a.kind)).toEqual(['fly'])
})

test('does NOT build FlyAdapter when only one fly var is present', () => {
  const adapters1 = buildAdapters({ ...baseCfg, flyApiToken: 'tok' } as any, http)
  expect(adapters1.map((a) => a.kind)).not.toContain('fly')

  const adapters2 = buildAdapters({ ...baseCfg, flyOrgSlug: 'myorg' } as any, http)
  expect(adapters2.map((a) => a.kind)).not.toContain('fly')
})

test('builds TigrisAdapter (s3 kind) when tigrisAccessKeyId and tigrisSecretAccessKey are present', () => {
  const adapters = buildAdapters({ ...baseCfg, tigrisAccessKeyId: 'kid', tigrisSecretAccessKey: 'sec' } as any, http)
  expect(adapters.map((a) => a.kind)).toEqual(['s3'])
})

test('does NOT build TigrisAdapter when only one tigris var is present', () => {
  const adapters1 = buildAdapters({ ...baseCfg, tigrisAccessKeyId: 'kid' } as any, http)
  expect(adapters1.map((a) => a.kind)).not.toContain('s3')

  const adapters2 = buildAdapters({ ...baseCfg, tigrisSecretAccessKey: 'sec' } as any, http)
  expect(adapters2.map((a) => a.kind)).not.toContain('s3')
})

test('builds all three adapters when all config vars present', () => {
  const adapters = buildAdapters({
    ...baseCfg,
    neonApiKey: 'neon_k',
    flyApiToken: 'tok',
    flyOrgSlug: 'myorg',
    tigrisAccessKeyId: 'kid',
    tigrisSecretAccessKey: 'sec',
  } as any, http)
  expect(adapters.map((a) => a.kind).sort()).toEqual(['fly', 'neon', 's3'])
})

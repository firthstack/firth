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

import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { decryptSecret, encryptSecret, loadKeks } from '../../src/crypto/secrets.js'

const v1 = randomBytes(32).toString('base64')
const v2 = randomBytes(32).toString('base64')
const env = { FIRTH_KEK_CURRENT: 'v1', FIRTH_KEK_v1: v1, FIRTH_KEK_v2: v2 }

describe('secret encryption', () => {
  test('round-trips plaintext under the current KEK', () => {
    const { keks, current } = loadKeks(env)
    const enc = encryptSecret('postgres://secret-conn', keks, current)
    expect(enc.kekVersion).toBe('v1')
    expect(enc.ciphertext).not.toContain('postgres')
    expect(decryptSecret(enc, keks)).toBe('postgres://secret-conn')
  })

  test('decrypts a value encrypted under a non-current KEK version', () => {
    const { keks } = loadKeks(env)
    const enc = encryptSecret('x', keks, 'v2')
    expect(decryptSecret(enc, keks)).toBe('x')
  })

  test('tampered ciphertext fails authentication', () => {
    const { keks, current } = loadKeks(env)
    const enc = encryptSecret('y', keks, current)
    const bad = { ...enc, ciphertext: Buffer.from('deadbeef').toString('base64') }
    expect(() => decryptSecret(bad, keks)).toThrow()
  })

  test('unknown KEK version throws without leaking plaintext', () => {
    const { keks } = loadKeks(env)
    expect(() => decryptSecret({ ciphertext: 'a', nonce: 'b', kekVersion: 'v9' }, keks))
      .toThrow(/unknown kek version/i)
  })
})

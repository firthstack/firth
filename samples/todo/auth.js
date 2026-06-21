import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

const KEYLEN = 32

export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, KEYLEN)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password, encoded) {
  const parts = String(encoded).split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let salt, expected
  try {
    salt = Buffer.from(parts[1], 'base64')
    expected = Buffer.from(parts[2], 'base64')
  } catch { return false }
  if (expected.length === 0) return false
  const actual = scryptSync(String(password), salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function newSessionToken() {
  const token = randomBytes(32).toString('hex')
  return { token, tokenHash: hashToken(token) }
}

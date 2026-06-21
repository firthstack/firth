import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, newSessionToken, hashToken } from '../auth.js'

test('hashPassword + verifyPassword round-trip', () => {
  const h = hashPassword('correct horse battery')
  assert.equal(verifyPassword('correct horse battery', h), true)
})

test('verifyPassword rejects the wrong password', () => {
  const h = hashPassword('correct horse battery')
  assert.equal(verifyPassword('wrong', h), false)
})

test('the same password hashes differently each time (random salt)', () => {
  assert.notEqual(hashPassword('same-password'), hashPassword('same-password'))
})

test('verifyPassword returns false on a malformed hash', () => {
  assert.equal(verifyPassword('x', 'not-a-valid-encoded-hash'), false)
  assert.equal(verifyPassword('x', ''), false)
})

test('newSessionToken: hashToken(token) equals tokenHash, token is 64 hex chars', () => {
  const { token, tokenHash } = newSessionToken()
  assert.equal(token.length, 64)
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(hashToken(token), tokenHash)
})

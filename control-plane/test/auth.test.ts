import { expect, test } from 'vitest'
import { resolveUid, UnauthorizedError } from '../src/auth.js'

const verifyOk = async (t: string) => (t === 'good' ? { id: 'uid-1' } : null)

test('extracts uid + token from a valid bearer header', async () => {
  const r = await resolveUid('Bearer good', verifyOk)
  expect(r).toEqual({ uid: 'uid-1', token: 'good' })
})

test('rejects a missing header', async () => {
  await expect(resolveUid(undefined, verifyOk)).rejects.toBeInstanceOf(UnauthorizedError)
})

test('rejects a token the backend does not recognize', async () => {
  await expect(resolveUid('Bearer bad', verifyOk)).rejects.toBeInstanceOf(UnauthorizedError)
})

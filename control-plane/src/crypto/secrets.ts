import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type EncryptedSecret = { ciphertext: string; nonce: string; kekVersion: string }

export function loadKeks(env: NodeJS.ProcessEnv): { keks: Map<string, Buffer>; current: string } {
  const current = env.FIRTH_KEK_CURRENT
  if (!current) throw new Error('FIRTH_KEK_CURRENT is not set')
  const keks = new Map<string, Buffer>()
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('FIRTH_KEK_') || k === 'FIRTH_KEK_CURRENT' || !v) continue
    const version = k.slice('FIRTH_KEK_'.length)
    const buf = Buffer.from(v, 'base64')
    if (buf.length !== 32) throw new Error(`KEK ${version} must be 32 bytes (base64)`)
    keks.set(version, buf)
  }
  if (!keks.has(current)) throw new Error(`current KEK ${current} not provided`)
  return { keks, current }
}

export function encryptSecret(plaintext: string, keks: Map<string, Buffer>, version: string): EncryptedSecret {
  const key = keks.get(version)
  if (!key) throw new Error(`unknown kek version: ${version}`)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([ct, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
    kekVersion: version,
  }
}

export function decryptSecret(enc: EncryptedSecret, keks: Map<string, Buffer>): string {
  const key = keks.get(enc.kekVersion)
  if (!key) throw new Error(`unknown kek version: ${enc.kekVersion}`)
  const raw = Buffer.from(enc.ciphertext, 'base64')
  const tag = raw.subarray(raw.length - 16)
  const ct = raw.subarray(0, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.nonce, 'base64'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeStorage, contentTypeToExt,
  ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, IMAGE_URL_TTL_SECONDS,
} from '../storage.js'

const ENV = {
  AWS_ENDPOINT_URL_S3: 'https://t3.storage.dev',
  AWS_REGION: 'auto',
  AWS_ACCESS_KEY_ID: 'tid_test',
  AWS_SECRET_ACCESS_KEY: 'tsec_test',
  BUCKET_NAME: 'mybucket',
}

// A fake S3 client: records every command's `.input` instead of hitting the network.
// Used for the send-based ops (upload/delete). presignedGetUrl needs a real client (local signing).
function fakeClient() {
  const sent = []
  return { sent, async send(cmd) { sent.push(cmd); return {} } }
}

test('constants', () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024)
  assert.equal(IMAGE_URL_TTL_SECONDS, 3600)
  assert.ok(ALLOWED_IMAGE_TYPES.has('image/jpeg'))
  assert.ok(!ALLOWED_IMAGE_TYPES.has('text/plain'))
})

test('contentTypeToExt maps allowed types and rejects others', () => {
  assert.equal(contentTypeToExt('image/jpeg'), 'jpg')
  assert.equal(contentTypeToExt('image/png'), 'png')
  assert.equal(contentTypeToExt('image/webp'), 'webp')
  assert.equal(contentTypeToExt('image/gif'), 'gif')
  assert.throws(() => contentTypeToExt('text/plain'))
})

test('uploadImage sends PutObject with the right params and returns a key', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  const { key } = await s.uploadImage(Buffer.from('data'), 'image/png')
  assert.match(key, /^todos\/[0-9a-f-]+\.png$/)
  assert.equal(client.sent.length, 1)
  const input = client.sent[0].input
  assert.equal(input.Bucket, 'mybucket')
  assert.equal(input.Key, key)
  assert.equal(input.ContentType, 'image/png')
  assert.equal(input.Body.toString(), 'data')
})

test('deleteImage sends DeleteObject', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  await s.deleteImage('todos/x.jpg')
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].input.Bucket, 'mybucket')
  assert.equal(client.sent[0].input.Key, 'todos/x.jpg')
})

test('deleteImages is a no-op for empty input', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  await s.deleteImages([])
  assert.equal(client.sent.length, 0)
})

test('deleteImages sends one DeleteObjects with all keys', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  await s.deleteImages(['todos/a.jpg', 'todos/b.png'])
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].input.Bucket, 'mybucket')
  assert.deepEqual(
    client.sent[0].input.Delete.Objects,
    [{ Key: 'todos/a.jpg' }, { Key: 'todos/b.png' }],
  )
})

test('presignedGetUrl returns a locally-signed URL for the object (no network)', async () => {
  const s = makeStorage(ENV) // real S3Client; getSignedUrl signs locally using the dummy creds
  const url = await s.presignedGetUrl('todos/x.jpg')
  assert.match(url, /^https:\/\/t3\.storage\.dev\/mybucket\/todos\/x\.jpg\?/)
  assert.match(url, /X-Amz-Signature=/)
  assert.match(url, /X-Amz-Expires=3600/)
})

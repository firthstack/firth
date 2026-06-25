import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeStorage, contentTypeToExt, publicBaseFromEndpoint,
  ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES,
} from '../storage.js'

const ENV = {
  AWS_ENDPOINT_URL_S3: 'https://app.us-east.insforge.app/storage/v1/s3',
  AWS_REGION: 'us-east-2',
  AWS_ACCESS_KEY_ID: 'x',
  AWS_SECRET_ACCESS_KEY: 'y',
  BUCKET_NAME: 'mybucket',
}

// A fake S3 client: records every command's `.input` instead of hitting the network.
function fakeClient() {
  const sent = []
  return { sent, async send(cmd) { sent.push(cmd); return {} } }
}

test('constants', () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024)
  assert.ok(ALLOWED_IMAGE_TYPES.has('image/jpeg'))
  assert.ok(!ALLOWED_IMAGE_TYPES.has('text/plain'))
})

test('publicBaseFromEndpoint strips the /storage/v1/s3 suffix', () => {
  assert.equal(
    publicBaseFromEndpoint('https://app.us-east.insforge.app/storage/v1/s3'),
    'https://app.us-east.insforge.app',
  )
  assert.equal(
    publicBaseFromEndpoint('https://app.us-east.insforge.app/storage/v1/s3/'),
    'https://app.us-east.insforge.app',
  )
})

test('contentTypeToExt maps allowed types and rejects others', () => {
  assert.equal(contentTypeToExt('image/jpeg'), 'jpg')
  assert.equal(contentTypeToExt('image/png'), 'png')
  assert.equal(contentTypeToExt('image/webp'), 'webp')
  assert.equal(contentTypeToExt('image/gif'), 'gif')
  assert.throws(() => contentTypeToExt('text/plain'))
})

test('publicUrl builds the public object URL', () => {
  const s = makeStorage(ENV, fakeClient())
  assert.equal(
    s.publicUrl('todos/abc.jpg'),
    'https://app.us-east.insforge.app/api/storage/buckets/mybucket/objects/todos/abc.jpg',
  )
})

test('uploadImage sends PutObject with the right params and returns key+url', async () => {
  const client = fakeClient()
  const s = makeStorage(ENV, client)
  const { key, url } = await s.uploadImage(Buffer.from('data'), 'image/png')
  assert.match(key, /^todos\/[0-9a-f-]+\.png$/)
  assert.equal(url, s.publicUrl(key))
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
  assert.deepEqual(
    client.sent[0].input.Delete.Objects,
    [{ Key: 'todos/a.jpg' }, { Key: 'todos/b.png' }],
  )
})

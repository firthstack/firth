import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { makeApp } from '../server.js'
import { makePool, createUser, createSession } from '../db.js'

// Fake storage records calls so we never touch real S3/presigning.
function fakeStorage() {
  const calls = { uploads: [], deletes: [], batchDeletes: [] }
  return {
    calls,
    async uploadImage(buffer, contentType) {
      calls.uploads.push({ size: buffer.length, contentType })
      return { key: 'todos/fake.jpg' }
    },
    async presignedGetUrl(key) { return `https://signed.test/${key}?sig=x` },
    async deleteImage(key) { calls.deletes.push(key) },
    async deleteImages(keys) { calls.batchDeletes.push(keys) },
  }
}

let pool, client, app, fake, token

before(() => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set')
  pool = makePool()
})
after(async () => { await pool.end() })

beforeEach(async () => {
  client = await pool.connect()
  await client.query('begin')
  await client.query('delete from users')
  const u = await createUser(client, 'img@example.com', 'password1')
  token = await createSession(client, u.id)
  fake = fakeStorage()
  app = makeApp(client, fake) // routes share the tx client as their "pool"
})
afterEach(async () => { await client.query('rollback'); client.release() })

const auth = (r) => r.set('Authorization', `Bearer ${token}`)

test('POST /api/todos with an image uploads and returns a presigned image_url, no image_key', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', 'with pic')
    .attach('image', Buffer.from('fakejpegbytes'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  assert.equal(res.status, 201)
  assert.equal(res.body.title, 'with pic')
  assert.equal(res.body.image_url, 'https://signed.test/todos/fake.jpg?sig=x')
  assert.equal(res.body.image_key, undefined)
  assert.equal(fake.calls.uploads.length, 1)
  assert.equal(fake.calls.uploads[0].contentType, 'image/jpeg')
})

test('POST /api/todos without an image returns image_url null and does not call storage', async () => {
  const res = await auth(request(app).post('/api/todos')).send({ title: 'no pic' })
  assert.equal(res.status, 201)
  assert.equal(res.body.image_url, null)
  assert.equal(res.body.image_key, undefined)
  assert.equal(fake.calls.uploads.length, 0)
})

test('GET /api/todos returns a presigned image_url per todo that has an image', async () => {
  await auth(request(app).post('/api/todos'))
    .field('title', 'with pic')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  await auth(request(app).post('/api/todos')).send({ title: 'no pic' })
  const res = await auth(request(app).get('/api/todos'))
  assert.equal(res.status, 200)
  const byTitle = Object.fromEntries(res.body.map((t) => [t.title, t]))
  assert.equal(byTitle['with pic'].image_url, 'https://signed.test/todos/fake.jpg?sig=x')
  assert.equal(byTitle['no pic'].image_url, null)
  assert.ok(res.body.every((t) => t.image_key === undefined))
})

test('POST /api/todos rejects an unsupported image type (no upload)', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', 'bad pic')
    .attach('image', Buffer.from('x'), { filename: 'p.txt', contentType: 'text/plain' })
  assert.equal(res.status, 400)
  assert.equal(fake.calls.uploads.length, 0)
})

test('POST /api/todos with a bad title does not upload (fail fast)', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', '   ')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  assert.equal(res.status, 400)
  assert.equal(fake.calls.uploads.length, 0)
})

test('DELETE /api/todos/:id deletes the image object', async () => {
  const created = (await auth(request(app).post('/api/todos'))
    .field('title', 't')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })).body
  const res = await auth(request(app).delete(`/api/todos/${created.id}`))
  assert.equal(res.status, 204)
  assert.deepEqual(fake.calls.deletes, ['todos/fake.jpg'])
})

test('DELETE /api/todos?completed=true batch-deletes image objects', async () => {
  const created = (await auth(request(app).post('/api/todos'))
    .field('title', 't')
    .attach('image', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })).body
  await auth(request(app).patch(`/api/todos/${created.id}`)).send({ completed: true })
  const res = await auth(request(app).delete('/api/todos?completed=true'))
  assert.equal(res.status, 200)
  assert.equal(res.body.deleted, 1)
  assert.deepEqual(fake.calls.batchDeletes, [['todos/fake.jpg']])
})

test('POST /api/todos with a file under an unexpected field returns 400 (not 500)', async () => {
  const res = await auth(request(app).post('/api/todos'))
    .field('title', 'oops')
    .attach('wrongfield', Buffer.from('x'), { filename: 'p.jpg', contentType: 'image/jpeg' })
  assert.equal(res.status, 400)
  assert.equal(fake.calls.uploads.length, 0)
})

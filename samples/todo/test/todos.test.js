import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted, ValidationError,
} from '../db.js'

const MISSING_ID = '00000000-0000-0000-0000-000000000000'
let pool, client

before(() => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set — run `firth secrets` first')
  pool = makePool()
})
after(async () => { await pool.end() })

// Isolate every test inside a transaction we roll back — no data persists. The DELETE gives each
// test a clean slate even when the live table already holds real rows; the rollback restores them.
beforeEach(async () => {
  client = await pool.connect()
  await client.query('begin')
  await client.query('delete from todos')
})
afterEach(async () => { await client.query('rollback'); client.release() })

test('createTodo inserts and returns the row', async () => {
  const t = await createTodo(client, 'buy milk')
  assert.equal(t.title, 'buy milk')
  assert.equal(t.completed, false)
  assert.ok(t.id)
})

test('createTodo trims whitespace', async () => {
  const t = await createTodo(client, '  spaced  ')
  assert.equal(t.title, 'spaced')
})

test('createTodo rejects an empty title', async () => {
  await assert.rejects(() => createTodo(client, '   '), ValidationError)
})

test('createTodo rejects a title over 500 chars', async () => {
  await assert.rejects(() => createTodo(client, 'x'.repeat(501)), ValidationError)
})

test('listTodos returns rows ordered by created_at', async () => {
  await createTodo(client, 'first')
  await createTodo(client, 'second')
  const rows = await listTodos(client)
  assert.deepEqual(rows.map((r) => r.title), ['first', 'second'])
})

test('updateTodo toggles completed', async () => {
  const t = await createTodo(client, 'task')
  const u = await updateTodo(client, t.id, { completed: true })
  assert.equal(u.completed, true)
})

test('updateTodo changes the title', async () => {
  const t = await createTodo(client, 'old')
  const u = await updateTodo(client, t.id, { title: 'new' })
  assert.equal(u.title, 'new')
})

test('updateTodo rejects an empty title', async () => {
  const t = await createTodo(client, 'keep')
  await assert.rejects(() => updateTodo(client, t.id, { title: '  ' }), ValidationError)
})

test('updateTodo returns null for an unknown id', async () => {
  const u = await updateTodo(client, MISSING_ID, { completed: true })
  assert.equal(u, null)
})

test('deleteTodo removes the row', async () => {
  const t = await createTodo(client, 'gone')
  assert.equal(await deleteTodo(client, t.id), true)
  assert.equal((await listTodos(client)).length, 0)
})

test('deleteTodo returns false for an unknown id', async () => {
  assert.equal(await deleteTodo(client, MISSING_ID), false)
})

test('clearCompleted deletes only completed rows', async () => {
  const a = await createTodo(client, 'a')
  await createTodo(client, 'b')
  await updateTodo(client, a.id, { completed: true })
  assert.equal(await clearCompleted(client), 1)
  assert.deepEqual((await listTodos(client)).map((r) => r.title), ['b'])
})

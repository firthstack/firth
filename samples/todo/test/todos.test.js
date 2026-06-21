import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted,
  createUser, findUserByEmail, createSession, findUserBySessionToken, deleteSession,
  ValidationError, EmailTakenError,
} from '../db.js'

const MISSING_ID = '00000000-0000-0000-0000-000000000000'
let pool, client, userA, userB

before(() => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set — run `firth secrets` first')
  pool = makePool()
})
after(async () => { await pool.end() })

// Clean slate within a rolled-back transaction; deleting users cascades to their todos + sessions.
beforeEach(async () => {
  client = await pool.connect()
  await client.query('begin')
  await client.query('delete from users')
  userA = await createUser(client, 'a@example.com', 'password-a')
  userB = await createUser(client, 'b@example.com', 'password-b')
})
afterEach(async () => { await client.query('rollback'); client.release() })

// --- users ---
test('createUser returns id + email and lowercases the email', async () => {
  const u = await createUser(client, 'Mixed@Case.COM', 'password1')
  assert.equal(u.email, 'mixed@case.com')
  assert.ok(u.id)
})

test('createUser rejects a duplicate email', async () => {
  await assert.rejects(() => createUser(client, 'a@example.com', 'password1'), EmailTakenError)
})

test('createUser rejects a bad email or short password', async () => {
  await assert.rejects(() => createUser(client, 'notanemail', 'password1'), ValidationError)
  await assert.rejects(() => createUser(client, 'c@example.com', 'short'), ValidationError)
})

test('findUserByEmail normalizes case and returns the hash', async () => {
  const u = await findUserByEmail(client, 'A@EXAMPLE.COM')
  assert.equal(u.id, userA.id)
  assert.ok(u.password_hash)
})

test('findUserByEmail returns null for an unknown email', async () => {
  assert.equal(await findUserByEmail(client, 'nobody@example.com'), null)
})

// --- sessions ---
test('createSession → findUserBySessionToken → deleteSession', async () => {
  const token = await createSession(client, userA.id)
  const u = await findUserBySessionToken(client, token)
  assert.equal(u.id, userA.id)
  await deleteSession(client, token)
  assert.equal(await findUserBySessionToken(client, token), null)
})

test('findUserBySessionToken returns null for an unknown or empty token', async () => {
  assert.equal(await findUserBySessionToken(client, 'bogus'), null)
  assert.equal(await findUserBySessionToken(client, ''), null)
})

test('findUserBySessionToken returns null for an expired session', async () => {
  const token = await createSession(client, userA.id, -1) // already expired
  assert.equal(await findUserBySessionToken(client, token), null)
})

// --- todos: ownership ---
test('createTodo inserts under the owner; listTodos returns only that owner', async () => {
  await createTodo(client, userA.id, 'a-todo')
  await createTodo(client, userB.id, 'b-todo')
  assert.deepEqual((await listTodos(client, userA.id)).map((r) => r.title), ['a-todo'])
  assert.deepEqual((await listTodos(client, userB.id)).map((r) => r.title), ['b-todo'])
})

test('createTodo trims and rejects empty / over-long titles', async () => {
  assert.equal((await createTodo(client, userA.id, '  spaced  ')).title, 'spaced')
  await assert.rejects(() => createTodo(client, userA.id, '   '), ValidationError)
  await assert.rejects(() => createTodo(client, userA.id, 'x'.repeat(501)), ValidationError)
})

test('updateTodo edits / toggles the owner\'s todo', async () => {
  const t = await createTodo(client, userA.id, 'task')
  assert.equal((await updateTodo(client, userA.id, t.id, { completed: true })).completed, true)
  assert.equal((await updateTodo(client, userA.id, t.id, { title: 'renamed' })).title, 'renamed')
})

// --- todos: isolation (the core multi-tenant requirement) ---
test('updateTodo returns null for another user\'s todo and leaves it unchanged', async () => {
  const t = await createTodo(client, userB.id, 'b-secret')
  assert.equal(await updateTodo(client, userA.id, t.id, { completed: true }), null)
  assert.equal((await listTodos(client, userB.id))[0].completed, false)
})

test('deleteTodo returns false for another user\'s todo and leaves it intact', async () => {
  const t = await createTodo(client, userB.id, 'b-secret')
  assert.equal(await deleteTodo(client, userA.id, t.id), false)
  assert.equal((await listTodos(client, userB.id)).length, 1)
})

test('updateTodo / deleteTodo return null/false for a missing id', async () => {
  assert.equal(await updateTodo(client, userA.id, MISSING_ID, { completed: true }), null)
  assert.equal(await deleteTodo(client, userA.id, MISSING_ID), false)
})

test('clearCompleted clears only the caller\'s completed todos', async () => {
  const a1 = await createTodo(client, userA.id, 'a-done')
  await updateTodo(client, userA.id, a1.id, { completed: true })
  const b1 = await createTodo(client, userB.id, 'b-done')
  await updateTodo(client, userB.id, b1.id, { completed: true })
  assert.equal(await clearCompleted(client, userA.id), 1)
  assert.equal((await listTodos(client, userB.id)).length, 1) // B untouched
})

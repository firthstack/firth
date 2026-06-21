import pg from 'pg'
import { hashPassword, verifyPassword, newSessionToken, hashToken } from './auth.js'

const COLS = 'id, title, completed, created_at, updated_at'
const SESSION_TTL_DAYS = 30

export class ValidationError extends Error {}
export class EmailTakenError extends Error {}

export function makePool(connectionString = process.env.DATABASE_URL) {
  const cs = connectionString ?? ''
  const needsSsl = /\bsslmode=require\b/.test(cs)
  // Strip sslmode so pg-connection-string doesn't emit SSL deprecation warnings; we pass ssl directly.
  // Remove the param with one adjacent separator (trailing if present, else leading) so the query stays valid.
  const cleanCs = cs
    .replace(/([?&])sslmode=[^&]*(&)?/, (_m, lead, trail) => (trail ? lead : ''))
    .replace(/[?&]$/, '')
  return new pg.Pool({
    connectionString: cleanCs,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  })
}

function cleanTitle(title) {
  if (typeof title !== 'string') throw new ValidationError('title must be a string')
  const t = title.trim()
  if (t.length < 1) throw new ValidationError('title must not be empty')
  if (t.length > 500) throw new ValidationError('title must be at most 500 characters')
  return t
}

function cleanEmail(email) {
  if (typeof email !== 'string') throw new ValidationError('email must be a string')
  const e = email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new ValidationError('invalid email')
  return e
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('password must be at least 8 characters')
  }
}

// --- users ---
export async function createUser(db, email, password) {
  const e = cleanEmail(email)
  checkPassword(password)
  const passwordHash = hashPassword(password)
  try {
    const { rows } = await db.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email',
      [e, passwordHash],
    )
    return rows[0]
  } catch (err) {
    if (err && err.code === '23505') throw new EmailTakenError('email already registered')
    throw err
  }
}

export async function findUserByEmail(db, email) {
  const e = String(email ?? '').trim().toLowerCase()
  const { rows } = await db.query(
    'select id, email, password_hash from users where email = $1',
    [e],
  )
  return rows[0] ?? null
}

// --- sessions ---
export async function createSession(db, userId, ttlDays = SESSION_TTL_DAYS) {
  const { token, tokenHash } = newSessionToken()
  await db.query(
    `insert into sessions (token_hash, user_id, expires_at)
     values ($1, $2, clock_timestamp() + make_interval(days => $3))`,
    [tokenHash, userId, ttlDays],
  )
  return token
}

export async function findUserBySessionToken(db, token) {
  if (!token) return null
  const { rows } = await db.query(
    `select u.id, u.email
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > clock_timestamp()`,
    [hashToken(token)],
  )
  return rows[0] ?? null
}

export async function deleteSession(db, token) {
  if (!token) return
  await db.query('delete from sessions where token_hash = $1', [hashToken(token)])
}

// --- todos (owner-scoped) ---
export async function listTodos(db, userId) {
  const { rows } = await db.query(
    `select ${COLS} from todos where user_id = $1 order by created_at`,
    [userId],
  )
  return rows
}

export async function createTodo(db, userId, title) {
  const t = cleanTitle(title)
  const { rows } = await db.query(
    `insert into todos (user_id, title) values ($1, $2) returning ${COLS}`,
    [userId, t],
  )
  return rows[0]
}

export async function updateTodo(db, userId, id, fields) {
  const sets = []
  const vals = []
  let i = 1
  if (fields.title !== undefined) { sets.push(`title = $${i++}`); vals.push(cleanTitle(fields.title)) }
  if (fields.completed !== undefined) {
    if (typeof fields.completed !== 'boolean') throw new ValidationError('completed must be a boolean')
    sets.push(`completed = $${i++}`); vals.push(fields.completed)
  }
  if (sets.length === 0) throw new ValidationError('no fields to update')
  sets.push('updated_at = clock_timestamp()')
  vals.push(id, userId)
  const { rows } = await db.query(
    `update todos set ${sets.join(', ')} where id = $${i} and user_id = $${i + 1} returning ${COLS}`,
    vals,
  )
  return rows[0] ?? null
}

export async function deleteTodo(db, userId, id) {
  const { rowCount } = await db.query(
    'delete from todos where id = $1 and user_id = $2',
    [id, userId],
  )
  return rowCount > 0
}

export async function clearCompleted(db, userId) {
  const { rowCount } = await db.query(
    'delete from todos where user_id = $1 and completed = true',
    [userId],
  )
  return rowCount
}

export { verifyPassword }

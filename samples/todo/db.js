import pg from 'pg'

const COLS = 'id, title, completed, created_at, updated_at'

export class ValidationError extends Error {}

export function makePool(connectionString = process.env.DATABASE_URL) {
  const cs = connectionString ?? ''
  const needsSsl = /\bsslmode=require\b/.test(cs)
  // Strip sslmode from the connection string so pg-connection-string doesn't emit SSL
  // deprecation warnings; we pass ssl directly to pg.Pool instead. Remove the param with one
  // adjacent separator (the trailing one if present, else the leading one) so the remaining
  // query string stays valid no matter where sslmode sits.
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

export async function listTodos(db) {
  const { rows } = await db.query(`select ${COLS} from todos order by created_at`)
  return rows
}

export async function createTodo(db, title) {
  const t = cleanTitle(title)
  const { rows } = await db.query(
    `insert into todos (title) values ($1) returning ${COLS}`,
    [t],
  )
  return rows[0]
}

export async function updateTodo(db, id, fields) {
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
  vals.push(id)
  const { rows } = await db.query(
    `update todos set ${sets.join(', ')} where id = $${i} returning ${COLS}`,
    vals,
  )
  return rows[0] ?? null
}

export async function deleteTodo(db, id) {
  const { rowCount } = await db.query('delete from todos where id = $1', [id])
  return rowCount > 0
}

export async function clearCompleted(db) {
  const { rowCount } = await db.query('delete from todos where completed = true')
  return rowCount
}

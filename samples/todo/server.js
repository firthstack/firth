import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import multer from 'multer'
import { makeStorage, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from './storage.js'
import {
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted, cleanTitle,
  createUser, findUserByEmail, createSession, findUserBySessionToken, deleteSession,
  verifyPassword, ValidationError, EmailTakenError,
} from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function bearerToken(req) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '')
  return m ? m[1] : null
}

export function makeApp(pool, storage = makeStorage()) {
  const app = express()
  app.use(express.json())

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } })

  // Map a db row (carrying internal image_key) to the client shape: a presigned image_url, no image_key.
  const toClient = async (row) => {
    const { image_key, ...rest } = row
    return { ...rest, image_url: image_key ? await storage.presignedGetUrl(image_key) : null }
  }

  const requireAuth = async (req, res, next) => {
    try {
      const user = await findUserBySessionToken(pool, bearerToken(req))
      if (!user) return res.status(401).json({ error: 'unauthorized' })
      req.userId = user.id
      req.user = user
      next()
    } catch (e) { next(e) }
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  // --- auth ---
  app.post('/api/auth/register', async (req, res, next) => {
    try {
      const user = await createUser(pool, req.body?.email, req.body?.password)
      const token = await createSession(pool, user.id)
      res.status(201).json({ token, user })
    } catch (e) { next(e) }
  })

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const u = await findUserByEmail(pool, req.body?.email)
      if (!u || !verifyPassword(String(req.body?.password ?? ''), u.password_hash)) {
        return res.status(401).json({ error: 'invalid email or password' })
      }
      const token = await createSession(pool, u.id)
      res.json({ token, user: { id: u.id, email: u.email } })
    } catch (e) { next(e) }
  })

  app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
    try { await deleteSession(pool, bearerToken(req)); res.status(204).end() } catch (e) { next(e) }
  })

  app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user))

  // --- todos (all owner-scoped, behind auth) ---
  app.get('/api/todos', requireAuth, async (req, res, next) => {
    try {
      const rows = await listTodos(pool, req.userId)
      res.json(await Promise.all(rows.map(toClient)))
    } catch (e) { next(e) }
  })

  app.post('/api/todos', requireAuth, upload.single('image'), async (req, res, next) => {
    try {
      const title = cleanTitle(req.body?.title) // validate before any upload → no orphan objects
      let imageKey
      if (req.file) {
        if (!ALLOWED_IMAGE_TYPES.has(req.file.mimetype)) {
          return res.status(400).json({ error: 'unsupported image type' })
        }
        const { key } = await storage.uploadImage(req.file.buffer, req.file.mimetype)
        imageKey = key
      }
      const row = await createTodo(pool, req.userId, title, imageKey)
      res.status(201).json(await toClient(row))
    } catch (e) { next(e) }
  })

  app.patch('/api/todos/:id', requireAuth, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      const row = await updateTodo(pool, req.userId, req.params.id, {
        title: req.body?.title,
        completed: req.body?.completed,
      })
      if (!row) return res.status(404).json({ error: 'not found' })
      res.json(await toClient(row))
    } catch (e) { next(e) }
  })

  app.delete('/api/todos', requireAuth, async (req, res, next) => {
    try {
      if (req.query.completed === 'true') {
        const { count, imageKeys } = await clearCompleted(pool, req.userId)
        if (imageKeys.length) {
          try { await storage.deleteImages(imageKeys) } catch (e) { console.error('image cleanup failed', e) }
        }
        return res.json({ deleted: count })
      }
      res.status(400).json({ error: 'specify ?completed=true to clear completed todos' })
    } catch (e) { next(e) }
  })

  app.delete('/api/todos/:id', requireAuth, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      const { deleted, imageKey } = await deleteTodo(pool, req.userId, req.params.id)
      if (!deleted) return res.status(404).json({ error: 'not found' })
      if (imageKey) {
        try { await storage.deleteImage(imageKey) } catch (e) { console.error('image cleanup failed', e) }
      }
      res.status(204).end()
    } catch (e) { next(e) }
  })

  app.use(express.static(path.join(__dirname, 'public')))

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message })
    if (err instanceof EmailTakenError) return res.status(409).json({ error: err.message })
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'image too large (max 5 MB)' })
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })

  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = makeApp(makePool())
  const port = Number(process.env.PORT) || 8080
  app.listen(port, () => console.log(`todo app listening on :${port}`))
}

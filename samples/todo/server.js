import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  makePool, listTodos, createTodo, updateTodo, deleteTodo, clearCompleted, ValidationError,
} from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function makeApp(pool) {
  const app = express()
  app.use(express.json())

  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  app.get('/api/todos', async (_req, res, next) => {
    try { res.json(await listTodos(pool)) } catch (e) { next(e) }
  })

  app.post('/api/todos', async (req, res, next) => {
    try { res.status(201).json(await createTodo(pool, req.body?.title)) } catch (e) { next(e) }
  })

  app.patch('/api/todos/:id', async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      const row = await updateTodo(pool, req.params.id, {
        title: req.body?.title,
        completed: req.body?.completed,
      })
      if (!row) return res.status(404).json({ error: 'not found' })
      res.json(row)
    } catch (e) { next(e) }
  })

  app.delete('/api/todos', async (req, res, next) => {
    try {
      if (req.query.completed === 'true') return res.json({ deleted: await clearCompleted(pool) })
      res.status(400).json({ error: 'specify ?completed=true to clear completed todos' })
    } catch (e) { next(e) }
  })

  app.delete('/api/todos/:id', async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      if (await deleteTodo(pool, req.params.id)) return res.status(204).end()
      res.status(404).json({ error: 'not found' })
    } catch (e) { next(e) }
  })

  app.use(express.static(path.join(__dirname, 'public')))

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message })
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

import Fastify, { type FastifyInstance } from 'fastify'
import type { FirthConfig } from './config.js'
import { resolveUid, UnauthorizedError } from './auth.js'
import type { DataClient } from './db/types.js'
import { ProjectsRepo, SecretsRepo } from './db/repos.js'
import { ProjectService } from './services/projects.js'
import { decryptSecret } from './crypto/secrets.js'

export type ServerDeps = {
  cfg: FirthConfig
  verifyToken: (token: string) => Promise<{ id: string } | null>
  dataForToken: (token: string) => DataClient
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.setErrorHandler((err, _req, reply) => {
    // Static strings only — never echo err.message/stack (they may carry tokens or secrets).
    if (err instanceof UnauthorizedError) return reply.code(401).send({ error: 'unauthorized' })
    return reply.code(500).send({ error: 'internal error' })
  })

  async function auth(req: any) {
    const { uid, token } = await resolveUid(req.headers.authorization, deps.verifyToken)
    return { uid, db: deps.dataForToken(token) }
  }

  app.post('/projects', async (req, reply) => {
    const { uid, db } = await auth(req)
    const name = (req.body as any)?.name
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const out = await new ProjectService(db).createProject(uid, name)
    return reply.code(201).send(out)
  })

  app.get('/projects', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projects = await new ProjectsRepo(db).listByOwner(uid)
    return reply.send({ projects })
  })

  app.get('/projects/:id/secrets', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const branch = (req.query as any).branch ?? null
    const rows = await new SecretsRepo(db).listForScope(uid, projectId, branch)
    const bundle: Record<string, string> = {}
    for (const row of rows) {
      bundle[row.name] = decryptSecret(
        { ciphertext: row.ciphertext, nonce: row.nonce, kekVersion: row.kek_version }, deps.cfg.keks)
    }
    return reply.send({ secrets: bundle })
  })

  return app
}

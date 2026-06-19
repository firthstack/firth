import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { FirthConfig } from './config.js'
import { resolveUid, UnauthorizedError, NotFoundError, ConflictError } from './auth.js'
import type { DataClient } from './db/types.js'
import { ProjectsRepo, SecretsRepo, BranchesRepo, ResourcesRepo, EventsRepo } from './db/repos.js'
import { decryptSecret } from './crypto/secrets.js'
import { ProvisioningService } from './services/provisioning.js'
import { BranchService } from './services/branches.js'
import { DeployService } from './services/deploy.js'
import { TeardownService } from './services/teardown.js'
import { publicResourceView } from './services/resource-view.js'
import type { ProviderAdapter } from './adapters/types.js'
import type { AuthProxy } from './insforge.js'

export type ServerDeps = {
  cfg: FirthConfig
  verifyToken: (token: string) => Promise<{ id: string } | null>
  dataForToken: (token: string) => DataClient
  adaptersForToken?: (token: string) => ProviderAdapter[]
  authProxy?: AuthProxy
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.setErrorHandler((err, _req, reply) => {
    // Static strings only — never echo err.message/stack (they may carry tokens or secrets).
    if (err instanceof UnauthorizedError) return reply.code(401).send({ error: 'unauthorized' })
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message })
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message })
    return reply.code(500).send({ error: 'internal error' })
  })

  async function auth(req: any) {
    const { uid, token } = await resolveUid(req.headers.authorization, deps.verifyToken)
    return { uid, token, db: deps.dataForToken(token) }
  }

  // best-effort: never let an event-write failure change the response
  async function emit(db: DataClient, uid: string, projectId: string, branchId: string | null, kind: string, payload: Record<string, unknown>) {
    try { await new EventsRepo(db).record({ project_id: projectId, owner: uid, branch_id: branchId, source: 'resource', kind, payload }) }
    catch { /* swallow */ }
  }

  app.register(cors, {
    origin: deps.cfg.corsOrigins ?? ['http://localhost:5173'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  })

  app.post('/projects', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const name = (req.body as any)?.name
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new ProvisioningService(db, deps.cfg, adapters).provisionProject(uid, name)
    await emit(db, uid, out.project.id, out.defaultBranch.id, 'project.create', { name, resources: out.resources?.map((r: any) => r.kind) ?? [] })
    return reply.code(201).send(out)
  })

  app.get('/projects', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projects = await new ProjectsRepo(db).listByOwner(uid)
    return reply.send({ projects })
  })

  app.get('/projects/:id', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const project = await new ProjectsRepo(db).findById(uid, projectId)
    if (!project) throw new NotFoundError('project not found')
    const branches = await new BranchesRepo(db).listByProject(uid, projectId)
    const resources = (await new ResourcesRepo(db).listByProject(uid, projectId)).map(publicResourceView)
    return reply.send({ project, branches, resources })
  })

  app.delete('/projects/:id', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new TeardownService(db, deps.cfg, adapters).deleteProject(uid, projectId)
    await emit(db, uid, projectId, null, 'project.delete', { teardown: out.teardown })
    return reply.send(out)
  })

  app.delete('/projects/:id/branches/:bid', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const branchId = (req.params as any).bid
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new TeardownService(db, deps.cfg, adapters).deleteBranch(uid, projectId, branchId)
    await emit(db, uid, projectId, branchId, 'branch.delete', { name: out.branch.name, teardown: out.teardown })
    return reply.send(out)
  })

  app.post('/projects/:id/branches', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const name = (req.body as any)?.name
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const from = (req.body as any)?.from ?? 'main'
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new BranchService(db, deps.cfg, adapters).createBranch(uid, projectId, name, from)
    await emit(db, uid, projectId, out.branch.id, 'branch.create', { name: out.branch.name, from })
    return reply.code(201).send(out)
  })

  app.get('/projects/:id/branches', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const branches = await new BranchesRepo(db).listByProject(uid, projectId)
    return reply.send({ branches })
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

  app.post('/projects/:id/deploy', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const body = (req.body as any) ?? {}
    if (!body.image) return reply.code(400).send({ error: 'image is required' })
    // `from` is an explicit branch override (id or name); otherwise the caller's
    // linked branch (`branch`), otherwise the project's default branch.
    let branch: string | undefined = body.from ?? body.branch
    if (!branch) {
      const all = await new BranchesRepo(db).listByProject(uid, projectId)
      branch = (all.find((b) => b.is_default) ?? all[0])?.id
    }
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new DeployService(db, deps.cfg, adapters).deploy(uid, projectId, {
      image: body.image, from: branch, port: body.port,
    })
    await emit(db, uid, projectId, branch ?? null, 'deploy', { machineId: out.machineId, url: out.url })
    return reply.send(out)
  })

  app.post('/projects/:id/events', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const events = ((req.body as any)?.events ?? []) as Array<any>
    if (!Array.isArray(events) || events.some((e) => e.source !== 'agent' && e.source !== 'resource')) {
      return reply.code(400).send({ error: 'each event needs source agent|resource' })
    }
    const repo = new EventsRepo(db)
    for (const e of events) {
      await repo.record({ project_id: projectId, owner: uid, branch_id: e.branch ?? null, source: e.source, kind: String(e.kind), payload: e.payload ?? {} })
    }
    return reply.code(201).send({ recorded: events.length })
  })

  app.get('/projects/:id/events', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const q = req.query as any
    const events = await new EventsRepo(db).listByProject(uid, projectId, {
      branch: q.branch, limit: q.limit ? Number(q.limit) : undefined,
    })
    return reply.send({ events })
  })

  // ---------- Auth proxy routes (unauthenticated — how you obtain a token) ----------

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = (req.body as any) ?? {}
    if (!email || !password) return reply.code(400).send({ error: 'email and password are required' })
    try { return reply.send(await deps.authProxy!.login(email, password)) }
    catch (e) { return reply.code(401).send({ error: e instanceof Error ? e.message : 'login failed' }) }
  })

  app.post('/auth/signup', async (req, reply) => {
    const { email, password, name, redirectTo } = (req.body as any) ?? {}
    if (!email || !password) return reply.code(400).send({ error: 'email and password are required' })
    try { return reply.send(await deps.authProxy!.signUp(email, password, name, redirectTo)) }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : 'sign-up failed' }) }
  })

  app.post('/auth/resend-verification', async (req, reply) => {
    const { email, redirectTo } = (req.body as any) ?? {}
    if (!email) return reply.code(400).send({ error: 'email is required' })
    try { await deps.authProxy!.resendVerification(email, redirectTo); return reply.send({ ok: true }) }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : 'resend failed' }) }
  })

  app.get('/auth/me', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return reply.code(401).send({ error: 'unauthorized' })
    const user = await deps.authProxy!.me(token)
    if (!user) return reply.code(401).send({ error: 'unauthorized' })
    return reply.send({ user })
  })

  return app
}

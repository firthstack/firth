import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import type { FirthConfig } from './config.js'
import { resolveUid, UnauthorizedError, NotFoundError, ConflictError, ForbiddenError } from './auth.js'
import type { DataClient } from './db/types.js'
import { ProjectsRepo, SecretsRepo, BranchesRepo, ResourcesRepo, EventsRepo } from './db/repos.js'
import { GovernService, isGatedAction, type GatedAction } from './services/govern.js'
import { decryptSecret, encryptSecret } from './crypto/secrets.js'
import { ProvisioningService } from './services/provisioning.js'
import { BranchService } from './services/branches.js'
import { DeployService } from './services/deploy.js'
import { TeardownService } from './services/teardown.js'
import { publicResourceView } from './services/resource-view.js'
import type { ProviderAdapter, ResourceHandle } from './adapters/types.js'
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

  // Fastify's default JSON parser rejects an empty body when Content-Type is
  // application/json. Bodyless POSTs (e.g. approvals approve/deny) legitimately send
  // that header with no body, so treat an empty body as `undefined` instead of a 400
  // (which our handler would surface as a 500). Routes needing a body still validate it.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = (body as string).trim()
    if (s === '') return done(null, undefined)
    try { done(null, JSON.parse(s)) } catch (e) { done(e as Error) }
  })

  app.setErrorHandler((err, _req, reply) => {
    // UnauthorizedError always sends the fixed string 'unauthorized'. Typed errors (NotFound/Conflict/Forbidden)
    // send err.message, which is author-controlled and never user input or secrets — never the stack. The 500
    // fallback is a generic static string.
    if (err instanceof UnauthorizedError) return reply.code(401).send({ error: 'unauthorized' })
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message })
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message })
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.message })
    // Log the real error server-side (clients still get only the generic string) so masked 500s are debuggable.
    console.error('unhandled error -> 500:', err)
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

  // Returns true if the caller should proceed; false means a 202 was already sent.
  async function gateOrReply(db: DataClient, uid: string, projectId: string, action: GatedAction, branchId: string | null, reply: FastifyReply): Promise<boolean> {
    const g = await new GovernService(db).gate(uid, projectId, action)
    if (g.decision === 'deny') throw new ForbiddenError(`${action} denied by policy`)
    if (g.decision === 'approval_required') {
      await emit(db, uid, projectId, branchId, 'govern.pending', { action, approvalId: g.approvalId })
      reply.code(202).send({ status: 'approval_required', approvalId: g.approvalId, action,
        message: `${action} requires approval — have a human run \`firth approve ${g.approvalId}\`, then retry` })
      return false
    }
    if (g.decision === 'approved') await emit(db, uid, projectId, branchId, 'govern.approved', { action, approvalId: g.approvalId })
    return true
  }

  app.register(cors, {
    origin: deps.cfg.corsOrigins ?? ['http://localhost:5173', 'https://u4vrn3sx.insforge.site', 'https://firth-dashboard.vercel.app'],
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
    // Hide destroyed resources (e.g. a deleted branch's Fly app, soft-kept as a
    // teardown tombstone) so the detail view shows only live resources.
    const resources = (await new ResourcesRepo(db).listByProject(uid, projectId))
      .filter((r) => r.status !== 'destroyed')
      .map(publicResourceView)
    return reply.send({ project, branches, resources })
  })

  // Per-environment serverless runtime state (running / suspended / stopped / none).
  // One Fly machine-list per branch app, in parallel. Powers the dashboard's live/asleep dots.
  app.get('/projects/:id/status', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const branches = await new BranchesRepo(db).listByProject(uid, projectId)
    const resources = (await new ResourcesRepo(db).listByProject(uid, projectId)).filter((r) => r.status !== 'destroyed')
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const fly = adapters.find((a) => a.kind === 'fly') as (ProviderAdapter & { appState?: (h: ResourceHandle) => Promise<string> }) | undefined
    const flyResources = resources.filter((r) => r.kind === 'fly')
    const byBranch = new Map<string, any>()
    for (const r of flyResources) byBranch.set((r.branch_id as string) ?? '__project__', r)
    const environments = await Promise.all(branches.map(async (b) => {
      const r = byBranch.get(b.id) ?? (b.is_default ? byBranch.get('__project__') : undefined)
      let state = 'none'
      if (r && fly?.appState) { try { state = await fly.appState({ kind: 'fly', providerRef: r.provider_ref }) } catch { state = 'unknown' } }
      return { branchId: b.id, name: b.name, isDefault: b.is_default, state }
    }))
    return reply.send({ environments })
  })

  // Env manifest — an agent-legible description of each environment's resources
  // (databases / storage / compute) and how they wire (public-url). Arrays so
  // "multiple compute, add a db" is native. Derived from the live resources.
  app.get('/projects/:id/manifest', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const project = await new ProjectsRepo(db).findById(uid, projectId)
    if (!project) throw new NotFoundError('project not found')
    const branches = await new BranchesRepo(db).listByProject(uid, projectId)
    const resources = (await new ResourcesRepo(db).listByProject(uid, projectId)).filter((r) => r.status !== 'destroyed')
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const fly = adapters.find((a) => a.kind === 'fly') as (ProviderAdapter & { appState?: (h: ResourceHandle) => Promise<string> }) | undefined

    const nameById = new Map(branches.map((b) => [b.id, b.name]))
    const s3 = resources.find((r) => r.kind === 's3')
    const storage = s3
      ? [{ name: 'assets', engine: 'tigris-s3', bucket: String((s3.provider_ref as any).bucket ?? (s3.provider_ref as any).bucketName ?? ''), shared: true, env: ['BUCKET_NAME', 'AWS_ENDPOINT_URL_S3', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'] }]
      : []
    const flyByBranch = new Map<string, any[]>()
    for (const r of resources) if (r.kind === 'fly') { const k = (r.branch_id as string) ?? '__project__'; flyByBranch.set(k, [...(flyByBranch.get(k) ?? []), r]) }
    const neonExtra = new Map<string, any[]>()
    for (const r of resources) if (r.kind === 'neon' && r.branch_id) neonExtra.set(r.branch_id as string, [...(neonExtra.get(r.branch_id as string) ?? []), r])

    const environments = await Promise.all(branches.map(async (b) => {
      const flyList: any[] = flyByBranch.get(b.id) ?? (b.is_default ? (flyByBranch.get('__project__') ?? []) : [])
      const databases = [
        ...(b.neon_branch_ref ? [{ name: 'primary', engine: 'neon-postgres', ref: b.neon_branch_ref, env: 'DATABASE_URL' }] : []),
        ...(neonExtra.get(b.id) ?? []).map((r) => ({ name: String((r.provider_ref as any).name ?? 'db'), engine: 'neon-postgres', ref: String((r.provider_ref as any).neonBranchRef ?? ''), env: `DATABASE_URL_${String((r.provider_ref as any).name ?? 'db').toUpperCase().replace(/[^A-Z0-9]/g, '_')}` })),
      ]
      const compute = await Promise.all(flyList.map(async (r, i) => {
        const flyApp = String((r.provider_ref as any).flyApp ?? '')
        let state = 'none'
        if (fly?.appState) { try { state = await fly.appState({ kind: 'fly', providerRef: r.provider_ref }) } catch { state = 'unknown' } }
        return { name: flyList.length > 1 ? `machine-${i + 1}` : 'app', engine: 'fly-machine', url: `https://${flyApp}.fly.dev`, state, uses: [...databases.map((d) => d.name), ...storage.map((x) => x.name)] }
      }))
      return {
        name: b.name,
        default: b.is_default,
        cloneOf: b.parent_branch_id ? (nameById.get(b.parent_branch_id) ?? null) : null,
        databases, storage, compute,
        wiring: 'public-url',
      }
    }))
    return reply.send({ project: project.name, environments })
  })

  // Add a single resource (compute machine or database) to an environment — the
  // composable "+ Add machine / + Add database" action. Provisions independently.
  app.post('/projects/:id/resources', async (req, reply) => {
    const { uid, token, db } = await auth(req)
   try {
    const projectId = (req.params as any).id
    const { kind, env: envName, name } = (req.body as any) ?? {}
    if (kind !== 'compute' && kind !== 'database') return reply.code(400).send({ error: 'kind must be compute | database' })
    const branches = await new BranchesRepo(db).listByProject(uid, projectId)
    const target = envName ? branches.find((b) => b.name === envName || b.id === envName) : (branches.find((b) => b.is_default) ?? branches[0])
    if (!target) return reply.code(404).send({ error: 'environment not found' })
    const safe = (typeof name === 'string' && /^[a-z0-9-]{1,24}$/i.test(name)) ? name.toLowerCase() : kind
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    if (kind === 'compute') {
      const fly = adapters.find((a) => a.kind === 'fly')
      if (!fly) return reply.code(400).send({ error: 'no fly adapter configured' })
      const handle = await fly.provision(`${target.name}-${safe}`)
      const res = await db.from('resources').insert({ project_id: projectId, owner: uid, kind: 'fly', branch_id: target.id, provider_ref: handle.providerRef, status: 'active' }).select()
      if (res.error) throw res.error
      return reply.send({ ok: true, kind: 'compute', name: safe, url: `https://${(handle.providerRef as { flyApp?: string }).flyApp}.fly.dev` })
    }
    const neon = adapters.find((a) => a.kind === 'neon')
    if (!neon) return reply.code(400).send({ error: 'no neon adapter configured' })
    const neonRes = await new ResourcesRepo(db).findByKind(uid, projectId, 'neon')
    if (!neonRes) return reply.code(400).send({ error: 'project has no neon resource' })
    const neonHandle: ResourceHandle = { kind: 'neon', providerRef: neonRes.provider_ref }
    const ref = await neon.createBranch(neonHandle, `${target.name}-${safe}`, target.neon_branch_ref ?? undefined)
    if (!ref) return reply.code(502).send({ error: 'neon branch create returned no id' })
    const creds = await neon.mintCredentials(neonHandle, ref)
    const envKey = `DATABASE_URL_${safe.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
    if ((creds as Record<string, string>).DATABASE_URL) {
      const e = encryptSecret((creds as Record<string, string>).DATABASE_URL, deps.cfg.keks, deps.cfg.currentKek)
      await db.from('secrets').insert({ project_id: projectId, owner: uid, branch_id: target.id, name: envKey, ciphertext: e.ciphertext, nonce: e.nonce, kek_version: e.kekVersion }).select()
    }
    const res = await db.from('resources').insert({ project_id: projectId, owner: uid, kind: 'neon', branch_id: target.id, provider_ref: { neonBranchRef: ref, name: safe }, status: 'active' }).select()
    if (res.error) throw res.error
    return reply.send({ ok: true, kind: 'database', name: safe, env: envKey })
   } catch (e) {
    // extract a real message from ANY thrown shape (Error, SDK error object, string)
    const msg = e instanceof Error ? e.message
      : (e && typeof e === 'object' && 'message' in e) ? String((e as { message: unknown }).message)
      : (typeof e === 'string' ? e : JSON.stringify(e))
    console.error('add-resource failed:', msg, e)
    return reply.code(502).send({ error: msg })
   }
  })

  app.delete('/projects/:id', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    if (!(await gateOrReply(db, uid, projectId, 'project.delete', null, reply))) return
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new TeardownService(db, deps.cfg, adapters).deleteProject(uid, projectId)
    await emit(db, uid, projectId, null, 'project.delete', { teardown: out.teardown })
    return reply.send(out)
  })

  app.delete('/projects/:id/branches/:bid', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const branchId = (req.params as any).bid
    if (!(await gateOrReply(db, uid, projectId, 'branch.delete', branchId, reply))) return
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
    if (!(await gateOrReply(db, uid, projectId, 'secrets.read', branch, reply))) return
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
    if (!(await gateOrReply(db, uid, projectId, 'deploy', branch ?? null, reply))) return
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new DeployService(db, deps.cfg, adapters).deploy(uid, projectId, {
      image: body.image, from: branch, port: body.port, machine: body.machine,
    })
    await emit(db, uid, projectId, branch ?? null, 'deploy', { machineId: out.machineId, url: out.url })
    return reply.send(out)
  })

  app.post('/projects/:id/deploy-token', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const body = (req.body as any) ?? {}
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new DeployService(db, deps.cfg, adapters).mintDeployToken(uid, projectId, { from: body.from ?? body.branch })
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
    let recorded = 0
    for (const e of events) {
      const { inserted } = await repo.record({
        project_id: projectId, owner: uid, branch_id: e.branch ?? null,
        source: e.source, kind: String(e.kind), payload: e.payload ?? {},
        dedup_key: e.dedup_key ?? null,
      })
      if (inserted) recorded++
    }
    return reply.code(201).send({ recorded, skipped: events.length - recorded })
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

  app.get('/projects/:id/approvals', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const status = (req.query as any).status
    const approvals = await new GovernService(db).listApprovals(uid, projectId, status)
    return reply.send({ approvals })
  })

  app.post('/projects/:id/approvals/:aid/approve', async (req, reply) => {
    const { uid, db } = await auth(req)
    const approval = await new GovernService(db).decide(uid, (req.params as any).id, (req.params as any).aid, 'granted')
    return reply.send({ approval })
  })

  app.post('/projects/:id/approvals/:aid/deny', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const approval = await new GovernService(db).decide(uid, projectId, (req.params as any).aid, 'denied')
    await emit(db, uid, projectId, null, 'govern.denied', { action: approval.action, approvalId: approval.id })
    return reply.send({ approval })
  })

  app.get('/projects/:id/policy', async (req, reply) => {
    const { uid, db } = await auth(req)
    const policy = await new GovernService(db).effectivePolicy(uid, (req.params as any).id)
    return reply.send({ policy })
  })

  app.put('/projects/:id/policy/:action', async (req, reply) => {
    const { uid, db } = await auth(req)
    const projectId = (req.params as any).id
    const action = (req.params as any).action
    const { decision } = (req.body as any) ?? {}
    if (!isGatedAction(action)) return reply.code(400).send({ error: 'unknown action' })
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'approve') return reply.code(400).send({ error: 'decision must be allow|deny|approve' })
    const svc = new GovernService(db)
    await svc.setRule(uid, projectId, action, decision)
    return reply.send({ policy: await svc.effectivePolicy(uid, projectId) })
  })

  // ---------- Auth proxy routes (unauthenticated — how you obtain a token) ----------

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = (req.body as any) ?? {}
    if (!email || !password) return reply.code(400).send({ error: 'email and password are required' })
    try { return reply.send(await deps.authProxy!.login(email, password)) }
    catch (e) { return reply.code(401).send({ error: e instanceof Error ? e.message : 'login failed' }) }
  })

  app.post('/auth/refresh', async (req, reply) => {
    const { refreshToken } = (req.body as any) ?? {}
    if (!refreshToken) return reply.code(400).send({ error: 'refreshToken is required' })
    try { return reply.send(await deps.authProxy!.refresh(refreshToken)) }
    catch { return reply.code(401).send({ error: 'invalid refresh token' }) }
  })

  app.post('/auth/oauth/start', async (req, reply) => {
    const { provider, redirectTo } = (req.body as any) ?? {}
    if (!provider || !redirectTo) return reply.code(400).send({ error: 'provider and redirectTo are required' })
    try { return reply.send(await deps.authProxy!.oauthStart(provider, redirectTo)) }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : 'oauth start failed' }) }
  })

  app.post('/auth/oauth/exchange', async (req, reply) => {
    const { code, codeVerifier } = (req.body as any) ?? {}
    if (!code) return reply.code(400).send({ error: 'code is required' })
    try { return reply.send(await deps.authProxy!.oauthExchange(code, codeVerifier)) }
    catch (e) { return reply.code(401).send({ error: e instanceof Error ? e.message : 'oauth exchange failed' }) }
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

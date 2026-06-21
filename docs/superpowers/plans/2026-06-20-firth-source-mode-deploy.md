# Source-Mode Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `firth deploy <dir>` builds the `Dockerfile` in `<dir>` on Fly's remote builder (no local Docker) and runs it on the branch's compute, authorized by a short-lived, app-scoped Fly deploy token the control plane mints — reusing the existing `/deploy` to launch the built image with branch secrets.

**Architecture:** CLI-side build (Approach A, modeled on the InsForge CLI). New `POST /projects/:id/deploy-token` mints an app-scoped (~20-min, `else:deny`) Fly token via `FlyAdapter.mintDeployToken` (GraphQL `createLimitedAccessToken`). The CLI runs `flyctl deploy --remote-only --build-only --push`, parses the digest-pinned image ref, then calls the unchanged `POST /deploy` with that ref.

**Tech Stack:** TypeScript/Node (control-plane Fastify + vitest; CLI + vitest), Fly GraphQL + Machines API via the injectable `HttpClient`, `flyctl` on the user's PATH.

## Global Constraints

- The minted token is **app-scoped + ~20-min (`expirySeconds: 1200`) + `else:deny`**. The org `FLY_API_TOKEN` never leaves the control plane. The minted token and org token are never logged.
- The user's source never transits the control plane — it streams from the CLI straight to Fly's remote builder.
- Source mode reuses the existing `POST /projects/:id/deploy` to launch; the launch + secret-injection path is unchanged.
- No local Docker (Fly remote builder only). No rollback on build failure (the branch's Fly app pre-exists from branch-create).
- The exact Fly `CreateLimitedAccessTokenInput` shape is **[VERIFY-LIVE]** — offline tests assert behavior (mutation name, app-scoping, returned token), not the unverified input fields; Task 5's gated live checkpoint verifies the real shape.
- `firth deploy --image <url>` (image mode) keeps working unchanged. `<dir>` + `--image` → error; neither → error.
- TDD: failing test → confirm fail → implement → pass → commit. Stage only the files each task names (never `git add -A`).

---

### Task 1: `FlyAdapter.mintDeployToken` + `ComputeAdapter` interface

**Files:**
- Modify: `control-plane/src/adapters/types.ts` (`ComputeAdapter`)
- Modify: `control-plane/src/adapters/fly.ts` (add `mintDeployToken`)
- Test: `control-plane/test/adapters/fly.test.ts`

**Interfaces:**
- Consumes: the existing private `graphql(query, variables)` method on `FlyAdapter`, the `FlyRef` type (`{ flyApp, orgSlug }`), `ResourceHandle`.
- Produces: `FlyAdapter.mintDeployToken(handle: ResourceHandle, opts: { expirySeconds: number }): Promise<{ token: string; expirySeconds: number }>` on the `ComputeAdapter` interface.

- [ ] **Step 1: Extend the `ComputeAdapter` interface**

In `control-plane/src/adapters/types.ts`, add `mintDeployToken` to `ComputeAdapter`:

```ts
export interface ComputeAdapter extends ProviderAdapter {
  deploy(handle: ResourceHandle, opts: DeployOpts): Promise<DeployResult>
  mintDeployToken(handle: ResourceHandle, opts: { expirySeconds: number }): Promise<{ token: string; expirySeconds: number }>
}
```

- [ ] **Step 2: Write the failing tests**

Append to `control-plane/test/adapters/fly.test.ts`:

```ts
test('mintDeployToken requests an app-scoped deploy token via GraphQL and returns it', async () => {
  let captured: any
  const http: HttpClient = async (url, init) => {
    captured = { url, body: JSON.parse(init.body as string) }
    return { status: 200, json: async () => ({ data: { createLimitedAccessToken: { token: 'FlyV1 deploy-abc' } } }), text: async () => '' }
  }
  const fly = new FlyAdapter('org-token', 'my-org', http)
  const out = await fly.mintDeployToken({ kind: 'fly', providerRef: { flyApp: 'firth-x-ab12', orgSlug: 'my-org' } }, { expirySeconds: 1200 })
  expect(out).toEqual({ token: 'FlyV1 deploy-abc', expirySeconds: 1200 })
  expect(captured.url).toMatch(/graphql/)
  expect(captured.body.query).toMatch(/createLimitedAccessToken/)
  // app-scoped + deploy profile (exact input fields are [VERIFY-LIVE], so assert on the variables blob loosely)
  const vars = JSON.stringify(captured.body.variables)
  expect(vars).toMatch(/firth-x-ab12/)
  expect(vars).toMatch(/deploy/)
})

test('mintDeployToken throws when Fly returns no token', async () => {
  const http: HttpClient = async () => ({ status: 200, json: async () => ({ data: { createLimitedAccessToken: {} } }), text: async () => '' })
  const fly = new FlyAdapter('t', 'o', http)
  await expect(
    fly.mintDeployToken({ kind: 'fly', providerRef: { flyApp: 'a', orgSlug: 'o' } }, { expirySeconds: 600 }),
  ).rejects.toThrow()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd control-plane && npx vitest run test/adapters/fly.test.ts`
Expected: FAIL — `mintDeployToken` is not a function.

- [ ] **Step 4: Implement `mintDeployToken`**

In `control-plane/src/adapters/fly.ts`, add the method to the `FlyAdapter` class (next to `deploy`):

```ts
  async mintDeployToken(handle: ResourceHandle, opts: { expirySeconds: number }): Promise<{ token: string; expirySeconds: number }> {
    const ref = handle.providerRef as FlyRef
    const minutes = Math.max(1, Math.round(opts.expirySeconds / 60))
    // [VERIFY-LIVE] CreateLimitedAccessTokenInput shape (profile name, profileParams.app_id form,
    // whether organizationId is required when app-scoped). Pinned live in scripts/live-deploy-token-check.ts.
    const data = await this.graphql(
      'mutation($input: CreateLimitedAccessTokenInput!) { createLimitedAccessToken(input: $input) { token } }',
      { input: {
        name: `firth-deploy-${ref.flyApp}`,
        organizationId: this.orgSlug,
        profile: 'deploy',
        profileParams: { app_id: ref.flyApp },
        expiry: `${minutes}m`,
      } },
    )
    const token = data?.createLimitedAccessToken?.token
    if (!token) throw new Error('fly did not return a deploy token')
    return { token, expirySeconds: opts.expirySeconds }
  }
```

(`this.orgSlug` is already a constructor field; `this.graphql` already exists.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd control-plane && npx vitest run test/adapters/fly.test.ts`
Expected: PASS.

- [ ] **Step 6: Build + commit**

```bash
cd control-plane && npm run build
cd /Users/junwen/Work/Personal/firth
git add control-plane/src/adapters/types.ts control-plane/src/adapters/fly.ts control-plane/test/adapters/fly.test.ts
git commit -m "feat: FlyAdapter.mintDeployToken (app-scoped deploy token)"
```

---

### Task 2: `DeployService.mintDeployToken` + `POST /deploy-token` route + API client

**Files:**
- Modify: `control-plane/src/services/deploy.ts` (add `mintDeployToken`)
- Modify: `control-plane/src/server.ts` (add the route, after the `/deploy` route ~line 145)
- Modify: `cli/src/api.ts` (add `FirthApi.mintDeployToken`)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `FlyAdapter.mintDeployToken` (Task 1); `BranchesRepo.listByProject`, `ResourcesRepo.findByKindForBranch`; `NotFoundError` from `../auth.js`; `deps.adaptersForToken(token)`.
- Produces:
  - `DeployService.mintDeployToken(owner: string, projectId: string, opts: { from?: string }): Promise<{ token: string; expirySeconds: number; flyApp: string }>`.
  - `POST /projects/:id/deploy-token` → `{ token, expirySeconds, flyApp }`.
  - `FirthApi.mintDeployToken(projectId: string, opts: { from?: string; branch?: string }): Promise<{ token: string; expirySeconds: number; flyApp: string }>`.

- [ ] **Step 1: Write the failing route tests**

Append to `control-plane/test/server.test.ts` (mirrors the existing deploy-test fake-fly shape; add `mintDeployToken` to the fake):

```ts
test('POST /projects/:id/deploy-token mints an app-scoped token for the branch fly app', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  db.tables.resources.push({ id: 'r-main', owner: 'uid-1', project_id: 'p1', kind: 'fly', branch_id: 'b-main', provider_ref: { flyApp: 'a-main', orgSlug: 'org' }, status: 'active' })
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy() { return { machineId: 'm', url: 'u' } },
    async mintDeployToken(h: any) { return { token: `FlyV1-for-${h.providerRef.flyApp}`, expirySeconds: 1200 } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy-token', headers: { authorization: 'Bearer good' }, payload: {} })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ token: 'FlyV1-for-a-main', expirySeconds: 1200, flyApp: 'a-main' })
})

test('POST /projects/:id/deploy-token 404 when the branch has no fly resource', async () => {
  const db = fakeData()
  db.tables.branches.push({ id: 'b-main', owner: 'uid-1', project_id: 'p1', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' })
  const fly = {
    kind: 'fly', branchModel: 'redeploy',
    async provision() { return { kind: 'fly', providerRef: {} } }, async destroy() {},
    async createBranch() { return null }, async deleteBranch() {}, async mintCredentials() { return {} }, async readUsage() { return {} },
    async deploy() { return { machineId: 'm', url: 'u' } },
    async mintDeployToken() { return { token: 'x', expirySeconds: 1200 } },
  }
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any, adaptersForToken: () => [fly as any] })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy-token', headers: { authorization: 'Bearer good' }, payload: {} })
  expect(r.statusCode).toBe(404)
})

test('POST /projects/:id/deploy-token requires auth', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => db as any })
  const r = await app.inject({ method: 'POST', url: '/projects/p1/deploy-token', payload: {} })
  expect(r.statusCode).toBe(401)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: FAIL — the route 404s as "not found" (route doesn't exist) rather than minting / returning the expected shapes.

- [ ] **Step 3: Implement `DeployService.mintDeployToken`**

In `control-plane/src/services/deploy.ts`, add the `NotFoundError` import and the method:

```ts
import { NotFoundError } from '../auth.js'
```

```ts
  async mintDeployToken(owner: string, projectId: string, opts: { from?: string }): Promise<{ token: string; expirySeconds: number; flyApp: string }> {
    const fly = this.adapters.find((a) => a.kind === 'fly') as ComputeAdapter | undefined
    if (!fly || typeof fly.mintDeployToken !== 'function') throw new Error('fly adapter not configured')

    const all = await new BranchesRepo(this.db).listByProject(owner, projectId)
    const target = opts.from
      ? all.find((b) => b.name === opts.from || b.id === opts.from)
      : (all.find((b) => b.is_default) ?? all[0])
    if (!target) throw new NotFoundError(`branch "${opts.from ?? '(default)'}" not found`)

    const resource = await new ResourcesRepo(this.db).findByKindForBranch(owner, projectId, target.id, 'fly')
    if (!resource) throw new NotFoundError('branch has no fly resource')

    const { token, expirySeconds } = await fly.mintDeployToken({ kind: 'fly', providerRef: resource.provider_ref }, { expirySeconds: 1200 })
    return { token, expirySeconds, flyApp: String(resource.provider_ref.flyApp) }
  }
```

- [ ] **Step 4: Implement the route**

In `control-plane/src/server.ts`, add immediately after the `POST /projects/:id/deploy` route:

```ts
  app.post('/projects/:id/deploy-token', async (req, reply) => {
    const { uid, token, db } = await auth(req)
    const projectId = (req.params as any).id
    const body = (req.body as any) ?? {}
    const adapters = deps.adaptersForToken ? deps.adaptersForToken(token) : []
    const out = await new DeployService(db, deps.cfg, adapters).mintDeployToken(uid, projectId, { from: body.from ?? body.branch })
    return reply.send(out)
  })
```

(`NotFoundError` thrown by the service → `404` via the existing `setErrorHandler`; `DeployService` is already imported in `server.ts`.)

- [ ] **Step 5: Add the API client method**

In `cli/src/api.ts`, add to `FirthApi` (next to `deploy`):

```ts
  mintDeployToken(projectId: string, opts: { from?: string; branch?: string }): Promise<{ token: string; expirySeconds: number; flyApp: string }> {
    return this.req('POST', `/projects/${projectId}/deploy-token`, opts)
  }
```

- [ ] **Step 6: Run both suites + build**

Run: `cd control-plane && npm test && npm run build`
Expected: PASS — the three new route tests plus all prior.
Run: `cd cli && npm run build`
Expected: clean (the api method compiles).

- [ ] **Step 7: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add control-plane/src/services/deploy.ts control-plane/src/server.ts control-plane/test/server.test.ts cli/src/api.ts
git commit -m "feat: POST /deploy-token mints an app-scoped deploy token for the branch"
```

---

### Task 3: CLI `flyctl-build.ts` — remote build + digest parse

**Files:**
- Create: `cli/src/flyctl-build.ts`
- Test: `cli/test/flyctl-build.test.ts`

**Interfaces:**
- Consumes: nothing (own `node:child_process`/`node:fs`).
- Produces:
  - `type BuildRunner = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; output: string }>`
  - `defaultBuildRunner: BuildRunner`
  - `parseImageDigest(output: string, flyApp: string): string | null`
  - `flyctlBuildAndPush(opts: { dir: string; flyApp: string; imageLabel: string; token: string; port: number }, run?: BuildRunner): Promise<{ imageRef: string }>`

- [ ] **Step 1: Write the failing tests**

Create `cli/test/flyctl-build.test.ts`:

```ts
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseImageDigest, flyctlBuildAndPush, type BuildRunner } from '../src/flyctl-build.js'

const MANIFEST = 'pushing manifest for registry.fly.io/firth-x-ab12:cli-123@sha256:abc123def456 0.1s done'

test('parseImageDigest extracts the digest-pinned ref', () => {
  expect(parseImageDigest(MANIFEST, 'firth-x-ab12')).toBe('registry.fly.io/firth-x-ab12@sha256:abc123def456')
})

test('parseImageDigest returns null when no manifest line is present', () => {
  expect(parseImageDigest('built and done, no manifest', 'firth-x-ab12')).toBeNull()
})

test('flyctlBuildAndPush writes a stub fly.toml, runs flyctl with the token, returns the digest, and cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  let seen: any
  const run: BuildRunner = async (cmd, args, opts) => {
    seen = { cmd, args, opts, hadFlyToml: existsSync(join(dir, 'fly.toml')) }
    return { code: 0, output: MANIFEST }
  }
  const { imageRef } = await flyctlBuildAndPush({ dir, flyApp: 'firth-x-ab12', imageLabel: 'cli-123', token: 'FlyV1 tok', port: 8080 }, run)
  expect(imageRef).toBe('registry.fly.io/firth-x-ab12@sha256:abc123def456')
  expect(seen.cmd).toBe('flyctl')
  expect(seen.args).toEqual(['deploy', '--remote-only', '--build-only', '--push', '--app', 'firth-x-ab12', '--image-label', 'cli-123', '--no-cache'])
  expect(seen.opts.env.FLY_API_TOKEN).toBe('FlyV1 tok')
  expect(seen.opts.cwd).toBe(dir)
  expect(seen.hadFlyToml).toBe(true)              // stub present during the build
  expect(existsSync(join(dir, 'fly.toml'))).toBe(false) // removed after
})

test('flyctlBuildAndPush leaves a user-provided fly.toml untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  writeFileSync(join(dir, 'fly.toml'), 'app = "mine"\n')
  const run: BuildRunner = async () => ({ code: 0, output: MANIFEST })
  await flyctlBuildAndPush({ dir, flyApp: 'firth-x-ab12', imageLabel: 'cli-123', token: 't', port: 8080 }, run)
  expect(readFileSync(join(dir, 'fly.toml'), 'utf8')).toBe('app = "mine"\n') // not overwritten, not deleted
})

test('flyctlBuildAndPush throws on non-zero exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const run: BuildRunner = async () => ({ code: 1, output: 'boom' })
  await expect(flyctlBuildAndPush({ dir, flyApp: 'a', imageLabel: 'l', token: 't', port: 8080 }, run)).rejects.toThrow(/exit 1/)
  expect(existsSync(join(dir, 'fly.toml'))).toBe(false) // stub cleaned up even on failure
})

test('flyctlBuildAndPush throws when the manifest digest line is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const run: BuildRunner = async () => ({ code: 0, output: 'built, but no manifest line' })
  await expect(flyctlBuildAndPush({ dir, flyApp: 'a', imageLabel: 'l', token: 't', port: 8080 }, run)).rejects.toThrow(/manifest/i)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cli && npx vitest run test/flyctl-build.test.ts`
Expected: FAIL — `Cannot find module '../src/flyctl-build.js'`.

- [ ] **Step 3: Implement the module**

Create `cli/src/flyctl-build.ts`:

```ts
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type BuildRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ code: number; output: string }>

// Spawn flyctl, tee its output to the user (so they see buildkit progress) AND capture it.
export const defaultBuildRunner: BuildRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['inherit', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (b) => { const s = b.toString(); output += s; process.stdout.write(s) })
    child.stderr?.on('data', (b) => { const s = b.toString(); output += s; process.stderr.write(s) })
    child.on('error', () => resolve({ code: -1, output }))
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })

// buildkit prints "pushing manifest for registry.fly.io/<app>:<label>@sha256:<digest>" on push.
// Pin to the digest — the bare tag races on Fly's registry (MANIFEST_UNKNOWN); the digest always resolves.
export function parseImageDigest(output: string, flyApp: string): string | null {
  const m = output.match(/pushing manifest for registry\.fly\.io\/[^\s]+@(sha256:[0-9a-f]+)/)
  return m ? `registry.fly.io/${flyApp}@${m[1]}` : null
}

// Write a minimal stub fly.toml iff the dir has none (flyctl needs app config; a fresh app has no
// machines to derive it from). Region is build-config only — `--build-only` places no machines.
// Returns a cleanup callback the caller MUST run in finally; leaves a user's own fly.toml alone.
function ensureFlyTomlStub(dir: string, flyApp: string, port: number): () => void {
  const path = join(dir, 'fly.toml')
  if (existsSync(path)) return () => { /* user owns it */ }
  const stub =
    `# Auto-generated by firth for source deploy. Safe to delete.\n` +
    `app = "${flyApp}"\n` +
    `primary_region = "iad"\n\n` +
    `[build]\n\n` +
    `[http_service]\n` +
    `  internal_port = ${port}\n` +
    `  force_https = true\n`
  writeFileSync(path, stub, 'utf8')
  return () => { try { unlinkSync(path) } catch { /* best-effort */ } }
}

export async function flyctlBuildAndPush(
  opts: { dir: string; flyApp: string; imageLabel: string; token: string; port: number },
  run: BuildRunner = defaultBuildRunner,
): Promise<{ imageRef: string }> {
  const cleanup = ensureFlyTomlStub(opts.dir, opts.flyApp, opts.port)
  try {
    const { code, output } = await run(
      'flyctl',
      ['deploy', '--remote-only', '--build-only', '--push', '--app', opts.flyApp, '--image-label', opts.imageLabel, '--no-cache'],
      { cwd: opts.dir, env: { ...process.env, FLY_API_TOKEN: opts.token } as Record<string, string> },
    )
    if (code !== 0) throw new Error(`flyctl deploy --build-only failed (exit ${code}). See output above.`)
    const imageRef = parseImageDigest(output, opts.flyApp)
    if (!imageRef) throw new Error('flyctl build succeeded but no "pushing manifest" digest line was found — cannot determine the image. Re-run with FLY_LOG_LEVEL=debug.')
    return { imageRef }
  } finally {
    cleanup()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd cli && npx vitest run test/flyctl-build.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add cli/src/flyctl-build.ts cli/test/flyctl-build.test.ts
git commit -m "feat: cli flyctl remote build + digest parse (source-deploy helper)"
```

---

### Task 4: `firth deploy <dir>` — source mode wiring

**Files:**
- Modify: `cli/src/commands/deploy.ts`
- Modify: `cli/src/index.ts` (help text + wire `buildRunner` in `main()`)
- Test: `cli/test/deploy.test.ts`

**Interfaces:**
- Consumes: `FirthApi.mintDeployToken` + `FirthApi.deploy` (Tasks 2); `flyctlBuildAndPush` + `BuildRunner` + `defaultBuildRunner` (Task 3); `ensureFlyctl` (`cli/src/fly.ts`); `readProjectLink`, `apiFromDeps`.
- Produces: `firth deploy [dir] [--image <url>] [--from <branch>] [--port <n>]` with two modes.

- [ ] **Step 1: Write the failing tests**

Add to `cli/test/deploy.test.ts` (the file already has a `deps(dir, api)` helper and image-mode tests — keep those):

```ts
import { writeFileSync as writeFile } from 'node:fs'
import type { BuildRunner } from '../src/flyctl-build.js'

const MANIFEST = 'pushing manifest for registry.fly.io/a-main:cli-1@sha256:deadbeef 0.1s done'

test('source mode: mints a token, builds via flyctl, then deploys the digest image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  setCurrentBranch({ id: 'b-main', name: 'main' }, dir)
  writeFile(join(dir, 'Dockerfile'), 'FROM nginx\n')
  const calls: any[] = []
  const api = {
    mintDeployToken: async (pid: string, opts: any) => { calls.push({ mint: { pid, opts } }); return { token: 'FlyV1 tok', expirySeconds: 1200, flyApp: 'a-main' } },
    deploy: async (pid: string, opts: any) => { calls.push({ deploy: { pid, opts } }); return { machineId: 'm-9', url: 'https://a-main.fly.dev' } },
  }
  let built: any
  const buildRunner: BuildRunner = async (cmd, args, o) => { built = { cmd, args, env: o.env }; return { code: 0, output: MANIFEST } }
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => api, buildRunner }
  expect(await deploy(['.'], d as any)).toBe(0)
  // minted for the current branch
  expect(calls[0].mint.opts).toEqual({ from: undefined, branch: 'b-main' })
  // flyctl invoked with the minted token
  expect(built.cmd).toBe('flyctl')
  expect(built.env.FLY_API_TOKEN).toBe('FlyV1 tok')
  // launched with the digest-pinned image
  expect(calls[1].deploy.opts).toMatchObject({ image: 'registry.fly.io/a-main@sha256:deadbeef', from: undefined, branch: 'b-main', port: 8080 })
  expect(out.join('\n')).toMatch(/a-main\.fly\.dev/)
})

test('source mode: no Dockerfile → error, exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => ({}) }
  expect(await deploy(['.'], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/Dockerfile/)
})

test('error when both <dir> and --image are given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => ({}) }
  expect(await deploy(['.', '--image', 'nginx'], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/one mode|both/i)
})

test('error when neither <dir> nor --image is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-')); writeProjectLink('p1', dir)
  const out: string[] = []
  const d = { print: (s: string) => out.push(s), home: dir, cwd: dir, env: {}, makeApi: () => ({}) }
  expect(await deploy([], d as any)).toBe(1)
  expect(out.join('\n')).toMatch(/usage|provide/i)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cli && npx vitest run test/deploy.test.ts`
Expected: FAIL — the current command rejects positionals / has no source mode.

- [ ] **Step 3: Implement the command**

Replace `cli/src/commands/deploy.ts` with:

```ts
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { ensureFlyctl } from '../fly.js'
import { flyctlBuildAndPush, defaultBuildRunner, type BuildRunner } from '../flyctl-build.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function deploy(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi; buildRunner?: BuildRunner }): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    image: { type: 'string' }, from: { type: 'string' }, port: { type: 'string' },
  }, allowPositionals: true })
  const dir = positionals[0]

  if (dir && values.image) { deps.print('pick one mode: a source <dir> OR --image <url>, not both'); return 1 }
  if (!dir && !values.image) { deps.print('usage: firth deploy <dir> | --image <url>  [--from <branch>] [--port <n>]'); return 1 }

  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const from = values.from
  const branch = link.branch?.id ?? link.branch?.name

  // ─── Image mode (unchanged) ───────────────────────────────────────────
  if (!dir) {
    const out = await apiFromDeps(deps).deploy(link.projectId, {
      image: values.image!, from, branch, port: values.port ? Number(values.port) : undefined,
    })
    deps.print(`deployed machine ${out.machineId} → ${out.url}`)
    return 0
  }

  // ─── Source mode ──────────────────────────────────────────────────────
  const absDir = resolve(deps.cwd, dir)
  if (!existsSync(join(absDir, 'Dockerfile'))) {
    deps.print(`no Dockerfile at ${join(absDir, 'Dockerfile')} — create one, or use --image <url>`)
    return 1
  }
  await ensureFlyctl(deps)
  const port = values.port ? Number(values.port) : 8080
  const api = apiFromDeps(deps)
  const { token, flyApp } = await api.mintDeployToken(link.projectId, { from, branch })
  const { imageRef } = await flyctlBuildAndPush(
    { dir: absDir, flyApp, imageLabel: `cli-${Date.now()}`, token, port },
    deps.buildRunner ?? defaultBuildRunner,
  )
  const out = await api.deploy(link.projectId, { image: imageRef, from, branch, port })
  deps.print(`deployed machine ${out.machineId} → ${out.url}`)
  deps.print(`image: ${imageRef} (built remotely)`)
  return 0
}
```

- [ ] **Step 4: Update help text + wire the build runner**

In `cli/src/index.ts`, update the deploy usage line (~line 44):

```
  deploy <dir>|--image <url> Deploy from a source dir (Dockerfile) or a pre-built image (--from, --port)
```

Add `buildRunner?` to the `CliDeps` type (mirroring the existing `run?: Runner`), so the `main()` literal type-checks and `deploy` receives it through `route()`:

```ts
import { defaultBuildRunner, type BuildRunner } from './flyctl-build.js'
```

In the `CliDeps` type (alongside `run?: Runner`):

```ts
  buildRunner?: BuildRunner
```

And in the `main()` deps literal, alongside `run: defaultRunner,`:

```ts
    buildRunner: defaultBuildRunner,
```

- [ ] **Step 5: Run the full CLI suite + build**

Run: `cd cli && npm test && npm run build`
Expected: PASS — new source-mode tests + the existing image-mode tests stay green. Build clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add cli/src/commands/deploy.ts cli/src/index.ts cli/test/deploy.test.ts
git commit -m "feat: firth deploy <dir> source mode (token -> remote build -> deploy)"
```

---

### Task 5: Gated live checkpoint — real deploy-token mint

**Files:**
- Create: `control-plane/scripts/live-deploy-token-check.ts`

**Interfaces:**
- Consumes: `FlyAdapter` (Task 1), `fetchHttp` from `../src/adapters/factory.js`.

- [ ] **Step 1: Write the checkpoint script**

Create `control-plane/scripts/live-deploy-token-check.ts` (mirrors `scripts/live-fly-check.ts` — SKIPs without creds; provisions a throwaway app, mints a token against it, asserts shape, destroys):

```ts
import { FlyAdapter } from '../src/adapters/fly.js'
import { fetchHttp } from '../src/adapters/factory.js'

async function main() {
  const token = process.env.FLY_API_TOKEN
  const orgSlug = process.env.FLY_ORG_SLUG
  if (!token || !orgSlug) {
    console.log('SKIP: FLY_API_TOKEN or FLY_ORG_SLUG not set — live deploy-token checkpoint skipped.')
    return
  }
  const adapter = new FlyAdapter(token, orgSlug, fetchHttp)
  const name = `firth-live-tok-${process.env.LIVE_TAG ?? 'manual'}`
  console.log(`provisioning Fly app "${name}" ...`)
  const handle = await adapter.provision(name)
  try {
    const { token: deployTok, expirySeconds } = await adapter.mintDeployToken(handle, { expirySeconds: 1200 })
    if (!deployTok.startsWith('FlyV1')) throw new Error(`unexpected token prefix: ${deployTok.slice(0, 8)}…`)
    console.log(`minted app-scoped deploy token (len ${deployTok.length}, expiry ${expirySeconds}s) ✓`)
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed app (cleanup) ✓')
  }
}

main().catch((e) => { console.error('live deploy-token check failed:', e.message); process.exit(1) })
```

- [ ] **Step 2: Verify it SKIPs cleanly without creds (offline)**

Run: `cd control-plane && npx tsx scripts/live-deploy-token-check.ts`
Expected: prints `SKIP: …`, exits 0. (If `FLY_API_TOKEN`/`FLY_ORG_SLUG` are set, it runs live and verifies the **[VERIFY-LIVE]** mutation shape; if the GraphQL input is wrong, this is where it surfaces — adjust `FlyAdapter.mintDeployToken`'s input until the mint returns a `FlyV1 …` token.)

- [ ] **Step 3: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add control-plane/scripts/live-deploy-token-check.ts
git commit -m "test: gated live checkpoint for the deploy-token mint"
```

---

## Notes for the executor

- The `--image` (image-mode) path must stay byte-for-byte behaviorally unchanged — the existing `cli/test/deploy.test.ts` image-mode tests are the regression guard.
- `ensureFlyctl(deps)` is a no-op in tests (they omit `deps.run`), so source-mode tests never spawn `brew`/`flyctl`; the build is driven entirely by the injected `buildRunner`.
- Branch targeting: the CLI passes the **same** `{ from, branch }` to `mintDeployToken` and `deploy`, and the route resolves `from ?? branch ?? default` exactly as `DeployService.deploy` does — so the token and the launch hit the same app.
- The minted Fly token's exact GraphQL input is the only **[VERIFY-LIVE]** piece; the offline adapter test asserts behavior (mutation name + app-scoping + returned token), and Task 5 confirms the real shape. If Task 5 reveals a different input (e.g. `organizationId` must be the org node id, or `app_id` must be numeric), fix only `FlyAdapter.mintDeployToken` — no other task depends on the input shape.

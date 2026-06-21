# Token Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the InsForge refresh token at login and silently refresh the 15-minute access token (refresh token lasts 7 days, rotated per use) so neither the `firth` CLI nor the web dashboard forces a re-login when the access token expires.

**Architecture:** The control plane is the only thing that talks to InsForge. Its anon SDK client runs in **server mode** (`isServerMode: true`) so `signInWithPassword` returns the refresh token and `refreshSession({ refreshToken })` works. `/auth/login` returns `{ token, refreshToken, user }`; a new `/auth/refresh` rotates the pair. Both clients store both tokens and, on a 401, refresh once and retry.

**Tech Stack:** TypeScript/Node (control-plane Fastify + vitest), `@insforge/sdk`, the `firth` CLI (vitest), the React dashboard (vitest + jsdom).

## Global Constraints

- Refresh token is **rotated** on every refresh — clients MUST persist the new pair before reuse. Access token TTL 15 min; refresh token TTL 7 days.
- `/auth/refresh` is **public** (not behind bearer/`auth(req)`): it is authorized by the refresh token in the body, because the access token is expired.
- Refresh is attempted **at most once per request** (no recursion, no loops). The `/auth/refresh` call is made directly, not through the retrying request wrapper.
- Dashboard refresh is **single-flight**: concurrent 401s share one in-flight refresh (rotation makes parallel refreshes invalidate each other).
- Control-plane error strings stay static (`invalid refresh token`); access/refresh tokens are never logged.
- TDD: failing test → confirm fail → implement → pass → commit. Stage only the files each task names (never `git add -A`; there may be an unrelated working-tree change — don't touch it).

---

### Task 1: Control plane — server-mode login + `/auth/refresh`

**Files:**
- Modify: `control-plane/src/insforge.ts` (`AuthProxy` type + `authProxy` factory)
- Modify: `control-plane/src/server.ts` (`/auth/refresh` route)
- Test: `control-plane/test/insforge.test.ts` (authProxy login/refresh via injected client) + `control-plane/test/server.test.ts` (routes)

**Interfaces:**
- Consumes: `@insforge/sdk` `createClient` (`{ baseUrl, anonKey, isServerMode }` → `{ auth: { signInWithPassword, refreshSession, signUp, resendVerificationEmail, getCurrentUser } }`).
- Produces:
  - `AuthProxy.login(email, password): Promise<{ token: string; refreshToken: string; user: { id; email } }>` (adds `refreshToken`).
  - `AuthProxy.refresh(refreshToken: string): Promise<{ token: string; refreshToken: string }>`.
  - `authProxy(cfg, makeClient = createClient)` — `makeClient` is injectable for tests.
  - `POST /auth/refresh` → `{ token, refreshToken }`.

- [ ] **Step 1: Write the failing authProxy tests**

Append to `control-plane/test/insforge.test.ts`:

```ts
import { authProxy } from '../src/insforge.js'

function fakeMakeClient(calls: any[]) {
  return ((config: any) => {
    calls.push(config)
    return {
      database: { from() { return {} } },
      auth: {
        async signInWithPassword() {
          return { data: { accessToken: 'acc-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } }, error: null }
        },
        async refreshSession(_o: { refreshToken?: string }) {
          return { data: { accessToken: 'acc-2', refreshToken: 'ref-2' }, error: null }
        },
        async getCurrentUser() { return { data: { user: { id: 'u1', email: 'a@b.co' } } } },
        async signUp() { return { data: {}, error: null } },
        async resendVerificationEmail() { return { error: null } },
      },
    }
  }) as any
}

test('authProxy.login returns the refresh token and builds the client in server mode', async () => {
  const calls: any[] = []
  const ap = authProxy(cfg as any, fakeMakeClient(calls))
  const out = await ap.login('a@b.co', 'pw')
  expect(out).toEqual({ token: 'acc-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } })
  expect(calls[0].isServerMode).toBe(true)
})

test('authProxy.refresh rotates the pair via refreshSession', async () => {
  const ap = authProxy(cfg as any, fakeMakeClient([]))
  const out = await ap.refresh('ref-1')
  expect(out).toEqual({ token: 'acc-2', refreshToken: 'ref-2' })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd control-plane && npx vitest run test/insforge.test.ts`
Expected: FAIL — `authProxy` is not exported / `refresh` missing / no `refreshToken` in login result.

- [ ] **Step 3: Implement the authProxy changes**

In `control-plane/src/insforge.ts`, update the `AuthProxy` type and the `authProxy` factory:

```ts
export type AuthProxy = {
  login(email: string, password: string): Promise<{ token: string; refreshToken: string; user: { id: string; email: string } }>
  refresh(refreshToken: string): Promise<{ token: string; refreshToken: string }>
  signUp(email: string, password: string, name?: string, redirectTo?: string): Promise<{ token: string | null; needsVerification: boolean; user: { id: string; email: string } | null }>
  resendVerification(email: string, redirectTo?: string): Promise<void>
  me(token: string): Promise<{ id: string; email: string } | null>
}

export function authProxy(cfg: FirthConfig, makeClient: typeof createClient = createClient): AuthProxy {
  // Server mode: signInWithPassword returns the refresh token in the body (web mode
  // would stash it in an httpOnly cookie we can't read), and refreshSession({ refreshToken })
  // rotates it. The control plane is a server — it holds + relays these tokens to clients.
  const anon = makeClient({ baseUrl: cfg.insforge.baseUrl, anonKey: cfg.insforge.anonKey, isServerMode: true })
  return {
    async login(email, password) {
      const { data, error } = await anon.auth.signInWithPassword({ email, password })
      if (error) throw error
      if (!data?.accessToken) throw new Error('email not verified')
      return { token: data.accessToken, refreshToken: (data as any).refreshToken, user: { id: data.user.id, email: data.user.email } }
    },
    async refresh(refreshToken) {
      const { data, error } = await anon.auth.refreshSession({ refreshToken })
      if (error) throw error
      if (!data?.accessToken) throw new Error('refresh failed')
      return { token: data.accessToken, refreshToken: (data as any).refreshToken }
    },
    async signUp(email, password, name, redirectTo) {
      const { data, error } = await anon.auth.signUp({ email, password, name, redirectTo })
      if (error) throw error
      if (!data) throw new Error('sign-up failed')
      const token = (data as any).accessToken ?? null
      const needsVerification = !!(data as any).requireEmailVerification || !token
      const user = data.user ? { id: data.user.id, email: data.user.email } : null
      return { token, needsVerification, user }
    },
    async resendVerification(email, redirectTo) {
      const { error } = await anon.auth.resendVerificationEmail({ email, redirectTo })
      if (error) throw error
    },
    async me(token) {
      const c = makeClient({ baseUrl: cfg.insforge.baseUrl, anonKey: cfg.insforge.anonKey, accessToken: token })
      const { data } = await c.auth.getCurrentUser()
      return data?.user ? { id: data.user.id, email: data.user.email } : null
    },
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd control-plane && npx vitest run test/insforge.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

In `control-plane/test/server.test.ts`, extend `fakeAuthProxy` with `login` returning a refresh token and a `refresh` method, then add the route tests. Update the existing `fakeAuthProxy` object:

```ts
const fakeAuthProxy = {
  async login(email: string, _password: string) {
    if (email === 'fail@x.co') throw new Error('email not verified')
    return { token: 'tok-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } }
  },
  async refresh(refreshToken: string) {
    if (refreshToken !== 'good-refresh') throw new Error('invalid')
    return { token: 'tok-2', refreshToken: 'ref-2' }
  },
  async signUp(_email: string, _password: string) {
    return { needsVerification: true, token: null, user: null }
  },
  async resendVerification(_email: string) {},
  async me(token: string) {
    if (token !== 'good') return null
    return { id: 'u1', email: 'a@b.co' }
  },
}
```

Add these tests (the existing `POST /auth/login returns token + user` test asserts `toEqual({ token, user })` — update that one assertion to include `refreshToken: 'ref-1'`):

```ts
test('POST /auth/login includes the refresh token', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.co', password: 'pw' } })
  expect(r.json()).toEqual({ token: 'tok-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } })
})

test('POST /auth/refresh rotates the pair (no bearer required)', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'good-refresh' } })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ token: 'tok-2', refreshToken: 'ref-2' })
})

test('POST /auth/refresh 400 when refreshToken missing', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} })
  expect(r.statusCode).toBe(400)
})

test('POST /auth/refresh 401 with a static message on an invalid token', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any, authProxy: fakeAuthProxy })
  const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'nope' } })
  expect(r.statusCode).toBe(401)
  expect(r.json()).toEqual({ error: 'invalid refresh token' })
})
```

(Also update the existing `POST /auth/login returns token + user on success` assertion from `{ token: 'tok-1', user: {...} }` to include `refreshToken: 'ref-1'`.)

- [ ] **Step 6: Run to verify they fail**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: FAIL — no `/auth/refresh` route (404), and the login test sees the extra `refreshToken`.

- [ ] **Step 7: Implement the route**

In `control-plane/src/server.ts`, add immediately after the `POST /auth/login` route (it does NOT use `auth(req)`):

```ts
  app.post('/auth/refresh', async (req, reply) => {
    const { refreshToken } = (req.body as any) ?? {}
    if (!refreshToken) return reply.code(400).send({ error: 'refreshToken is required' })
    try { return reply.send(await deps.authProxy!.refresh(refreshToken)) }
    catch { return reply.code(401).send({ error: 'invalid refresh token' }) }
  })
```

- [ ] **Step 8: Run the full suite + build**

Run: `cd control-plane && npm test && npm run build`
Expected: PASS (new authProxy + route tests; the updated login assertion).

- [ ] **Step 9: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add control-plane/src/insforge.ts control-plane/src/server.ts control-plane/test/insforge.test.ts control-plane/test/server.test.ts
git commit -m "feat: control-plane server-mode login + POST /auth/refresh"
```

---

### Task 2: CLI — store refresh token + refresh on 401

**Files:**
- Modify: `cli/src/config.ts` (`CliConfig`)
- Modify: `cli/src/api.ts` (`FirthApi`)
- Modify: `cli/src/commands/auth.ts` (login persists refreshToken; logout clears it)
- Modify: `cli/src/commands/project.ts` (`apiFromDeps` wiring)
- Test: `cli/test/api.test.ts`, `cli/test/auth.test.ts`

**Interfaces:**
- Consumes: `POST /auth/refresh → { token, refreshToken }` and `POST /auth/login → { token, refreshToken, user }` (Task 1).
- Produces:
  - `CliConfig` gains `refreshToken?: string`.
  - `new FirthApi(apiUrl, token, fetcher?, opts?: { refreshToken?: string; onTokens?: (t: { token: string; refreshToken: string }) => void })` with refresh-on-401.
  - `FirthApi.login(...) : Promise<{ token: string; refreshToken: string; user: {...} }>`.

- [ ] **Step 1: Write the failing FirthApi tests**

In `cli/test/api.test.ts`, add (uses a sequenced fake fetcher; mirror the file's existing fetcher fake style):

```ts
function resp(status: number, body: any) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) }
}

test('refreshes once on 401, persists the rotated pair, retries, and returns the result', async () => {
  const seen: Array<{ url: string; auth?: string; body?: any }> = []
  const queue = [
    resp(401, { error: 'unauthorized' }),                         // 1st: GET /projects → expired
    resp(200, { token: 'acc-2', refreshToken: 'ref-2' }),         // 2nd: POST /auth/refresh
    resp(200, { projects: [{ id: 'p1' }] }),                      // 3rd: GET /projects retried
  ]
  const fetcher = (async (url: string, init: any) => {
    seen.push({ url, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined })
    return queue.shift()!
  }) as any
  let persisted: any
  const api = new FirthApi('http://cp', 'acc-1', fetcher, { refreshToken: 'ref-1', onTokens: (t) => { persisted = t } })
  const projects = await api.listProjects()
  expect(projects).toEqual([{ id: 'p1' }])
  expect(seen[1].url).toBe('http://cp/auth/refresh')
  expect(seen[1].body).toEqual({ refreshToken: 'ref-1' })
  expect(persisted).toEqual({ token: 'acc-2', refreshToken: 'ref-2' })
  expect(seen[2].auth).toBe('Bearer acc-2')                       // retry uses the new token
})

test('a 2xx response triggers no refresh', async () => {
  const seen: string[] = []
  const fetcher = (async (url: string) => { seen.push(url); return resp(200, { projects: [] }) }) as any
  const api = new FirthApi('http://cp', 'acc-1', fetcher, { refreshToken: 'ref-1' })
  await api.listProjects()
  expect(seen).toEqual(['http://cp/projects'])                    // no /auth/refresh
})

test('refresh failure surfaces a session-expired error, no retry loop', async () => {
  const queue = [resp(401, { error: 'unauthorized' }), resp(401, { error: 'invalid refresh token' })]
  const fetcher = (async () => queue.shift() ?? resp(500, {})) as any
  const api = new FirthApi('http://cp', 'acc-1', fetcher, { refreshToken: 'ref-1' })
  await expect(api.listProjects()).rejects.toThrow(/firth login/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && npx vitest run test/api.test.ts`
Expected: FAIL — `FirthApi` ignores the 4th opts arg and doesn't refresh.

- [ ] **Step 3: Implement `FirthApi`**

In `cli/src/api.ts`, replace the constructor + `req`, and split the request out so `/auth/refresh` is called directly (no recursion):

```ts
export class FirthApi {
  private refreshToken?: string
  private onTokens?: (t: { token: string; refreshToken: string }) => void
  constructor(
    private apiUrl: string,
    private token: string,
    private fetcher: Fetcher = realFetcher,
    opts: { refreshToken?: string; onTokens?: (t: { token: string; refreshToken: string }) => void } = {},
  ) {
    this.refreshToken = opts.refreshToken
    this.onTokens = opts.onTokens
  }

  private send(method: string, path: string, body?: unknown) {
    return this.fetcher(`${this.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  // Exchange the refresh token for a fresh pair. Direct call (not via send/req) so a
  // failing refresh can't loop. Returns true and rotates this.token on success.
  private async tryRefresh(): Promise<boolean> {
    if (!this.refreshToken) return false
    const res = await this.fetcher(`${this.apiUrl}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    })
    if (res.status < 200 || res.status >= 300) { this.refreshToken = undefined; return false }
    const data = await res.json()
    this.token = data.token
    this.refreshToken = data.refreshToken
    this.onTokens?.({ token: data.token, refreshToken: data.refreshToken })
    return true
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    let res = await this.send(method, path, body)
    if (res.status === 401 && this.refreshToken) {
      if (await this.tryRefresh()) res = await this.send(method, path, body)
      else throw new Error('session expired — run `firth login`')
    }
    if (res.status < 200 || res.status >= 300) {
      let msg = ''
      try { msg = (await res.json())?.error ?? '' } catch { /* ignore */ }
      throw new Error(`request failed: ${res.status}${msg ? ` ${msg}` : ''}`)
    }
    return res.json()
  }
```

Update the `login` method's return type to include `refreshToken`:

```ts
  login(email: string, password: string): Promise<{ token: string; refreshToken: string; user: { id: string; email: string } }> {
    return this.req('POST', '/auth/login', { email, password })
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd cli && npx vitest run test/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire config + login + apiFromDeps (failing test first)**

In `cli/test/auth.test.ts`, add a test that login persists the refresh token (mirror the file's existing login test style; the fake `makeApi().login` returns `{ token, refreshToken, user }`):

```ts
test('login persists both the access and refresh tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firth-'))
  const api = { login: async () => ({ token: 'acc-1', refreshToken: 'ref-1', user: { id: 'u1', email: 'a@b.co' } }) }
  const d = { print: () => {}, home: dir, cwd: dir, env: {}, makeApi: () => api }
  expect(await login(['--email', 'a@b.co', '--password', 'pw'], d as any)).toBe(0)
  const cfg = readConfig(dir, {})
  expect(cfg.token).toBe('acc-1')
  expect(cfg.refreshToken).toBe('ref-1')
})
```

(Ensure `readConfig` is imported in the test.)

- [ ] **Step 6: Run to verify it fails, then implement config + login + apiFromDeps**

Run: `cd cli && npx vitest run test/auth.test.ts` → FAIL (`refreshToken` not persisted).

`cli/src/config.ts` — `CliConfig`:

```ts
export type CliConfig = { apiUrl: string; token?: string; refreshToken?: string }
```

`cli/src/commands/auth.ts` — `login` captures + persists `refreshToken`, `logout` clears it:

```ts
    const { token, refreshToken } = await api.login(email, password)
    writeConfig({ ...cfg, apiUrl, token, refreshToken }, deps.home)
```

In `logout`, after `delete cfg.token` add `delete cfg.refreshToken`.

`cli/src/commands/project.ts` — `apiFromDeps` wires refresh (add `writeConfig` to the import from `../config.js`):

```ts
export function apiFromDeps(deps: CliDeps & { makeApi?: () => FirthApi }): FirthApi {
  if (deps.makeApi) return deps.makeApi()
  const cfg = readConfig(deps.home, deps.env)
  if (!cfg.token) throw new Error('not logged in — run `firth login`')
  return new FirthApi(cfg.apiUrl, cfg.token, undefined, {
    refreshToken: cfg.refreshToken,
    onTokens: ({ token, refreshToken }) => writeConfig({ ...cfg, token, refreshToken }, deps.home),
  })
}
```

- [ ] **Step 7: Run the full CLI suite + build**

Run: `cd cli && npm test && npm run build`
Expected: PASS — new + existing tests green; build clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add cli/src/config.ts cli/src/api.ts cli/src/commands/auth.ts cli/src/commands/project.ts cli/test/api.test.ts cli/test/auth.test.ts
git commit -m "feat: cli stores the refresh token and refreshes on 401"
```

---

### Task 3: Dashboard — store refresh token + single-flight refresh on 401

**Files:**
- Modify: `dashboard/src/auth/auth.ts` (store/clear `firth_refresh_token`; expose token helpers)
- Modify: `dashboard/src/api/client.ts` (`Api` refresh-on-401, single-flight)
- Modify: `dashboard/src/App.tsx` (wire the `Api` refresh callbacks)
- Test: `dashboard/src/auth/auth.test.ts`, `dashboard/src/api/client.test.ts`

**Interfaces:**
- Consumes: `POST /auth/refresh → { token, refreshToken }` (Task 1); `localStorage`.
- Produces:
  - `auth.ts` exports `getStoredToken()`, `getStoredRefreshToken()`, `setStoredTokens({ token, refreshToken })`, `clearStoredTokens()` (localStorage keys `firth_token`, `firth_refresh_token`).
  - `new Api(baseUrl, getToken, fetcher?, opts?: { getRefreshToken?: () => string | null; onTokens?: (t: { token: string; refreshToken: string }) => void; onAuthLost?: () => void })` with single-flight refresh-on-401.

- [ ] **Step 1: Write the failing auth test**

In `dashboard/src/auth/auth.test.ts`, add:

```ts
it('signIn stores both the access and refresh tokens; signOut clears both', async () => {
  const fetcher = makeFetcher([{ ok: true, body: { token: 'tok-abc', refreshToken: 'ref-abc', user: { id: 'u1', email: 'a@b.co' } } }])
  const auth = createControlPlaneAuth(API_URL, fetcher as unknown as typeof fetch)
  await auth.signIn('a@b.co', 'secret')
  expect(localStorage.getItem('firth_token')).toBe('tok-abc')
  expect(localStorage.getItem('firth_refresh_token')).toBe('ref-abc')
  await auth.signOut()
  expect(localStorage.getItem('firth_token')).toBeNull()
  expect(localStorage.getItem('firth_refresh_token')).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run src/auth/auth.test.ts`
Expected: FAIL — refresh token not stored.

- [ ] **Step 3: Implement auth token storage**

In `dashboard/src/auth/auth.ts`, add a refresh-token key + exported helpers, and store/clear it in `signIn`/`signUp`/`signOut`:

```ts
const TOKEN_KEY = 'firth_token'
const REFRESH_KEY = 'firth_refresh_token'

export function getStoredToken(): string | null { return localStorage.getItem(TOKEN_KEY) }
export function getStoredRefreshToken(): string | null { return localStorage.getItem(REFRESH_KEY) }
export function setStoredTokens(t: { token: string; refreshToken: string }): void {
  localStorage.setItem(TOKEN_KEY, t.token)
  localStorage.setItem(REFRESH_KEY, t.refreshToken)
}
export function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_KEY)
}
```

In `signIn`, after the call: `if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken)` (destructure `refreshToken` from the response alongside `token`/`user`). In `signUp`'s success branch, same. In `signOut`, add `localStorage.removeItem(REFRESH_KEY)` next to the existing `removeItem(TOKEN_KEY)`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard && npx vitest run src/auth/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Api tests**

In `dashboard/src/api/client.test.ts`, add (mirror the file's fetcher-fake style):

```ts
function resp(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

it('refreshes once on 401, persists the pair, retries, and returns the result', async () => {
  const queue = [resp(401, { error: 'unauthorized' }), resp(200, { token: 't2', refreshToken: 'r2' }), resp(200, { projects: [{ id: 'p1' }] })]
  const seen: string[] = []
  const fetcher = ((url: string) => { seen.push(url); return Promise.resolve(queue.shift()!) }) as unknown as typeof fetch
  let persisted: any
  let token = 't1'
  const api = new Api('http://cp', () => token, fetcher, {
    getRefreshToken: () => 'r1',
    onTokens: (t) => { persisted = t; token = t.token },
  })
  const projects = await api.listProjects()
  expect(projects).toEqual([{ id: 'p1' }])
  expect(seen).toEqual(['http://cp/projects', 'http://cp/auth/refresh', 'http://cp/projects'])
  expect(persisted).toEqual({ token: 't2', refreshToken: 'r2' })
})

it('two concurrent 401s trigger only one refresh (single-flight)', async () => {
  let refreshCalls = 0
  let token = 't1'
  const fetcher = ((url: string) => {
    if (url.endsWith('/auth/refresh')) { refreshCalls++; return Promise.resolve(resp(200, { token: 't2', refreshToken: 'r2' })) }
    return Promise.resolve(token === 't1' ? resp(401, {}) : resp(200, { projects: [] }))
  }) as unknown as typeof fetch
  const api = new Api('http://cp', () => token, fetcher, { getRefreshToken: () => 'r1', onTokens: (t) => { token = t.token } })
  await Promise.all([api.listProjects(), api.listProjects()])
  expect(refreshCalls).toBe(1)
})

it('refresh failure clears tokens and propagates the 401', async () => {
  const queue = [resp(401, {}), resp(401, { error: 'invalid refresh token' })]
  const fetcher = (() => Promise.resolve(queue.shift() ?? resp(500, {}))) as unknown as typeof fetch
  let cleared = false
  const api = new Api('http://cp', () => 't1', fetcher, { getRefreshToken: () => 'r1', onAuthLost: () => { cleared = true } })
  await expect(api.listProjects()).rejects.toMatchObject({ status: 401 })
  expect(cleared).toBe(true)
})
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd dashboard && npx vitest run src/api/client.test.ts`
Expected: FAIL — `Api` ignores the 4th opts arg.

- [ ] **Step 7: Implement the `Api` refresh path**

In `dashboard/src/api/client.ts`, update `Api` (constructor + `req` + helpers):

```ts
export class Api {
  private refreshing: Promise<boolean> | null = null
  constructor(
    private baseUrl: string,
    private getToken: () => string | null,
    private fetcher: Fetcher = (...args: Parameters<typeof fetch>) => fetch(...args),
    private opts: {
      getRefreshToken?: () => string | null
      onTokens?: (t: { token: string; refreshToken: string }) => void
      onAuthLost?: () => void
    } = {},
  ) {}

  private send(method: string, path: string, body?: unknown) {
    const token = this.getToken()
    return this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  // Single-flight: concurrent 401s share one refresh (rotation makes parallel refreshes
  // invalidate each other). Resolves true once the token is rotated + persisted.
  private refreshOnce(): Promise<boolean> {
    if (!this.refreshing) this.refreshing = this.doRefresh().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = this.opts.getRefreshToken?.()
    if (!refreshToken) return false
    const res = await this.fetcher(`${this.baseUrl}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) { this.opts.onAuthLost?.(); return false }
    const data = await res.json()
    this.opts.onTokens?.({ token: data.token, refreshToken: data.refreshToken })
    return true
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    let res = await this.send(method, path, body)
    if (res.status === 401 && this.opts.getRefreshToken?.()) {
      if (await this.refreshOnce()) res = await this.send(method, path, body)
    }
    if (!res.ok) {
      let msg = ''
      try { msg = (await res.json())?.error ?? '' } catch { /* ignore */ }
      throw new ApiError(res.status, msg || `request failed: ${res.status}`)
    }
    return res.json()
  }
```

(The public methods — `listProjects`, etc. — are unchanged; they call `req`.)

- [ ] **Step 8: Wire the Api in `App.tsx`**

Where `App.tsx` constructs the `Api` (currently `new Api(apiUrl, () => token …)` via a `useMemo`), pass the refresh wiring so a rotated token is persisted and reused. Import the helpers from `../auth/auth` and build the Api as:

```ts
import { getStoredToken, getStoredRefreshToken, setStoredTokens, clearStoredTokens } from '../auth/auth'
// ...
const api = useMemo(() => new Api(apiUrl, getStoredToken, undefined, {
  getRefreshToken: getStoredRefreshToken,
  onTokens: setStoredTokens,
  onAuthLost: clearStoredTokens,
}), [apiUrl])
```

(Use `getStoredToken` as the token getter so a refreshed token written to localStorage is picked up on the retry. If `App.tsx` currently holds the token in React state, keep that for render/auth-gating but pass `getStoredToken` to the `Api` so the retry reads the freshly-persisted token. Adjust the existing 401→AuthScreen handling to remain: `clearStoredTokens` + the existing redirect.)

- [ ] **Step 9: Run the full dashboard suite + build**

Run: `cd dashboard && npm test && npm run build`
Expected: PASS — new auth + client tests, existing tests green; build clean.

- [ ] **Step 10: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add dashboard/src/auth/auth.ts dashboard/src/api/client.ts dashboard/src/App.tsx dashboard/src/auth/auth.test.ts dashboard/src/api/client.test.ts
git commit -m "feat: dashboard stores the refresh token and refreshes on 401 (single-flight)"
```

---

## Notes for the executor

- `/auth/refresh` must NOT be placed behind `auth(req)` — it's authorized by the body's refresh token (the access token is expired by definition).
- The SDK server-mode behavior (`isServerMode: true` → `signInWithPassword`/`refreshSession` return the refresh token in the body) is confirmed against the `@insforge/sdk` source; the tests inject a fake client matching that shape. A post-deploy sanity check: `firth login` then confirm `~/.firth/config.json` contains `refreshToken`, and that a call made >15 min later still succeeds (silent refresh).
- Refresh rotates the token — every success path persists the new pair before any reuse. The CLI is sequential (simple retry); the dashboard uses single-flight for parallel requests.
- App.tsx wiring is integration glue — keep the existing auth-gate/render flow; only add the Api refresh callbacks and ensure the Api's token getter reads the freshly-persisted token on retry.

# Firth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the firth control-plane foundation on InsForge — metadata schema (projects/branches/resources/secrets) with RLS, an AES-256-GCM secret encryption module + the single `secrets` seam, and a minimal HTTP API (projects CRUD + secret seam) that runs and is tested locally.

**Architecture:** TypeScript/Node service (`control-plane/`) talking to the linked InsForge project (Postgres metadata via `@insforge/sdk`, auth via InsForge auth). Metadata writes go through a per-request **user-scoped** client so RLS enforces ownership; the **admin** client is reserved for privileged ops. Secret values are encrypted in the app layer (KEK from env, never in DB) and stored as ciphertext; the `secrets` seam is the only path that decrypts. No provider adapters yet — this plan ends with a working, tested control plane that later plans build adapters into.

**Tech Stack:** Node 20 + TypeScript, `@insforge/sdk`, `vitest` (test), `fastify` (HTTP), Node built-in `crypto` (AES-256-GCM). InsForge CLI for migrations/compute.

## Global Constraints

- Linked InsForge project: `firth` / `0662c2ef-202a-4feb-8267-5501b3b60037`. Never commit `.insforge/project.json` (already gitignored).
- All schema changes go through `npx @insforge/cli db migrations` files in `migrations/`. Never `BEGIN/COMMIT` inside migration SQL. App objects live in `public`; reference `auth.users(id)` and `auth.uid()` but never modify `auth.*`.
- RLS on every metadata table. Every policy uses `(SELECT auth.uid())` subquery form. `owner` is denormalized onto every table for non-recursive, join-free policies. `owner` is immutable (trigger-guarded).
- The KEK (key-encryption key) is loaded from env (`FIRTH_KEK_<VERSION>`, base64-encoded 32 bytes) and **must never** be written to the DB, logs, or error messages. Secret plaintext must never appear in logs.
- Two `@insforge/sdk` clients: `adminClient` (uses admin API key `ik_…` from env) and `userClient(token)` (uses the caller's bearer token). Metadata CRUD uses `userClient`; only secret encryption-key access and (future) provider calls use `adminClient`.
- `EncryptedSecret = { ciphertext: string; nonce: string; kekVersion: string }` — all base64 strings.
- `SecretBundle = Record<string, string>` — map of secret name → plaintext value.
- Resource kinds are exactly `'neon' | 's3' | 'fly'`.
- InsForge **compute is private preview / gated** — the deploy task (Task 10) may fail with an access error; that's expected and is a checkpoint, not a blocker for the rest of the plan, which runs locally.

---

### Task 1: Scaffold the control-plane TypeScript project

**Files:**
- Create: `control-plane/package.json`
- Create: `control-plane/tsconfig.json`
- Create: `control-plane/vitest.config.ts`
- Create: `control-plane/.gitignore`
- Create: `control-plane/src/index.ts` (placeholder export)
- Create: `control-plane/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` and `npm run build` in `control-plane/`.

- [ ] **Step 1: Create `control-plane/package.json`**

```json
{
  "name": "firth-control-plane",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@insforge/sdk": "latest",
    "fastify": "^4.28.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `control-plane/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `control-plane/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
```

- [ ] **Step 4: Create `control-plane/.gitignore`**

```
node_modules/
dist/
.env
.env.*
```

- [ ] **Step 5: Write the smoke test `control-plane/test/smoke.test.ts`**

```typescript
import { expect, test } from 'vitest'
import { version } from '../src/index.js'

test('package exposes a version string', () => {
  expect(version).toBe('0.0.0')
})
```

- [ ] **Step 6: Create minimal `control-plane/src/index.ts`**

```typescript
export const version = '0.0.0'
```

- [ ] **Step 7: Install and run the test**

Run: `cd control-plane && npm install && npm test`
Expected: 1 passing test (`smoke.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add control-plane/
git commit -m "chore: scaffold control-plane TS project"
```

---

### Task 2: Create the firth-core metadata schema with RLS

**Files:**
- Create: `migrations/<version>_create-firth-core.sql` (filename from `migrations new`)
- Test: `control-plane/test/schema.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `public.projects`, `public.branches`, `public.resources`, `public.secrets` with RLS, grants, indexes, and an immutable-`owner` guard. Column contracts:
  - `projects(id uuid, owner uuid, name text, status text, created_at, updated_at)`
  - `branches(id uuid, project_id uuid, owner uuid, name text, parent_branch_id uuid?, is_default bool, neon_branch_ref text?, status text, created_at, updated_at)`
  - `resources(id uuid, project_id uuid, owner uuid, kind text in (neon|s3|fly), provider_ref jsonb, status text, created_at, updated_at)`
  - `secrets(id uuid, project_id uuid, owner uuid, branch_id uuid?, name text, ciphertext text, nonce text, kek_version text, expires_at timestamptz?, created_at)`

- [ ] **Step 1: Create the migration file**

Run: `npx @insforge/cli db migrations new create-firth-core`
Expected: prints `migrations/<version>_create-firth-core.sql`.

- [ ] **Step 2: Write the migration SQL** (into the file created above)

```sql
-- projects
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- branches
CREATE TABLE public.branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  neon_branch_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- resources
CREATE TABLE public.resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('neon','s3','fly')),
  provider_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind)
);

-- secrets (ciphertext only; KEK lives outside the DB)
CREATE TABLE public.secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  kek_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- indexes on policy / lookup columns
CREATE INDEX idx_projects_owner ON public.projects(owner);
CREATE INDEX idx_branches_owner ON public.branches(owner);
CREATE INDEX idx_branches_project ON public.branches(project_id);
CREATE INDEX idx_resources_owner ON public.resources(owner);
CREATE INDEX idx_resources_project ON public.resources(project_id);
CREATE INDEX idx_secrets_owner ON public.secrets(owner);
CREATE INDEX idx_secrets_scope ON public.secrets(project_id, branch_id);

-- updated_at triggers (InsForge built-in)
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();
CREATE TRIGGER branches_updated_at BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();
CREATE TRIGGER resources_updated_at BEFORE UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

-- immutable owner guard
CREATE OR REPLACE FUNCTION public.prevent_owner_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner IS DISTINCT FROM OLD.owner THEN
    RAISE EXCEPTION 'owner is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_owner_guard BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();
CREATE TRIGGER branches_owner_guard BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();
CREATE TRIGGER resources_owner_guard BEFORE UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();

-- enable RLS
ALTER TABLE public.projects  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.secrets   ENABLE ROW LEVEL SECURITY;

-- owner-only policies (join-free; owner denormalized on every table)
CREATE POLICY projects_owner_all ON public.projects FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
CREATE POLICY branches_owner_all ON public.branches FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
CREATE POLICY resources_owner_all ON public.resources FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
CREATE POLICY secrets_owner_all ON public.secrets FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));

-- privileges (RLS decides rows; grants decide operations)
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects, public.branches, public.resources TO authenticated;
-- secrets: app reads via the seam; user role may select/insert its own, never update ciphertext in place
GRANT SELECT, INSERT, DELETE ON public.secrets TO authenticated;
```

- [ ] **Step 3: Apply the migration**

Run: `npx @insforge/cli db migrations up --all`
Expected: prints the applied filename; no error.

- [ ] **Step 4: Write an integration test asserting the schema + policies exist** `control-plane/test/schema.integration.test.ts`

```typescript
import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'

function query(sql: string): any[] {
  const out = execFileSync('npx', ['@insforge/cli', 'db', 'query', sql, '--json'],
    { cwd: '..', encoding: 'utf8' })
  return JSON.parse(out).rows
}

test('all four firth-core tables exist', () => {
  const rows = query(
    "select table_name from information_schema.tables where table_schema='public' " +
    "and table_name in ('projects','branches','resources','secrets')")
  expect(rows.map((r) => r.table_name).sort())
    .toEqual(['branches', 'projects', 'resources', 'secrets'])
})

test('RLS is enabled on every metadata table', () => {
  const rows = query(
    "select relname from pg_class where relrowsecurity=true and relname in " +
    "('projects','branches','resources','secrets')")
  expect(rows.length).toBe(4)
})

test('every owner-policy carries USING and WITH CHECK', () => {
  const rows = query(
    "select policyname, qual, with_check from pg_policies where schemaname='public'")
  expect(rows.length).toBeGreaterThanOrEqual(4)
  for (const r of rows) {
    expect(r.qual, `${r.policyname} USING`).not.toBeNull()
    expect(r.with_check, `${r.policyname} WITH CHECK`).not.toBeNull()
  }
})
```

> Note: this verifies policy *shape*, not live cross-user isolation. Full authenticated-token isolation testing needs auth fixtures and is deferred to a dedicated test-harness task (called out in Self-Review gaps). Marking it here so it is not mistaken for covered.

- [ ] **Step 5: Run the integration test**

Run: `cd control-plane && npx vitest run test/schema.integration.test.ts`
Expected: 3 passing tests.

- [ ] **Step 6: Commit**

```bash
git add migrations/ control-plane/test/schema.integration.test.ts
git commit -m "feat: firth-core metadata schema with RLS"
```

---

### Task 3: Secret encryption module (AES-256-GCM, versioned KEK)

**Files:**
- Create: `control-plane/src/crypto/secrets.ts`
- Test: `control-plane/test/crypto/secrets.test.ts`

**Interfaces:**
- Consumes: env vars `FIRTH_KEK_CURRENT` (e.g. `v1`) and `FIRTH_KEK_<VERSION>` (base64 32-byte key).
- Produces:
  - `loadKeks(env: NodeJS.ProcessEnv): { keks: Map<string, Buffer>; current: string }`
  - `type EncryptedSecret = { ciphertext: string; nonce: string; kekVersion: string }`
  - `encryptSecret(plaintext: string, keks, current): EncryptedSecret`
  - `decryptSecret(enc: EncryptedSecret, keks): string`

- [ ] **Step 1: Write the failing test** `control-plane/test/crypto/secrets.test.ts`

```typescript
import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { decryptSecret, encryptSecret, loadKeks } from '../../src/crypto/secrets.js'

const v1 = randomBytes(32).toString('base64')
const v2 = randomBytes(32).toString('base64')
const env = { FIRTH_KEK_CURRENT: 'v1', FIRTH_KEK_v1: v1, FIRTH_KEK_v2: v2 }

describe('secret encryption', () => {
  test('round-trips plaintext under the current KEK', () => {
    const { keks, current } = loadKeks(env)
    const enc = encryptSecret('postgres://secret-conn', keks, current)
    expect(enc.kekVersion).toBe('v1')
    expect(enc.ciphertext).not.toContain('postgres')
    expect(decryptSecret(enc, keks)).toBe('postgres://secret-conn')
  })

  test('decrypts a value encrypted under a non-current KEK version', () => {
    const { keks } = loadKeks(env)
    const enc = encryptSecret('x', keks, 'v2')
    expect(decryptSecret(enc, keks)).toBe('x')
  })

  test('tampered ciphertext fails authentication', () => {
    const { keks, current } = loadKeks(env)
    const enc = encryptSecret('y', keks, current)
    // Flip a byte but keep the 16-byte tag length intact — genuine GCM auth failure.
    const raw = Buffer.from(enc.ciphertext, 'base64')
    raw[0] ^= 0xff
    const bad = { ...enc, ciphertext: raw.toString('base64') }
    expect(() => decryptSecret(bad, keks)).toThrow()
  })

  test('unknown KEK version throws without leaking plaintext', () => {
    const { keks } = loadKeks(env)
    expect(() => decryptSecret({ ciphertext: 'a', nonce: 'b', kekVersion: 'v9' }, keks))
      .toThrow(/unknown kek version/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run test/crypto/secrets.test.ts`
Expected: FAIL — cannot find module `../../src/crypto/secrets.js`.

- [ ] **Step 3: Implement `control-plane/src/crypto/secrets.ts`**

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type EncryptedSecret = { ciphertext: string; nonce: string; kekVersion: string }

export function loadKeks(env: NodeJS.ProcessEnv): { keks: Map<string, Buffer>; current: string } {
  const current = env.FIRTH_KEK_CURRENT
  if (!current) throw new Error('FIRTH_KEK_CURRENT is not set')
  const keks = new Map<string, Buffer>()
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('FIRTH_KEK_') || k === 'FIRTH_KEK_CURRENT' || !v) continue
    const version = k.slice('FIRTH_KEK_'.length)
    const buf = Buffer.from(v, 'base64')
    if (buf.length !== 32) throw new Error(`KEK ${version} must be 32 bytes (base64)`)
    keks.set(version, buf)
  }
  if (!keks.has(current)) throw new Error(`current KEK ${current} not provided`)
  return { keks, current }
}

export function encryptSecret(plaintext: string, keks: Map<string, Buffer>, version: string): EncryptedSecret {
  const key = keks.get(version)
  if (!key) throw new Error(`unknown kek version: ${version}`)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([ct, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
    kekVersion: version,
  }
}

export function decryptSecret(enc: EncryptedSecret, keks: Map<string, Buffer>): string {
  const key = keks.get(enc.kekVersion)
  if (!key) throw new Error(`unknown kek version: ${enc.kekVersion}`)
  const raw = Buffer.from(enc.ciphertext, 'base64')
  const tag = raw.subarray(raw.length - 16)
  const ct = raw.subarray(0, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.nonce, 'base64'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && npx vitest run test/crypto/secrets.test.ts`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/crypto/secrets.ts control-plane/test/crypto/secrets.test.ts
git commit -m "feat: AES-256-GCM secret encryption with versioned KEK"
```

---

### Task 4: Config loader (env validation)

**Files:**
- Create: `control-plane/src/config.ts`
- Test: `control-plane/test/config.test.ts`

**Interfaces:**
- Consumes: `loadKeks` (Task 3); env `INSFORGE_BASE_URL`, `INSFORGE_ANON_KEY`, `INSFORGE_ADMIN_KEY`.
- Produces: `loadConfig(env): FirthConfig` where
  `FirthConfig = { keks: Map<string,Buffer>; currentKek: string; insforge: { baseUrl: string; anonKey: string; adminKey: string } }`.

- [ ] **Step 1: Write the failing test** `control-plane/test/config.test.ts`

```typescript
import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  FIRTH_KEK_CURRENT: 'v1',
  FIRTH_KEK_v1: randomBytes(32).toString('base64'),
  INSFORGE_BASE_URL: 'https://u4vrn3sx.us-east.insforge.app',
  INSFORGE_ANON_KEY: 'anon',
  INSFORGE_ADMIN_KEY: 'ik_test',
}

test('loads a complete config', () => {
  const cfg = loadConfig(base)
  expect(cfg.currentKek).toBe('v1')
  expect(cfg.insforge.baseUrl).toContain('insforge.app')
})

test('throws when a required InsForge var is missing', () => {
  const { INSFORGE_ADMIN_KEY, ...rest } = base
  expect(() => loadConfig(rest)).toThrow(/INSFORGE_ADMIN_KEY/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane/src/config.ts`**

```typescript
import { loadKeks } from './crypto/secrets.js'

export type FirthConfig = {
  keks: Map<string, Buffer>
  currentKek: string
  insforge: { baseUrl: string; anonKey: string; adminKey: string }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (!v) throw new Error(`${key} is required`)
  return v
}

export function loadConfig(env: NodeJS.ProcessEnv): FirthConfig {
  const { keks, current } = loadKeks(env)
  return {
    keks,
    currentKek: current,
    insforge: {
      baseUrl: required(env, 'INSFORGE_BASE_URL'),
      anonKey: required(env, 'INSFORGE_ANON_KEY'),
      adminKey: required(env, 'INSFORGE_ADMIN_KEY'),
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/config.test.ts`
Expected: 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/config.ts control-plane/test/config.test.ts
git commit -m "feat: control-plane config loader with env validation"
```

---

### Task 5: Repository layer with an injectable data client

**Files:**
- Create: `control-plane/src/db/types.ts`
- Create: `control-plane/src/db/repos.ts`
- Test: `control-plane/test/db/repos.test.ts`

**Interfaces:**
- Consumes: `EncryptedSecret` (Task 3).
- Produces:
  - `interface DataClient { from(table): { insert(values): Promise<{data,error}>; select(): ...; eq(col,val): ... } }` — the minimal subset of `@insforge/sdk`'s `database` we use, so logic is testable with a fake.
  - `class ProjectsRepo { constructor(db: DataClient); create(owner, name): Promise<Project>; listByOwner(owner): Promise<Project[]> }`
  - `class SecretsRepo { constructor(db: DataClient); store(row: NewSecretRow): Promise<void>; listForScope(owner, projectId, branchId|null): Promise<SecretRow[]> }`
  - `type Project = { id: string; owner: string; name: string; status: string }`
  - `type NewSecretRow = { project_id; owner; branch_id: string|null; name; ciphertext; nonce; kek_version }`
  - `type SecretRow = NewSecretRow & { id: string }`

- [ ] **Step 1: Write the failing test** `control-plane/test/db/repos.test.ts` (uses an in-memory fake DataClient)

```typescript
import { expect, test } from 'vitest'
import { ProjectsRepo, SecretsRepo } from '../../src/db/repos.js'

// Minimal fake implementing the DataClient query-builder surface we use.
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { projects: [], branches: [], secrets: [], ...seed }
  return {
    tables,
    from(table: string) {
      let rows = tables[table]
      const filters: Array<[string, any]> = []
      const api: any = {
        insert(values: any) { const arr = Array.isArray(values) ? values : [values]
          for (const v of arr) tables[table].push({ id: `id-${tables[table].length}`, ...v })
          api._inserted = arr; return api },
        select() { api._mode = 'select'; return api },
        eq(col: string, val: any) { filters.push([col, val]); return api },
        async then(res: any) {
          if (api._mode === 'select') {
            rows = tables[table].filter((r) => filters.every(([c, v]) => r[c] === v))
            return res({ data: rows, error: null })
          }
          return res({ data: api._inserted, error: null })
        },
      }
      return api
    },
  }
}

test('ProjectsRepo.create inserts with owner and default status', async () => {
  const db = fakeDb()
  const repo = new ProjectsRepo(db as any)
  const p = await repo.create('owner-1', 'my-proj')
  expect(p.owner).toBe('owner-1')
  expect(p.name).toBe('my-proj')
  expect(db.tables.projects.length).toBe(1)
})

test('SecretsRepo.listForScope filters by project and null branch', async () => {
  const db = fakeDb({ secrets: [
    { id: 's1', owner: 'o', project_id: 'p', branch_id: null, name: 'S3_KEY', ciphertext: 'c', nonce: 'n', kek_version: 'v1' },
    { id: 's2', owner: 'o', project_id: 'p', branch_id: 'b1', name: 'DB_URL', ciphertext: 'c', nonce: 'n', kek_version: 'v1' },
  ] })
  const repo = new SecretsRepo(db as any)
  const rows = await repo.listForScope('o', 'p', null)
  expect(rows.map((r) => r.name)).toEqual(['S3_KEY'])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/db/repos.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane/src/db/types.ts`**

```typescript
export type Project = { id: string; owner: string; name: string; status: string }
export type NewSecretRow = {
  project_id: string; owner: string; branch_id: string | null
  name: string; ciphertext: string; nonce: string; kek_version: string
}
export type SecretRow = NewSecretRow & { id: string }

// The subset of @insforge/sdk's `database` query builder we depend on.
export interface QueryBuilder {
  insert(values: object | object[]): QueryBuilder
  select(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  then<T>(onfulfilled: (r: { data: any[] | null; error: Error | null }) => T): Promise<T>
}
export interface DataClient { from(table: string): QueryBuilder }
```

- [ ] **Step 4: Implement `control-plane/src/db/repos.ts`**

```typescript
import type { DataClient, NewSecretRow, Project, SecretRow } from './types.js'

export class ProjectsRepo {
  constructor(private db: DataClient) {}

  async create(owner: string, name: string): Promise<Project> {
    const { data, error } = await this.db.from('projects')
      .insert({ owner, name, status: 'active' }).select()
    if (error) throw error
    return data![0] as Project
  }

  async listByOwner(owner: string): Promise<Project[]> {
    const { data, error } = await this.db.from('projects').select().eq('owner', owner)
    if (error) throw error
    return (data ?? []) as Project[]
  }
}

export class SecretsRepo {
  constructor(private db: DataClient) {}

  async store(row: NewSecretRow): Promise<void> {
    const { error } = await this.db.from('secrets').insert(row).select()
    if (error) throw error
  }

  async listForScope(owner: string, projectId: string, branchId: string | null): Promise<SecretRow[]> {
    let q = this.db.from('secrets').select().eq('owner', owner).eq('project_id', projectId)
    q = branchId === null ? q.eq('branch_id', null) : q.eq('branch_id', branchId)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as SecretRow[]
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/db/repos.test.ts`
Expected: 2 passing tests.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/db/ control-plane/test/db/
git commit -m "feat: projects + secrets repositories over injectable data client"
```

---

### Task 6: InsForge client factory (admin + per-user-token)

**Files:**
- Create: `control-plane/src/insforge.ts`
- Test: `control-plane/test/insforge.test.ts`

**Interfaces:**
- Consumes: `FirthConfig` (Task 4), `DataClient` (Task 5).
- Produces:
  - `adminClient(cfg): { database: DataClient; auth: AuthApi }`
  - `userClient(cfg, token: string): { database: DataClient }`
  - `type AuthApi = { getCurrentUser(): Promise<{ id: string } | null> }` (the subset used by auth middleware).
- Implementation calls `@insforge/sdk`'s `createClient`. The user client is constructed with the caller's bearer token so PostgREST runs as `authenticated` and RLS applies. **Exact token-setter call** (`createClient` option vs `auth.setSession`) must be confirmed with `npx @insforge/cli docs auth typescript` at implementation; the wrapper isolates it to this one file.

- [ ] **Step 1: Write the failing test** `control-plane/test/insforge.test.ts`

```typescript
import { expect, test } from 'vitest'
import { adminClient, userClient } from '../src/insforge.js'

const cfg = {
  keks: new Map(), currentKek: 'v1',
  insforge: { baseUrl: 'https://x.insforge.app', anonKey: 'anon', adminKey: 'ik_test' },
}

test('adminClient exposes database + auth', () => {
  const c = adminClient(cfg as any)
  expect(typeof c.database.from).toBe('function')
  expect(typeof c.auth.getCurrentUser).toBe('function')
})

test('userClient exposes a database bound to a token', () => {
  const c = userClient(cfg as any, 'token-abc')
  expect(typeof c.database.from).toBe('function')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/insforge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane/src/insforge.ts`**

```typescript
import { createClient } from '@insforge/sdk'
import type { FirthConfig } from './config.js'
import type { DataClient } from './db/types.js'

export type AuthApi = { getCurrentUser(): Promise<{ id: string } | null> }

export function adminClient(cfg: FirthConfig): { database: DataClient; auth: AuthApi } {
  const c = createClient({ baseUrl: cfg.insforge.baseUrl, anonKey: cfg.insforge.adminKey })
  return {
    database: c.database as unknown as DataClient,
    auth: {
      async getCurrentUser() {
        const { data } = await c.auth.getCurrentUser()
        return data?.user ? { id: data.user.id } : null
      },
    },
  }
}

export function userClient(cfg: FirthConfig, token: string): { database: DataClient } {
  const c = createClient({ baseUrl: cfg.insforge.baseUrl, anonKey: cfg.insforge.anonKey })
  // Bind the caller's session so PostgREST runs as `authenticated` and RLS applies.
  c.auth.setSession?.({ accessToken: token })
  return { database: c.database as unknown as DataClient }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/insforge.test.ts`
Expected: 2 passing tests. (If `@insforge/sdk` shape differs, adjust this file only; the wrapper is the isolation seam.)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/insforge.ts control-plane/test/insforge.test.ts
git commit -m "feat: InsForge admin + per-user-token client factory"
```

---

### Task 7: Auth middleware (bearer token → uid)

**Files:**
- Create: `control-plane/src/auth.ts`
- Test: `control-plane/test/auth.test.ts`

**Interfaces:**
- Consumes: `AuthApi` (Task 6).
- Produces: `resolveUid(authHeader: string | undefined, verify: (token: string) => Promise<{ id: string } | null>): Promise<{ uid: string; token: string }>` — throws `UnauthorizedError` on missing/invalid token.
- Produces: `class UnauthorizedError extends Error`.

- [ ] **Step 1: Write the failing test** `control-plane/test/auth.test.ts`

```typescript
import { expect, test } from 'vitest'
import { resolveUid, UnauthorizedError } from '../src/auth.js'

const verifyOk = async (t: string) => (t === 'good' ? { id: 'uid-1' } : null)

test('extracts uid + token from a valid bearer header', async () => {
  const r = await resolveUid('Bearer good', verifyOk)
  expect(r).toEqual({ uid: 'uid-1', token: 'good' })
})

test('rejects a missing header', async () => {
  await expect(resolveUid(undefined, verifyOk)).rejects.toBeInstanceOf(UnauthorizedError)
})

test('rejects a token the backend does not recognize', async () => {
  await expect(resolveUid('Bearer bad', verifyOk)).rejects.toBeInstanceOf(UnauthorizedError)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane/src/auth.ts`**

```typescript
export class UnauthorizedError extends Error {
  constructor(msg = 'unauthorized') { super(msg); this.name = 'UnauthorizedError' }
}

export async function resolveUid(
  authHeader: string | undefined,
  verify: (token: string) => Promise<{ id: string } | null>,
): Promise<{ uid: string; token: string }> {
  if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedError('missing bearer token')
  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) throw new UnauthorizedError('empty token')
  const user = await verify(token)
  if (!user) throw new UnauthorizedError('invalid token')
  return { uid: user.id, token }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/auth.test.ts`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/auth.ts control-plane/test/auth.test.ts
git commit -m "feat: bearer-token auth middleware"
```

---

### Task 8: Project service — create project + default branch

**Files:**
- Create: `control-plane/src/services/projects.ts`
- Test: `control-plane/test/services/projects.test.ts`

**Interfaces:**
- Consumes: `ProjectsRepo` (Task 5), `DataClient` (Task 5).
- Produces: `class ProjectService { constructor(db: DataClient); createProject(owner: string, name: string): Promise<{ project: Project; defaultBranch: { id: string; name: string } }> }` — inserts the project then a default `main` branch (`is_default=true`) owned by the same user.

- [ ] **Step 1: Write the failing test** `control-plane/test/services/projects.test.ts`

```typescript
import { expect, test } from 'vitest'
import { ProjectService } from '../../src/services/projects.js'

function fakeDb() {
  const tables: Record<string, any[]> = { projects: [], branches: [] }
  return {
    tables,
    from(table: string) {
      const api: any = {
        insert(v: any) { const row = { id: `${table}-${tables[table].length}`, ...v }
          tables[table].push(row); api._row = row; return api },
        select() { return api },
        eq() { return api },
        async then(res: any) { return res({ data: [api._row], error: null }) },
      }
      return api
    },
  }
}

test('createProject creates project then a default main branch', async () => {
  const db = fakeDb()
  const svc = new ProjectService(db as any)
  const out = await svc.createProject('owner-1', 'demo')
  expect(out.project.name).toBe('demo')
  expect(out.defaultBranch.name).toBe('main')
  expect(db.tables.branches[0].is_default).toBe(true)
  expect(db.tables.branches[0].owner).toBe('owner-1')
  expect(db.tables.branches[0].project_id).toBe(out.project.id)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/services/projects.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane/src/services/projects.ts`**

```typescript
import { ProjectsRepo } from '../db/repos.js'
import type { DataClient, Project } from '../db/types.js'

export class ProjectService {
  private projects: ProjectsRepo
  constructor(private db: DataClient) { this.projects = new ProjectsRepo(db) }

  async createProject(owner: string, name: string): Promise<{
    project: Project; defaultBranch: { id: string; name: string }
  }> {
    const project = await this.projects.create(owner, name)
    const { data, error } = await this.db.from('branches').insert({
      project_id: project.id, owner, name: 'main', is_default: true, status: 'active',
    }).select()
    if (error) throw error
    const branch = data![0] as { id: string; name: string }
    return { project, defaultBranch: { id: branch.id, name: branch.name } }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/services/projects.test.ts`
Expected: 1 passing test.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/services/projects.ts control-plane/test/services/projects.test.ts
git commit -m "feat: project service creates project + default branch"
```

---

### Task 9: HTTP API — projects routes + the secret seam

**Files:**
- Create: `control-plane/src/server.ts`
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `FirthConfig` (4), `adminClient`/`userClient` (6), `resolveUid` (7), `ProjectService` (8), `ProjectsRepo`/`SecretsRepo` (5), `decryptSecret` (3).
- Produces: `buildServer(deps): FastifyInstance` where
  `deps = { cfg: FirthConfig; verifyToken: (t)=>Promise<{id}|null>; dataForToken: (t)=>DataClient }` (injected for testability).
- Routes:
  - `POST /projects` body `{ name }` → 201 `{ project, defaultBranch }`
  - `GET /projects` → 200 `{ projects: Project[] }`
  - `GET /projects/:id/secrets?branch=<id>` → 200 `{ secrets: SecretBundle }` — **the seam**: server-side decrypt, returns plaintext map. `branch` omitted → project-scoped (branch_id null).

- [ ] **Step 1: Write the failing test** `control-plane/test/server.test.ts`

```typescript
import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { buildServer } from '../src/server.js'
import { encryptSecret, loadKeks } from '../src/crypto/secrets.js'

const env = { FIRTH_KEK_CURRENT: 'v1', FIRTH_KEK_v1: randomBytes(32).toString('base64') }
const { keks, current } = loadKeks(env)
const cfg = { keks, currentKek: current, insforge: { baseUrl: 'x', anonKey: 'a', adminKey: 'ik' } }

function fakeData() {
  const tables: Record<string, any[]> = { projects: [], branches: [], secrets: [] }
  return { tables, from(t: string) {
    const filters: Array<[string, any]> = []
    const api: any = {
      insert(v: any) { const row = { id: `${t}-${tables[t].length}`, ...v }; tables[t].push(row); api._row = row; return api },
      select() { api._sel = true; return api },
      eq(c: string, val: any) { filters.push([c, val]); return api },
      async then(res: any) {
        if (api._sel && !api._row) return res({ data: tables[t].filter((r) => filters.every(([c, v]) => r[c] === v)), error: null })
        return res({ data: [api._row], error: null })
      },
    }
    return api
  } }
}

test('POST /projects then GET /projects round-trips for the owner', async () => {
  const db = fakeData()
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const created = await app.inject({ method: 'POST', url: '/projects',
    headers: { authorization: 'Bearer good' }, payload: { name: 'demo' } })
  expect(created.statusCode).toBe(201)
  const list = await app.inject({ method: 'GET', url: '/projects', headers: { authorization: 'Bearer good' } })
  expect(list.json().projects).toHaveLength(1)
})

test('POST /projects without a token is 401', async () => {
  const app = buildServer({ cfg, verifyToken: async () => null, dataForToken: () => fakeData() as any })
  const r = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x' } })
  expect(r.statusCode).toBe(401)
})

test('GET secrets seam returns decrypted project-scoped bundle', async () => {
  const db = fakeData()
  const enc = encryptSecret('postgres://conn', keks, current)
  db.tables.secrets.push({ id: 's1', owner: 'uid-1', project_id: 'p1', branch_id: null,
    name: 'DATABASE_URL', ciphertext: enc.ciphertext, nonce: enc.nonce, kek_version: enc.kekVersion })
  const app = buildServer({ cfg, verifyToken: async () => ({ id: 'uid-1' }), dataForToken: () => db as any })
  const r = await app.inject({ method: 'GET', url: '/projects/p1/secrets',
    headers: { authorization: 'Bearer good' } })
  expect(r.statusCode).toBe(200)
  expect(r.json().secrets).toEqual({ DATABASE_URL: 'postgres://conn' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane/src/server.ts`**

```typescript
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
    if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message })
    return reply.code(500).send({ error: 'internal error' }) // never echo err details (may carry secrets)
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && npx vitest run test/server.test.ts`
Expected: 3 passing tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd control-plane && npm test`
Expected: all tests green (smoke, schema, crypto, config, repos, insforge, auth, projects, server).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat: HTTP API with projects routes and secret seam"
```

---

### Task 10: Bootstrap + Dockerfile + compute deploy checkpoint

**Files:**
- Modify: `control-plane/src/index.ts`
- Create: `control-plane/Dockerfile`
- Create: `control-plane/.dockerignore`
- Create: `control-plane/.env.example`

**Interfaces:**
- Consumes: `buildServer` (9), `loadConfig` (4), `adminClient`/`userClient` (6).
- Produces: a runnable server (`npm run dev`) and a deployable container.

- [ ] **Step 1: Replace `control-plane/src/index.ts` with the real bootstrap**

```typescript
import { loadConfig } from './config.js'
import { adminClient, userClient } from './insforge.js'
import { buildServer } from './server.js'

export const version = '0.0.0'

async function main() {
  const cfg = loadConfig(process.env)
  const admin = adminClient(cfg)
  const app = buildServer({
    cfg,
    verifyToken: (token) => userClientAuth(token),
    dataForToken: (token) => userClient(cfg, token).database,
  })
  async function userClientAuth(token: string) {
    // Verify by asking the backend who this token belongs to.
    return admin.auth.getCurrentUser ? verifyVia(token) : null
  }
  async function verifyVia(token: string) {
    const u = userClient(cfg, token) as any
    const who = await u.auth?.getCurrentUser?.()
    return who?.data?.user ? { id: who.data.user.id } : null
  }
  const port = Number(process.env.PORT ?? 8080)
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`firth control-plane listening on :${port}`)
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((e) => { console.error('startup failed:', e.message); process.exit(1) })
}
```

> Note: `verifyVia` depends on the SDK's per-token `getCurrentUser`; confirm the exact call with `npx @insforge/cli docs auth typescript` and adjust `insforge.ts` if the setter/getter differs. Keep all SDK specifics inside `insforge.ts`.

- [ ] **Step 2: Create `control-plane/Dockerfile`**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
```

- [ ] **Step 3: Create `control-plane/.dockerignore`**

```
node_modules
dist
.env
.env.*
test
```

- [ ] **Step 4: Create `control-plane/.env.example`**

```
FIRTH_KEK_CURRENT=v1
FIRTH_KEK_v1=<base64-32-bytes>
INSFORGE_BASE_URL=https://u4vrn3sx.us-east.insforge.app
INSFORGE_ANON_KEY=<anon-key>
INSFORGE_ADMIN_KEY=<ik_-admin-key>
PORT=8080
```

- [ ] **Step 5: Verify the build compiles**

Run: `cd control-plane && npm run build`
Expected: `dist/` produced, no type errors.

- [ ] **Step 6: Deploy checkpoint (may be gated — do not block on failure)**

Generate a real KEK locally first: `openssl rand -base64 32`.
Run: `npx @insforge/cli compute deploy ./control-plane --name firth-control-plane --port 8080 --env-file ./control-plane/.env`
Expected: either `Service "firth-control-plane" deployed [running]` with an endpoint URL, OR a private-preview/access error. If gated, record the error and contact InsForge for compute access — the rest of the foundation is complete and locally testable regardless.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/index.ts control-plane/Dockerfile control-plane/.dockerignore control-plane/.env.example
git commit -m "feat: control-plane bootstrap + Dockerfile + deploy checkpoint"
```

---

## Self-Review

**1. Spec coverage** (spec §2/§3/§5 scope for Foundation = build-order 1–2):
- 元数据 schema (§3) → Task 2 ✓
- RLS + owner 隔离 (§3/§9) → Task 2 (policies) ✓; **gap:** live cross-user isolation test needs auth-token fixtures — not automated here. **Added as known gap** (see below), not silently skipped.
- 加密策略 KEK-outside-DB (§5) → Task 3 + Task 10 `.env`/secrets-vault note ✓
- secret 缝 (§5) → Task 9 `GET /projects/:id/secrets` ✓
- 控制面 API 骨架 on InsForge compute (§2) → Tasks 9–10 ✓ (deploy gated)
- auth Google/GitHub (§2) → relies on InsForge auth; firth API consumes tokens (Task 7). OAuth sign-in UI is in the Web plan (later), not Foundation — **intentionally out of scope here.**
- Adapters / provisioning / branching / Observe → **later plans**, correctly excluded.

**2. Placeholder scan:** No "TODO/TBD". Two explicit "confirm exact SDK call" notes (Task 6, Task 10) are isolated to `insforge.ts` and flagged, not silent — acceptable because the SDK's token-binding method is the one detail we couldn't verify offline. Everything else is complete code.

**3. Type consistency:** `EncryptedSecret{ciphertext,nonce,kekVersion}` consistent across Tasks 3/9. `SecretRow` uses snake_case DB columns (`kek_version`) and is mapped to `EncryptedSecret` (`kekVersion`) only at the decrypt call in Task 9 — consistent. `DataClient`/`QueryBuilder` defined Task 5, consumed Tasks 5/6/8/9. `resolveUid` signature consistent Tasks 7/9.

**Known gaps to fold into a later task (do not lose):**
- Automated RLS cross-user isolation test (needs two authenticated tokens / verification-disabled test users).
- Background/admin-context secret writes (provisioning saga has no user token) — addressed in the Neon-adapter plan (build-order 3).
- Moving the KEK from `.env` into InsForge secrets vault for the deployed service.

---

## Execution Handoff

Plan complete. After you pick an execution mode I'll proceed task-by-task.

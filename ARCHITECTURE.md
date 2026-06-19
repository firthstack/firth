# Firth — Architecture & Design Decisions

The *why* and *how* behind Firth: what we're building, the decisions already locked, and what's deliberately out of scope. Written for contributors and for agents reading this repo. For the strategic framing see [README.md](./README.md); for the full design spec and implementation plan see [`docs/superpowers/`](./docs/superpowers/).

---

## 1. What we're building — and what we killed

Firth is a **builder platform / agent-action control plane**: developers and their agents create projects that orchestrate third-party resources, with secrets, observability, and failure analysis layered on top as the high-value surface.

An earlier direction is **explicitly dead**: an "operational knowledge layer" that helped vibe coders + agents pick a stack, scaffold, deploy, and manage keys. It was killed by a three-way squeeze:

1. **Agents now self-select stacks and operate platforms** — the knowledge gap it sold into closed.
2. **Platforms verticalized into full-stack** (Cloudflare / Vercel / Railway) — the integration gap closed.
3. **Stripe Projects ate provision + credentials + billing** (a public catalog of dozens of providers, with provider skills auto-injected into the agent's context).

The lesson, and the principle that now governs every decision: **anything that is "knowledge" is not a moat — the agent already has it, or a connector injects it. Firth sells trust/control, which commoditization *strengthens* rather than erodes.**

Principles that survived the pivot and still hold: orchestrate providers, don't be a PaaS; emit agent-consumable output; one unified secrets boundary; agent-aware error handling; project state an agent can always read back.

## 2. Locked decisions

| Decision | Value | Consequence |
|---|---|---|
| **Role** | Orchestrator, not reseller | Resource cost passed through; profit = integration + governance. Keeps Firth a neutral judge, not a "sell more" vendor. |
| **Account-of-record** | Firth provisions under its own Neon / S3 / Fly keys | Every resource credential flows through Firth **by construction** → the enforcement chokepoint is structural, not bolted on. |
| **Resources** | Neon (DB) · S3 (storage) · Fly.io (compute) | — |
| **Hosting** | Managed SaaS | The resource layer can't be self-hosted (provider accounts + secrets live on Firth's side); trust is earned via governance auditability + compliance, not self-hosting. |
| **Credential path** | Provisioning-centric + env injection now, behind a **secret seam** | Ships fast; the seam lets us upgrade to runtime credential brokering later without rewriting apps. |
| **Branching** | DB native; storage shared; compute redeploy | See §8. |
| **Backend** | [InsForge](https://insforge.dev) | See §4. |

**Out of scope for v1:** failure-analysis triage logic (collect signals only), runtime credential brokering, parallel multi-branch compute, full billing (metering stubbed).

## 3. Two layers — never blur them

- **firth-as-tenant-of-InsForge** — Firth's *own* auth, metadata, API, and site run on InsForge.
- **firth-provisions-for-users** — Neon / S3 / Fly resources, orchestrated by adapters, created under Firth's own provider org accounts.

Two same-named-but-different concepts kept distinct in code and docs: a **`firth-meta branch`** (InsForge backend branch, for testing Firth's own backend) ≠ a **`user-project branch`** (a Neon branch Firth creates for a user's project). Likewise, the Fly org Firth opens user compute in ≠ the Fly org InsForge runs Firth's own compute in.

## 4. Surfaces and the control plane

- **Control plane API (the brain)** — runs on **InsForge compute**. The single source of truth.
- **Web app / dashboard** — runs on **InsForge sites**. For humans.
- **firth-cli** — the agent/dev interface. Like the web app, just a client of the control-plane API.

### Subsystem → InsForge primitive

| Firth subsystem | Rides on | Custom code |
|---|---|---|
| Control-plane API | InsForge **compute** + **Postgres** | orchestration (saga) |
| Firth accounts | InsForge **auth** (Google / GitHub OAuth) | ~none |
| Metadata DB | InsForge **Postgres + RLS** | migrations |
| Resource adapters | compute | **Neon / S3 / Fly adapters (the core)** |
| Secret seam | ciphertext in **Firth DB**; KEK in InsForge **secrets / compute env** | seam + scoped-env generation |
| Observability | InsForge **logs** + Postgres tables | `observe/` hook ingest + correlation |
| Metering | InsForge **scheduled jobs** (stubbed in v1) | metering logic |

The genuinely-from-scratch code is small: the three provider adapters, the orchestration + secret seam, the Observe correlation, and the CLI + web. Everything else is InsForge configuration + migrations.

## 5. Metadata schema (built)

InsForge Postgres, `public` schema, RLS on every table, `owner` denormalized onto each table for join-free non-recursive policies, `owner` immutable (trigger-guarded), `(SELECT auth.uid())` subquery form, policy/lookup columns indexed.

```
projects(id, owner=auth.uid(), name, status, created_at, updated_at)

branches(id, project_id, owner, name, parent_branch_id?, is_default,
         neon_branch_ref?,        -- per-branch Neon branch (DB is the only truly isolated resource)
         status, created_at, updated_at)

resources(id, project_id, owner, kind∈{neon|s3|fly},
          provider_ref jsonb,     -- neon project id / bucket name / fly app id
          status, created_at, updated_at)   -- project-scoped: S3 bucket & Fly app shared across branches

secrets(id, project_id, owner, branch_id?,  -- branch_id NULL → project-scoped (S3/Fly); set → that branch's DB conn
        name, ciphertext, nonce, kek_version, expires_at?, created_at)
```

## 6. Provider adapter interface (core, to build)

The three providers must present one shape so orchestration is uniform:

```ts
interface ProviderAdapter {
  kind: 'neon' | 's3' | 'fly'
  branchModel: 'native' | 'shared' | 'redeploy'
  provision(projectId): ResourceHandle              // create the base resource
  destroy(handle): void                             // for compensating rollback
  createBranch(handle, name, parentRef?): BranchRef | null   // neon=native; s3/fly=null
  mintCredentials(handle, branchRef?): SecretBundle // connection creds; DB varies per branch
  readUsage(handle): UsageSnapshot                  // metering (stubbed v1)
}
```

| | provision | branchModel | mintCredentials |
|---|---|---|---|
| Neon | project/DB in Firth's Neon org | `native` (API branch) | that branch's connection string |
| S3 | bucket in Firth's Tigris account (S3-compatible; `t3.storage.dev`) via bucket-scoped keys minted through Tigris IAM (`iam.storage.dev`) | `shared` (createBranch→null) | bucket-scoped creds |
| Fly | app in Firth's Fly org | `redeploy` (no branch) | (compute consumes others' creds) |

Adapters call provider APIs directly — we orchestrate, we don't re-abstract a provider's features (any such wrapper becomes a liability the moment the provider's API drifts).

## 7. Secret management & encryption (built)

The **secret seam** — `firth secrets <project> [--branch]` — is the *only* path that yields a credential: the control plane decrypts server-side, returns over TLS, and the CLI writes a local `.env` or injects into a Fly deploy. Apps and agents never hardcode connection strings. Today it's env injection; swapping to runtime short-lived brokering later is a change behind the seam, not an app rewrite.

Firth's DB holds every customer's resource credentials — the juiciest target on the network — so encryption is non-negotiable:

- Secret rows are **AES-256-GCM** encrypted in the app layer (fresh 12-byte nonce per encryption; auth-tag verified on decrypt).
- The **KEK lives outside this DB** (InsForge secrets / compute env), so a DB dump alone is useless. `kek_version` supports rotation. KEK labels must be uppercase (`FIRTH_KEK_V1`) to be settable as InsForge compute env keys.
- Plaintext and key material never appear in logs or error responses (the API error handler returns static strings only).
- Two classes of secret: Firth's **master provider keys** (few, rarely rotated) live in InsForge secrets / compute env; **per-project/branch derived credentials** are encrypted in the Firth DB.

## 8. Branching semantics

| Resource | On branch | Isolated? |
|---|---|---|
| DB (Neon) | native copy-on-write branch, one per branch | ✅ truly isolated |
| Storage (S3) | all branches share one bucket | ❌ not isolated |
| Compute (Fly) | not branched; redeploy to restore | n/a (reproducible) |

A branch ≈ a Neon DB branch + that branch's own secret (connection string) + the shared bucket + redeployable compute.

**Honest caveat (a known hole, not papered over):** because storage is shared, a branch gives **no isolation for S3** — an agent that deletes/overwrites objects on a branch affects the main branch, and discarding the branch won't bring them back. "branch = undo" holds for the DB only. Storage recovery needs a separate mechanism (S3 versioning, or Observe + a compensating action). Derived UX consequence: there is one Fly app per project, so deploying "on a branch" repoints that app at the branch's DB and redeploys — only one branch's compute is live at a time. Parallel multi-branch compute is a later concern.

## 9. Key flows & the provisioning saga

- **`firth project create <name>`** — insert project + default `main` branch; concurrently provision Neon (+ create its `main` branch), S3, Fly; `mintCredentials` → encrypt → store; the CLI pulls provider skills locally. Because this is multi-step across three external providers, **partial failure is the norm**: it runs as a **saga** — each step records `resources.status`, is idempotent/retryable, and on failure either resumes or compensates (destroys partial resources). Never leave orphan resources; never report false success.
- **`firth branch create <name> [--from main]`** — insert branch; `NeonAdapter.createBranch` (native); mint that branch's DB connection string; S3/Fly are no-ops (shared).
- **`firth deploy [--branch]`** — bundle source → resolve the branch's secret bundle via the seam → inject into Fly → deploy → emit a side-effect event to Observe.

## 10. Observability & failure analysis

Two event streams keyed by `(project, branch)`, correlated into one timeline:

- **Agent actions** — from the `observe/` hook (what the agent did: files edited, commands run, credentials touched) → control-plane ingest.
- **Resource side-effects** — deploys, migrations, provisioning, usage, provider logs.

The unit is "agent action ↔ resource side-effect" (e.g. *agent issued a refund → which rows changed → which credential was used*) — deliberately **not** the prompt/token/trace unit that dev-time agent-observability tools (LangSmith, Langfuse, ...) track. Failure analysis is a triage layer on top of this timeline (v1 collects the data; triage logic comes later). This is the agent-aware "what state is this project in / what just broke" surface, evolved from the old handoff idea.

## 11. Security

- Firth is a credential honeypot → §7's encryption discipline is mandatory, not optional.
- RLS isolates every tenant (the load-bearing control for a multi-tenant credential store).
- Master provider keys and per-resource derived credentials are stored separately.
- API errors return static strings; no secret/PII/error detail is ever echoed or logged.

## 12. Status, build order, and known gaps

**Built (Foundation, `control-plane/`, TypeScript/Node on InsForge):** metadata schema + RLS migration; AES-256-GCM secret module with versioned KEK; config loader; injectable repository layer; InsForge client factory (admin + per-user-token, SDK confined to one file); bearer-token auth; project service; Fastify API (`POST/GET /projects` + the `GET /projects/:id/secrets` seam); Dockerfile + bootstrap. Full test suite green.

**Build order from here:** (1) Neon adapter + `create project` saga → (2) S3 + Fly adapters → (3) branching → (4) `firth-cli` + skill download + `deploy` → (5) Observe correlation + dashboard.

**Known gaps (tracked):** automated cross-user RLS isolation test (needs authenticated-token fixtures — current tests verify policy shape); admin-context secret writes for the background saga; moving the KEK from env into the InsForge secrets vault; live compute deploy (InsForge compute is private preview and needs the project's anon key + access).

## 13. Naming

**Firth** — Scottish for a narrow inlet where a river meets the sea: the builder's work is the river, the cloud is the sea, Firth is the channel that carries it out — and now the channel every credential and action flows through. (Rejected, for posterity: `vibe`, `agent.stack`, `rig`, `keel`, `kindo` — collisions on npm/crates/existing products. `firth` was first clean across npm, pypi, and crates.io.)

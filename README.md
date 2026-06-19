# Firth

> One control plane for a project's cloud resources. Firth provisions a Postgres database, S3-compatible storage, and compute for your project, and hands them back through a single CLI and one credential file — so you (or your AI agent) can build against real infrastructure without wiring up each provider by hand.

**Status:** Early WIP — usable end to end (provision, secrets, branching, deploy), not yet hardened for production.

---

## What Firth gives you

Create a project and Firth automatically provisions three base resources, ready to build against:

- **Postgres database** ([Neon](https://neon.tech)) — your app's relational DB, connected directly (no ORM layer in front).
- **S3-compatible storage** ([Tigris](https://www.tigrisdata.com)) — object/blob storage.
- **Compute** ([Fly.io](https://fly.io)) — where your container runs.

On top of those resources:

- **Unified secrets** — one `firth secrets` writes every connection credential into a local `.env`. Credentials are never hardcoded into your app or your agent.
- **Branching** — each branch gets its **own isolated database and its own compute** (the storage bucket is shared), so you can make risky changes in isolation and merge back when verified.
- **Deploy** — ship a container image to the current branch's compute with one command.
- **Observability** — a timeline of agent actions correlated with resource side-effects, per project and branch.

Firth talks to the providers under its own accounts and passes resource cost through — you manage everything through Firth, not through each provider's console.

## Install

```bash
npm install -g firth
# or run without installing:
npx firth --help
```

## Quickstart

```bash
# 1. Sign in (use --api-url to point at a non-default control plane)
firth login --email you@example.com --password ******

# 2. Create a project — provisions DB + storage + compute, leaves you on the default branch `main`
firth project create my-app

# 3. Write the current branch's credentials into ./.env
firth secrets

# 4. Build your app against ./.env, then deploy a container image
firth deploy --image <image-url>
```

`firth status` shows your login state, linked project, and current branch. `firth --version` prints the version.

## Database & migrations

You connect **directly** to the Postgres database using the `DATABASE_URL` from `firth secrets`. Keep a **`migrations/` directory at your project root** to store and version your schema changes — this lets you replay the same schema on a branch database and re-apply it on `main` after a merge.

## Branching — isolate risky changes

Before a high-risk change (a schema migration, a data backfill, a risky refactor), do the work on a branch and merge it back when you're confident.

```bash
firth branch create my-change   # new isolated DB branch + its own compute (storage stays shared)
firth branch switch my-change   # then `firth secrets` to refresh ./.env for this branch
# ... run migrations against the branch DB, firth deploy, validate ...
```

Each branch has its own compute app, so multiple branches run in parallel without disturbing each other.

**Merging is done in your own code repo** (Firth does not auto-merge): merge the branch's code and its migration files into `main`, switch back (`firth branch switch main` → `firth secrets`), re-run the migrations against `main`'s database, and redeploy.

## Using Firth with an AI agent

Firth ships an agent skill under [`skills/firth/`](./skills/firth/) describing the full workflow (provisioning, the credential seam, branching, deploy). Point your agent at it so it treats `./.env` as the only source of resource credentials and tracks schema changes under `migrations/`.

## Repository layout

| Path | What it is |
|---|---|
| [`control-plane/`](./control-plane/) | The API server (the brain): provisioning orchestration, the secret seam, the provider adapters. |
| [`cli/`](./cli/) | The `firth` command-line interface. |
| [`dashboard/`](./dashboard/) | The web dashboard (terminal-style UI). |
| [`skills/firth/`](./skills/firth/) | The agent skill. |
| [`observe/`](./observe/) | The agent-action observability hook. |

## Architecture

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design: the two-layer model, the provider-adapter interface, the metadata schema, the secret seam, and branching semantics. The dated design specs and implementation plans live under [`docs/superpowers/`](./docs/superpowers/).

## Naming

**Firth** — Scottish for a narrow inlet where a river meets the sea. A builder's work is the river, the cloud is the sea, and Firth is the channel that carries it out reliably.

## License

TBD.

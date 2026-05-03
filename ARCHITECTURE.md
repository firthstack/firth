# Firth — Architecture & Design Decisions

This document captures the *why* behind Firth: the problem we're solving, the design choices we've already made, and the things we've explicitly chosen *not* to do. It's intended for contributors and for AI agents reading this repo to understand the project's shape.

---

## 1. Mission

> Make it possible for an AI coding agent and its human collaborator to take a web product idea from "I have a stack" to "it's live in production" without either of them needing to memorize the operational quirks of every cloud platform involved.

Concretely: Firth turns operational knowledge — which platform to pick, how to scaffold for it, how to deploy, how to manage secrets, how to debug — into a portable, versioned, agent-readable layer that lives *in the user's project*.

## 2. The problem

Vibe coders today face a workflow that looks something like:

1. They (or their agent) write app code.
2. They Google "how to deploy Next.js + Postgres on a budget."
3. They get conflicting advice from blog posts of varying ages.
4. They pick a stack semi-randomly.
5. They spend a weekend wiring up Vercel + a Postgres host + secrets + CI.
6. The deploy fails with a cryptic error. The agent can't help because the failure context is in their terminal scrollback, not in a form the agent can reason about.
7. Repeat.

The state-of-the-art alternative — "ask the agent what stack to use" — partially works, but the agent's training data is months stale, it has no awareness of the user's actual project state, and its recommendations come without runnable scaffolding or operational follow-through.

## 3. Why a "directory site" doesn't solve this

We considered (and rejected) building a curated directory of dev tools — yet another `awesome-platforms`. Three reasons it doesn't work:

1. **Information rot.** Pricing, free tiers, and product positioning change monthly. Manual lists go stale within a quarter.
2. **No decision support.** A list of 30 Postgres hosts doesn't help a beginner pick one. Lists ≠ help.
3. **No moat against AI.** A user can ask their agent the same question and get a comparable answer; there's no reason to visit a directory site.

The differentiation has to come from being *executable* and *agent-shaped*, not from being *comprehensive*.

## 4. Differentiation strategy

Firth's value sits in things a static directory and a generic AI chat *can't* easily produce:

- **Pre-validated stack templates** — not "here are 5 Postgres hosts," but "here's a complete, deployable Next.js + Neon + Vercel + Railway project, with the Skills your agent needs to operate it."
- **Agent-consumable knowledge** — Skills that teach the agent about the chosen stack, runbooks for when things break, structured CLI errors with next-step hints.
- **Project-local state** — `firth.config.ts` and `firth.lock.json` so the agent can always answer "what services does this project depend on, and what state are they in?"
- **A thin orchestration CLI** — wraps the official CLIs/APIs of each provider, doesn't reimplement them.

## 5. The three-layer architecture

```
┌──────────────────────────────────────────────────────────────┐
│  L1 — KNOWLEDGE  (this repo: firth)                          │
│      skills/  templates/  runbooks  CLAUDE.md / AGENTS.md    │
│      Static, version-controlled, ships in user's project     │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  L2 — CLI  (separate repo: firth-cli)                        │
│      firth init / deploy / secrets / logs / status / db:*    │
│      Thin orchestrator over each provider's CLI/API          │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  L3 — MCP SERVER  (future, optional)                         │
│      Structured tool calls for cases where CLI text          │
│      output is too unstructured for agents to reason about   │
└──────────────────────────────────────────────────────────────┘
```

### L1 — Knowledge layer (this repo)

- **Skills** in [Anthropic Skills format](https://docs.claude.com) — Markdown files with YAML frontmatter that teach an agent one capability each ("deploy a Next.js app to Vercel," "set up Neon Postgres with connection pooling," "diagnose a Railway build failure").
- **Templates** — fully scaffolded project starters for each golden path. Each template ships with its own `.claude/skills/` (or equivalent) directory, `RUNBOOK.md`, `CLAUDE.md` / `AGENTS.md`, `.env.example`, and CI config.
- **Runbooks** — "what to do when X breaks" guides that the agent reads when triaging issues.

A user who runs `firth init` ends up with all of L1's relevant files copied into their project, where they live alongside their app code and travel with the repo.

### L2 — CLI (separate repo, `firth-cli`)

- **Thin, not thick.** Firth's CLI does **not** abstract over providers in a way that hides their behavior. `firth deploy` reads `firth.config.ts`, figures out which providers are involved, and shells out to their official CLIs/APIs (`vercel deploy`, `flyctl deploy`, Railway API, Neon API, ...). We are the package.json scripts of the cloud, not a competing PaaS.
- **State-aware.** Every resource the CLI creates (Neon DB ID, Railway service ID, Vercel project ID) is recorded in `firth.lock.json`. This is the project's source-of-truth for "what infra exists right now."
- **Agent-friendly output.** Every command emits structured output (text + optional JSON) and, on failure, includes a likely cause and suggested next actions. See §7.

### L3 — MCP server (future)

When CLI text output isn't structured enough — e.g. an agent wants to query "all errors in the last hour" or "current row count in users table" — a Firth MCP server can expose those queries as tool calls. This is explicitly out of scope for v0.1.

## 6. Key design decisions (already settled)

### 6.1 No abstraction over provider CLIs/APIs

We call the official CLIs and APIs directly. We do not write wrappers that re-implement provider features. Reason: any wrapper we add becomes a maintenance liability the moment the provider's API drifts. The CLI's job is *orchestration*, not *abstraction*.

### 6.2 Skills format = Anthropic Skills

We adopt the Anthropic Skills format (`SKILL.md` with YAML frontmatter) as our source of truth. It's the most standardized agent-knowledge format in 2026 and has the most ecosystem traction.

If demand emerges, we'll add a `firth skills sync` (or similar) command that compiles Skills to other formats (`.cursorrules`, `.github/copilot-instructions.md`, ...). But there's a single source format.

### 6.3 Local state file: `firth.config.ts` + `firth.lock.json`

- **`firth.config.ts`** — declarative, hand-edited. Defines which providers the project uses, with which settings. Committed to git.
- **`firth.lock.json`** — generated, machine-managed. Holds resource IDs, deployment URLs, current state. Committed to git so any agent session can read it.

This split mirrors the `package.json` / `package-lock.json` pattern that developers already understand.

### 6.4 Auth & secrets

- A unified `firth secrets set/get/list` interface that syncs secrets across all providers a project uses (e.g. setting `DATABASE_URL` once pushes it to both Vercel and Railway).
- Local development: secrets land in `.env.local` (git-ignored).
- Provider auth: tokens stored in OS keychain, never in plaintext config.
- Never has the agent paste tokens into chat or code; the CLI handles all credential I/O.

### 6.5 Agent-aware error handling

Every CLI failure emits output of the form:

```
ERROR: deploy failed - Neon database connection refused
LIKELY CAUSE: connection pooler not enabled
SUGGESTED ACTIONS:
  1. Run: firth db:fix-pooling
  2. Or read: skills/neon-pooling/SKILL.md
```

This is not a stylistic choice — it's a **product decision**. Without it, an agent that hits a deploy failure has no path forward except guessing. With it, the failure is a recoverable step in the agent's loop.

### 6.6 Killer feature: `firth handoff`

Generates a single Markdown file describing:
- Current stack and provider setup
- Deployment URLs and resource IDs (from `firth.lock.json`)
- Last successful deploy, last failure, recent changes
- Known issues / open TODOs

This file is optimized for pasting into a fresh agent session. Vibe coders restart agent sessions constantly; this is the cheapest, highest-impact feature we can build to make Firth indispensable.

## 7. MVP path

We do **not** support every platform out of the gate. The first milestone is one golden path, end-to-end perfect:

> **Next.js frontend + Hono (or Express) backend + Neon Postgres + Vercel (frontend) + Railway (backend)**

The deliverable is:

1. `firth init my-app` produces a runnable project including Skills, RUNBOOK, CI.
2. `firth deploy` takes the project from local to live URLs (creating Neon DB, pushing to Vercel, pushing to Railway).
3. `firth secrets set KEY=value` syncs to Vercel + Railway.
4. Five Skills shipped with the template:
   - Stack overview
   - Deploy flow
   - Debug runbook
   - Cost & scaling considerations
   - Handoff (project state dump for fresh agent sessions)

We let real users (target: 10 vibe coders + their agents) run this for a week before deciding what to build next. The next provider is **not** prioritized until the first one's agent ergonomics are tight.

## 8. Out of scope for v1

Explicitly cut from v1 to keep scope honest:

- **AWS** — too complex for a thin orchestrator at this stage; the abstraction surface is too wide. Likely a v2 target.
- **Visual stack picker / web UI** — the interactive CLI is enough.
- **AI-powered "smart" stack recommendation** — a 60-line decision tree based on user inputs (framework, persistence needed?, budget) is sufficient.
- **MCP server** — interesting, but build only when the CLI's output truly can't carry the agent forward.
- **Affiliate / sponsored placements** — never. Firth's recommendations must be trustworthy. We will rely on donations / GitHub Sponsors if monetization is needed.
- **Multiple framework matrices** — pick one (Next.js) for v1.

## 9. Open questions

These are unresolved and will need answers before v1 ships:

- **Sustainable maintenance of pricing/free-tier data.** If we ever surface cost estimates inside the CLI, the underlying data must be auto-updated (scrape + diff) rather than hand-curated. Not a v0.1 problem, but a v1 problem.
- **Multi-agent format support.** Do we ship a `sync` command to translate Skills → `.cursorrules` etc., or do we wait for the ecosystem to converge on Skills natively?
- **Repo split granularity.** Long term, do `skills/`, `templates/`, and `firth-cli` stay in three repos, or fold back into a monorepo? Defer until contributor velocity tells us which is friction.

## 10. Naming

The project is named **Firth** — Scottish for a narrow inlet of the sea, the place where a river enters the ocean. The metaphor: a builder's code is the river, the cloud is the sea, and Firth is the channel that gets the river there reliably.

(Naming history is preserved here for posterity. We considered and rejected: `vibe`, `agent.stack`, `rig` (collision with rig.rs / rig-core LLM framework), `keel` (collision with keel.so backend service), `kindo` (collision with kindo.ai agent platform), and a long tail of common English words taken on npm. `firth` was the first candidate clean across npm, pypi, and crates.io.)

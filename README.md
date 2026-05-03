# Firth

> Cloud platform SDK for AI coding agents — help builders ship real apps with the help of their agent.

**Status:** Early WIP. APIs, Skills, and the CLI surface are still moving. Not yet recommended for production projects.

---

## Why Firth?

Modern builders — many of them "vibe coders" turning an idea into a web product with an AI coding agent at their side — have access to an embarrassment of dev infrastructure: Vercel, Railway, Fly, Neon, Supabase, Upstash, BetterStack, Resend, and on and on. The hard part isn't writing the app anymore. The hard part is the **operational layer**:

- Which platforms fit *this* project's shape and budget?
- How do I scaffold a project that's actually deployable on day one, not day fourteen?
- How do I push secrets across three providers without leaking them?
- When the deploy fails, what do I do — and can my agent help me figure it out?

AI coding agents can write the app code beautifully. They struggle with the operational layer because the relevant knowledge is scattered across docs, blog posts, and a thousand different CLI quirks.

**Firth packages that operational knowledge into something an agent can read, run, and reason about.**

## Who Firth is for

- Solo builders / vibe coders shipping web products with help from a coding agent (Claude Code, Cursor, Cline, Aider, ...).
- Small teams that want a sane default stack and don't want to reinvent deploy plumbing.
- AI agents themselves — Firth's outputs (Skills, CLI errors, lockfiles) are explicitly designed to be agent-consumable.

Firth is **not** trying to be:

- A general-purpose IaC tool (use Terraform / Pulumi).
- A PaaS (it orchestrates existing PaaS providers; it does not run your code).
- An "awesome list" of dev tools (lists go stale; Firth ships executable knowledge).

## What's in this repo?

This repo holds the **Skills bundle** and project templates — the *knowledge layer* of Firth.

```
firth/
├── README.md            ← you are here
├── ARCHITECTURE.md      ← project goals, design rationale, decisions
├── skills/              ← Anthropic-format Skills that teach agents about specific platforms
└── templates/           ← project starters for the Firth golden paths (coming soon)
```

The companion **CLI** lives in a separate repo (`firth-cli`, planned). The CLI is what agents and humans actually invoke at runtime; the Skills in this repo teach the agent *how to use the CLI* and *how to reason about the platforms underneath*.

## Architecture in one diagram

```
┌────────────────────────────────────────────────────────────────┐
│  LAYER 1 — Knowledge (this repo)                               │
│  Skills · Runbooks · Templates · CLAUDE.md / AGENTS.md         │
│  ↓ ships into the user's project as static files               │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│  LAYER 2 — CLI (firth-cli, separate repo)                      │
│  firth init · deploy · secrets · logs · status · db:*          │
│  ↓ thin orchestrator over each provider's official CLI/API     │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│  LAYER 3 — MCP server (optional, future)                       │
│  Structured tool calls when CLI text output isn't enough       │
└────────────────────────────────────────────────────────────────┘
```

The full rationale, design decisions, and MVP path are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Getting started

> The first golden path is in active development:
> **Next.js frontend + Hono backend + Neon Postgres + Vercel + Railway.**

Quickstart and installation instructions will land here once `firth-cli` reaches its first preview release.

## Roadmap snapshot

- [x] Project naming, scope, and architecture decided
- [ ] First golden path: Next.js + Hono + Neon + Vercel + Railway
- [ ] First five Skills: stack overview, deploy flow, debug runbook, cost/scaling, handoff
- [ ] `firth-cli` v0.1: `init`, `deploy`, `secrets`, `logs`
- [ ] `firth handoff` — generate a context dump for a fresh agent session
- [ ] Second golden path (TBD based on user feedback)

## Companion projects

- **`firth`** (this repo) — Skills, templates, runbooks. The knowledge layer.
- **`firth-cli`** (separate repo, planned) — The runtime CLI agents and humans invoke.

## Contributing

We're not accepting general PRs yet. The architecture is still settling. Issues with use-case feedback, missing Skills, or platform requests are very welcome.

## License

MIT (planned).

# Firth

> A builder platform for agents and developers: spin up a project with real cloud resources, and get unified secrets, runtime observability, and failure analysis on top — the things an autonomous agent actually needs to operate safely.

**Status:** Early WIP. The control-plane **Foundation** is built (auth, metadata + RLS, encrypted secret store, projects API on [InsForge](https://insforge.dev)); provider adapters, branching, and observability are next. Not yet for production.

---

## The bet (why now)

In the agent era, base infrastructure — databases, compute, storage — is commoditizing:

- Agents have no brand loyalty and don't care about dashboard polish. Dev-infra's old moats (DX, docs, community) were **all built for humans**; they evaporate the moment the buyer is an agent.
- Connectors (e.g. Stripe Projects) turn providers into **interchangeable SKUs** in a catalog. Switching cost for an agent approaches zero → a race to the cheapest → thinning margins.

**When the resource layer commoditizes, profit migrates to the layer that isn't substitutable. Only two things resist commoditization: trust/control, and data/state.** Firth sells that layer.

The structural opening: an autonomous agent with root, facing a zero-friction platform, has no party with both the incentive and the standing to be the brake / auditor / accountable party. The agent can't audit itself (judge ≠ player); the platform is mis-incentivized (its KPI is to make you do *more*). That vacuum doesn't close as models get stronger — it widens.

## What Firth is

A platform where a developer (or their agent) creates an account, then creates **projects**. Each project orchestrates three third-party base resources — **Neon** (Postgres), **S3** (storage), **Fly.io** (compute) — and layers on the high-value control surface:

- **Unified secret management** — one boundary; encrypted at rest; never hardcoded into app or agent.
- **Runtime observability** — agent actions correlated with resource side-effects, per project/branch.
- **Failure analysis** — cross-stack triage on top of that timeline.
- **Branching** — per-project branches for safe, isolated change.

Firth is an **orchestrator, not a reseller.** It provisions resources under its *own* provider accounts (account-of-record, cost passed through at/near cost), which puts it in the credential and action path *by construction* — but resources are not the profit center. **Integration + governance are the product.** Not charging a resource markup is also what keeps Firth a credible, neutral party rather than a vendor incentivized to make you consume more.

## Moat — why it holds

The most natural party to govern agents is the **harness vendor** (Claude Code hooks, OpenAI, Cursor) — the same "Stripe eats provisioning" threat, one layer up. But buyers won't accept *"the company selling you the autonomous agent also certifies that it's safe"* (judge ≠ player). The only defensible shape is:

**Independent + cross-harness + accountable/audit-grade**, anchored on the **credential boundary** as the enforcement chokepoint. Independence is both the moat and exactly the thing a harness vendor can't credibly provide.

## Go-to-market — the wedge

**Rule: don't enter as the brake** (push, high trust bar, requires enforcement). **Enter as something people already pull for** (read-only, zero blocking), then sell governance/recovery as the upgrade.

- **Today's wedge — agent credential exposure.** "Which credentials did the agent touch or leak this week across its whole action surface (chat / code / logs / sandbox)?" — read-only audit. That's a security incident *today*, with budget, independent of whether the agent is in production yet. (See `observe/` for the first read-only scanner.)
- **Expansion** — observe credential exposure → broker short-lived scoped credentials → become the gate for production actions (the enforcement layer) → governance / audit / recovery.

The rare alignment at the core of this thesis: **the cheapest wedge to enter (credential-exposure audit) and the most defensible moat (credential-boundary enforcement) are the same surface.** Other wedges are merely "on the way"; this one *is* the moat being built.

## The risk we accept

**Timing.** Most teams haven't put agents directly into production yet, so the highest-value buyer ("the agent broke prod") isn't born.

- **The bet:** "agents in production" is inevitable within the fundable window (~18–24 months).
- **Mitigation:** enter at pain that already hurts in dev/CI and lies on the path to production.
- **Survival line:** can the cheap dev/credential pain sustain us until the production-governance market arrives?
- **Validation discipline (Mom Test):** count teams that have already *spent time or money* on this problem — not those who say "nice idea." A request to be introduced or shown their current workaround is signal; verbal praise is not.

## Status & roadmap

- [x] Strategy converged; design spec + Foundation implementation plan written.
- [x] **Foundation** — control plane on InsForge: auth, metadata schema (projects / branches / resources / secrets) with RLS, AES-256-GCM secret store + the single secret seam, projects API.
- [ ] Provider adapters: Neon → S3 → Fly.io, with `create project` saga + rollback.
- [ ] Branching (Neon-native DB branch; shared storage; redeploy compute).
- [ ] the firth CLI + provider-skill download + `deploy`.
- [ ] Observability: agent-action ↔ resource-side-effect correlation + dashboard.

## Architecture

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full design — two-layer model, the InsForge mapping, the metadata schema, the provider-adapter interface, the secret seam, branching semantics, and the build order. The dated design spec and implementation plan live under [`docs/superpowers/`](./docs/superpowers/).

## Naming

**Firth** — Scottish for a narrow inlet where a river meets the sea. A builder's work is the river, the cloud is the sea, and Firth is the channel that carries it out reliably — now also the channel every credential and action flows through.

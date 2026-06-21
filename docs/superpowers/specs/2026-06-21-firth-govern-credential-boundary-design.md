# Govern at the Credential Boundary — Design (v1)

**Date:** 2026-06-21
**Status:** Approved (pending spec review)

## Goal

Put a policy checkpoint in front of Firth's high-blast-radius actions. Before a gated action runs, the control plane consults a per-project policy and decides **allow / deny / require-approval**. "Require-approval" pauses the action until a human grants a **one-shot** approval. Every decision is recorded on the Observe timeline. This is the Govern layer — the enforcement chokepoint at the credential boundary (the secret seam) and the destructive control-plane actions.

The compelling default: `project.delete` requires approval out of the box, so an autonomous agent cannot tear down a project without a human in the loop; everything else flows until the developer tightens it.

## Scope

This is the **Govern @ the seam** slice of the larger Govern/Recover phase. Out of scope (separate specs): runtime credential brokering (short-lived per-action creds); multi-user / role-based approvers; fine-grained per-resource approval scope; the Recover layer (compensating actions).

## Gated actions

| action | where it's enforced | default decision |
|---|---|---|
| `secrets.read` | `GET /projects/:id/secrets` | `allow` |
| `deploy` | `POST /projects/:id/deploy` | `allow` |
| `project.delete` | `DELETE /projects/:id` | `approve` |
| `branch.delete` | `DELETE /projects/:id/branches/:bid` | `allow` |

`DEFAULTS` is a code constant; its keys are the canonical gated-action set. The deploy-token route is not separately gated (it's a step of deploy).

## Data model (InsForge Postgres, owner-scoped RLS, like the rest)

```
governance_rules(id, project_id, owner, action, decision∈{allow,deny,approve},
                 created_at, updated_at)            -- UNIQUE(project_id, action); OVERRIDES only
approvals(id, project_id, owner, action,
          status∈{pending,granted,denied,consumed}, -- default 'pending'
          requested_at, decided_at?)                -- index (project_id, action, status)
```

- `governance_rules` stores **overrides only** — the effective decision for an action is `rule.decision ?? DEFAULTS[action]`. (Minimal storage; no row needed for defaults.)
- `approvals` is the one-shot grant ledger. RLS: `owner = auth.uid()` on both, `owner` denormalized + immutable (trigger-guarded), matching the existing tables. Grants: `SELECT, INSERT, UPDATE` to `authenticated`.

## `GovernService` (`control-plane/src/services/govern.ts`)

```ts
type GateResult =
  | { decision: 'allow' }
  | { decision: 'deny' }
  | { decision: 'approval_required'; approvalId: string }
  | { decision: 'approved'; approvalId: string }

class GovernService {
  constructor(db: DataClient)
  gate(owner: string, projectId: string, action: GatedAction): Promise<GateResult>
  effectivePolicy(owner: string, projectId: string): Promise<Record<GatedAction, Decision>>
  setRule(owner: string, projectId: string, action: GatedAction, decision: Decision): Promise<void>
  listApprovals(owner: string, projectId: string, status?: ApprovalStatus): Promise<ApprovalRow[]>
  decide(owner: string, projectId: string, approvalId: string, status: 'granted' | 'denied'): Promise<ApprovalRow>
}
```

`gate` logic (the heart):
- `effective = (override for (project, action)) ?? DEFAULTS[action]`.
- `allow` → `{ allow }`.
- `deny` → `{ deny }`.
- `approve` → look up the oldest `granted` approval for `(project_id, action)`. If found → `markConsumed(id)` → `{ approved, approvalId }`. Else → insert a `pending` approval → `{ approval_required, approvalId }`.
- **Matching is by `(project_id, action)`** in v1 (coarse: approving `deploy` grants the next deploy on that project). Finer per-resource scope is a future refinement.
- A grant is **consumed when the gate passes**, before the action runs. If the action then fails (e.g. a deploy error), the grant is still spent — the human re-approves to retry. (v1 simplification: the approval authorizes one *attempt*, not one *success*.)

A small `GovernanceRepo` (`db/repos.ts`) backs it: `findRule`, `upsertRule`, `createApproval`, `findGrantedApproval`, `markConsumed`, `listApprovals`, `decideApproval`. Reuses the injectable `QueryBuilder` (`insert`/`upsert`/`update`/`select`/`eq`); `upsertRule` uses `onConflict: 'project_id,action'`.

## Enforcement at the routes (`server.ts`)

Each gated route calls `gate(uid, projectId, action)` **before** doing its work, and branches:
- `allow` → proceed (no event — keep the timeline signal-rich, not noisy).
- `approved` → emit `govern.approved`; proceed.
- `deny` → throw `ForbiddenError('<action> denied by policy')` → **403** (new error class + handler mapping).
- `approval_required` → emit `govern.pending`; reply **202** `{ status: 'approval_required', approvalId, action, message }`; **do NOT perform the action**.

`message` is a static, helpful string: `"<action> requires approval — have a human run \`firth approve <id>\`, then retry"`. The 202 carries no secret/credential data.

For the secret seam (a GET), a 202 with the approval body is acceptable — the body's `status` field tells the client it's a gate, not the secrets bundle.

## Approval + policy API

- `GET /projects/:id/approvals?status=pending` → `{ approvals }`.
- `POST /projects/:id/approvals/:aid/approve` → `decide(...,'granted')` → the approval row (404 if not found / not owned).
- `POST /projects/:id/approvals/:aid/deny` → `decide(...,'denied')`.
- `GET /projects/:id/policy` → `{ policy: effectivePolicy }` (defaults merged with overrides).
- `PUT /projects/:id/policy/:action` body `{ decision }` → `setRule(...)` → the effective policy (400 on an unknown action or invalid decision).

All owner-scoped (bearer auth like the rest).

## CLI

- `firth approvals` — list pending approvals (id, action, requested_at).
- `firth approve <id>` / `firth deny <id>` — decide an approval.
- `firth policy` — show the effective policy; `firth policy set <action> <allow|deny|approve>` — set an override.
- **Gated commands** (`deploy`, `project delete`, `branch delete`, `secrets`) detect a `{ status: 'approval_required' }` response and print: `⛔ <action> requires approval (id <id>) — have a human run \`firth approve <id>\`, then re-run.` and return exit 1 (the action did not complete). On the retry after approval, the response is the normal success body.
- `FirthApi` gains: `listApprovals`, `approve`, `deny`, `getPolicy`, `setPolicy`.

## Dashboard (last task — droppable to a fast-follow)

An **Approvals panel** in the dashboard: list the project's `pending` approvals (action + requested time) with **[approve]** / **[deny]** buttons wired to the API; refresh on action. Surfaced on the project-detail view. No policy editor in v1 (CLI-only) — keep the UI minimal.

## Timeline & events

Govern decisions are emitted onto the existing `events` timeline (the `emit` helper, `source: 'resource'`):
- `govern.pending` — a gated action created a pending approval (payload: `{ action, approvalId }`).
- `govern.approved` — a granted approval was consumed (payload: `{ action, approvalId }`).
- `govern.denied` — an approver denied (emitted from the deny route; payload `{ action, approvalId }`).

So the audit story reads end-to-end: *agent requested `project.delete` → `govern.pending` → human approved → `govern.approved` → `project.delete`.* (A `deny`-by-policy 403 is not emitted in v1 — the action never started; revisit if we want denial telemetry.)

## Error handling & security

- New `ForbiddenError` (in `auth.js` with the other typed errors) → `setErrorHandler` maps it to `403 { error: err.message }` (message is the static "<action> denied by policy").
- Owner-scoped throughout (RLS); v1 approver = the project owner (the human approving their agent's request — the circuit-breaker value holds even at the same identity).
- Approval/policy payloads carry no secrets. Existing static-error discipline preserved.
- A gated action that is denied or pending must NOT have run (the gate is checked first, before any provisioning/teardown/deploy/secret-decrypt).

## Testing (offline, fakes)

**Control plane:**
- `GovernService.gate`: allow→allow; deny→deny; approve with no grant → creates a pending approval + returns `approval_required`; approve with an existing `granted` → consumes it (status→consumed) + returns `approved`; `effectivePolicy` merges defaults+overrides; `setRule` upserts; `decide` flips pending→granted/denied.
- Routes: `project.delete` with default policy → 202 `approval_required` + a pending approval exists + the project is NOT torn down; after `POST …/approve` + a re-DELETE → teardown proceeds (grant consumed); `PUT /policy/project.delete {decision:'deny'}` → DELETE → 403, not torn down; `secrets.read` default allow → returns the bundle (no gate); an unknown action on `PUT /policy` → 400; approvals list/approve/deny; the timeline shows `govern.pending`/`govern.approved`.
- The gate runs before the action (assert the side-effecting adapter/teardown was never called on deny/pending).

**CLI:** gated command on a `approval_required` response prints the message + exits 1; `firth approve <id>` calls the route; `firth policy set` calls the route; offline (fake api).

**Dashboard:** the Approvals panel lists pending + approve/deny call the API (offline fake api + jsdom).

## Build order (informs the plan)

1. Migration (`governance_rules` + `approvals` + RLS/grants/indexes) + `GovernanceRepo` + row types.
2. `GovernService` (gate/effectivePolicy/setRule/listApprovals/decide) + `ForbiddenError` + handler mapping + unit tests.
3. Enforce `gate` at the 4 routes (202/403/proceed) + `govern.*` timeline events + route tests.
4. Approval + policy API routes (approvals list/approve/deny; policy get/set) + tests.
5. CLI: `FirthApi` methods + `approvals`/`approve`/`deny`/`policy` commands + gated-command `approval_required` handling + tests.
6. Dashboard Approvals panel (list + approve/deny) + tests. (Last; droppable.)

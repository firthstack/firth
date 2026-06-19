# Firth Per-Branch Isolated Compute — Design

**Date:** 2026-06-19
**Status:** Approved (pending spec review)

## Goal

Give every project branch its own **isolated compute** (a dedicated Fly app), so a branch is a fully isolated environment for risky changes. The Neon DB is already per-branch; the **storage bucket stays project-shared**. This reverses the current v1 model (*"compute not branched; redeploy to restore"*, with *"parallel multi-branch compute"* listed out of scope in ARCHITECTURE.md §2/§8).

**Model:** a branch = { its Neon DB branch, its Fly app } + the shared bucket. `main` is just the default branch and owns the Fly app provisioned at project-create. Compute is provisioned **eagerly** at branch-create.

## Non-Goals

- Cross-branch compute orchestration / autoscaling / multi-region per branch.
- A deploy UI in the dashboard (deploy stays CLI-driven).
- Per-branch storage (the bucket is deliberately shared across branches).

## Data model — branch-aware `resources`

Today `resources` is project-scoped: `UNIQUE(project_id, kind)`, one `fly` row per project. Make it branch-aware:

- Add `branch_id UUID NULL REFERENCES public.branches(id) ON DELETE CASCADE` to `public.resources`.
- `neon` and `s3` rows remain project-scoped (`branch_id IS NULL`); `fly` rows are **per-branch** (`branch_id` set, including `main`'s).
- Replace `UNIQUE(project_id, kind)` with `UNIQUE(project_id, branch_id, kind)`. (Project-scoped `neon`/`s3` keep one row each — the provisioning saga inserts exactly one; the NULL `branch_id` makes the constraint non-enforcing for them, which is acceptable since nothing inserts duplicates.)
- Index `idx_resources_branch ON resources(branch_id)` for the per-branch lookups.
- RLS/grants unchanged (owner-scoped, already in place).

**Why not store the Fly app on the `branches` row?** It splits the canonical "what's provisioned" store; teardown (which iterates `resources`) would need two sources. Keeping compute in `resources` lets project teardown destroy every branch's app by iterating one table.

### Existing-project migration (data backfill)

The migration backfills existing `fly` rows to their project's default branch so live projects (e.g. `first`) keep working without re-provisioning:

```sql
UPDATE public.resources r
SET branch_id = (SELECT b.id FROM public.branches b
                 WHERE b.project_id = r.project_id AND b.is_default AND b.archived_at IS NULL)
WHERE r.kind = 'fly' AND r.branch_id IS NULL;
```

This is a schema change + a one-time data backfill on the live InsForge DB (applied via `db migrations up`).

## Flows

### project create (ProvisioningService)
Unchanged shape, one tweak: the `fly` resource row is inserted with `branch_id = defaultBranch.id` (main's compute). `neon`/`s3` stay `branch_id NULL`. The parallel saga + best-effort rollback are unchanged.

### branch create (BranchService) — now a 2-resource saga
`firth branch create` (eager) does, in order:
1. Create the branch row (`status: 'creating'`).
2. Provision the **Neon DB branch** (existing): `neon.createBranch` → `neon_branch_ref`; mint the branch-scoped `DATABASE_URL` secret.
3. Provision a **new Fly app** for the branch: `fly.provision(<name>)` → `{flyApp, orgSlug}`; insert a `fly` resource row with `branch_id = <new branch>`, `status: 'active'`.
4. Mark the branch `active`.

**Rollback (best-effort, never masks the original error):** if the Fly provision (or any later step) fails after the Neon branch exists, delete the Neon branch (`neon.deleteBranch`) and any inserted rows are marked `error` — mirroring the project-create saga's compensating rollback.

### deploy (DeployService + `/deploy` + CLI)
`firth deploy` targets the **current branch's** compute:
- The CLI sends the current branch (from `./.firth/project.json`) to `POST /projects/:id/deploy` (`{ image, branch, port? }`; default = the project's default branch).
- `DeployService` resolves the **branch's** `fly` resource (`ResourcesRepo` lookup by `project_id` + `branch_id` + `kind='fly'`), and injects that branch's secrets: the branch-scoped `DATABASE_URL` + the project-scoped `AWS_*`/bucket (the seam already merges both scopes).
- Each branch's Fly app has its own `https://<app>.fly.dev` URL; the deploy result returns it.

### branch delete (TeardownService.deleteBranch)
Destroy the branch's Fly app (find its `fly` resource → `fly.destroy`, then `markStatus('destroyed')` on that resource row) **and** the Neon branch (`neon.deleteBranch`), then archive the branch row. Best-effort per-resource (failures recorded in `teardown.failed`, not thrown). Default branch still undeletable. (Branches are soft-archived, so the `resources.branch_id` `ON DELETE CASCADE` does not fire — the row is explicitly marked `destroyed` instead.)

### project delete (TeardownService.deleteProject)
Iterate **all** of the project's `resources` (now including every branch's `fly` app + the Neon project + the bucket) and destroy each via its adapter; archive the project. Per-branch apps are destroyed for free because they're rows in `resources`. **Skip resources already `status='destroyed'`** (e.g. a previously deleted branch's Fly app) so teardown doesn't try to re-destroy a gone app and spuriously report a failure.

## Affected components

- **Migration** — `resources.branch_id` + constraint swap + index + backfill.
- **`src/db/types.ts` / `repos.ts`** — `ResourceRow` gains `branch_id`; `ResourcesRepo` gains a branch-scoped lookup (e.g. `findByKindForBranch(owner, projectId, branchId, kind)`) and `listByProject` already returns all rows.
- **`ProvisioningService`** — tag the `fly` resource with the default branch id.
- **`BranchService`** — provision + record the branch's Fly app; 2-resource rollback.
- **`DeployService` + `server.ts` `/deploy`** — branch-aware target + secret scope.
- **CLI `deploy`** — pass the current branch.
- **Dashboard** — the detail endpoint already returns the `resources` array; with multiple `fly` rows (one per branch) it now also returns each fly row's `branch_id`. The ProjectDetail **compute** card lists one entry per branch's Fly app (app name + status, labeled by branch name via the branches list) instead of a single project compute. Whitelist already covers `flyApp`/`orgSlug`; it must also pass through `branch_id` (non-secret) on `fly` rows.
- **ARCHITECTURE.md** — flip the branching/compute lines (compute is now per-branch isolated; remove "parallel multi-branch compute out of scope").

## Error handling

- branch-create saga: compensating rollback (delete the Neon branch if Fly provisioning fails); the new branch's Fly app is rolled back if a later step fails. Never mask the original error.
- deploy: if the branch has no `fly` resource (shouldn't happen with eager provisioning, but e.g. a half-rolled-back branch), return a clear error rather than deploying to the wrong app.
- All provider-error strings stay static/controlled in API responses.

## Testing

Offline, against the existing in-memory `DataClient` + fake adapters (no live providers):
- branch create provisions a Fly app (asserts a `fly` resource row with the branch's `branch_id`) + the Neon branch; a failing Fly provision rolls back the Neon branch.
- deploy resolves and deploys to the **current branch's** Fly app (not another branch's), with the branch's secrets merged.
- branch delete destroys that branch's Fly app + Neon branch; other branches' apps untouched.
- project delete destroys every branch's Fly app + project resources.
- repo: branch-scoped `fly` lookup; `listByProject` returns per-branch fly rows.
- migration backfill is verified live (constraint present, existing `fly` rows now carry a `branch_id`).

## Build order (informs the plan)

1. Migration (branch_id + constraint + index + backfill) + `ResourceRow`/repo lookup.
2. `ProvisioningService` tags main's fly with the default branch id.
3. `BranchService` eager Fly provisioning + 2-resource rollback.
4. `DeployService` + `/deploy` + CLI deploy → branch-aware.
5. `TeardownService.deleteBranch` destroys the branch's Fly app.
6. Dashboard compute card per-branch + ARCHITECTURE.md update.

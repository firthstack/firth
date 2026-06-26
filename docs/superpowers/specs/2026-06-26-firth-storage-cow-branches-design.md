# Firth Copy-on-Write Storage Branches — Design

**Date:** 2026-06-26
**Status:** Approved (pending spec review)

## Goal

Give every project branch its own **isolated storage** via a Tigris copy-on-write
(CoW) bucket fork, closing the gap [ARCHITECTURE.md §8](../../../ARCHITECTURE.md)
flags: today *"a branch gives no isolation for S3 — an agent that deletes/overwrites
objects on a branch affects main, and discarding the branch won't bring them back."*
With this change, an agent working on a branch can read, overwrite, and delete objects
without ever touching the parent branch's bucket, and deleting the branch discards its
storage along with its DB — so **"branch = safe sandbox / undo" now holds for storage too**,
matching the Neon DB model.

Tigris ships bucket forking as of the
[bucket-forking deep dive](https://www.tigrisdata.com/blog/bucket-forking-deep-dive/):
a forked bucket shares its parent's objects (CoW) and only stores divergence, so isolation
is cheap. Firth already talks to Tigris over raw SigV4 S3 HTTP, so this is additive headers
on calls Firth already makes — **no schema migration**.

**Model:** a branch = { its Neon DB branch, its Fly app, **its forked bucket** }. `main` is
the default branch and owns the project's root bucket created at project-create. Storage forks
**eagerly** at branch-create, exactly like the Neon DB branch does today (chosen over a lazy
Fly-style model so isolation holds for `firth secrets` / local dev, not only for deploy).

## Non-Goals

- **Migrating legacy buckets.** Snapshots must be enabled at bucket creation and cannot be
  retrofitted, so only buckets created after this ships are forkable. Existing projects keep
  today's shared-storage behavior (branch create still succeeds; storage just isn't isolated).
  No data copy, no surprise cost.
- **User-facing snapshot / point-in-time commands** (`firth storage snapshot`, fork-from-snapshot).
  The headline is per-branch isolation; explicit snapshots are a separable follow-up.
- **Restoring a deleted branch's storage.** Branch delete is destructive (the parked Recover
  layer stays parked).

## Tigris fork API (external dependency)

Confirmed against current Tigris docs (`/buckets/snapshots-and-forks`, `/forks`):

- **Enable snapshots** (prerequisite for forking) — header on `CreateBucket`/`PUT /{bucket}`:
  `X-Tigris-Enable-Snapshot: true`. **Must be set at creation; cannot be retrofitted, and a
  source bucket must be snapshot-enabled to be forkable.**
- **Create a fork** — `PUT /{newBucket}` with `X-Tigris-Fork-Source-Bucket: {parentBucket}`.
  Optional `X-Tigris-Fork-Source-Bucket-Snapshot: {version}`; **omitted** ⇒ Tigris snapshots
  the source at fork time, which is exactly our "fork from now" semantics.
- **Check enablement** — `HEAD /{bucket}` returns `X-Tigris-Enable-Snapshot: true`.
- CoW billing: shared objects billed once on the parent; only diverged/new objects bill on the
  fork — reclaimed when the branch (and its bucket) is deleted.

**To verify during implementation** (not fully settled by docs): whether a freshly-forked bucket
must *itself* carry `X-Tigris-Enable-Snapshot: true` to be re-forkable (for grandchild branches).
We pass it defensively on every fork and confirm against the live API.

## Data model

**No migration needed.** The `resources` table already has `branch_id` and the
`UNIQUE(project_id, branch_id, kind)` index from
[migration 20260619213418](../../../migrations/20260619213418_resources-branch-id.sql).
The forked bucket is modeled as a **branch-scoped `s3` resource row** (`branch_id` set),
exactly like the per-branch Fly app — *not* like Neon (which keeps one project row + a ref
column). This keeps the canonical "what's provisioned" store in one table so project teardown
destroys every branch's bucket by iterating `resources`.

- Project **root** bucket: `s3` row with `branch_id IS NULL` (owned by `main`).
- Branch **fork** bucket: `s3` row with `branch_id = <branch>`.
- `forkable` marker lives on the root bucket's `provider_ref` (`snapshotEnabled: true`).
  Legacy roots lack it ⇒ branch-create skips forking and keeps shared behavior.

`TigrisRef` ([tigris.ts:9](../../../control-plane/src/adapters/tigris.ts#L9)) gains
`snapshotEnabled?: boolean`.

## Flows

### project create (ProvisioningService)
Unchanged shape. `TigrisAdapter.provision()` now sends `X-Tigris-Enable-Snapshot: true` and
records `snapshotEnabled: true` on the `TigrisRef`. The root `s3` row stays `branch_id NULL`,
project-scoped `AWS_*` secrets stay `branch_id NULL` — unchanged.

### branch create (BranchService) — now forks storage too
After the existing Neon-branch + `DATABASE_URL` steps
([branches.ts:31-46](../../../control-plane/src/services/branches.ts#L31)), if the project's
**root** `s3` resource is forkable:

1. Resolve the **parent branch's** bucket ref: parent = default ⇒ the root `s3` row
   (`branch_id IS NULL`); parent = non-default ⇒ the parent's branch-scoped `s3` row. (Mirrors the
   DB `--from` semantics; CoW chains are fine — Tigris does recursive parent lookups.)
2. `tigris.forkBucket(parentRef, projectName)` → `PUT /{forkBucket}` with
   `X-Tigris-Fork-Source-Bucket: {parentBucket}` (+ enable-snapshot) → full `ResourceHandle`.
3. Insert a branch-scoped `s3` `resources` row (`branch_id = <new branch>`, `status: 'active'`).
4. `tigris.mintCredentials(handle)` → bucket-scoped IAM key + policy (reuses existing minting).
5. Store the 5 `AWS_*` values as **branch-scoped** secrets (`branch_id = <new branch>`).

All 5 `AWS_*` keys are re-minted for the fork, so they **fully override** main's project-scoped
creds in the merge — no parent-bucket credential leaks to the branch.

### firth secrets / deploy — no code change
Both already merge `{...projectScoped, ...branchScoped}` (branch wins):
[secrets.ts:24-28](../../../cli/src/commands/secrets.ts#L24),
[deploy.ts:49-56](../../../control-plane/src/services/deploy.ts#L49). A forked branch's
branch-scoped `AWS_*` transparently overrides main's; `main` (no branch-scoped `AWS_*`) keeps the
root bucket. **The isolation seam is the secret layering that already exists.**

### branch delete (TeardownService.deleteBranch)
In addition to the Neon branch + Fly app, destroy the branch's `s3` fork resource: find its `s3`
row (`branch_id = <branch>`), `tigris.destroy(handle)` (empties the bucket + deletes it + tears
down the IAM key/policy — all existing code), then `markStatus('destroyed')`. Best-effort per
resource (failures recorded in `TeardownSummary.failed`, not thrown). Default branch still
undeletable.

### project delete (TeardownService.deleteProject)
Unchanged — already iterates **all** `resources` and destroys each via its adapter. Per-branch
fork buckets are destroyed for free because they're `s3` rows. Already skips `status='destroyed'`.

## Affected components

- **`adapters/tigris.ts`** — `branchModel: 'shared'` → `'fork'`; `provision()` sends the
  enable-snapshot header + records `snapshotEnabled`; new `forkBucket(parentRef, projectName)`;
  `destroy()` reused as-is for fork buckets.
- **`adapters/types.ts`** — add `'fork'` to the `branchModel` union.
- **`db/repos.ts`** — `ResourcesRepo.findByKind` for `s3` must filter `branch_id IS NULL` to
  return the **project root** bucket (otherwise a fork row could be returned). Add a helper to
  resolve a branch's bucket (root for default, branch-scoped otherwise).
- **`services/branches.ts`** — eager storage fork inside the existing create saga + rollback.
- **`services/teardown.ts`** — `deleteBranch` destroys the branch's fork bucket (mirrors Fly).
- **`ARCHITECTURE.md §8`** — flip the storage lines: storage is per-branch CoW-forked for new
  projects (isolation holds for storage); note the legacy-project caveat.

## Error handling

- branch-create: the storage fork slots into the **existing** compensating rollback
  ([branches.ts:52-57](../../../control-plane/src/services/branches.ts#L52)). If `forkBucket` or
  cred-mint fails after the Neon branch exists, destroy the fork bucket + IAM and the Neon branch,
  mark the branch `error`, and **never mask the original error**. Same pattern as today.
- teardown: per-resource best-effort; a failed bucket destroy is recorded in
  `TeardownSummary.failed`, not thrown.
- All provider-error strings stay static/controlled in API responses (no raw provider text leaked
  through governance, per the §8 credential-boundary rule).

## Testing

Offline, against the in-memory `DataClient` + fake adapters (the `TigrisAdapter` fake gains
`forkBucket` + snapshot-aware `provision`):

- project create: root bucket is created snapshot-enabled (`provision` sent enable-snapshot;
  `provider_ref.snapshotEnabled === true`).
- branch create (forkable project): inserts a branch-scoped `s3` row; mints + stores
  branch-scoped `AWS_*`; the fork sourced from the **parent** branch's bucket (assert the
  fork-source passed). A failing `forkBucket` rolls back the Neon branch and marks the branch
  `error`.
- branch create (legacy project, no `snapshotEnabled`): no `s3` fork row; storage stays shared;
  branch still `active`.
- secrets/deploy: a forked branch resolves the **fork** bucket creds (override), `main` resolves
  the root bucket; no cross-branch leak.
- branch delete: destroys the branch's fork bucket (`s3` row → `destroyed`); other branches'
  buckets untouched; default branch undeletable.
- project delete: destroys root + every branch's fork bucket.
- repo: `findByKind('s3')` returns the root (NULL `branch_id`), not a fork row; branch-bucket
  resolver returns root for default and the branch row otherwise.

## Build order (informs the plan)

1. `adapters/types.ts` + `adapters/tigris.ts`: `'fork'` model, enable-snapshot on `provision`,
   `forkBucket`, `TigrisRef.snapshotEnabled`; update the Tigris fake.
2. `db/repos.ts`: root-vs-fork `s3` lookups.
3. `services/branches.ts`: eager storage fork + rollback.
4. `services/teardown.ts`: `deleteBranch` destroys the fork bucket.
5. `ARCHITECTURE.md §8` update.
6. Verify the re-forkability header behavior against the live Tigris API.

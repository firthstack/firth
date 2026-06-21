# Source-Mode Deploy for Firth — Design

**Date:** 2026-06-20
**Status:** Approved (pending spec review)

## Goal

Let a developer deploy a project from **source** — `firth deploy <dir>` builds the `Dockerfile` in `<dir>` and runs it on the branch's compute — instead of being forced to pre-build a container image and push it to a registry first (`firth deploy --image <url>`). Modeled on the InsForge CLI's `compute deploy` source mode (`~/Work/InsFg/CLI/src/lib/flyctl.ts` + `commands/compute/deploy.ts`): the build runs on **Fly's remote builder** (no local Docker), authorized by a short-lived, app-scoped deploy token the control plane mints.

## Non-Goals

- **Local-Docker build path.** Source builds go to Fly's remote builder only; we never require a local Docker daemon.
- **Building inside the control plane.** The user's source never transits Firth; it streams straight to Fly's builder. The control plane only mints the token and (via the existing path) launches the machine.
- **Changing the launch or secret-injection path.** Source mode reuses the existing `POST /projects/:id/deploy` to launch the built image with the branch's secrets.
- Multi-process / volumes / custom `fly.toml` topologies beyond a single HTTP/TCP service.

## Architecture (Approach A)

The build happens **CLI-side** (`flyctl` remote build) using a token the **control plane** mints. The only new server surface is a token endpoint; the launch is entirely reused.

```
firth deploy <dir>
  └─ CLI: require Dockerfile + flyctl
  └─ POST /projects/:id/deploy-token { branch }        → { token, expirySeconds, flyApp }   [NEW]
  └─ flyctl deploy --remote-only --build-only --push --app <flyApp>  (FLY_API_TOKEN=token)
        → Fly remote builder builds + pushes registry.fly.io/<flyApp>@sha256:<digest>
  └─ POST /projects/:id/deploy { image: <digest ref>, branch, port }  → { machineId, url } [EXISTING]
```

## Components

### CLI — `firth deploy [dir] [--image <url>] [--port <n>] [--from <branch>]`

`cli/src/commands/deploy.ts` gains a positional `dir`:
- `dir` present → **source mode**. `--image` present → **image mode** (unchanged). Both → error (`pick one mode`). Neither → error (`provide <dir> or --image`).
- Shared: `--port` (default unchanged), `--from <branch>` (explicit branch override; otherwise the linked branch).

Source mode steps (compute the branch fields **once** — `const from = values.from` and `const branch = link.branch?.id ?? link.branch?.name` — and pass the same pair to both calls so the token and the launch target one app):
1. Resolve `absDir = resolve(dir)`; require `<absDir>/Dockerfile` (else a clear error pointing to `--image` or creating a Dockerfile).
2. `ensureFlyctl(deps)` — reuse the existing auto-installer in `cli/src/fly.ts` (Homebrew install when missing).
3. `const { token, flyApp } = await api.mintDeployToken(projectId, { from, branch })`.
4. `const { imageRef } = await flyctlBuildAndPush({ dir: absDir, flyApp, imageLabel: 'cli-' + Date.now(), token, port })`.
5. `const out = await api.deploy(projectId, { image: imageRef, from, branch, port })`.
6. Print `deployed machine <id> → <url>` (same as image mode), plus `image: <imageRef> (built remotely)`.

### CLI — `cli/src/flyctl-build.ts` (new), modeled on InsForge `lib/flyctl.ts`

- `flyctlBuildAndPush(opts: { dir; flyApp; imageLabel; token; port; protocol? }): Promise<{ imageRef: string }>`:
  - Write a stub `fly.toml` **iff** the dir has none (return a cleanup callback; run it in `finally`; if the user has a `fly.toml`, leave it). Minimal stub: `app = "<flyApp>"`, `primary_region = "iad"`, `[build]`, and an `[http_service]`/`[[services]]` block for the port. Region is build-config only (`--build-only` places no machines; the real machine is launched by `DeployService`).
  - Spawn `flyctl deploy --remote-only --build-only --push --app <flyApp> --image-label <imageLabel> --no-cache` with `env: { ...process.env, FLY_API_TOKEN: token }`, cwd `dir`; tee stdout/stderr to the user **and** capture.
  - On non-zero exit → throw with the streamed output referenced. On success, parse the digest: `/pushing manifest for registry\.fly\.io\/[^\s]+@(sha256:[0-9a-f]+)/` → return `registry.fly.io/<flyApp>@<digest>`. If the manifest line is absent → throw (cannot determine digest).
- `parseImageDigest(output: string, flyApp: string): string | null` — the regex extractor, unit-tested in isolation.

### CLI — `FirthApi.mintDeployToken(projectId, opts)`

`cli/src/api.ts`: `mintDeployToken(projectId: string, opts: { from?: string; branch?: string })` → `POST /projects/:id/deploy-token` with `{ from, branch }`, returns `{ token: string; expirySeconds: number; flyApp: string }`.

### Control plane — `POST /projects/:id/deploy-token`

`control-plane/src/server.ts`:
- Auth (bearer) as other routes.
- Resolve the target branch (same logic as `/deploy`: `body.from ?? body.branch ?? default branch`).
- `findByKindForBranch(uid, projectId, branchId, 'fly')` → the branch's Fly resource. Absent → `400`/`404` static error (`branch has no fly resource`).
- `const { token, expirySeconds } = await fly.mintDeployToken({ kind:'fly', providerRef }, { expirySeconds: 1200 })`.
- Reply `{ token, expirySeconds, flyApp: providerRef.flyApp }`.
- `fly` adapter resolved via `deps.adaptersForToken(token)` (same as `/deploy`); missing fly adapter → static error.

### Control plane — `FlyAdapter.mintDeployToken(handle, opts)`

`control-plane/src/adapters/fly.ts`, using the existing `graphql()` client (org token):

```
mintDeployToken(handle: ResourceHandle, opts: { expirySeconds: number }): Promise<{ token: string; expirySeconds: number }>
```

- GraphQL `createLimitedAccessToken` mutation, `profile: "deploy"`, app-scoped via `profileParams: { app_id: <flyApp> }`, `expiry: "<n>m"`, `organizationId: <org>`. Returns the `FlyV1 …` macaroon.
- **[VERIFY-LIVE]** the exact `CreateLimitedAccessTokenInput` shape (profile name, `profileParams.app_id` form — app name vs numeric id, organization id source) against the live Fly GraphQL API. Pin it like Firth pinned its other provider calls; the live checkpoint (below) verifies it end to end.
- Add `mintDeployToken` to the `ComputeAdapter` interface (`adapters/types.ts`).

## Error handling

- No `Dockerfile` → `No Dockerfile at <path>. Create one, or use --image <url>.`
- flyctl missing → auto-install via existing `ensureFlyctl`; if that fails, `flyctl is required for source-mode deploy …` with install hint.
- `flyctl deploy` non-zero → throw referencing the streamed output; exit 1. **No rollback** — the branch's Fly app pre-exists (provisioned at branch-create), so a failed build leaves the running machine untouched.
- Missing manifest/digest line → throw (re-run with `FLY_LOG_LEVEL=debug`).
- Branch has no Fly resource / no fly adapter / mint failure → clear, static server error.
- All control-plane error strings stay static/controlled; the minted token and the org token are never logged.

## Security

- The minted token is **single-app + ~20-min + `else:deny`** — even if exfiltrated within its TTL it can deploy only that one branch's Fly app within Firth's Fly org; it can't read or mutate any other app, mint tokens, or persist past TTL.
- The org `FLY_API_TOKEN` lives only in the control-plane env and is never sent to the CLI.
- The build context (the user's source) goes straight from the CLI to Fly's remote builder over flyctl; it never passes through Firth's control plane.
- The token is returned over TLS and exported to flyctl only for the build subprocess's lifetime.

## Testing

Offline unless a live checkpoint is explicitly gated.

**Control plane (offline, fakes):**
- `FlyAdapter.mintDeployToken` with a fake `HttpClient`: asserts the `createLimitedAccessToken` mutation is called with the app-scoped, deploy-profile, expiry input and returns the token from the response.
- `POST /projects/:id/deploy-token`: returns `{ token, expirySeconds, flyApp }` for a branch with a fly resource; `404`/`400` when the branch has no fly resource; resolves the target branch from `from`/default; auth required.

**Control plane (gated live checkpoint, SKIP without creds):** mint a real deploy token for a provisioned branch app and assert it is a non-empty `FlyV1 …` string scoped to that app — verifies the **[VERIFY-LIVE]** mutation shape.

**CLI (offline, fake runner + fake api):**
- `parseImageDigest` unit test: extracts `registry.fly.io/<app>@sha256:…` from a sample buildkit "pushing manifest" line; returns null when absent.
- source-mode `deploy`: asserts `mintDeployToken` is called, then `flyctl` is spawned with `deploy --remote-only --build-only --push --app <flyApp> --image-label … --no-cache` and `FLY_API_TOKEN=<token>`, the stub `fly.toml` is written when absent and removed after (and left untouched when the user already has one), the digest is parsed, and `api.deploy` is called with `{ image: <digest ref>, from: branch, port }`.
- mode validation: `dir` + `--image` → error; neither → error; no `Dockerfile` → error.

## Build order (informs the plan)

1. `FlyAdapter.mintDeployToken` (GraphQL `createLimitedAccessToken`, app-scoped, expiry) + `ComputeAdapter` interface + offline test.
2. `POST /projects/:id/deploy-token` route (resolve branch fly app → mint → `{ token, expirySeconds, flyApp }`) + tests; `FirthApi.mintDeployToken`.
3. `cli/src/flyctl-build.ts` — stub `fly.toml` writer, `flyctlBuildAndPush`, `parseImageDigest` + unit tests.
4. CLI `firth deploy <dir>` source-mode wiring (mode detection, orchestrate token → build → deploy) + tests + help text.
5. Gated live checkpoint: real source build + deploy against a branch app (SKIP without creds).

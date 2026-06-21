# Token Refresh for Firth — Design

**Date:** 2026-06-21
**Status:** Approved (pending spec review)

## Goal

Stop forcing a re-login every time the 15-minute InsForge access token expires. Capture the **refresh token** at login and refresh the access token silently, giving a working session that lasts as long as the refresh token (**7 days**) with no user-visible interruption — across both the `firth` CLI and the web dashboard.

## Background (confirmed against InsForge)

- InsForge access token TTL = **15 min**; refresh token TTL = **7 days**; the refresh token is **rotated** on every use (each `/api/auth/refresh` returns a new refresh token and invalidates the old one).
- The `@insforge/sdk` client distinguishes **web mode** (refresh token set as an httpOnly cookie; `signInWithPassword` returns only `accessToken` + `csrfToken`) from **server mode** (`isServerMode: true` → `signInWithPassword` returns `refreshToken` in the response; `refreshSession({ refreshToken })` calls `/api/auth/refresh` with the token in the body).
- Firth's control-plane today builds its anon client in the default (web) mode, so login never sees the refresh token. Switching that client to **server mode** is what unlocks refresh.

## Non-Goals

- Moving the dashboard to httpOnly-cookie refresh (the control-plane and dashboard are different hosts → cross-site cookies are a larger change; the dashboard stays bearer-token + localStorage, where it already keeps the access token).
- Changing signup, OAuth, or the access-token TTL itself.
- Server-side refresh-token storage/revocation (the clients hold the rotating token, same as today's access token).

## Architecture

Three layers. The control plane is the only place that talks to InsForge; both clients refresh through it.

```
login:    client → POST /auth/login    → { token, refreshToken, user }
refresh:  client → POST /auth/refresh  { refreshToken } → { token, refreshToken }   [NEW]
          (control plane → InsForge SDK server mode: signInWithPassword / refreshSession)
on 401:   client refreshes once, persists the rotated pair, retries the original request
```

## Components

### Control plane — `insforge.ts` (auth proxy)

- Build the anon auth client with **`isServerMode: true`** (the client used by `login`/`refresh`; the per-token clients for `verifyToken`/data stay as they are).
- `AuthProxy.login(email, password)` → returns `{ token, refreshToken, user }` (adds `refreshToken` from `signInWithPassword`'s server-mode response; the existing "email not verified" throw when there's no access token is preserved).
- New `AuthProxy.refresh(refreshToken: string)` → `anon.auth.refreshSession({ refreshToken })` → returns `{ token, refreshToken }`. Throws on failure (expired/invalid refresh token).

### Control plane — `server.ts`

- `POST /auth/login`: response gains `refreshToken` → `{ token, refreshToken, user }`. (Validation/verification-needed paths unchanged.)
- New **`POST /auth/refresh`**: body `{ refreshToken }`; missing → `400`. Calls `authProxy.refresh`; success → `{ token, refreshToken }`; failure → `401 { error: 'invalid refresh token' }` (static string; the real error is never echoed). Mirrors the existing `/auth/login` route's try/catch shape. **Like `/auth/login`, this route does NOT run through `auth(req)`/bearer verification** — the access token is expired (that's the point); the route is authorized by the refresh token in the body.

### CLI

- `CliConfig` gains `refreshToken?: string`. `firth login` persists both `token` and `refreshToken` (the existing `writeConfig({ ...cfg, apiUrl, token })` also writes `refreshToken`).
- `FirthApi` is constructed with the refresh token and a persist callback so it can rotate tokens:
  - `new FirthApi(apiUrl, token, fetcher?, opts?: { refreshToken?: string; onTokens?: (t: { token: string; refreshToken: string }) => void })`.
  - `req(...)`: when a response is **401** and a `refreshToken` is present, `POST /auth/refresh { refreshToken }` once; on success update the in-memory `token`/`refreshToken`, call `onTokens` to persist, and **retry the original request once**. If the refresh itself 401s (or there's no refresh token), surface a clear error: `session expired — run \`firth login\``.
  - Refresh is attempted **at most once per request** (no recursion); the `/auth/refresh` call is made directly (not through the retrying `req` wrapper) so a failing refresh can't loop. Sequential per-command requests make a single-flight unnecessary on the CLI.
- `apiFromDeps(deps)` wires `refreshToken` from `readConfig` and an `onTokens` that writes the rotated pair back to `~/.firth/config.json`.

### Dashboard

- `createControlPlaneAuth`: on `signIn`/`signUp` store `firth_refresh_token` in localStorage alongside `firth_token`; `signOut` clears both.
- The `Api` client (`api/client.ts`) gets a refresh-on-401 path: on a 401, call `/auth/refresh` with the stored refresh token, persist the rotated pair (localStorage), retry the request once; on refresh failure clear both tokens and let the 401 propagate (the App shell already routes 401 → AuthScreen).
- **Single-flight refresh:** a shared in-flight refresh promise so concurrent requests (e.g. the detail page firing `getProject` + `getSecrets` together) trigger **one** refresh — refresh rotates the token, so parallel refreshes would invalidate each other. Subsequent callers await the same promise and use the resulting access token.

## Error handling

- No/invalid refresh token at `/auth/refresh` → `401 { error: 'invalid refresh token' }`; the client treats it as "session over" (CLI: prompt `firth login`; dashboard: AuthScreen).
- Refresh-token rotation: every successful refresh **must** persist the new refresh token before the old one is reused; the in-flight/persist ordering guarantees this.
- A request that 401s, refreshes successfully, and 401s **again** on retry is not retried a second time — surfaced as auth failure (prevents loops).
- Control-plane error strings stay static; access/refresh tokens are never logged.

## Testing

Offline (fakes/mocked fetch) unless noted.

**Control plane:**
- `AuthProxy.login` returns `{ token, refreshToken, user }` (server-mode SDK fake returns a refresh token); "email not verified" path preserved.
- `AuthProxy.refresh` returns the rotated `{ token, refreshToken }`; throws on a rejecting SDK.
- `POST /auth/login` body includes `refreshToken`. `POST /auth/refresh`: 200 `{ token, refreshToken }` on a valid token; `400` when `refreshToken` missing; `401 { error: 'invalid refresh token' }` when the proxy throws.

**CLI:**
- A request that 401s then succeeds after refresh: asserts `/auth/refresh` was called with the stored refresh token, `onTokens` persisted the rotated pair, and the original request was retried once and returned its result.
- Refresh itself 401s → a single clear "session expired — run `firth login`" error, no retry loop.
- `firth login` writes both `token` and `refreshToken` to config; `apiFromDeps` reads them.
- A 2xx request triggers no refresh (no spurious `/auth/refresh`).

**Dashboard:**
- `signIn` stores `firth_token` + `firth_refresh_token`; `signOut` clears both.
- A 401 from the Api triggers one `/auth/refresh`, persists the rotated pair, retries, and returns the result.
- Two concurrent 401s trigger **one** refresh (single-flight), both retried with the new token.
- Refresh failure clears both tokens and the 401 propagates.

## Build order (informs the plan)

1. Control plane: anon client `isServerMode: true`; `AuthProxy.login` returns `refreshToken`; `AuthProxy.refresh`; `/auth/login` body + `POST /auth/refresh` route + tests.
2. CLI: `CliConfig.refreshToken`; `firth login` persists it; `FirthApi` refresh-on-401 (+ `onTokens` persist) + `apiFromDeps` wiring + tests.
3. Dashboard: store/clear `firth_refresh_token`; `Api` refresh-on-401 with single-flight + tests.

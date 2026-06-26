# Firth CLI reference

Command catalog, deploy modes, Dockerfile templates, and govern/observe. For the development *process* (branch → deploy → test → promote) and the deploy gotchas, see `workflow.md`.

## Commands
| Command | Purpose |
|---|---|
| `firth login --email <e> --password <p>` [`--api-url <url>`] · `firth logout` | auth (api-url persists) |
| `firth status` | login + linked project + current branch |
| `firth project create <name>` | provision DB + storage + compute, link |
| `firth project link <id>` · `firth project list` | link existing / list |
| `firth project delete --yes` | tear down ALL resources + unlink (policy-gated by default) |
| `firth branch create <name>` [`--from <parent>`] | isolated env: own Neon branch + own copy-on-write storage bucket (forked from parent); **compute is provisioned on first deploy** (does NOT switch) |
| `firth branch switch <name>` · `firth branch list` | set current branch / list |
| `firth branch delete <name> --yes` | tear down branch's Neon branch + forked storage bucket + Fly app (not the default) |
| `firth secrets` [`--branch <id>`] | write current/given branch creds → `./.env` |
| `firth deploy <dir> --port <n>` \| `--image <url>` [`--from <branch>`] | deploy (see Deploy modes) |
| `firth manifest` [`--json`] | env manifest: each env's databases / storage / compute + how they wire (public-url) |
| `firth events` [`--branch <id>`] [`--limit <n>`] · `firth observe sync` | timeline / upload agent-action logs |
| `firth policy` [`set <action> <allow\|deny\|approve>`] | view/set govern policy |
| `firth approvals` · `firth approve <id>` · `firth deny <id>` | manage gated actions |

`DATABASE_URL` + compute + storage (`AWS_*`/`BUCKET_NAME`) are **per-branch** (new projects: each branch copy-on-write-forks its parent's bucket; projects created before storage forking keep a **shared** bucket).

## Deploy modes
```
firth deploy <dir> --port <n>          # SOURCE (preferred): builds the Dockerfile in <dir> on Fly's
                                        #   remote builder — no local Docker, no registry
firth deploy --image <url> --port <n>  # IMAGE: deploy a pre-built / already-pushed image
# both target the CURRENT branch's compute; --from <branch> targets another; URL prints on success
```
`--port` must match the port the image actually listens on (`ENV PORT`/`EXPOSE`/server bind) — a mismatch boots fine but every request fails with `instance refused connection on 0.0.0.0:<port>`. See workflow.md gotchas.
Secrets are **injected at deploy** as env vars (decrypted from the branch). Read creds from `process.env` in production; **never bake `./.env` into the image** (it's local-dev only). A branch serves **one app on one port** at `https://<app>.fly.dev`.

## Dockerfile templates
**Backend** (reads creds from env, listens on `--port`):
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]   # reads process.env.DATABASE_URL etc.
```
**Full-stack:** ship frontend + backend as **one container, one port** — have the backend serve the built frontend (SSR, or copy the SPA `dist/` into the server's static dir). One `firth deploy`, one URL, same-origin calls.
**Separate SPA:** build static assets, serve from a tiny static-server container (e.g. caddy) with unknown paths rewritten to `index.html`; host it separately and deploy only the backend to Firth compute.

## Govern & observe
- **Policy** gates sensitive actions — `deploy`, `branch.delete`, `project.delete`, `secrets.read`. `approve` = require a human: the action returns `approval_required`; a human runs `firth approve <id>`, then you **re-run** it (one-shot). `project.delete` is gated by default.
- `firth approvals` / `firth approve <id>` / `firth deny <id>` — manage pending gates.
- `firth events [--branch] [--limit]` — timeline of **agent actions ↔ resource side-effects** (branch creates, deploys + URLs). `firth observe sync` uploads local `.firth/audit.jsonl` agent-action logs into the same timeline.

# firth

The **Firth CLI** — provision and govern a project's cloud resources (Neon Postgres,
Tigris storage, Fly.io compute) behind one CLI and one credential seam. It is a thin
client of the Firth control-plane API; you sign in, create a project (which provisions
the resources under Firth's own provider accounts), and pull a complete `.env` of
scoped, encrypted-at-rest credentials.

## Install

```bash
npm install -g firth
# or run without installing
npx firth --help
```

Requires Node ≥ 20.

## Quickstart

```bash
firth login                      # sign in (email/password)
firth project create my-app      # provision DB + storage + compute; links ./.firth/project.json
firth branch create dev          # fork an isolated DB branch (storage shared; compute redeploys)
firth branch switch dev          # make dev the current branch
firth secrets                    # write the project's credentials into ./.env
firth deploy --image <url>       # deploy a container image to the project's compute
firth events                     # the action ↔ side-effect timeline
```

> **Connectivity:** the CLI talks to the Firth control-plane API. Set `FIRTH_API_URL`
> (default `http://localhost:8080`) to point at your control plane. While Firth is
> pre-release, run the control plane locally and target `http://localhost:8080`.

## Commands

```
login                     Sign in (email/password)
logout                    Clear stored credentials
status                    Show login, linked project, and current branch

project create <name>     Create + link a project (provisions DB/storage/compute)
project link <id>         Link this directory to a project
project list              List your projects
project delete            Delete the linked project + all resources (--yes)

branch create <name>      Create a branch (--from <parent>, default main)
branch list               List the linked project's branches
branch switch <name>      Set the current branch (secrets/events default to it)
branch delete <name>      Delete a branch + its Neon branch (--yes)

secrets                   Fetch the linked project's secrets into .env (--branch <id>)
deploy                    Deploy --image <url> to the project's compute (--from, --port)
events                    Show the action ↔ side-effect timeline (--branch, --limit)
observe sync              Upload local observe-hook findings (.firth/audit.jsonl) to the timeline
skills pull               Install the firth skill into ./.claude/skills
```

## Configuration & state

- **Global** — `~/.firth/config.json`: API URL, InsForge auth endpoint, and your access token.
- **Per-project** — `./.firth/project.json`: the linked project id and the current branch
  (set by `firth branch switch`). `secrets` and `events` default to the current branch.
- **Override** — `FIRTH_API_URL` selects which control plane to talk to.

## Credentials

Treat `./.env` as the only source of resource credentials — never hardcode them or copy
them elsewhere. A branch's `DATABASE_URL` is isolated per branch; storage (`AWS_*`) is
shared across branches. Re-run `firth secrets` after `firth branch switch` to refresh
`DATABASE_URL`.

## License

MIT

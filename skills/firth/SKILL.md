---
name: firth
description: Use when working in a project managed by Firth — provisioning DB/storage/compute, creating/switching branches, deploying, checking status, or wiring app secrets via the firth CLI.
---

# Firth

Firth provisions and governs a project's cloud resources — **Neon** (Postgres), **Tigris** (S3-compatible storage), **Fly.io** (compute) — behind one CLI and one credential seam. The CLI talks **only** to the Firth control plane; you never configure a cloud backend directly.

## Setup
- `firth login --email <e> --password <p>` — sign in. Add `--api-url <url>` to target a non-local control plane (default `http://localhost:8080`; it persists for later commands, so production is just `firth login --api-url https://… …`).
- `firth status` — show login state, linked project, and current branch.
- `firth --version`.

## Workflow
1. **Create or link a project** — you end up linked (`./.firth/project.json`) and on the default branch `main`:
   - `firth project create <name>` — provisions DB + storage + compute.
   - `firth project link <id>` — link an existing project.
2. `firth secrets` — write the current branch's connection credentials into `./.env`. **This is how an agent gets DB/storage access.** (`--branch <id>` targets a specific branch.)
3. `firth deploy --image <url>` — deploy a container image to the project's compute (`--port`, `--from`).
4. `firth events` — the action ↔ resource-side-effect timeline (`--branch`, `--limit`).

## Branches
- `firth branch create <name>` — fork an isolated **DB branch** (storage is shared across branches; compute redeploys).
- `firth branch switch <name>` — set the current branch; `secrets`/`events` then target it. (After `project create`/`link` you're already on `main`, so this is only needed to move to another branch.)
- `firth branch list`.
- Re-run `firth secrets` after switching — a branch's `DATABASE_URL` is branch-specific.

## Delete (destructive — require `--yes`)
- `firth project delete --yes` — tears down ALL resources (Neon DB, Fly app, Tigris bucket) and unlinks the directory.
- `firth branch delete <name> --yes` — tears down the branch's Neon branch. The default branch can't be deleted.

## Rules for agents
- Treat `./.env` as the **only** source of resource credentials — run `firth secrets` to populate it; never hardcode credential values or print them.
- `DATABASE_URL` is isolated **per branch**; storage credentials (`AWS_*` / `BUCKET_NAME`) are **shared** across branches.
- The CLI auto-installs `flyctl` (via Homebrew) when missing during project/branch commands, so the Fly app is manageable directly if needed.

---
name: firth
description: Use when working in a project managed by Firth — provisioning DB/storage/compute, creating/switching branches, checking status, or wiring app secrets via the firth CLI.
---

# Firth

Firth provisions and governs a project's cloud resources (Neon Postgres, S3/Tigris storage, Fly.io compute) behind one CLI and one credential seam.

## Workflow
1. `firth login` — sign in (email/password).
2. `firth project create <name>` — provision DB + storage + compute; links `./.firth/project.json`.
3. `firth branch create <name>` — fork an isolated DB branch (storage is shared; compute redeploys).
3a. `firth branch switch <name>` — set the current branch (secrets/events automatically target it).
4. `firth secrets` — fetch the project's connection credentials into `./.env`. **Never** hardcode credentials; always read them from this `.env`. (Defaults to the current branch after `branch switch`.)
5. `firth project list` / `firth branch list` — inspect state.
6. `firth status` — check login state, linked project, and current branch.

## Delete commands (destructive, require --yes)
- `firth project delete` — tears down all resources (Neon DB, Fly app, S3 bucket) + unlinks the directory.
- `firth branch delete <name>` — tears down the Neon branch. Cannot delete the default branch.

## Rules for agents
- Treat `./.env` as the only source of resource credentials; do not copy values elsewhere or print them.
- A branch's `DATABASE_URL` is isolated per branch; storage (`AWS_*`) is shared across branches.
- Run `firth branch switch <name>` to change the active branch; secrets and events then target it automatically. Run `firth secrets` after switching to refresh `.env`.

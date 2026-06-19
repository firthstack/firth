---
name: firth
description: Use when working in a project managed by Firth — provisioning DB/storage/compute, creating branches, or wiring app secrets via the firth CLI.
---

# Firth

Firth provisions and governs a project's cloud resources (Neon Postgres, S3/Tigris storage, Fly.io compute) behind one CLI and one credential seam.

## Workflow
1. `firth login` — sign in (email/password).
2. `firth project create <name>` — provision DB + storage + compute; links `./.firth/project.json`.
3. `firth branch create <name>` — fork an isolated DB branch (storage is shared; compute redeploys).
4. `firth secrets [--branch <id>]` — fetch the project's connection credentials into `./.env`. **Never** hardcode credentials; always read them from this `.env`.
5. `firth project list` / `firth branch list` — inspect state.

## Rules for agents
- Treat `./.env` as the only source of resource credentials; do not copy values elsewhere or print them.
- A branch's `DATABASE_URL` is isolated per branch; storage (`AWS_*`) is shared across branches.
- Re-run `firth secrets` after switching branches to refresh `DATABASE_URL`.

# Firth Observe (MVP)

**What it is:** a local, read-only audit of what your AI coding agent does with
credentials. It watches every tool call the agent makes and records when a
secret is *touched* (read/handled) or *exposed* (printed, sent over the network,
committed to git, or written into a non-secret file).

**The whole pitch is the trust model:**

- Runs 100% on your machine as a Claude Code hook. **Nothing is sent anywhere.**
- **Never stores raw secrets** — even the local log keeps only a redacted
  fingerprint (`type ••••last4 #hash`).
- **Read-only.** It's a `PostToolUse` hook; the tool has already run, so it
  cannot block or change anything. It only writes an audit line.

This is the first wedge of the larger plan (see `../README.md` and
`../ARCHITECTURE.md`): observe → govern → recover, entering at the pre-prod blast
radius where agents act today.

## Install

```bash
python3 observe/install.py            # installs into ./.claude/settings.json
```

This registers a `PostToolUse` hook (matcher `*`) and adds `.firth/` to
`.gitignore`. Restart / new agent turns will start being audited.

Uninstall:

```bash
python3 observe/install.py --uninstall
```

## Read the report

```bash
python3 observe/summary.py
```

Example:

```
 exposures   : 2  (secrets that left a safe place)
 touches     : 9  (secrets the agent handled)

⚠  EXPOSURES (look at these first)
  ┌─ sink: network  (1 finding(s))
  │  [HIGH] secret in an outbound network command
  │     secret : github_token:••••e5f6:#1a2b3c4d
  │     where  : Bash:input.command  (tool Bash)
```

## What it detects

| | |
|---|---|
| **Secret material** | AWS keys, GitHub tokens/PATs, Slack, Stripe, LLM API keys, Google API keys, private-key blocks, JWTs, DB connection strings with creds, `Bearer` tokens, generic `secret=`/`password=` assignments |
| **Secret files** | `.env*` (not `.example`/`.sample`), `*.pem`/`*.key`, `~/.aws/credentials`, ssh private keys, `.npmrc`, `.netrc`, `.git-credentials`, kube/docker config, service-account json |
| **Exposure sinks** | network (`curl`/`ssh`/…), git (`git add`/`commit`), stdout (`echo`/`cat`/command output), non-secret file (secret written into source/docs) |

Findings are classified `touch` (info) or `exposure` (`warn` for stdout, `high`
for network / git / non-secret file).

## Verify it works (offline, no real secrets)

```bash
python3 observe/selftest.py
```

## Scope (deliberately small)

In: local hook, detection, redacted local log, summary report.
Out (later): backend/dashboard, blocking, credential brokering, other harnesses,
team aggregation. The scanner core (`scanner.py`) is harness-agnostic — other
agents are a thin adapter over `scan_event(event)`.

## Files

- `scanner.py` — detection core (`scan_event(event) -> findings`). Single source of truth.
- `hook.py` — Claude Code `PostToolUse` entry: stdin JSON → scan → append `.firth/audit.jsonl`.
- `summary.py` — render the audit report.
- `install.py` — register/unregister the hook.
- `selftest.py` — offline tests with synthetic secrets.

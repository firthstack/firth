# Observe Hook → Node Port + Auto-Install at Link — Design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)

## Goal

Remove the Python runtime dependency from Firth Observe. Port the credential
touch/exposure hook (today `observe/hook.py` + `observe/scanner.py`) to
TypeScript so the whole Observe stack is Node, ships with the `firth` npm
package for free, and can be **auto-installed during `firth project link` /
`firth project create`** — the way related agent skills already are. The
detection logic, the redacted local log, and the explicit upload path are
preserved unchanged in behavior.

This is the follow-up to the auto-install discussion: today the Python hook is
**not shipped** with the npm CLI at all (`cli/package.json` `files` is
`["dist","README.md"]`; the build only copies `../skills`), and its
`.claude/settings.json` entry hardcodes `python3` — a runtime the npm audience
is not guaranteed to have. Going Node fixes both: the hook compiles into `dist`
and runs on the Node that installed `firth`.

## Non-Goals

- **Changing the trust model.** The hook still writes only redacted fingerprints
  to a local `.firth/audit.jsonl`; nothing leaves the machine until the user
  runs `firth observe sync` (explicit, opt-in — unchanged).
- **Auto-upload from the hook.** The hook does not POST events. Upload stays the
  existing `firth observe sync` (already Node).
- **Changing what is detected** or the audit-line format. This is a port, not a
  detector rewrite — `scanEvent` output is field-for-field equivalent to
  `scan_event`.
- **Other harnesses.** The hook remains a Claude Code `PostToolUse` hook
  (`.claude/settings.json`). The scanner stays harness-agnostic so a future
  adapter is a thin wrapper.
- **Changing the `events` ingest / `firth events` timeline.** Untouched.

## Decisions locked (from brainstorming)

1. **Upload model:** local log + manual `firth observe sync`. Trust model preserved.
2. **Python removal:** delete the entire top-level `observe/` directory
   (`hook.py`, `scanner.py`, `summary.py`, `install.py`, `selftest.py`). The TS
   scanner becomes the single source of truth; `summary.py`'s local report is
   ported to `firth observe report`.

## Architecture

All new code lives under `cli/src/observe/` and compiles via the existing
`tsc -p tsconfig.json` into `dist/observe/`. Because `files` already includes
`dist`, the Node hook ships with the package with **no packaging change** — the
key structural win over the Python layout (which lived outside `cli/`).

### Units & interfaces

- `cli/src/observe/scanner.ts` — **single source of truth.** Pure, no I/O.
  - `scanEvent(event: ToolEvent, opts?: { ignorePath?: (p: string) => boolean }): Finding[]`
  - Direct port of `scanner.py`: the detector table (AWS id/secret, GitHub
    token/PAT, Slack, Stripe, LLM, Google, private-key block, JWT, DB conn
    string, Bearer, generic assignment), the placeholder + reference filters,
    secret-file detection (`isSecretFile`) with the safe-template exclusion, the
    `classify` matrix (network/git/stdout/nonsecret_file/write_secret_file/
    read/shell → kind+severity+sink+note), `fingerprint` (`type:••••last4:#hash`),
    `snippet` redaction, the recursive `leaves` walk over input/output, and the
    position-sorted overlap dedup. Regexes translated to JS (note `(?i)` →
    `/i`, `\b` semantics, named-group/`lastindex` → JS capture-group handling).
  - **Invariant:** a `Finding` never carries a raw secret — only the fingerprint
    and a redacted snippet. Enforced by a test.
- `cli/src/observe/hook.ts` — thin stdin wrapper, the `node` entry the hook
  command invokes. Reads PostToolUse JSON from stdin → `scanEvent` (with an
  `ignorePath` that skips `$CLAUDE_PROJECT_DIR/.firth/` and its own dir) →
  appends each redacted finding as a JSON line to
  `$CLAUDE_PROJECT_DIR/.firth/audit.jsonl` with the common envelope
  (`ts`, `session_id`, `tool`, `cwd`). **Always exits 0, never writes stdout**
  (so it can never block or alter a tool), swallows all errors to stderr.
  Equivalent of `hook.py`. **Constraint:** `hook.ts` imports only
  `./scanner.js` and node builtins — no other CLI module — so the materialized
  two-file copy (`hook.js` + `scanner.js`) is complete and runnable on its own.
- `cli/src/observe/report.ts` — `firth observe report`. Reads the local
  `.firth/audit.jsonl` and renders the exposures-first / touches summary. Port
  of `summary.py`.
- `cli/src/observe/install.ts` — `.claude/settings.json` register / unregister
  + the hook-file materialization. Port of `install.py` logic, plus the upsert
  migration below.
- `cli/src/ensure-observe.ts` — link-time auto-install, mirroring
  `cli/src/ensure-skills.ts`.

### Hook invocation: materialized self-contained files

The `PostToolUse` command runs on **every** tool call, so it must be fast and
self-contained (no `npx`, no `node_modules` resolution from the project).

- `tsc` emits `dist/observe/hook.js` + `dist/observe/scanner.js`. `hook.js`
  imports `./scanner.js` (relative, NodeNext `.js` extension). The two files are
  self-contained (scanner has zero runtime deps).
- Install **materializes** both files into the project's `.firth/observe/`, plus
  a `.firth/observe/VERSION` stamp (the CLI version).
- `settings.json` command: `node "${CLAUDE_PROJECT_DIR}/.firth/observe/hook.js"`.

**Why materialize vs. point at the global install path:** a copy is
self-contained and survives nvm switches, reinstalls, and global-prefix changes
— whose failure mode (a `settings.json` command pointing at a moved/deleted path)
is *silent breakage*, worse than the copy's failure mode (mild staleness). It
also matches `.firth/` semantics — already per-machine, regenerable, gitignored
state (project link, current branch, sync-state, audit log). Staleness is
handled by **re-materializing (overwrite) on every `firth project link` /
`firth observe install`**, and by comparing the `VERSION` stamp so an upgraded
CLI refreshes the copy.

### settings.json registration — upsert by marker (handles migration)

The entry shape (mirrors the Python one, marker preserved so detection is
uniform):

```json
{ "matcher": "*", "hooks": [{
  "type": "command", "command": "node",
  "args": ["${CLAUDE_PROJECT_DIR}/.firth/observe/hook.js"],
  "timeout": 15, "_firth": "firth-observe"
}]}
```

Registration is an **upsert by the `_firth` marker**, not "skip if present":
remove every existing `_firth == "firth-observe"` hook entry, then add the new
one. This automatically cleans up the **old `python3 ${CLAUDE_PROJECT_DIR}/observe/hook.py`
entry** that prior repos have — after `observe/` is deleted that command errors
(missing file, non-zero exit, a logged hook error every tool call), so silently
replacing it on the next link is the migration path. `uninstall` removes all
marker-matched entries.

### Auto-install at link time — `ensureObserveHook(deps)`

Called from `projectCreate` and `projectLink` immediately after `ensureSkills`,
following the `ensure-skills.ts` pattern exactly:

- Gated by a new `observeInstalled` marker on the `.firth/project.json` link
  (mirror of `skillsInstalled`); `config.ts` gains `markObserveInstalled` and
  reads the flag. Runs once per linked project.
- Steps: (1) materialize `dist/observe/{hook,scanner}.js` + `VERSION` into
  `.firth/observe/`; (2) idempotently upsert the `settings.json` entry;
  (3) print a clear notice —
  `installed Firth observe hook → .claude/settings.json (local, read-only audit; nothing leaves your machine until you run \`firth observe sync\`)`;
  (4) `markObserveInstalled`.
- Wrapped in `try/catch` — convenience only, **never blocks or fails** the host
  command. Touches only `.claude/settings.json` (Claude Code). `.firth/` is
  already gitignored by `writeProjectLink`.

### CLI surface — `firth observe …`

`firth observe sync` is unchanged (already Node). Add subcommands and wire them
in `cli/src/index.ts` (dispatch + USAGE):

- `firth observe install` — manual (re)install: materialize + upsert-register.
- `firth observe uninstall` — remove all marker-matched `settings.json` entries
  (and the `.firth/observe/` files).
- `firth observe report` — render the local audit report (`report.ts`).

## Data flow (unchanged in shape)

```
agent tool call
  → Claude Code PostToolUse
    → node .firth/observe/hook.js   (scanEvent → redacted findings)
      → append .firth/audit.jsonl   (local only)
  … later, explicitly …
firth observe sync                  (existing: watermark + dedup_key → POST /events)
  → control-plane events timeline   (firth events / future dashboard)
```

## Error handling

- Hook: any parse/scan/write error is swallowed (stderr note), **always exit 0**,
  never stdout — identical guarantee to `hook.py`. Oversize strings (>1 MB)
  skipped, as today.
- `ensureObserveHook`: `try/catch`, never blocks the host command; a failure
  leaves a friendly note and the project still linked.
- `install` on a malformed `settings.json`: report and abort that command (don't
  clobber a file we can't parse) — mirrors `install.py`'s parse-error exit.
- All existing API/CLI error discipline (static strings, no secret/PII) unchanged.

## Trust model (restated, not changed)

The hook stores only redacted fingerprints (`type:••••last4:#hash`) in a local,
gitignored log; it sends nothing off the machine; uploading stays the explicit,
opt-in `firth observe sync` over an already-redacted log. The port preserves
every one of these guarantees; a test asserts no `Finding` ever contains a raw
secret value.

## Testing (vitest — replaces `selftest.py`)

- `cli/test/observe-scanner.test.ts` — port `selftest.py`'s synthetic-secret
  cases: each detector hits; **no raw secret appears in any finding** (redaction
  invariant); placeholder + reference values filtered; secret-file detection and
  safe-template (`.example`/`.pub`) exclusion; `classify` severity/sink matrix
  (network/git → high, stdout → warn, nonsecret_file write → high, secret-file
  read/write → touch); overlap dedup yields one finding per secret.
- `cli/test/observe-hook.test.ts` — stdin JSON → appends one redacted line per
  finding to `audit.jsonl`; empty findings → no write; exit 0 + no stdout;
  self-writes under `.firth/` ignored.
- `cli/test/observe-install.test.ts` — register is idempotent; upsert removes a
  pre-existing (Python-style) `_firth` entry rather than duplicating; uninstall
  removes only marker-matched entries; malformed settings.json aborts safely.
- `cli/test/observe-report.test.ts` — renders the summary from a sample log.
- `cli/test/ensure-observe.test.ts` — materializes + registers once; the
  `observeInstalled` marker prevents a second run; never throws.

## Cleanup

- Delete the top-level `observe/` directory entirely.
- Update `README.md`, `observe`-related docs, and `ARCHITECTURE.md` §4
  ("Observability … `observe/` hook ingest") so wording reflects the Node hook
  and the `firth observe install`/`report` commands (drop `python3 observe/*`).

## Build order (informs the plan)

1. `scanner.ts` (port + redaction-invariant tests) — the single source of truth.
2. `hook.ts` (stdin wrapper + tests).
3. `install.ts` (materialize + upsert-register/uninstall + migration test) and
   `report.ts` (+ test).
4. `ensure-observe.ts` + `config.ts` `observeInstalled` marker + wire into
   `projectCreate`/`projectLink` (+ test).
5. `firth observe install|uninstall|report` dispatch + USAGE in `index.ts`.
6. Delete `observe/`; sync README / docs / ARCHITECTURE §4.

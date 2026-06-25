# Observe Hook → Node Port + Auto-Install at Link — Design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)

## Goal

Remove the Python runtime dependency from Firth Observe. Port the credential
touch/exposure hook (today `observe/hook.py` + `observe/scanner.py`) to
TypeScript so the whole Observe stack is Node, ships with the `firth` npm
package for free, and can be **auto-installed during `firth project link` /
`firth project create`** — the way related agent skills already are — for
**both Claude Code and Codex**. The detection logic, the redacted local log, and
the explicit upload path are preserved unchanged in behavior.

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
- **Harnesses beyond Claude Code + Codex.** This port wires **both** Claude Code
  and Codex `PostToolUse` (see "Two harnesses" below). The scanner stays
  harness-agnostic so any further adapter (Cursor, etc.) is a thin wrapper — but
  only Claude Code + Codex are wired in v1.
- **Changing the `events` ingest / `firth events` timeline.** Untouched.

## Decisions locked (from brainstorming)

1. **Upload model:** local log + manual `firth observe sync`. Trust model preserved.
2. **Python removal:** delete the entire top-level `observe/` directory
   (`hook.py`, `scanner.py`, `summary.py`, `install.py`, `selftest.py`). The TS
   scanner becomes the single source of truth; `summary.py`'s local report is
   ported to `firth observe report`.
3. **Two harnesses:** wire both Claude Code and Codex `PostToolUse` in this
   port. Same `hook.js` + scanner; the only deltas are the registration target
   and the `apply_patch` tool mapping (see "Two harnesses").

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
  - **Harness-agnostic by design.** The value-detection path (the `leaves` walk
    over all string fields) is tool- and harness-independent, so it covers
    Codex unchanged. `classify`/path-extraction additionally learns Codex's
    `apply_patch` tool so a file-targeted secret is classified like Claude's
    `Write`/`Edit` (see "Two harnesses"); when it can't, it degrades to a generic
    value finding — never a miss of the value itself.
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
- `cli/src/observe/install.ts` — register / unregister into **both**
  `.claude/settings.json` and `.codex/hooks.json`, plus the hook-file
  materialization into `.firth/observe/`. Port of `install.py` logic, plus the
  upsert-by-marker migration. Each harness writer is independent (one failing
  doesn't abort the other).
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

### Claude Code registration — upsert by marker (handles migration)

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

## Two harnesses — Claude Code + Codex

Codex's `PostToolUse` is near-identical to Claude Code's, so **the same
`hook.js` + `scanner.js` serve both** — the deltas are the registration target
and the `apply_patch` tool mapping. (Verified against the official Codex hooks
docs.)

**Shared contract.** Codex delivers one JSON object on stdin with `tool_name`,
`tool_input` (Bash uses `tool_input.command`), `tool_response`, `cwd`,
`session_id` (plus Codex extras `turn_id`, `tool_use_id`, `hook_event_name`,
`model`). This is the shape `scanEvent` already consumes. Codex PostToolUse can
block, but we deliberately don't: exit 0 + no stdout is a read-only no-op in
both harnesses, preserving the trust model. The hook reads its base dir from
`$CLAUDE_PROJECT_DIR` **or** the stdin `cwd` (already a fallback in `hook.py`),
so it needs no Claude-specific env under Codex.

**Codex registration target.** Not `.claude/settings.json` but a project-level
`<repo>/.codex/hooks.json` (Codex also accepts a `[hooks]` table in
`.codex/config.toml`; we write `hooks.json` — simpler to edit idempotently). The
entry mirrors Claude's but Codex's `command` is a **single string** (no separate
`args` array):

```json
{ "hooks": { "PostToolUse": [ {
  "matcher": "*",
  "hooks": [ { "type": "command",
    "command": "node \"${cwd}/.firth/observe/hook.js\"",
    "timeout": 15, "_firth": "firth-observe" } ]
} ] } }
```

Two Codex-specific caveats, both surfaced to the user (printed), not papered
over:
- **Trust gate.** Project-local `.codex/` hooks fire only after the user trusts
  that project layer in Codex. Auto-install can't grant trust — print a one-line
  "trust this project's `.codex/` in Codex to activate the hook" note.
- **Path resolution.** Codex does not expand `${CLAUDE_PROJECT_DIR}`. Prefer a
  cwd-relative path (`.firth/observe/hook.js`) if Codex runs project hooks with
  cwd = repo root; **verify at implementation**, else resolve an absolute path to
  the materialized file at install time. (The `${cwd}` shown above is a
  placeholder for whichever Codex supports — pin it in the plan.)

**`apply_patch` tool mapping — and why coverage is robust anyway.** Codex edits
files via `apply_patch` (one tool carrying a patch payload), not Claude's
`Write`/`Edit`/`MultiEdit` + `file_path`. This matters **only for the
path/sink classification** in `_classify` (is the target a secret file? is this
a write into a non-secret file?), which is keyed on Claude tool names. The
load-bearing design principle:

- **Value detection is shape-independent.** `scanEvent` walks every string leaf
  of `tool_input`/`tool_response`, so a secret *value* inside an `apply_patch`
  payload is still detected and redacted regardless of the payload's structure —
  Codex value-exposure coverage works with zero `apply_patch` knowledge.
- **Path/sink classification is the only tool-name-specific part.** Teach
  `_classify` (+ the path extractor) to recognize `apply_patch`: pull the edited
  file path(s) from its payload so a secret written via Codex is classified as
  `write_secret_file` / `nonsecret_file` like Claude's edits. If the payload
  shape can't be parsed on the installed Codex version, this **degrades to the
  generic value finding** — no crash, no missed value exposure.

**Risk to flag (version-dependent).** The official docs list `apply_patch` among
the tools PostToolUse fires for, but Codex historically fired PostToolUse only
for Bash and added `apply_patch`/MCP coverage more recently (see codex#16732).
So Codex *file-write* auditing has a real asterisk: the plan MUST include a
smoke test against a real Codex install (does PostToolUse fire for `apply_patch`?
what is its exact `tool_input` shape?) before claiming file-write parity. Bash /
MCP / value-in-command coverage is unaffected.

### Auto-install at link time — `ensureObserveHook(deps)`

Called from `projectCreate` and `projectLink` immediately after `ensureSkills`,
following the `ensure-skills.ts` pattern exactly:

- Gated by a new `observeInstalled` marker on the `.firth/project.json` link
  (mirror of `skillsInstalled`); `config.ts` gains `markObserveInstalled` and
  reads the flag. Runs once per linked project.
- Steps: (1) materialize `dist/observe/{hook,scanner}.js` + `VERSION` into
  `.firth/observe/`; (2) idempotently upsert **both** harness entries —
  `.claude/settings.json` and `.codex/hooks.json` (mirroring `ensure-skills`,
  which already targets claude-code + codex); (3) print a clear notice —
  `installed Firth observe hook → .claude/settings.json + .codex/hooks.json (local, read-only audit; nothing leaves your machine until you run \`firth observe sync\`)`
  plus the Codex trust-gate note; (4) `markObserveInstalled`.
- Both registrations are unconditional and harmless when a harness is unused (a
  dormant config file), matching how `ensure-skills` writes both skill dirs.
- Wrapped in `try/catch` — convenience only, **never blocks or fails** the host
  command. Touches `.claude/settings.json`, `.codex/hooks.json`, and
  `.firth/observe/`. Only `.firth/` is gitignored (already, by
  `writeProjectLink`) — it holds the materialized hook + the local log. The two
  harness config files are the **user's own config** we upsert into; Firth does
  not gitignore them (consistent with how `.claude/settings.json` is already
  left untracked-or-tracked per the user's choice, not Firth-managed).

### CLI surface — `firth observe …`

`firth observe sync` is unchanged (already Node). Add subcommands and wire them
in `cli/src/index.ts` (dispatch + USAGE):

- `firth observe install` — manual (re)install: materialize + upsert-register
  into **both** `.claude/settings.json` and `.codex/hooks.json`.
- `firth observe uninstall` — remove all marker-matched entries from **both**
  harness config files (and the `.firth/observe/` files).
- `firth observe report` — render the local audit report (`report.ts`).

## Data flow (unchanged in shape)

```
agent tool call (Claude Code or Codex)
  → PostToolUse  (.claude/settings.json | .codex/hooks.json)
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
- `install` on a malformed `settings.json` / `hooks.json`: report and skip that
  one target (don't clobber a file we can't parse) — mirrors `install.py`'s
  parse-error exit; a parse failure on one harness must not abort the other.
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
  read/write → touch); overlap dedup yields one finding per secret. **Codex
  cases:** a Codex Bash event (`tool_name: "Bash"`, `tool_input.command`) scans
  identically; a secret value inside an `apply_patch` payload is detected
  (shape-independent) even if the file-path classification can't resolve; an
  `apply_patch` write to a secret-file path classifies as `write_secret_file`
  once the payload shape is wired.
- `cli/test/observe-hook.test.ts` — stdin JSON → appends one redacted line per
  finding to `audit.jsonl`; empty findings → no write; exit 0 + no stdout;
  self-writes under `.firth/` ignored; base dir falls back to stdin `cwd` when
  `$CLAUDE_PROJECT_DIR` is unset (the Codex path).
- `cli/test/observe-install.test.ts` — for **both** targets: register is
  idempotent; upsert removes a pre-existing (Python-style) `_firth` entry rather
  than duplicating; uninstall removes only marker-matched entries; a malformed
  config on one harness is skipped without aborting the other; the Codex entry
  uses a single `command` string (no `args`), the Claude entry uses
  `command`+`args`.
- `cli/test/observe-report.test.ts` — renders the summary from a sample log.
- `cli/test/ensure-observe.test.ts` — materializes + registers into both
  harnesses once; the `observeInstalled` marker prevents a second run; never
  throws.
- **Manual smoke test (not vitest):** against a real Codex install, confirm
  PostToolUse fires for `apply_patch` and capture its actual `tool_input` shape
  (codex#16732 risk). Pin the shape in code only after this passes; until then
  the `apply_patch` path classification stays best-effort.

## Cleanup

- Delete the top-level `observe/` directory entirely.
- Update `README.md`, `observe`-related docs, and `ARCHITECTURE.md` §4
  ("Observability … `observe/` hook ingest") so wording reflects the Node hook,
  **both Claude Code + Codex harnesses**, and the `firth observe
  install`/`report` commands (drop `python3 observe/*`).

## Build order (informs the plan)

1. `scanner.ts` (port + redaction-invariant tests) — the single source of truth.
   Include the harness-agnostic value-scan tests.
2. `hook.ts` (stdin wrapper + tests; `cwd`-fallback for the Codex path).
3. `install.ts` — materialize + upsert-register/uninstall for **both**
   `.claude/settings.json` and `.codex/hooks.json` (+ migration + per-target
   isolation tests) and `report.ts` (+ test).
4. `apply_patch` mapping in `scanner.ts` — **gated on the manual Codex smoke
   test** confirming firing + payload shape; ship the shape-independent value
   path first, add path classification when the shape is pinned.
5. `ensure-observe.ts` + `config.ts` `observeInstalled` marker + wire into
   `projectCreate`/`projectLink`, installing both harnesses (+ test).
6. `firth observe install|uninstall|report` dispatch + USAGE in `index.ts`.
7. Delete `observe/`; sync README / docs / ARCHITECTURE §4.

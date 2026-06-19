#!/usr/bin/env python3
"""Firth Observe — Claude Code PostToolUse hook (read-only).

Reads the PostToolUse event JSON from stdin, scans it for credential touches /
exposures, and appends redacted findings to ``$CLAUDE_PROJECT_DIR/.firth/audit.jsonl``.

Guarantees:
  * Always exits 0 and writes nothing to stdout -> never blocks or alters a tool.
  * Never persists raw secret values (see scanner.py fingerprinting).
  * Sends nothing off the machine.
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scanner import scan_event  # noqa: E402


def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0

    base = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or "."
    firth_dir = os.path.join(base, ".firth")
    firth_abs = os.path.abspath(firth_dir)
    self_dir = os.path.dirname(os.path.abspath(__file__))

    def ignore(path):
        try:
            ap = os.path.abspath(path)
        except Exception:
            return False
        return ap.startswith(firth_abs) or ap.startswith(self_dir)

    try:
        findings = scan_event(event, ignore_path=ignore)
    except Exception as exc:  # never let the hook disrupt the session
        print("firth-observe: scan error: {}".format(exc), file=sys.stderr)
        return 0

    if not findings:
        return 0

    common = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "session_id": event.get("session_id"),
        "tool": event.get("tool_name"),
        "cwd": event.get("cwd"),
    }
    try:
        os.makedirs(firth_dir, exist_ok=True)
        with open(os.path.join(firth_dir, "audit.jsonl"), "a", encoding="utf-8") as fh:
            for fd in findings:
                rec = dict(common)
                rec.update(fd)
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as exc:
        print("firth-observe: write failed: {}".format(exc), file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())

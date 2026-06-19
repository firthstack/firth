#!/usr/bin/env python3
"""Firth Observe — print the credential audit report from the local log.

Usage:
  python3 observe/summary.py [path-to-audit.jsonl]

Defaults to ``$CLAUDE_PROJECT_DIR/.firth/audit.jsonl`` (or ./.firth/audit.jsonl).
"""

import collections
import json
import os
import sys

SEV_LABEL = {"high": "HIGH", "warn": "warn", "info": "info"}


def _log_path(argv):
    if len(argv) > 1:
        return argv[1]
    base = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return os.path.join(base, ".firth", "audit.jsonl")


def _load(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows


def main(argv):
    path = _log_path(argv)
    if not os.path.exists(path):
        print("No audit log at {}\nNothing recorded yet — install the hook and let an agent run.".format(path))
        return 0
    rows = _load(path)
    if not rows:
        print("Audit log is empty: {}".format(path))
        return 0

    exposures = [r for r in rows if r.get("kind") == "exposure"]
    touches = [r for r in rows if r.get("kind") == "touch"]
    ts = sorted(r.get("ts", "") for r in rows if r.get("ts"))
    span = "{}  →  {}".format(ts[0][:19], ts[-1][:19]) if ts else "unknown"
    unique_secrets = {r.get("fingerprint") for r in rows}

    print("=" * 64)
    print(" Firth Observe — what your agents did to your credentials")
    print("=" * 64)
    print(" window      : {}".format(span))
    print(" events      : {} findings across {} distinct secrets".format(len(rows), len(unique_secrets)))
    print(" exposures   : {}  (secrets that left a safe place)".format(len(exposures)))
    print(" touches     : {}  (secrets the agent handled)".format(len(touches)))
    print("=" * 64)

    if exposures:
        print("\n⚠  EXPOSURES (look at these first)\n")
        by_sink = collections.defaultdict(list)
        for r in exposures:
            by_sink[r.get("sink", "?")].append(r)
        sink_order = ["network", "git", "nonsecret_file", "stdout"]
        for sink in sink_order + [s for s in by_sink if s not in sink_order]:
            group = by_sink.get(sink)
            if not group:
                continue
            print("  ┌─ sink: {}  ({} finding(s))".format(sink, len(group)))
            for r in group:
                print("  │  [{}] {}".format(SEV_LABEL.get(r.get("severity"), "?"), r.get("note", "")))
                print("  │     secret : {}".format(r.get("fingerprint")))
                print("  │     where  : {}  (tool {})".format(r.get("surface"), r.get("tool")))
                print("  │     when   : {}".format((r.get("ts") or "")[:19]))
                if r.get("snippet"):
                    print("  │     context: {}".format(r.get("snippet")))
            print("  └─")
    else:
        print("\n✓ No exposures recorded.\n")

    if touches:
        print("\n·  TOUCHES (informational)\n")
        counter = collections.Counter(
            (r.get("detector"), r.get("note")) for r in touches)
        for (detector, note), count in counter.most_common():
            print("   {:>3}×  {}  — {}".format(count, detector, note))

    print("\n(local audit only — nothing in this report has left your machine)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

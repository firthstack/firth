#!/usr/bin/env python3
"""Offline self-test for the scanner — no Claude Code, no live secrets.

Run: python3 observe/selftest.py
Exits non-zero if any case fails.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scanner import scan_event  # noqa: E402

# Synthetic, non-real secrets shaped like the real formats.
AKIA = "AKIA" + "Q" * 16
GHP = "ghp_" + "a1b2c3d4e5" * 4  # 44 chars after prefix
STRIPE = "sk_live_" + "0A1b2C3d4E5f6G7h"

CASES = [
    {
        "name": "read .env -> touch",
        "event": {"tool_name": "Read", "tool_input": {"file_path": "/app/.env"},
                  "tool_response": {"type": "text", "text": "DB_PASSWORD=hunter2pass\n"}},
        "expect_kinds": {"touch"},
        "expect_min": 1,
    },
    {
        "name": "write AWS key into source -> exposure/high/nonsecret_file",
        "event": {"tool_name": "Write",
                  "tool_input": {"file_path": "/app/src/config.ts",
                                 "content": "export const k = '" + AKIA + "'"},
                  "tool_response": {"type": "text", "text": "ok"}},
        "expect_sink": "nonsecret_file",
        "expect_sev": "high",
    },
    {
        "name": "curl with github token -> exposure/high/network",
        "event": {"tool_name": "Bash",
                  "tool_input": {"command": "curl -H 'Authorization: Bearer " + GHP + "' https://x"},
                  "tool_response": {"type": "text", "text": "", "exit_code": 0}},
        "expect_sink": "network",
        "expect_sev": "high",
    },
    {
        "name": "echo secret -> exposure/warn/stdout",
        "event": {"tool_name": "Bash",
                  "tool_input": {"command": "echo " + STRIPE},
                  "tool_response": {"type": "text", "text": STRIPE + "\n", "exit_code": 0}},
        "expect_sink": "stdout",
    },
    {
        "name": "git commit .env -> exposure/high/git",
        "event": {"tool_name": "Bash",
                  "tool_input": {"command": "git add .env && git commit -m wip"},
                  "tool_response": {"type": "text", "text": "1 file changed"}},
        "expect_sink": "git",
        "expect_sev": "high",
    },
    {
        "name": "clean command -> no findings",
        "event": {"tool_name": "Bash", "tool_input": {"command": "npm test"},
                  "tool_response": {"type": "text", "text": "ok", "exit_code": 0}},
        "expect_min": 0, "expect_max": 0,
    },
    {
        "name": "env-var reference, not a secret -> no findings",
        "event": {"tool_name": "Write",
                  "tool_input": {"file_path": "/app/db.ts",
                                 "content": "const password = process.env.DB_PASSWORD"},
                  "tool_response": {"type": "text", "text": "ok"}},
        "expect_min": 0, "expect_max": 0,
    },
    {
        "name": "placeholder -> no findings",
        "event": {"tool_name": "Write",
                  "tool_input": {"file_path": "/app/.env.example",
                                 "content": "API_KEY=your_api_key_here"},
                  "tool_response": {"type": "text", "text": "ok"}},
        "expect_min": 0, "expect_max": 0,
    },
]


def check(case):
    findings = scan_event(case["event"])
    n = len(findings)
    if "expect_min" in case and n < case["expect_min"]:
        return "expected >= {} findings, got {}".format(case["expect_min"], n)
    if "expect_max" in case and n > case["expect_max"]:
        return "expected <= {} findings, got {}: {}".format(case["expect_max"], n, findings)
    if case.get("expect_min", 1) >= 1 and n == 0 and case.get("expect_max", 1) != 0:
        return "expected a finding, got none"
    if "expect_kinds" in case:
        kinds = {f["kind"] for f in findings}
        if not kinds & case["expect_kinds"]:
            return "expected kinds {}, got {}".format(case["expect_kinds"], kinds)
    if "expect_sink" in case:
        sinks = {f["sink"] for f in findings}
        if case["expect_sink"] not in sinks:
            return "expected sink {}, got {}".format(case["expect_sink"], sinks)
    if "expect_sev" in case:
        sevs = {f["severity"] for f in findings}
        if case["expect_sev"] not in sevs:
            return "expected severity {}, got {}".format(case["expect_sev"], sevs)
    # No raw secret may appear in any finding.
    blob = repr(findings)
    for raw in (AKIA, GHP, STRIPE, "hunter2pass"):
        if raw in blob:
            return "RAW SECRET LEAKED into findings: {}".format(raw)
    return None


def main():
    failed = 0
    for case in CASES:
        err = check(case)
        if err:
            failed += 1
            print("FAIL  {}\n      {}".format(case["name"], err))
        else:
            print("ok    {}".format(case["name"]))
    print("\n{} passed, {} failed".format(len(CASES) - failed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

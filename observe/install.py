#!/usr/bin/env python3
"""Firth Observe — install the PostToolUse hook into a project's .claude/settings.json.

Usage:
  python3 observe/install.py [project-dir]   # defaults to current directory
  python3 observe/install.py --uninstall [project-dir]

Idempotent. Also adds .firth/ to .gitignore. Nothing leaves the machine.
"""

import json
import os
import sys

HOOK_REL = "observe/hook.py"
MARKER = "firth-observe"


def _settings_path(project_dir):
    return os.path.join(project_dir, ".claude", "settings.json")


def _load(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        print("error: cannot parse {}: {}".format(path, exc))
        sys.exit(1)


def _entry():
    return {
        "matcher": "*",
        "hooks": [{
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/" + HOOK_REL],
            "timeout": 15,
            "_firth": MARKER,
        }],
    }


def _has_firth(post):
    for group in post:
        for h in group.get("hooks", []):
            if h.get("_firth") == MARKER or MARKER in (h.get("command", "") + " ".join(h.get("args", []))):
                return True
    return False


def _gitignore(project_dir):
    path = os.path.join(project_dir, ".gitignore")
    line = ".firth/"
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            existing = fh.read()
        if line in existing.split():
            return False
    with open(path, "a", encoding="utf-8") as fh:
        if existing and not existing.endswith("\n"):
            fh.write("\n")
        fh.write(line + "\n")
    return True


def install(project_dir):
    path = _settings_path(project_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    settings = _load(path)
    hooks = settings.setdefault("hooks", {})
    post = hooks.setdefault("PostToolUse", [])
    if _has_firth(post):
        print("• hook already installed in {}".format(path))
    else:
        post.append(_entry())
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2)
            fh.write("\n")
        print("✓ installed PostToolUse hook -> {}".format(path))
    if _gitignore(project_dir):
        print("✓ added .firth/ to .gitignore")
    else:
        print("• .firth/ already gitignored")
    print("\nDone. New agent tool calls will be audited locally to .firth/audit.jsonl")
    print("Read the report any time:  python3 observe/summary.py")


def uninstall(project_dir):
    path = _settings_path(project_dir)
    settings = _load(path)
    post = settings.get("hooks", {}).get("PostToolUse", [])
    kept = []
    for group in post:
        group["hooks"] = [h for h in group.get("hooks", [])
                          if h.get("_firth") != MARKER and MARKER not in (h.get("command", "") + " ".join(h.get("args", [])))]
        if group["hooks"]:
            kept.append(group)
    settings.setdefault("hooks", {})["PostToolUse"] = kept
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, indent=2)
        fh.write("\n")
    print("✓ removed firth-observe hook from {}".format(path))


def main(argv):
    args = [a for a in argv[1:] if a != "--uninstall"]
    project_dir = os.path.abspath(args[0]) if args else os.getcwd()
    if "--uninstall" in argv:
        uninstall(project_dir)
    else:
        install(project_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

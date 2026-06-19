"""Firth Observe — credential touch/exposure scanner (read-only, local).

Pure stdlib. Given a Claude Code PostToolUse event dict, return a list of
findings describing where an agent *touched* or *exposed* credential material.

Hard rule: this module NEVER stores or returns a raw secret value. Findings
carry only a redacted fingerprint (type + last4 + sha256 prefix) and a snippet
with the secret replaced by that fingerprint.
"""

import hashlib
import re

# --- secret-material detectors -------------------------------------------------
# (name, compiled regex). Specific detectors first; the generic assignment
# detector is lowest-confidence and is dropped where it overlaps a specific hit.
_DETECTORS = [
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b")),
    ("aws_secret_access_key", re.compile(
        r"(?i)aws_secret_access_key\s*[:=]\s*['\"]?([A-Za-z0-9/+]{40})")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("github_pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{82}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("stripe_secret_key", re.compile(r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b")),
    ("llm_api_key", re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("private_key_block", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")),
    ("db_conn_string", re.compile(
        r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^:\s/@]+:[^@\s/]+@[^\s'\"]+")),
    ("bearer_token", re.compile(r"(?i)\bbearer\s+([A-Za-z0-9._\-]{20,})")),
    ("generic_secret_assignment", re.compile(
        r"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|"
        r"client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['\"]?([^\s'\"]{8,})")),
]

# Values that look like placeholders / examples — not real secrets.
_PLACEHOLDER = re.compile(
    r"(?i)^(?:your[_-]|example|changeme|placeholder|dummy|sample|redacted|secret|"
    r"x{4,}|<.+>|\.\.\.|0{6,}|1234567|test[_-]?(?:key|token|secret))")

# Values that are clearly a code reference to a secret, not the secret itself.
_REFERENCE = re.compile(
    r"(process\.env|os\.environ|getenv|import\.meta|\$\{|\$[A-Za-z_]|config\.|"
    r"settings\.|^env\.|^[A-Z][A-Z0-9_]{3,}$)")

# --- secret files --------------------------------------------------------------
_SECRET_FILE = re.compile(
    r"(?i)(?:^|/)(?:"
    r"\.env(?:\.[A-Za-z0-9_]+)?|"          # .env, .env.local, .env.production
    r"\.aws/credentials|"
    r"\.ssh/id_(?:rsa|dsa|ecdsa|ed25519)|"
    r"id_(?:rsa|dsa|ecdsa|ed25519)|"
    r"\.npmrc|\.pypirc|\.netrc|\.git-credentials|"
    r"\.kube/config|kubeconfig|"
    r"\.docker(?:cfg|/config\.json)|"
    r"credentials\.json|service-account[^/]*\.json|"
    r"[^/]+\.(?:pem|key|p12|pfx|keystore|jks)"
    r")$")
# Files that look like secret files but are safe templates.
_SECRET_FILE_SAFE = re.compile(r"(?i)\.(?:example|sample|template|dist)$|\.pub$")

# --- bash command-context classifiers -----------------------------------------
_NETWORK = re.compile(r"(?i)\b(?:curl|wget|httpie|http|nc|ncat|netcat|scp|sftp|ssh|telnet|rsync)\b")
_PRINT = re.compile(r"(?i)\b(?:echo|printf|cat|print|less|more|head|tail|xxd|base64|env|printenv|set)\b")
_GIT_WRITE = re.compile(r"(?i)\bgit\s+(?:add|commit|push|stash)\b")


def is_secret_file(path):
    if not path:
        return False
    if _SECRET_FILE_SAFE.search(path):
        return False
    return bool(_SECRET_FILE.search(path))


def _fingerprint(secret, detector):
    h = hashlib.sha256(secret.encode("utf-8", "ignore")).hexdigest()[:8]
    last4 = secret[-4:] if len(secret) >= 8 else ""
    tail = "••••" + last4 if last4 else "••••"
    return "{}:{}:#{}".format(detector, tail, h)


def _snippet(text, span, fp):
    s, e = span
    redacted = text[:s] + "«" + fp + "»" + text[e:]
    marker = "«" + fp + "»"
    i = redacted.find(marker)
    start = max(0, i - 36)
    end = min(len(redacted), i + len(marker) + 36)
    out = redacted[start:end]
    out = re.sub(r"\s+", " ", out).strip()
    if start > 0:
        out = "…" + out
    if end < len(redacted):
        out = out + "…"
    return out[:160]


def _leaves(obj, prefix):
    out = []

    def walk(o, p):
        if isinstance(o, str):
            out.append((p, o))
        elif isinstance(o, dict):
            for k, v in o.items():
                walk(v, "{}.{}".format(p, k))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, "{}[{}]".format(p, i))

    walk(obj, prefix)
    return out


def _scan_text(text):
    """Return kept matches as (start, end, detector, secret)."""
    hits = []
    for name, rx in _DETECTORS:
        for m in rx.finditer(text):
            gi = m.lastindex
            secret = m.group(gi) if gi else m.group(0)
            span = m.span(gi) if gi else m.span(0)
            if not secret:
                continue
            if _PLACEHOLDER.match(secret):
                continue
            if name == "generic_secret_assignment" and _REFERENCE.search(secret):
                continue
            hits.append((span[0], span[1], name, secret))
    # Sort by position; on an equal span the more-specific detector (earlier in
    # _DETECTORS) was appended first and wins via stable sort. Drop any match
    # that overlaps an already-kept one so a single secret yields one finding
    # even when several patterns match it (e.g. github_token vs bearer_token).
    hits.sort(key=lambda r: (r[0], r[1]))
    kept = []
    for r in hits:
        if any(not (r[1] <= k[0] or r[0] >= k[1]) for k in kept):
            continue
        kept.append(r)
    return kept


def _classify(tool, side, command, file_path, secret_file_target):
    """Return (kind, severity, sink, note) for a detected secret."""
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit") and side == "input":
        if secret_file_target:
            return ("touch", "info", "write_secret_file",
                    "secret written to secret file {}".format(file_path))
        return ("exposure", "high", "nonsecret_file",
                "secret written into {}".format(file_path or "a non-secret file"))
    if tool == "Bash" and side == "input":
        if _NETWORK.search(command):
            return ("exposure", "high", "network", "secret in an outbound network command")
        if _GIT_WRITE.search(command):
            return ("exposure", "high", "git", "secret in a git write command")
        if _PRINT.search(command):
            return ("exposure", "warn", "stdout", "secret printed to stdout")
        return ("touch", "info", "shell", "secret present in a shell command")
    if side == "output":
        if tool == "Bash":
            return ("exposure", "warn", "stdout", "secret appeared in command output")
        return ("touch", "info", "read", "secret visible in tool output")
    return ("touch", "info", "other", "secret handled by agent")


def scan_event(event, ignore_path=None):
    tool = event.get("tool_name") or "?"
    ti = event.get("tool_input") or {}
    tr = event.get("tool_response") or {}
    file_path = ti.get("file_path") or ""
    command = ti.get("command") or ""

    if ignore_path and file_path and ignore_path(file_path):
        return []

    findings = []
    seen = set()

    def add(kind, sev, detector, surface, sink, fp, snippet, note):
        key = (kind, detector, surface, fp, sink)
        if key in seen:
            return
        seen.add(key)
        findings.append({
            "kind": kind, "severity": sev, "detector": detector,
            "surface": surface, "sink": sink, "fingerprint": fp,
            "snippet": snippet, "note": note,
        })

    # Path-based rules (fire even without a value match in content).
    if is_secret_file(file_path):
        if tool == "Read":
            add("touch", "info", "secret_file", "{}.file_path".format(tool), "read",
                "file:" + file_path.rsplit("/", 1)[-1], file_path,
                "agent read secret file {}".format(file_path))
        elif tool in ("Write", "Edit", "MultiEdit"):
            add("touch", "info", "secret_file", "{}.file_path".format(tool), "write_secret_file",
                "file:" + file_path.rsplit("/", 1)[-1], file_path,
                "agent wrote secret file {}".format(file_path))
    if command and _GIT_WRITE.search(command):
        for tok in re.findall(r"[^\s'\"]+", command):
            if is_secret_file(tok):
                add("exposure", "high", "secret_file", "Bash.command", "git",
                    "file:" + tok.rsplit("/", 1)[-1], "git ... {}".format(tok),
                    "secret file {} staged/committed via git".format(tok))

    # Value-based rules: scan every string surface of input and output.
    secret_file_target = is_secret_file(file_path)
    for surface, text in _leaves(ti, "input") + _leaves(tr, "output"):
        if not text or len(text) > 1_000_000:
            continue
        side = "input" if surface.startswith("input") else "output"
        for start, end, detector, secret in _scan_text(text):
            fp = _fingerprint(secret, detector)
            kind, sev, sink, note = _classify(tool, side, command, file_path, secret_file_target)
            add(kind, sev, detector, "{}:{}".format(tool, surface), sink, fp,
                _snippet(text, (start, end), fp), note)

    return findings

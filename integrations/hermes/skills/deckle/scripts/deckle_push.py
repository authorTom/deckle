#!/usr/bin/env python3
"""Copy files or whole folders into a Deckle knowledge base.

For what MCP's save_file is not built for: big files (it takes 10 MB of
base64 at most) and whole folders — a project's working directory, a set of
generated reports. Uploads over Deckle's REST API, one file per request, with
the same bearer token Hermes uses for MCP.

    deckle_push.py report.pdf --project "Acme research"
    deckle_push.py ./out --project "Acme research" --message "final deliverables"
    deckle_push.py ./site --to "Projects/Blog relaunch/site" --dry-run

Folders keep their structure under the destination. Some things are never
sent: hidden files and folders (.git, .env, .venv…), dependency and build
caches (node_modules, __pycache__…), private keys and credential files, and
anything matching a pattern in a .deckleignore file at the top of a pushed
folder or given with --exclude. A file already in Deckle is replaced — the old
copy goes to Deckle's recycle bin — unless --no-overwrite is given.

Needs DECKLE_URL (e.g. https://deckle.example.com) and DECKLE_TOKEN in the
environment. Python 3.8+, standard library only. Exits non-zero if anything
failed to upload.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Folders that are never anyone's knowledge.
SKIP_DIRS = {
    "node_modules", "__pycache__", "venv", "env", ".venv", ".tox", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".next", ".nuxt", ".cache", ".gradle", ".idea",
    ".vscode", "target", "bower_components", ".terraform",
}

# Files that must never leave the machine, whatever the agent was asked.
SECRET_PATTERNS = [
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore",
    "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*", "*.kdbx", "credentials.json",
    "credentials", "*.credentials", "secrets.*", "*.secret", ".netrc", ".pgpass",
    "*.tfstate", "*.tfstate.*", "service-account*.json",
]

# Clutter that only operating systems and editors care about.
CLUTTER_PATTERNS = ["*.pyc", "*.pyo", "*.swp", "*~", "Thumbs.db", "desktop.ini"]


def is_secret(name: str) -> bool:
    lower = name.lower()
    return any(fnmatch.fnmatch(lower, p) for p in SECRET_PATTERNS)


def read_ignore_file(folder: Path) -> list[str]:
    ignore = folder / ".deckleignore"
    if not ignore.is_file():
        return []
    patterns = []
    for line in ignore.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(line.rstrip("/"))
    return patterns


def matches(rel: str, patterns: list[str]) -> bool:
    """A .gitignore-ish match: a pattern with no slash matches any path segment."""
    parts = rel.split("/")
    for pattern in patterns:
        if "/" in pattern:
            if fnmatch.fnmatch(rel, pattern.lstrip("/")) or fnmatch.fnmatch(rel, pattern.lstrip("/") + "/*"):
                return True
        elif any(fnmatch.fnmatch(part, pattern) for part in parts):
            return True
    return False


def collect(paths: list[str], excludes: list[str]) -> tuple[list[tuple[Path, str]], list[tuple[str, str]]]:
    """Every file to send as (local path, path relative to the destination), and what was skipped."""
    files: list[tuple[Path, str]] = []
    skipped: list[tuple[str, str]] = []
    for raw in paths:
        root = Path(raw).expanduser()
        if not root.exists():
            skipped.append((raw, "does not exist"))
            continue
        if root.is_file():
            if root.name.startswith("."):
                skipped.append((raw, "hidden file"))
            elif is_secret(root.name):
                skipped.append((raw, "looks like a secret"))
            else:
                files.append((root, root.name))
            continue
        patterns = excludes + read_ignore_file(root)
        base = root.resolve().name
        for dirpath, dirnames, filenames in os.walk(root):
            here = Path(dirpath)
            rel_dir = here.relative_to(root).as_posix()
            rel_dir = "" if rel_dir == "." else rel_dir
            keep = []
            for d in sorted(dirnames):
                rel = f"{rel_dir}/{d}" if rel_dir else d
                if d.startswith(".") or d in SKIP_DIRS or matches(rel, patterns):
                    continue
                keep.append(d)
            dirnames[:] = keep  # prune the walk
            for name in sorted(filenames):
                rel = f"{rel_dir}/{name}" if rel_dir else name
                full = here / name
                if name.startswith("."):
                    continue  # hidden: never sent, not worth a line each
                if any(fnmatch.fnmatch(name, p) for p in CLUTTER_PATTERNS):
                    continue
                if is_secret(name):
                    skipped.append((f"{base}/{rel}", "looks like a secret"))
                    continue
                if matches(rel, patterns):
                    continue
                if full.is_symlink() or not full.is_file():
                    skipped.append((f"{base}/{rel}", "not a regular file"))
                    continue
                files.append((full, f"{base}/{rel}"))
    return files, skipped


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def upload(base_url: str, token: str, dest: str, local: Path, overwrite: bool, message: str | None) -> tuple[int, dict]:
    quoted = "/".join(urllib.parse.quote(part, safe="") for part in dest.split("/"))
    query = {}
    if not overwrite:
        query["overwrite"] = "false"
    if message:
        query["message"] = message
    url = f"{base_url}/api/v1/files/{quoted}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = local.read_bytes()
    request = urllib.request.Request(
        url,
        data=data,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(data)),
            "User-Agent": "deckle-push/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            body = json.loads(err.read() or b"{}")
        except ValueError:
            body = {}
        return err.code, body


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Copy files or folders into a Deckle knowledge base.",
        epilog="Needs DECKLE_URL and DECKLE_TOKEN in the environment.",
    )
    parser.add_argument("paths", nargs="+", help="files and folders to send")
    where = parser.add_mutually_exclusive_group()
    where.add_argument("--project", help='shorthand for --to "Projects/<name>"')
    where.add_argument("--to", help="destination folder in the library (default: Inbox)")
    parser.add_argument("--message", help="one line on what this is, shown in Deckle's activity log")
    parser.add_argument("--no-overwrite", action="store_true", help="skip files that already exist in Deckle")
    parser.add_argument("--exclude", action="append", default=[], metavar="PATTERN", help="skip matching paths (repeatable)")
    parser.add_argument("--max-mb", type=float, default=100, help="skip files larger than this (default 100)")
    parser.add_argument("--flatten", action="store_true", help="drop a pushed folder's own name from the destination")
    parser.add_argument("--dry-run", action="store_true", help="list what would be sent, and send nothing")
    args = parser.parse_args()

    base_url = os.environ.get("DECKLE_URL", "").rstrip("/")
    token = os.environ.get("DECKLE_TOKEN", "")
    if base_url.endswith("/api/v1/mcp"):
        base_url = base_url[: -len("/api/v1/mcp")]
    if not args.dry_run and (not base_url or not token):
        print("DECKLE_URL and DECKLE_TOKEN must be set.", file=sys.stderr)
        return 2

    dest_root = f"Projects/{args.project}" if args.project else (args.to or "Inbox")
    dest_root = dest_root.strip("/")
    files, skipped = collect(args.paths, args.exclude)
    limit = int(args.max_mb * 1024 * 1024)

    sent = replaced = 0
    failed: list[tuple[str, str]] = []
    total_bytes = 0
    for local, rel in files:
        if args.flatten and "/" in rel:
            rel = rel.split("/", 1)[1]
        dest = f"{dest_root}/{rel}" if dest_root else rel
        size = local.stat().st_size
        if size > limit:
            skipped.append((str(local), f"larger than {human(limit)}"))
            continue
        if args.dry_run:
            print(f"would send {dest} ({human(size)})")
            continue
        status, body = upload(base_url, token, dest, local, not args.no_overwrite, args.message)
        if status in (200, 201):
            sent += 1
            total_bytes += size
            if status == 200:
                replaced += 1
            print(f"{'replaced' if status == 200 else 'saved'} {dest} ({human(size)})")
        elif status == 409 and args.no_overwrite:
            skipped.append((dest, "already in Deckle"))
        else:
            reason = (body.get("error") or {}).get("message") if isinstance(body, dict) else None
            failed.append((dest, reason or f"HTTP {status}"))
            print(f"failed {dest}: {reason or f'HTTP {status}'}", file=sys.stderr)

    if args.dry_run:
        print(f"\n{len(files)} file(s) would go to {dest_root}/")
    else:
        extra = f", {replaced} replaced (old copies are in Deckle's recycle bin)" if replaced else ""
        print(f"\nSent {sent} file(s), {human(total_bytes)}, to {dest_root}/{extra}.")
    for name, reason in skipped:
        print(f"skipped {name}: {reason}")
    for name, reason in failed:
        print(f"FAILED {name}: {reason}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

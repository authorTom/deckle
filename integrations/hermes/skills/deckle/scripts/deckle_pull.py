#!/usr/bin/env python3
"""Download a Deckle brief's files into a local folder to work on.

MCP's `read` gives back the text of notes, Word, Excel, PowerPoint, CSV and
code files, but not their bytes — and nothing at all of a PDF or an image. To
open the original (a .docx template to fill in, a PDF to parse, a photo to
crop), pull the brief's files down:

    deckle_pull.py "Projects/Acme/Briefs/2026-11-19 Pitch deck"
    deckle_pull.py "Projects/Acme/Briefs/2026-11-19 Pitch deck" ./work --output

Lays them out as:

    <folder>/Context/...          the files attached to the brief
    <folder>/Project context/...  the files shared across the project
    <folder>/Output/...           what was delivered before (with --output),
                                  to build on when changes were requested

The folder defaults to the brief's title, in the current directory. Files that
are already there with the same size are skipped, so pulling again is cheap.
Never writes outside the folder.

Needs DECKLE_URL and DECKLE_TOKEN in the environment (a read-only token is
enough). Python 3.8+, standard library only. Exits non-zero if anything
failed to download.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath


def request(base_url: str, token: str, path: str) -> urllib.request.Request:
    return urllib.request.Request(
        f"{base_url}/api/v1{path}",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "deckle-pull/1"},
    )


def get_json(base_url: str, token: str, path: str) -> dict:
    with urllib.request.urlopen(request(base_url, token, path), timeout=60) as response:
        return json.loads(response.read() or b"{}")


def safe_target(folder: Path, relative: str) -> Path | None:
    """`folder/relative`, or None if the name would land outside the folder."""
    parts = PurePosixPath(relative).parts
    if not parts or any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None
    target = (folder / Path(*parts)).resolve()
    root = folder.resolve()
    return target if target == root or root in target.parents else None


def download(base_url: str, token: str, library_path: str, target: Path) -> int:
    quoted = "/".join(urllib.parse.quote(part, safe="") for part in library_path.split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    size = 0
    with urllib.request.urlopen(request(base_url, token, f"/files/{quoted}"), timeout=300) as response:
        with open(partial, "wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                size += len(chunk)
    os.replace(partial, target)
    return size


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download a Deckle brief's files into a local folder.",
        epilog="Needs DECKLE_URL and DECKLE_TOKEN in the environment.",
    )
    parser.add_argument("brief", help='the brief id, e.g. "Projects/Acme/Briefs/2026-11-19 Pitch deck"')
    parser.add_argument("folder", nargs="?", help="where to put them (default: a folder named after the brief)")
    parser.add_argument("--output", action="store_true", help="also pull what was delivered before")
    parser.add_argument("--no-project", action="store_true", help="skip the project's shared Context folder")
    args = parser.parse_args()

    base_url = os.environ.get("DECKLE_URL", "").rstrip("/")
    token = os.environ.get("DECKLE_TOKEN", "")
    if base_url.endswith("/api/v1/mcp"):
        base_url = base_url[: -len("/api/v1/mcp")]
    if not base_url or not token:
        print("DECKLE_URL and DECKLE_TOKEN must be set.", file=sys.stderr)
        return 2

    try:
        brief = get_json(base_url, token, "/briefs/detail?" + urllib.parse.urlencode({"id": args.brief}))
    except urllib.error.HTTPError as err:
        try:
            reason = (json.loads(err.read() or b"{}").get("error") or {}).get("message")
        except ValueError:
            reason = None
        print(f"Could not read the brief: {reason or f'HTTP {err.code}'}", file=sys.stderr)
        return 1

    title = "".join(c for c in brief.get("title", "brief") if c not in '\\/:*?"<>|').strip() or "brief"
    folder = Path(args.folder or title).expanduser()
    folder.mkdir(parents=True, exist_ok=True)

    plan: list[tuple[str, str, int | None]] = []  # (library path, relative target, size)
    for entry in brief.get("context", []):
        plan.append((entry["path"], "Context/" + entry["path"][len(brief["contextDir"]) + 1 :], entry.get("size")))
    if not args.no_project:
        prefix = f"Projects/{brief['project']}/Context/"
        for entry in brief.get("projectContext", []):
            if entry["path"].startswith(prefix):
                plan.append((entry["path"], "Project context/" + entry["path"][len(prefix) :], entry.get("size")))
    if args.output:
        for entry in brief.get("output", []):
            plan.append((entry["path"], "Output/" + entry["path"][len(brief["outputDir"]) + 1 :], entry.get("size")))

    got = kept = 0
    failed: list[tuple[str, str]] = []
    for library_path, relative, size in plan:
        target = safe_target(folder, relative)
        if target is None:
            failed.append((library_path, "unsafe name"))
            continue
        if size is not None and target.is_file() and target.stat().st_size == size:
            kept += 1
            continue
        try:
            n = download(base_url, token, library_path, target)
            got += 1
            print(f"pulled {relative} ({n} bytes)")
        except (urllib.error.URLError, OSError) as err:
            failed.append((library_path, str(err)))
            print(f"failed {library_path}: {err}", file=sys.stderr)

    extra = f", {kept} already up to date" if kept else ""
    print(f"\nPulled {got} file(s) into {folder}/{extra}.")
    for name, reason in failed:
        print(f"FAILED {name}: {reason}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Prepare and verify the Chinook demonstration source. Stdlib only.

The upstream artifact is pinned by URL and SHA-256 and never modified:

    python3 examples/chinook/prepare.py                     # download and verify
    python3 examples/chinook/prepare.py --from PATH         # verify a local copy instead
    python3 examples/chinook/prepare.py --verify            # re-check hash and mtime
    python3 examples/chinook/prepare.py --view-copy         # demo working copy + one view

Everything lands in examples/chinook/data/ (gitignored). The view copy is a
separate file: the reader-authored view in views/ is applied to a copy, never
to the upstream artifact, and the copy is reported with its own hash.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sqlite3
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
UPSTREAM_URL = (
    "https://github.com/lerocha/chinook-database/releases/download/v1.4.5/"
    "Chinook_Sqlite.sqlite"
)
UPSTREAM_NAME = "Chinook_Sqlite.sqlite"
# Measured from the v1.4.5 release asset on download, not taken from upstream.
UPSTREAM_SHA256 = "bdf635be69850bd3be09c9a2dbeef7ddfb80036bd3ef3381383cd03b61e4a61a"
UPSTREAM_SIZE = 1_067_008
VIEW_SQL = HERE / "views" / "invoice_line_customer.sql"
VIEW_COPY_NAME = "Chinook_Sqlite.with-view.sqlite"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check_upstream(path: Path) -> None:
    actual = sha256(path)
    if actual != UPSTREAM_SHA256:
        raise SystemExit(
            f"{path}: SHA-256 {actual} is not the pinned v1.4.5 artifact {UPSTREAM_SHA256}"
        )


def fetch(target: Path, local: Path | None) -> None:
    if target.exists():
        check_upstream(target)
        print(f"present  {target}")
        return
    DATA.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=DATA, delete=False, suffix=".part") as handle:
        partial = Path(handle.name)
    try:
        if local is not None:
            # The caller's file is only read; the demo serves its own copy.
            check_upstream(local)
            shutil.copyfile(local, partial)
        else:
            with urllib.request.urlopen(UPSTREAM_URL) as response, partial.open("wb") as out:
                shutil.copyfileobj(response, out)
        check_upstream(partial)
        # Read-only on disk too: nothing in the demo needs to write it.
        partial.chmod(0o444)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    print(f"prepared {target}")


def report(path: Path) -> None:
    status = path.stat()
    print(f"sha256   {sha256(path)}")
    print(f"size     {status.st_size}")
    print(f"mtime_ns {status.st_mtime_ns}")
    sidecars = [p.name for p in path.parent.glob(path.name + "-*")]
    print(f"sidecars {sidecars or 'none'}")


def view_copy(upstream: Path, target: Path) -> None:
    check_upstream(upstream)
    before = upstream.stat().st_mtime_ns
    partial = target.with_suffix(".part")
    shutil.copyfile(upstream, partial)
    db = sqlite3.connect(partial)
    try:
        db.executescript(VIEW_SQL.read_text(encoding="utf-8"))
        db.commit()
    finally:
        db.close()
    partial.replace(target)
    # The view went into the copy only.
    check_upstream(upstream)
    if upstream.stat().st_mtime_ns != before:
        raise SystemExit(f"{upstream}: modification time changed while building the copy")
    print(f"view copy {target}")
    report(target)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="local", type=Path, help="verify and use a local copy of the v1.4.5 asset")
    parser.add_argument("--verify", action="store_true", help="re-check the prepared artifact")
    parser.add_argument("--view-copy", action="store_true", help="build the separate view working copy")
    args = parser.parse_args()
    upstream = DATA / UPSTREAM_NAME
    if args.verify:
        if not upstream.exists():
            raise SystemExit(f"{upstream} is missing; run prepare.py first")
        check_upstream(upstream)
        print(f"verified {upstream} (pinned v1.4.5)")
        report(upstream)
        return
    fetch(upstream, args.local)
    report(upstream)
    if args.view_copy:
        view_copy(upstream, DATA / VIEW_COPY_NAME)


if __name__ == "__main__":
    sys.exit(main())

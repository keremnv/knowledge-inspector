#!/usr/bin/env python3
"""Run both Chinook demonstrations from one command. Stdlib only.

    python3 examples/chinook/run.py            # upstream file: structure + reading
    python3 examples/chinook/run.py --view     # demo view copy + its reading

Starts, from the repository root:

  - the structural adapter (adapters/sqlite/server.py) on 127.0.0.1:8149,
    reading the file by reference on every request;
  - the conceptual adapter (adapters/world/server.py) on 127.0.0.1:8139,
    serving a private startup snapshot through the external declaration;
  - the Vite dev server, with /sqlite/* proxied to 8149 and /world/* to 8139.

Then open http://127.0.0.1:5173/sqlite (structure) and
http://127.0.0.1:5173/ (reading). Ctrl-C stops all three. Run prepare.py
first; this script never downloads or writes the database.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA = HERE / "data"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--view", action="store_true", help="serve the demo view copy and its reading")
    parser.add_argument("--structural-port", type=int, default=8149)
    parser.add_argument("--world-port", type=int, default=8139)
    args = parser.parse_args()

    if args.view:
        db = DATA / "Chinook_Sqlite.with-view.sqlite"
        declaration = HERE / "declaration-view.json"
        hint = "python3 examples/chinook/prepare.py --view-copy"
    else:
        db = DATA / "Chinook_Sqlite.sqlite"
        declaration = HERE / "declaration.json"
        hint = "python3 examples/chinook/prepare.py"
    if not db.exists():
        print(f"{db.relative_to(ROOT)} is missing; run: {hint}", file=sys.stderr)
        return 1

    children = [
        subprocess.Popen(
            [sys.executable, "adapters/sqlite/server.py", "--db", str(db), "--port", str(args.structural_port)],
            cwd=ROOT,
            start_new_session=True,
        ),
        subprocess.Popen(
            [sys.executable, "adapters/world/server.py", "--db", str(db),
             "--declaration", str(declaration), "--port", str(args.world_port)],
            cwd=ROOT,
            start_new_session=True,
        ),
        subprocess.Popen(
            ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
            cwd=ROOT,
            env={
                **os.environ,
                "VITE_WORLD_TARGET": f"http://127.0.0.1:{args.world_port}",
                "VITE_SQLITE_TARGET": f"http://127.0.0.1:{args.structural_port}",
            },
            # npm starts Vite as its own child: each child gets a process
            # group, so stopping reaches everything it started.
            start_new_session=True,
        ),
    ]
    print("structure: http://127.0.0.1:5173/sqlite   reading: http://127.0.0.1:5173/", flush=True)
    try:
        while all(child.poll() is None for child in children):
            try:
                children[0].wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
    failed = [child.args[1] if child.args[0] == sys.executable else "vite" for child in children
              if child.returncode not in (0, None, -signal.SIGINT, 130)]
    if failed:
        print(
            f"stopped early: {', '.join(failed)} (a port already in use? see --structural-port and --world-port)",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

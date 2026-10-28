"""The installed `ki` command: `adapters.source.app` with the packaged frontend.

The frontend is located as this package's resource, never by assuming a
repository checkout exists. It must carry the manifest the release build wrote
(`ki-frontend.json`), so a missing or damaged file stops the launch before a
capture is taken. Nothing is built or downloaded at startup.
"""
from __future__ import annotations

import sys
from importlib.resources import files
from pathlib import Path

from knowledge_inspector import __version__

REINSTALL = ("This installation of ki is incomplete; reinstall it from a release wheel "
             "(see \"Build a release wheel\" in the README).")


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 11):
        print("ki: Python 3.11 or newer is required", file=sys.stderr)
        return 2
    try:
        from adapters.source.app import main as app_main
    except ImportError as failure:
        # The service modules ship as the top-level `adapters` package.
        print(f"ki: cannot load the Source service ({failure}).\n  {REINSTALL}", file=sys.stderr)
        return 2
    frontend = files("knowledge_inspector") / "frontend"
    if not isinstance(frontend, Path):
        print(f"ki: the packaged frontend is not on the file system ({frontend}).\n  {REINSTALL}", file=sys.stderr)
        return 2
    return app_main(argv, frontend=frontend, frontend_hint=REINSTALL, require_manifest=True, version=__version__)


if __name__ == "__main__":
    sys.exit(main())

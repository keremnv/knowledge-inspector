"""Knowledge Inspector as one local application over one SQLite file.

    ki open /path/to/database.sqlite [--port N] [--no-browser]

Run as `bin/ki` from a checkout (frontend in `dist/`), or as the installed
`ki` command (`knowledge_inspector.cli`, frontend packaged in the wheel).

One loopback-only origin serves the built Source workspace and its
/source/v1 API, so neither a Vite server nor a second process is needed.
The API uses the captured Source service with no idle expiry: the same capture,
Host/Origin, request-size, admission and read-only rules (`server.py`). The
application's own pages pass the same Host/Origin check before any byte is
served. Ctrl+C or SIGTERM stops the service and releases its capture.

Owner decision O19: a browser app with a small local companion service.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import signal
import sqlite3
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from adapters.capture import CaptureError, SnapshotUnavailable
from adapters.sqlite.server import request_allowed
from adapters.source.server import Handler, SessionManager, SourceHTTPServer

SQLITE_HEADER = b"SQLite format 3\x00"
# Written by scripts/build_release.py beside a packaged frontend: every file's
# SHA-256 and the entry it was built for. Never served (only index.html and
# /assets/* are).
FRONTEND_MANIFEST = "ki-frontend.json"
CHECKOUT_HINT = f"Build it once from the repository: cd {_ROOT} && npm ci && npm run build"
# Built file names: letters, digits, dot, dash, underscore; never a separator.
ASSET_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}")
TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png",
         ".json": "application/json", ".map": "application/json"}


class LaunchError(Exception):
    """A failure to report plainly, with the exit status it calls for."""
    def __init__(self, message: str, status: int = 1):
        super().__init__(message)
        self.status = status


class AppHandler(Handler):
    """The Source API as `Handler` serves it, plus the built workspace."""
    server_version = "KnowledgeInspector/1.0"

    def send_bytes(self, status: int, body: bytes, content_type: str, cache: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/source/v1/"):
            super().do_GET()
            return
        # The same gates the API applies, before anything else.
        if not request_allowed(self.headers):
            self.send_json(403, {"error": "source_loopback_origin_required"})
            return
        if len(self.path) > 8192 or self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0") != "0":
            self.send_json(400, {"error": "application_request_refused"})
            return
        frontend: Path = self.server.frontend
        try:
            if path == "/":
                self.send_response(302)
                self.send_header("Location", "/source")
                self.send_header("Content-Length", "0")
                self.end_headers()
            elif path == "/source":
                self.send_bytes(200, (frontend / "index.html").read_bytes(), "text/html; charset=utf-8", "no-store")
            elif path.startswith("/assets/") and ASSET_NAME.fullmatch(name := path[len("/assets/"):]) and (frontend / "assets" / name).is_file():
                kind = TYPES.get(Path(name).suffix) or mimetypes.guess_type(name)[0] or "application/octet-stream"
                # Vite names built assets by content hash: a name never changes meaning.
                self.send_bytes(200, (frontend / "assets" / name).read_bytes(), kind, "public, max-age=31536000, immutable")
            else:
                self.send_bytes(404, b"not found\n", "text/plain; charset=utf-8", "no-store")
        except (BrokenPipeError, ConnectionResetError):
            pass


class AppServer(SourceHTTPServer):
    def __init__(self, address, manager, frontend: Path):
        self.frontend = frontend
        super().__init__(address, manager)
        # SourceHTTPServer binds its own handler; the application adds its pages.
        self.RequestHandlerClass = AppHandler


def frontend_problems(frontend: Path, require_manifest: bool = False) -> list[str]:
    """What is wrong with a built frontend, or nothing: every asset the page
    names exists and, given a manifest, every listed file has its hash."""
    problems = []
    for name in sorted(set(re.findall(r'"/assets/([^"?#]+)"', (frontend / "index.html").read_text("utf-8", "replace")))):
        if not ASSET_NAME.fullmatch(name) or not (frontend / "assets" / name).is_file():
            problems.append(f"index.html names a missing asset: /assets/{name}")
    manifest = frontend / FRONTEND_MANIFEST
    if not manifest.is_file():
        return problems + ([f"no {FRONTEND_MANIFEST}"] if require_manifest else [])
    try:
        recorded = json.loads(manifest.read_text("utf-8"))
        files = recorded["files"]
        if recorded.get("format") != 1 or recorded.get("entry") != "source" or not isinstance(files, dict) or "index.html" not in files:
            return problems + [f"{FRONTEND_MANIFEST} is not a Source frontend manifest"]
    except (ValueError, KeyError, TypeError):
        return problems + [f"{FRONTEND_MANIFEST} is unreadable"]
    for name, digest in sorted(files.items()):
        path = frontend / name
        if name != "index.html" and not (name.startswith("assets/") and ASSET_NAME.fullmatch(name[len("assets/"):])):
            problems.append(f"{FRONTEND_MANIFEST} lists an unexpected path: {name}")
        elif not path.is_file():
            problems.append(f"missing: {name}")
        elif hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            problems.append(f"damaged (SHA-256 differs from the build): {name}")
    return problems


def check_frontend(frontend: Path, hint: str = CHECKOUT_HINT, require_manifest: bool = False) -> Path:
    if not (frontend / "index.html").is_file() or not (frontend / "assets").is_dir():
        raise LaunchError(f"the Source frontend is missing or not built (no {frontend / 'index.html'} or {frontend / 'assets'}).\n  {hint}", 2)
    if problems := frontend_problems(frontend, require_manifest):
        shown = "\n  ".join(problems[:8] + ([f"… and {len(problems) - 8} more"] if len(problems) > 8 else []))
        raise LaunchError(f"the Source frontend at {frontend} is incomplete or damaged:\n  {shown}\n  {hint}", 2)
    return frontend.resolve()


def check_database(path: Path) -> Path:
    if not path.exists():
        raise LaunchError(f"no such file: {path}", 2)
    if not path.is_file():
        raise LaunchError(f"not a file: {path}", 2)
    try:
        with path.open("rb") as handle:
            header = handle.read(len(SQLITE_HEADER))
    except OSError as failure:
        raise LaunchError(f"cannot read {path}: {failure.strerror or failure}", 2) from failure
    if header != SQLITE_HEADER:
        raise LaunchError(f"not a SQLite database (no SQLite header): {path}", 2)
    return path.resolve()


def run(args: argparse.Namespace) -> int:
    frontend = check_frontend(args.frontend, getattr(args, "frontend_hint", CHECKOUT_HINT),
                              getattr(args, "require_manifest", False))
    database = check_database(args.database)
    manager = server = None

    def terminate(signum, frame):
        raise KeyboardInterrupt
    # Installed before the capture, so termination during a long read still
    # unwinds the capture owner's cleanup (as server.py does). SIGINT too: a
    # shell starts background jobs with it ignored, and Python then never
    # installs its own Ctrl+C handler.
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        print(f"capturing {database} …", flush=True)
        try:
            manager = SessionManager(database, ttl_s=None, capture_deadline_s=args.capture_deadline)
        except (SnapshotUnavailable, CaptureError, sqlite3.Error) as failure:
            raise LaunchError(f"cannot capture {database}: {getattr(failure, 'code', None) or failure}") from failure
        except ValueError as failure:
            raise LaunchError(f"cannot capture {database}: {failure}") from failure
        try:
            server = AppServer(("127.0.0.1", args.port), manager, frontend)
        except OSError as failure:
            raise LaunchError(f"cannot listen on 127.0.0.1:{args.port}: {failure.strerror or failure}") from failure
        url = f"http://127.0.0.1:{server.server_port}/source"
        print(f"Knowledge Inspector: {url}\n  {database} (read-only capture)\n  Ctrl+C to stop", flush=True)
        if not args.no_browser:
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server is not None:
            server.server_close()
        if manager is not None:
            manager.close()
            print("stopped; capture released", flush=True)
    return 0


def main(argv: list[str] | None = None, *, frontend: Path | None = None, frontend_hint: str = CHECKOUT_HINT,
         require_manifest: bool = False, version: str | None = None) -> int:
    """`frontend` defaults to the checkout's `dist/`; the installed command
    passes its packaged copy, which must carry its manifest."""
    if sys.version_info < (3, 11):
        print("ki: Python 3.11 or newer is required", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(prog="ki", description="Knowledge Inspector: inspect a SQLite file, read-only, in the browser.")
    if version:
        parser.add_argument("--version", action="version", version=f"ki {version}")
    commands = parser.add_subparsers(dest="command", required=True)
    open_ = commands.add_parser("open", help="open one SQLite file in the browser")
    open_.add_argument("database", type=Path, help="the SQLite file to inspect (never written)")
    open_.add_argument("--port", type=int, default=0, help="loopback port (default: a free one)")
    open_.add_argument("--no-browser", action="store_true", help="print the address instead of opening a browser")
    open_.add_argument("--frontend", type=Path, default=frontend or _ROOT / "dist", help=argparse.SUPPRESS)
    open_.add_argument("--capture-deadline", type=float, default=120, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    args.frontend_hint, args.require_manifest = frontend_hint, require_manifest
    try:
        return run(args)
    except LaunchError as failure:
        print(f"ki: {failure}", file=sys.stderr)
        return failure.status


if __name__ == "__main__":
    sys.exit(main())

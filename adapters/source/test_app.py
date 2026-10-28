"""The local application launcher (owner decision O19): bin/ki open DB.

Runs the real `bin/ki` as a process, with its own temporary directory so the
capture it owns can be found and checked gone, and its own small frontend so
these tests do not depend on a build.

Run: python3 -m unittest adapters.source.test_app -v
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KI = ROOT / "bin" / "ki"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Launch:
    """One `ki open` process and what it printed."""
    def __init__(self, test, *args, env=None):
        self.process = subprocess.Popen([sys.executable, str(KI), "open", *args], cwd=ROOT,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.lines = []
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if not line:
                break
            self.lines.append(line)
            if line.startswith("Knowledge Inspector: "):
                self.url = line.split(": ", 1)[1].strip()
                self.origin = self.url.rsplit("/source", 1)[0]
                return
        self.process.kill()
        test.fail("ki did not report an address: " + "".join(self.lines) + self.process.stderr.read())

    def get(self, path, headers=None, method="GET"):
        request = urllib.request.Request(self.origin + path, headers=headers or {}, method=method)
        opener = urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(request, timeout=10) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as failure:
            return failure.code, dict(failure.headers), failure.read()

    def stop(self, sig=signal.SIGINT):
        self.process.send_signal(sig)
        out, err = self.process.communicate(timeout=15)
        return self.process.returncode, "".join(self.lines) + out, err


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class AppFixture(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="ki-app-test-"))
        self.tmp = self.dir / "tmp"; self.tmp.mkdir()
        self.db = self.dir / "fixture.sqlite"
        with sqlite3.connect(self.db) as db:
            db.executescript("CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);"
                             "INSERT INTO parent VALUES (1, 'one'), (2, 'two');")
        db.close()
        self.frontend = self.dir / "dist"; (self.frontend / "assets").mkdir(parents=True)
        (self.frontend / "index.html").write_text("<!doctype html><script type=module src=/assets/app-1a2b3c4d.js></script>")
        (self.frontend / "assets" / "app-1a2b3c4d.js").write_text("console.log('app')")
        self.env = {**os.environ, "TMPDIR": str(self.tmp), "BROWSER": ""}

    def tearDown(self):
        subprocess.run(["rm", "-rf", str(self.dir)], check=False)

    def captures(self):
        return sorted(p.name for p in self.tmp.iterdir() if p.name.startswith("knowledge-inspector-source-"))

    def launch(self, *extra, env=None):
        return Launch(self, str(self.db), "--no-browser", "--frontend", str(self.frontend), *extra, env=env or self.env)


class TestApplication(AppFixture):
    def test_one_loopback_origin_serves_the_workspace_and_the_api(self):
        before = sha256(self.db)
        app = self.launch()
        try:
            self.assertRegex(app.url, r"^http://127\.0\.0\.1:\d+/source$")
            self.assertEqual(len(self.captures()), 1)
            status, headers, _ = app.get("/")
            self.assertEqual((status, headers["Location"]), (302, "/source"))
            status, headers, body = app.get("/source")
            self.assertEqual((status, headers["Content-Type"], headers["Cache-Control"]), (200, "text/html; charset=utf-8", "no-store"))
            self.assertIn(b"/assets/app-1a2b3c4d.js", body)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            status, headers, body = app.get("/assets/app-1a2b3c4d.js")
            self.assertEqual((status, headers["Content-Type"]), (200, "text/javascript; charset=utf-8"))
            self.assertIn("immutable", headers["Cache-Control"])
            # The API is the captured Source service: one fixed session, as before.
            first = app.get("/source/v1/session")[2]
            self.assertEqual(app.get("/source/v1/session")[2], first)
            self.assertIn(b'"generation"', first)
        finally:
            code, out, err = app.stop()
        self.assertEqual(code, 0, err)
        self.assertIn("stopped; capture released", out)
        self.assertEqual(self.captures(), [])
        self.assertEqual(sha256(self.db), before)

    def test_the_same_gates_hold_for_the_pages_as_for_the_api(self):
        app = self.launch()
        try:
            for path in ("/source", "/assets/app-1a2b3c4d.js", "/source/v1/session"):
                with self.subTest(path=path):
                    self.assertEqual(app.get(path, {"Host": "evil.example"})[0], 403)
                    self.assertEqual(app.get(path, {"Origin": "http://evil.example"})[0], 403)
                    self.assertEqual(app.get(path, {"Origin": f"http://localhost"})[0], 200)
            for path in ("/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/", "/assets/nope.js", "/world", "/index.html", "/etc/passwd"):
                with self.subTest(path=path):
                    self.assertEqual(app.get(path)[0], 404)
            for method in ("POST", "PUT", "DELETE"):
                self.assertEqual(app.get("/source", method=method)[0], 405)
                self.assertEqual(app.get("/source/v1/session", method=method)[0], 405)
        finally:
            app.stop()

    def test_application_reads_after_two_hours_idle_without_heartbeat(self):
        from adapters.source import app
        before = sha256(self.db)
        managers = []
        real_manager, real_serve = app.SessionManager, app.AppServer.serve_forever

        def acquired(*args, **kwargs):
            manager = real_manager(*args, **kwargs)
            managers.append(manager)
            return manager

        def serve_after_idle(server):
            manager = server.manager
            token = manager.initial_session
            capture = manager.sessions[token]["capture"]
            generation = capture.generation
            # Simulate two hours without a request, including the expiry path.
            manager.sessions[token]["last_used"] -= 7200
            manager.expire()

            def read_then_stop():
                try:
                    origin = f"http://127.0.0.1:{server.server_port}"
                    with urllib.request.urlopen(origin + "/source/v1/session", timeout=5) as response:
                        descriptor = json.load(response)
                    self.assertIsNone(descriptor["idle_ttl_seconds"])
                    self.assertEqual((descriptor["session"], descriptor["generation"]), (token, generation))
                    manager.sessions[token]["last_used"] -= 7200
                    query = f"?session={token}&generation={generation}&table=parent"
                    with urllib.request.urlopen(origin + "/source/v1/rows" + query, timeout=5) as response:
                        rows = json.load(response)
                    self.assertIsNone(rows["context"]["idle_ttl_seconds"])
                    self.assertEqual(rows["data"]["returned"], 2)
                    self.assertTrue(capture.snapshot_path.exists())
                finally:
                    server.shutdown()

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                result = executor.submit(read_then_stop)
                real_serve(server, poll_interval=0.01)
                result.result(timeout=10)

        # run() installs process signal handlers; leave the test runner's intact.
        for sig in (signal.SIGINT, signal.SIGTERM):
            self.addCleanup(signal.signal, sig, signal.getsignal(sig))
        with patch.object(app, "SessionManager", side_effect=acquired), \
             patch.object(app.AppServer, "serve_forever", autospec=True, side_effect=serve_after_idle):
            status = app.run(argparse.Namespace(frontend=self.frontend, database=self.db,
                                               port=0, no_browser=True, capture_deadline=120))
        self.assertEqual(status, 0)
        self.assertIsNone(managers[0].ttl_s)
        self.assertEqual(managers[0].sessions, {})
        self.assertTrue(all(not capture.directory.exists() for capture in managers[0]._captures))
        self.assertEqual(sha256(self.db), before)

    def test_sigterm_also_releases_the_capture(self):
        before = sha256(self.db)
        app = self.launch()
        self.assertEqual(len(self.captures()), 1)
        code, out, _ = app.stop(signal.SIGTERM)
        self.assertEqual((code, self.captures()), (0, []))
        self.assertEqual(sha256(self.db), before)
        self.assertIn("stopped; capture released", out)

    def test_the_default_browser_is_asked_to_open_the_address(self):
        record = self.dir / "opened.txt"
        script = self.dir / "browser.sh"
        script.write_text(f"#!/bin/sh\necho \"$1\" > {record}\n"); script.chmod(0o755)
        app = Launch(self, str(self.db), "--frontend", str(self.frontend), env={**self.env, "BROWSER": f"{script} %s"})
        try:
            for _ in range(50):
                if record.exists():
                    break
                time.sleep(0.1)
            self.assertEqual(record.read_text().strip(), app.url)
        finally:
            app.stop()


class TestFailures(AppFixture):
    def run_ki(self, *args):
        done = subprocess.run([sys.executable, str(KI), "open", *args, "--no-browser"], cwd=ROOT,
                              capture_output=True, text=True, timeout=60, env=self.env)
        return done.returncode, done.stderr

    def test_missing_unreadable_and_invalid_files_are_named(self):
        not_sqlite = self.dir / "notes.txt"; not_sqlite.write_text("hello")
        unreadable = self.dir / "locked.sqlite"; unreadable.write_bytes(self.db.read_bytes()); unreadable.chmod(0)
        cases = [(self.dir / "absent.sqlite", "no such file"), (self.dir, "not a file"), (not_sqlite, "not a SQLite database")]
        if os.geteuid() != 0:  # root reads anything
            cases.append((unreadable, "cannot read"))
        for path, message in cases:
            with self.subTest(path=path.name):
                code, err = self.run_ki(str(path), "--frontend", str(self.frontend))
                self.assertEqual(code, 2)
                self.assertIn(message, err)
        self.assertEqual(self.captures(), [])

    def test_a_damaged_database_is_a_capture_failure(self):
        damaged = self.dir / "damaged.sqlite"
        damaged.write_bytes(b"SQLite format 3\x00" + os.urandom(4096))
        code, err = self.run_ki(str(damaged), "--frontend", str(self.frontend))
        self.assertEqual(code, 1)
        self.assertIn("cannot capture", err)
        self.assertEqual(self.captures(), [])

    def test_a_missing_frontend_build_says_how_to_build_it(self):
        code, err = self.run_ki(str(self.db), "--frontend", str(self.dir / "no-dist"))
        self.assertEqual(code, 2)
        self.assertIn("the Source frontend is missing or not built", err)
        self.assertIn("npm run build", err)
        self.assertEqual(self.captures(), [])

    def test_a_taken_port_is_reported_and_the_capture_released(self):
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0)); taken.listen(1)
            port = taken.getsockname()[1]
            code, err = self.run_ki(str(self.db), "--frontend", str(self.frontend), "--port", str(port))
        self.assertEqual(code, 1)
        self.assertRegex(err, rf"cannot listen on 127\.0\.0\.1:{port}")
        self.assertEqual(self.captures(), [])


if __name__ == "__main__":
    unittest.main()

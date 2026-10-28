#!/usr/bin/env python3
"""The built wheel, installed in a clean virtual environment, run as `ki`.

    python3.11 scripts/test_installed_wheel.py [-v]

KI_WHEEL names the wheel (default: the one in release/). The virtual
environment uses this interpreter and installs with `--no-index`, so nothing
is downloaded. `ki` runs from an unrelated empty directory with no PYTHONPATH,
and with `node`, `npm`, `npx` and `vite` first on PATH as stubs that record
any call. Each test checks that the original SQLite file is byte-identical and
that no capture is left in the private TMPDIR.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CHECKOUT = Path(__file__).resolve().parents[1]
STUBS = ("node", "npm", "npx", "vite")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wheel_path() -> Path:
    if os.environ.get("KI_WHEEL"):
        return Path(os.environ["KI_WHEEL"]).resolve()
    found = sorted((CHECKOUT / "release").glob("knowledge_inspector-*.whl"))
    if len(found) != 1:
        raise SystemExit(f"set KI_WHEEL, or build one wheel into release/ (found {found})")
    return found[0]


def setUpModule():
    global HOME, VENV, KI, FRONTEND, ENV, WORK, MARKER
    HOME = Path(tempfile.mkdtemp(prefix="ki-installed-"))
    VENV, WORK, stubs = HOME / "venv", HOME / "elsewhere", HOME / "stubs"
    WORK.mkdir(); stubs.mkdir()
    subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    subprocess.run([VENV / "bin" / "python", "-m", "pip", "install", "--quiet", "--no-index", str(wheel_path())], check=True)
    KI = VENV / "bin" / "ki"
    MARKER = HOME / "node-was-called"
    for name in STUBS:
        stub = stubs / name
        stub.write_text(f"#!/bin/sh\necho \"{name} $*\" >> {MARKER}\nexit 127\n"); stub.chmod(0o755)
    ENV = {key: value for key, value in os.environ.items() if not key.startswith(("PYTHON", "VIRTUAL_ENV", "CONDA"))}
    ENV.update(PATH=f"{stubs}:{VENV / 'bin'}:/usr/bin:/bin", BROWSER="", HOME=str(HOME))
    FRONTEND = Path(subprocess.run([VENV / "bin" / "python", "-I", "-c",
                                    "from importlib.resources import files; print(files('knowledge_inspector') / 'frontend')"],
                                   check=True, capture_output=True, text=True, cwd=WORK, env=ENV).stdout.strip())


def tearDownModule():
    shutil.rmtree(HOME, ignore_errors=True)


class Installed(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="case-", dir=HOME))
        self.tmp = self.dir / "tmp"; self.tmp.mkdir()
        self.db = self.dir / "research.sqlite"
        with sqlite3.connect(self.db) as db:
            db.executescript("CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);"
                             "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), label TEXT);"
                             "INSERT INTO parent VALUES (1, 'one'), (2, 'two');"
                             "INSERT INTO child VALUES (10, 1, 'a'), (11, 2, 'b');")
        db.close()
        self.before = sha256(self.db)
        self.env = {**ENV, "TMPDIR": str(self.tmp)}

    def tearDown(self):
        self.assertEqual(self.captures(), [], "a capture was left behind")
        self.assertEqual(sha256(self.db), self.before, "the original database changed")
        self.assertFalse(MARKER.exists(), MARKER.exists() and MARKER.read_text())
        shutil.rmtree(self.dir, ignore_errors=True)

    def captures(self):
        return sorted(p.name for p in self.tmp.iterdir() if p.name.startswith("knowledge-inspector-source-"))

    def ki(self, *args):
        return subprocess.run([KI, *args], cwd=WORK, env=self.env, capture_output=True, text=True, timeout=60)

    def launch(self):
        process = subprocess.Popen([KI, "open", str(self.db), "--no-browser"], cwd=WORK, env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        lines = []
        for line in process.stdout:
            lines.append(line)
            if line.startswith("Knowledge Inspector: "):
                return process, line.split(": ", 1)[1].strip().rsplit("/source", 1)[0], lines
        process.kill()
        self.fail("ki did not report an address: " + "".join(lines) + process.stderr.read())

    def stop(self, process, lines, sig):
        process.send_signal(sig)
        out, err = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, err)
        self.assertIn("stopped; capture released", "".join(lines) + out)

    def get(self, origin, path):
        try:
            with urllib.request.urlopen(origin + path, timeout=10) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as failure:
            return failure.code, failure.headers, failure.read()

    def api(self, origin, path, **query):
        status, _, body = self.get(origin, f"/source/v1/{path}?{urllib.parse.urlencode(query)}")
        self.assertEqual(status, 200, body)
        return json.loads(body)["data"]

    def test_imports_come_from_the_installed_package(self):
        done = subprocess.run([VENV / "bin" / "python", "-I", "-c",
                               "import adapters.source.app as a, knowledge_inspector as k; print(a.__file__); print(k.__file__)"],
                              cwd=WORK, env=self.env, capture_output=True, text=True, check=True)
        for path in done.stdout.split():
            self.assertTrue(Path(path).is_relative_to(VENV), path)
            self.assertFalse(Path(path).is_relative_to(CHECKOUT), path)
        # Only the Source application ships: no World adapters, no tests.
        for module in ("adapters.world.server", "adapters.source.test_app"):
            gone = subprocess.run([VENV / "bin" / "python", "-I", "-c", f"import {module}"], cwd=WORK, env=self.env, capture_output=True)
            self.assertNotEqual(gone.returncode, 0, module)

    def test_version_and_help(self):
        done = self.ki("--version")
        self.assertEqual((done.returncode, done.stdout.strip()), (0, "ki 0.1.0"))
        done = self.ki("open", "--help")
        self.assertEqual(done.returncode, 0)
        self.assertIn("--no-browser", done.stdout)
        self.assertIn("--port", done.stdout)
        # The same through `python -m`.
        done = subprocess.run([VENV / "bin" / "python", "-m", "knowledge_inspector", "--version"], cwd=WORK, env=self.env, capture_output=True, text=True)
        self.assertEqual(done.stdout.strip(), "ki 0.1.0")

    def test_serves_every_packaged_asset_and_the_api_from_one_origin_then_ctrl_c(self):
        process, origin, lines = self.launch()
        try:
            self.assertRegex(origin, r"^http://127\.0\.0\.1:\d+$")
            self.assertEqual(len(self.captures()), 1)
            status, headers, page = self.get(origin, "/source")
            self.assertEqual((status, headers["Content-Type"]), (200, "text/html; charset=utf-8"))
            self.assertEqual(page, (FRONTEND / "index.html").read_bytes())
            # Every file the page names, and every font the stylesheet names.
            named = set(re.findall(rb'"/assets/([^"]+)"', page))
            for css in [n for n in named if n.endswith(b".css")]:
                named |= set(re.findall(rb"url\(/assets/([^)]+)\)", self.get(origin, "/assets/" + css.decode())[2]))
            fonts = {n for n in named if n.endswith((b".woff", b".woff2"))}
            self.assertGreaterEqual(len(fonts), 8)
            for name in sorted(named):
                with self.subTest(asset=name):
                    status, headers, body = self.get(origin, "/assets/" + name.decode())
                    self.assertEqual(status, 200)
                    self.assertEqual(body, (FRONTEND / "assets" / name.decode()).read_bytes())
            self.assertEqual({p.name.encode() for p in (FRONTEND / "assets").iterdir()}, named)
            # The Source API on the same origin: records and a relationship.
            session = json.loads(self.get(origin, "/source/v1/session")[2])
            self.assertIsNone(session["idle_ttl_seconds"])
            lease = {"session": session["session"], "generation": session["generation"]}
            tables = {t["name"] for t in self.api(origin, "overview", **lease)["relations"]}
            self.assertEqual(tables, {"parent", "child"})
            rows = self.api(origin, "rows", table="child", **lease)["rows"]
            self.assertEqual([[k["exact"] for k in r["key"]] for r in rows], [["10"], ["11"]])
            record = self.api(origin, "record", id=rows[0]["record_id"], **lease)
            self.assertEqual(record["record_id"], rows[0]["record_id"])
            outgoing = self.api(origin, "references", record=rows[0]["record_id"], **lease)["observations"]
            self.assertEqual([(o["status"], o["parent"]["name"], o["parent"]["key"][0]["exact"]) for o in outgoing], [("resolved", "parent", "1")])
            parent = outgoing[0]["parent"]["record_id"]
            groups = self.api(origin, "references", record=parent, direction="incoming", **lease)["groups"]
            self.assertEqual([g["declaration"]["child_table"] for g in groups], ["child"])
            # Following the group back lists the referencing rows.
            referencing = self.api(origin, "search", table="child", mode="reference", record=parent,
                                   fk=groups[0]["declaration"]["declaration_id"], **lease)["rows"]
            self.assertEqual([r["record_id"] for r in referencing], [rows[0]["record_id"]])
            # The gates hold for the installed pages as for the API.
            request = urllib.request.Request(origin + "/source", headers={"Origin": "http://evil.example"})
            with self.assertRaises(urllib.error.HTTPError) as refused:
                urllib.request.urlopen(request, timeout=10)
            self.assertEqual(refused.exception.code, 403)
            self.assertEqual(self.get(origin, "/assets/ki-frontend.json")[0], 404)
            self.assertEqual(self.get(origin, "/ki-frontend.json")[0], 404)
        finally:
            self.stop(process, lines, signal.SIGINT)

    def test_sigterm_releases_the_capture(self):
        process, origin, lines = self.launch()
        self.assertEqual(len(self.captures()), 1)
        self.assertEqual(self.get(origin, "/source")[0], 200)
        self.stop(process, lines, signal.SIGTERM)

    def test_two_launches_are_two_sessions(self):
        first, origin, lines = self.launch()
        one = json.loads(self.get(origin, "/source/v1/session")[2])
        self.stop(first, lines, signal.SIGINT)
        second, origin, lines = self.launch()
        two = json.loads(self.get(origin, "/source/v1/session")[2])
        self.stop(second, lines, signal.SIGINT)
        self.assertNotEqual(one["source_namespace"], two["source_namespace"])
        self.assertNotEqual(one["generation"], two["generation"])
        self.assertEqual(one["capture_digest"], two["capture_digest"])

    def test_missing_and_invalid_databases_are_named(self):
        notes = self.dir / "notes.txt"; notes.write_text("hello")
        damaged = self.dir / "damaged.sqlite"; damaged.write_bytes(b"SQLite format 3\x00" + os.urandom(4096))
        for path, status, message in [(self.dir / "absent.sqlite", 2, "no such file"), (self.dir, 2, "not a file"),
                                      (notes, 2, "not a SQLite database"), (damaged, 1, "cannot capture")]:
            with self.subTest(path=path.name):
                done = self.ki("open", str(path), "--no-browser")
                self.assertEqual(done.returncode, status, done.stderr)
                self.assertIn(message, done.stderr)
                self.assertNotIn("Traceback", done.stderr)

    def broken(self, damage, *expected):
        """Damage the installed frontend, check `ki open` refuses before any capture, then repair."""
        saved = self.dir / "frontend-saved"
        shutil.copytree(FRONTEND, saved)
        try:
            damage()
            done = self.ki("open", str(self.db), "--no-browser")
            self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
            self.assertNotIn("capturing", done.stdout)
            for text in (*expected, "reinstall it from a release wheel"):
                self.assertIn(text, done.stderr)
        finally:
            shutil.rmtree(FRONTEND, ignore_errors=True)
            shutil.copytree(saved, FRONTEND)

    def test_a_missing_asset_fails_clearly(self):
        font = next((FRONTEND / "assets").glob("*.woff2"))
        self.broken(font.unlink, "incomplete or damaged", f"missing: assets/{font.name}")

    def test_a_missing_bundle_fails_clearly(self):
        script = next((FRONTEND / "assets").glob("*.js"))
        self.broken(script.unlink, f"index.html names a missing asset: /assets/{script.name}")

    def test_a_damaged_asset_fails_clearly(self):
        sheet = next((FRONTEND / "assets").glob("*.css"))
        self.broken(lambda: sheet.write_bytes(sheet.read_bytes()[:-1] + b" "), f"damaged (SHA-256 differs from the build): assets/{sheet.name}")

    def test_a_missing_manifest_fails_clearly(self):
        self.broken((FRONTEND / "ki-frontend.json").unlink, "no ki-frontend.json")

    def test_a_missing_frontend_fails_clearly(self):
        self.broken(lambda: shutil.rmtree(FRONTEND), "the Source frontend is missing or not built")

    def test_the_checkout_is_not_needed(self):
        # ki never names the repository, even when it fails.
        done = self.ki("open", str(self.dir / "absent.sqlite"))
        self.assertNotIn(str(CHECKOUT), done.stdout + done.stderr)
        self.assertNotIn("npm", done.stderr)


if __name__ == "__main__":
    unittest.main()

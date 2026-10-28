"""KI-003 private startup snapshots: lifecycle, consistency, and identity.

Every case builds a real disposable producer file, acquires a real snapshot
through `prepare_world`, serves it through the real HTTP plane, and only then
mutates the producer. The producer file must stay byte- and sidecar-identical
wherever SQLite's read-only behavior permits (asserted per test).
"""

from __future__ import annotations

import http.client
import json
import os
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server as world  # noqa: E402


def declaration() -> dict:
    return world.validate_declaration(
        {
            "version": 1,
            "world": {"id_prefix": "snaptest"},
            "entities": [
                {"kind": "entity", "source": "entity", "key_columns": ["id"], "label_column": "label"}
            ],
            "relations": [
                {
                    "name": "event",
                    "source": "event",
                    "key_columns": ["id"],
                    "roles": [
                        {"role": "participant", "column_name": "participant", "target_kind": "entity"}
                    ],
                }
            ],
        }
    )


def build_source(path: Path, *, journal: str = "DELETE", events: int = 1) -> None:
    db = sqlite3.connect(path)
    db.execute(f"PRAGMA journal_mode={journal}")
    db.executescript(
        """
        CREATE TABLE entity(id TEXT COLLATE NOCASE PRIMARY KEY, label TEXT);
        INSERT INTO entity VALUES('ABC', 'Canonical target');
        CREATE TABLE event(id INTEGER PRIMARY KEY, participant TEXT);
        """
    )
    db.executemany(
        "INSERT INTO event VALUES(?, 'abc')", [(i,) for i in range(1, events + 1)]
    )
    db.commit()
    db.close()


def file_state(path: Path) -> tuple[str, int, list[str]]:
    import hashlib

    return (
        hashlib.sha256(path.read_bytes()).hexdigest(),
        path.stat().st_mtime_ns,
        sorted(p.name for p in path.parent.glob(path.name + "*") if p != path),
    )


class SnapshotCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.producer = Path(self.tmp.name) / "producer.sqlite"
        self.prepared: list[world.PreparedWorld] = []
        self.servers: list[ThreadingHTTPServer] = []

    def tearDown(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for prepared in self.prepared:
            prepared.cleanup()
        world.Handler.snapshot_mode = False
        world.Handler.db_connect = staticmethod(world.connect)
        world.Handler.db_path = Path("missing.sqlite")
        world.Handler.model = None
        world.Handler.world_id = ""

    def prepare(self, **kwargs) -> world.PreparedWorld:
        prepared = world.prepare_world(self.producer, declaration(), **kwargs)
        self.prepared.append(prepared)
        return prepared

    def boot(self, prepared: world.PreparedWorld) -> str:
        world.Handler.db_path = prepared.snapshot_path
        world.Handler.fingerprint = prepared.fingerprint
        world.Handler.model = prepared.model
        world.Handler.world_id = prepared.world_id
        world.Handler.snapshot_mode = True
        world.Handler.db_connect = staticmethod(world.connect_snapshot)
        server = ThreadingHTTPServer(("127.0.0.1", 0), world.Handler)
        self.servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{server.server_port}"

    def get(self, base: str, path: str) -> tuple[int, str]:
        host, port = base.removeprefix("http://").split(":")
        conn = http.client.HTTPConnection(host, int(port), timeout=10)
        conn.request("GET", path)
        response = conn.getresponse()
        body = response.read().decode("utf-8")
        conn.close()
        return response.status, body


class TestSnapshotConsistency(SnapshotCase):
    def test_r007_regression_rollback_mutations_invisible(self) -> None:
        build_source(self.producer)
        base = self.boot(self.prepare())
        status, overview_before = self.get(base, "/world/overview")
        self.assertEqual(status, 200)
        status, assertion_before = self.get(base, "/world/assertion?id=event:1")
        self.assertEqual(status, 200)
        # Canonical KI-002 projection survives inside the snapshot reading.
        self.assertIn('"entity:ABC"', assertion_before)

        writer = sqlite3.connect(self.producer)
        writer.execute("DELETE FROM event")
        writer.execute("UPDATE entity SET label='changed' WHERE id='ABC'")
        writer.commit()
        writer.close()

        self.assertEqual(self.get(base, "/world/overview"), (200, overview_before))
        self.assertEqual(self.get(base, "/world/assertion?id=event:1"), (200, assertion_before))

    def test_r007_regression_wal_mutations_invisible(self) -> None:
        build_source(self.producer, journal="WAL")
        base = self.boot(self.prepare())
        _, overview_before = self.get(base, "/world/overview")
        writer = sqlite3.connect(self.producer)
        writer.execute("DELETE FROM event")
        writer.commit()
        writer.close()
        self.assertEqual(self.get(base, "/world/overview"), (200, overview_before))

    def test_wal_only_commit_is_in_snapshot_despite_unchanged_main_hash(self) -> None:
        build_source(self.producer, journal="WAL")
        writer = sqlite3.connect(self.producer)
        main_hash_before = world.file_sha256(self.producer)
        writer.execute("INSERT INTO event VALUES(99, 'abc')")
        writer.commit()  # stays in -wal; main file bytes do not move
        self.assertEqual(world.file_sha256(self.producer), main_hash_before)

        base = self.boot(self.prepare())
        writer.close()
        status, overview = self.get(base, "/world/overview")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(overview)["assertions"], 2)

    def test_atomic_replacement_and_deletion_cannot_change_responses(self) -> None:
        build_source(self.producer)
        base = self.boot(self.prepare())
        _, overview_before = self.get(base, "/world/overview")

        other = Path(self.tmp.name) / "other.sqlite"
        build_source(other, events=7)
        os.replace(other, self.producer)
        self.assertEqual(self.get(base, "/world/overview"), (200, overview_before))

        self.producer.unlink()
        self.assertEqual(self.get(base, "/world/overview"), (200, overview_before))

    def test_concurrent_reads_share_one_snapshot(self) -> None:
        build_source(self.producer, events=5)
        base = self.boot(self.prepare())
        results: list[tuple[int, str]] = []

        def read() -> None:
            results.append(self.get(base, "/world/overview"))

        threads = [threading.Thread(target=read) for _ in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(results), 20)
        self.assertTrue(all(status == 200 for status, _ in results))
        self.assertEqual(len({body for _, body in results}), 1)

    def test_reopen_new_identity_revalidation_and_determinism(self) -> None:
        build_source(self.producer)
        first = self.prepare()
        again = self.prepare()
        self.assertEqual(first.world_id, again.world_id)  # identical restart

        writer = sqlite3.connect(self.producer)
        writer.execute("INSERT INTO event VALUES(2, 'abc')")
        writer.commit()
        changed = self.prepare()
        self.assertNotEqual(first.world_id, changed.world_id)  # content reopen

        writer.execute("INSERT INTO event VALUES(3, 'nobody')")  # dangling
        writer.commit()
        writer.close()
        with self.assertRaises(ValueError):  # reopen revalidates fully
            world.prepare_world(self.producer, declaration())

    def test_wal_checkpoint_does_not_move_identity(self) -> None:
        build_source(self.producer, journal="WAL")
        writer = sqlite3.connect(self.producer)
        writer.execute("INSERT INTO event VALUES(50, 'abc')")
        writer.commit()
        before = self.prepare()
        writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        writer.close()
        after = self.prepare()
        self.assertEqual(before.world_id, after.world_id)

    def test_snapshot_loss_is_503_never_live_fallback(self) -> None:
        build_source(self.producer)
        prepared = self.prepare()
        base = self.boot(prepared)
        self.assertEqual(self.get(base, "/world/overview")[0], 200)

        prepared.snapshot_path.unlink()
        status, body = self.get(base, "/world/overview")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"error": "world_snapshot_lost"})
        # Producer is intact and readable — and still not served.
        self.assertTrue(self.producer.is_file())
        self.assertEqual(self.get(base, "/world/overview")[0], 503)

    def test_snapshot_corruption_is_503_and_handler_survives(self) -> None:
        build_source(self.producer)
        prepared = self.prepare()
        base = self.boot(prepared)
        prepared.snapshot_path.write_bytes(b"not a database" * 64)
        for _ in range(2):
            status, body = self.get(base, "/world/overview")
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body), {"error": "world_snapshot_lost"})

    def test_error_classification_uses_structured_codes(self) -> None:
        build_source(self.producer)
        # Missing serving store: cannot open (structured CANTOPEN code).
        missing = Path(self.tmp.name) / "missing.sqlite"
        with self.assertRaises(sqlite3.Error) as caught:
            world.connect_snapshot(missing)
        self.assertTrue(world._is_snapshot_storage_error(caught.exception))

        # Garbage file: opens lazily, fails as not-a-database on first read.
        garbage = Path(self.tmp.name) / "garbage.sqlite"
        garbage.write_bytes(b"not a database" * 64)
        with closing(world.connect_snapshot(garbage)) as db:
            with self.assertRaises(sqlite3.Error) as caught:
                db.execute("SELECT * FROM event").fetchall()
        self.assertTrue(world._is_snapshot_storage_error(caught.exception))

        # Ordinary SQL error against a healthy snapshot: SQLITE_ERROR,
        # never classified as snapshot loss. Non-SQLite errors neither.
        prepared = self.prepare()
        with closing(world.connect_snapshot(prepared.snapshot_path)) as db:
            with self.assertRaises(sqlite3.Error) as caught:
                db.execute("SELECT missing_column FROM event").fetchall()
        self.assertFalse(world._is_snapshot_storage_error(caught.exception))
        self.assertFalse(world._is_snapshot_storage_error(ValueError("bug")))
        self.assertFalse(world._is_snapshot_storage_error(OSError("bug")))

    def test_post_open_corruption_is_503_without_producer_fallback(self) -> None:
        build_source(self.producer)
        prepared = self.prepare()
        base = self.boot(prepared)
        self.assertEqual(self.get(base, "/world/overview")[0], 200)

        # Producer moves on; if the server fell back to it, counts would
        # change. Then the already-serving snapshot is corrupted on disk:
        # the next request still opens a connection successfully and fails
        # on first read — that post-open failure is the 503 case.
        writer = sqlite3.connect(self.producer)
        writer.execute("DELETE FROM event")
        writer.commit()
        writer.close()
        producer_after = file_state(self.producer)
        prepared.snapshot_path.write_bytes(b"corrupt" * 128)

        for _ in range(2):
            status, body = self.get(base, "/world/overview")
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body), {"error": "world_snapshot_lost"})
        self.assertEqual(file_state(self.producer), producer_after)

    def test_ordinary_sql_error_is_not_reported_as_snapshot_loss(self) -> None:
        build_source(self.producer)
        prepared = self.prepare()
        base = self.boot(prepared)
        self.assertEqual(self.get(base, "/world/overview")[0], 200)

        # An application/query mistake against the healthy snapshot (the
        # model now names a table the snapshot does not have) must surface
        # as itself — dropped connection / raised handler error — never
        # as a contractual 503 world_snapshot_lost.
        relation = prepared.model.relations["event"]
        original = relation["source"]
        relation["source"] = "missing_table"
        try:
            try:
                status, body = self.get(base, "/world/overview")
                self.assertNotEqual(status, 503)
                self.assertNotIn("world_snapshot_lost", body)
            except (http.client.HTTPException, ConnectionError, OSError):
                pass  # unmasked failure: no false snapshot-loss response
        finally:
            relation["source"] = original
        # The handler and the healthy snapshot survive the defect.
        self.assertEqual(self.get(base, "/world/overview")[0], 200)

    def test_source_preserved_by_acquisition_and_serving(self) -> None:
        for journal in ("DELETE", "WAL"):
            with self.subTest(journal=journal):
                path = Path(self.tmp.name) / f"producer-{journal}.sqlite"
                build_source(path, journal=journal)
                before = file_state(path)
                prepared = world.prepare_world(path, declaration())
                self.prepared.append(prepared)
                base = self.boot(prepared)
                self.assertEqual(self.get(base, "/world/overview")[0], 200)
                sha256, mtime_ns, sidecars = file_state(path)
                # Producer bytes and mtime never move, in either mode.
                self.assertEqual((sha256, mtime_ns), before[:2])
                if journal == "DELETE":
                    self.assertEqual(sidecars, before[2])
                else:
                    # Documented read-only SQLite behavior: opening a WAL
                    # database read-only may create SQLite's own -shm/-wal
                    # beside it (the previous live adapter did so per
                    # request; snapshotting does so once at startup). No
                    # other file may appear, and snapshot artifacts never
                    # live beside the source.
                    self.assertLessEqual(
                        set(sidecars),
                        {f"{path.name}-shm", f"{path.name}-wal"},
                    )

    def test_snapshot_permissions_location_and_grounding(self) -> None:
        build_source(self.producer)
        prepared = self.prepare()
        self.assertEqual(stat.S_IMODE(prepared.directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(prepared.snapshot_path.stat().st_mode), 0o600)
        self.assertNotEqual(prepared.snapshot_path.parent, self.producer.parent)

        base = self.boot(prepared)
        status, body = self.get(base, "/world/assertion?id=event:1")
        self.assertEqual(status, 200)
        self.assertIn("in event", body)  # producer attribution retained
        self.assertNotIn(str(prepared.snapshot_path), body)
        self.assertNotIn(str(prepared.directory), body)

    def test_failed_acquisition_cleans_up(self) -> None:
        missing = Path(self.tmp.name) / "missing.sqlite"
        temp_root = Path(tempfile.gettempdir())
        before = {p.name for p in temp_root.glob("knowledge-inspector-world-*")}
        with self.assertRaises(world.SnapshotUnavailable):
            world.prepare_world(missing, declaration())
        after = {p.name for p in temp_root.glob("knowledge-inspector-world-*")}
        self.assertEqual(before, after)


class TestAcquisitionConcurrency(SnapshotCase):
    def _writer(self, path: Path, stop: threading.Event, outcomes: list) -> None:
        db = sqlite3.connect(path, timeout=0)
        db.execute("PRAGMA busy_timeout=0")
        next_id = 1_000_000  # above every fixture id: no PK collisions
        try:
            while not stop.is_set():
                try:
                    db.execute("INSERT INTO event VALUES(?, 'abc')", (next_id,))
                    db.commit()
                    outcomes.append("commit")
                    next_id += 1
                except sqlite3.OperationalError:
                    db.rollback()
                    outcomes.append("busy")
                time.sleep(0.002)
        finally:
            db.close()

    def test_wal_writer_commits_throughout_acquisition(self) -> None:
        build_source(self.producer, journal="WAL", events=2000)
        stop = threading.Event()
        outcomes: list[str] = []
        writer = threading.Thread(target=self._writer, args=(self.producer, stop, outcomes))
        writer.start()
        prepared = self.prepare()
        stop.set()
        writer.join()
        self.assertIn("commit", outcomes)
        # The snapshot is exactly one committed generation: all fixture
        # rows, plus a contiguous prefix of the writer's sequential ids
        # (however many committed before the acquisition pin) — never a
        # torn or partial commit.
        with closing(world.connect_snapshot(prepared.snapshot_path)) as db:
            base = db.execute("SELECT COUNT(*) FROM event WHERE id <= 2000").fetchone()[0]
            extra, top = db.execute(
                "SELECT COUNT(*), MAX(id) FROM event WHERE id >= 1000000"
            ).fetchone()
        self.assertEqual(base, 2000)
        if extra:
            self.assertEqual(top, 1000000 + extra - 1)

    def test_rollback_writer_bounded_outcome(self) -> None:
        build_source(self.producer, journal="DELETE", events=20000)
        stop = threading.Event()
        outcomes: list[str] = []
        writer = threading.Thread(target=self._writer, args=(self.producer, stop, outcomes))
        writer.start()
        try:
            prepared = self.prepare()  # completes, or refuses by deadline
            with closing(world.connect_snapshot(prepared.snapshot_path)) as db:
                base = db.execute(
                    "SELECT COUNT(*) FROM event WHERE id <= 20000"
                ).fetchone()[0]
                extra, top = db.execute(
                    "SELECT COUNT(*), MAX(id) FROM event WHERE id >= 1000000"
                ).fetchone()
            self.assertEqual(base, 20000)
            if extra:
                self.assertEqual(top, 1000000 + extra - 1)
        except world.SnapshotUnavailable:
            pass  # the other documented outcome: fail clearly, never hang
        stop.set()
        writer.join(timeout=10)
        self.assertFalse(writer.is_alive())
        with closing(sqlite3.connect(self.producer)) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_deadline_refuses_and_cleans_up(self) -> None:
        # Large enough that the copy spans several progress batches, so
        # the zero deadline cannot be outrun by a single-step backup.
        build_source(self.producer, events=200000)
        temp_root = Path(tempfile.gettempdir())
        before = {p.name for p in temp_root.glob("knowledge-inspector-world-*")}
        # A zero deadline trips on the first backup progress callback,
        # however fast the copy itself is: refusal must not depend on size.
        with self.assertRaises(world.SnapshotUnavailable):
            world.prepare_world(self.producer, declaration(), deadline_s=0.0)
        after = {p.name for p in temp_root.glob("knowledge-inspector-world-*")}
        self.assertEqual(before, after)


class TestMainLifecycle(SnapshotCase):
    def _free_port(self) -> int:
        with closing(socket.socket()) as probe:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]

    def test_main_serves_snapshot_and_cleans_up_on_sigint(self) -> None:
        build_source(self.producer)
        decl_path = Path(self.tmp.name) / "declaration.json"
        decl_path.write_text(json.dumps({
            "version": 1,
            "world": {"id_prefix": "snaptest"},
            "entities": [{"kind": "entity", "source": "entity", "key_columns": ["id"], "label_column": "label"}],
            "relations": [{"name": "event", "source": "event", "key_columns": ["id"],
                           "roles": [{"role": "participant", "column_name": "participant", "target_kind": "entity"}]}],
        }), encoding="utf-8")
        temp_root = Path(tempfile.gettempdir())
        dirs_before = {p for p in temp_root.glob("knowledge-inspector-world-*")}
        port = self._free_port()
        proc = subprocess.Popen(
            [sys.executable, str(Path(world.__file__)), "--db", str(self.producer),
             "--declaration", str(decl_path), "--port", str(port)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            assert proc.stdout is not None
            self.assertIn("sqlite world:", proc.stdout.readline())
            self.assertIn("snapshot: backup=", proc.stdout.readline())
            base = f"http://127.0.0.1:{port}"
            status, overview = self.get(base, "/world/overview")
            self.assertEqual(status, 200)
            writer = sqlite3.connect(self.producer)
            writer.execute("DELETE FROM event")
            writer.commit()
            writer.close()
            self.assertEqual(self.get(base, "/world/overview"), (200, overview))
            dirs_during = {p for p in temp_root.glob("knowledge-inspector-world-*")} - dirs_before
            self.assertEqual(len(dirs_during), 1)
        finally:
            proc.send_signal(signal.SIGINT)
            proc.wait(timeout=10)
        dirs_after = {p for p in temp_root.glob("knowledge-inspector-world-*")} - dirs_before
        self.assertEqual(dirs_after, set())  # normal shutdown removes artifacts


if __name__ == "__main__":
    unittest.main()

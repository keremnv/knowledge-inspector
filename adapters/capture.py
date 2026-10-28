"""Private SQLite capture ownership, independent of conceptual declarations.

Only acquisition reads the producer. Consumers lease the completed immutable
artifact; retirement blocks new leases and defers deletion until existing
consumers finish. Files are never replaced under an existing generation.
"""
from __future__ import annotations

import hashlib
import math
import os
import sqlite3
import tempfile
import time
import secrets
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

def file_sha256(path: Path, *, deadline_at: float | None = None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            if deadline_at is not None and time.monotonic() > deadline_at:
                raise SnapshotUnavailable("capture deadline exceeded during hashing")
            digest.update(chunk)
    return digest.hexdigest()


def connect(db_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


def connect_snapshot(db_path: Path) -> sqlite3.Connection:
    """Open the completed private snapshot: read-only and immutable.

    `immutable=1` is used only on this adapter-owned file, never on a
    producer database: the snapshot cannot change under its readers, so
    SQLite needs no locks, journals, or WAL recovery to serve it.
    """
    db = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


class SnapshotUnavailable(Exception):
    """Startup cannot obtain a reliable private snapshot; refuse to serve."""


# Acquisition is bounded so a continuously writing producer cannot hang
# startup forever: the backup advances in page batches, and the progress
# callback enforces this wall-clock deadline across those batches.
SNAPSHOT_DEADLINE_S = 120.0
_SNAPSHOT_PROGRESS_PAGES = 1024
_SNAPSHOT_DIRECTORY_PREFIX = "knowledge-inspector-world-"


def _snapshot_directory() -> Path:
    """A fresh server-owned temp directory, current-user access only."""
    directory = Path(tempfile.mkdtemp(prefix=_SNAPSHOT_DIRECTORY_PREFIX))
    # mkdtemp already creates 0o700; state the contract explicitly.
    os.chmod(directory, 0o700)
    return directory


def _remove_snapshot(directory: Path, snapshot_path: Path | None) -> None:
    """Remove only artifacts this process created in its own directory.

    The snapshot file is unlinked by exact path and the directory removed
    only if empty (rmdir never recurses and never follows a substituted
    tree). Foreign or still-running processes' snapshots are never touched:
    each process removes solely the directory it created.
    """
    if snapshot_path is not None:
        try:
            snapshot_path.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        directory.rmdir()
    except OSError:
        pass


def acquire_snapshot(db_path: Path, directory: Path, *, deadline_s: float = SNAPSHOT_DEADLINE_S,
                     max_bytes: int | None = None) -> Path:
    """Copy the producer database once into `directory` via online backup.

    The producer is opened read-only and never written, checkpointed, or
    indexed; committed WAL-visible data is included by the backup itself.

    The copy is pinned to one generation: a read transaction is opened on
    the source and read once before backing up, so the backup copies that
    transaction's snapshot. Without the pin, every producer commit landing
    mid-copy restarts the backup, and a continuously committing producer
    starves acquisition entirely (measured: no completion in 20 s under a
    tight commit loop, versus 0.12 s pinned, with the copy byte-count equal
    to the pinned generation in both journal modes). The pin lasts only
    for acquisition — never for the server's lifetime. In WAL mode it does
    not block producer commits; in rollback mode producer commits may wait
    or fail busy for the copy's duration, exactly as they can while any
    reader holds the file.

    Raises SnapshotUnavailable — with the partial file left for the caller's
    cleanup — when no reliable snapshot can be obtained in time.
    """
    snapshot_path = directory / "snapshot.sqlite"
    started = time.monotonic()

    def _deadline(status: int, remaining: int, total: int) -> None:
        if max_bytes is not None and total * page_size > max_bytes:
            raise SnapshotUnavailable("capture exceeds configured byte limit")
        if time.monotonic() - started > deadline_s:
            raise SnapshotUnavailable(
                f"snapshot acquisition from {db_path} exceeded {deadline_s:g}s; "
                "the source is changing too fast to copy reliably"
            )

    try:
        source = connect(db_path)
        try:
            source.execute(f"PRAGMA busy_timeout={max(0, min(5000, int(deadline_s * 1000)))}")
            page_size = source.execute("PRAGMA page_size").fetchone()[0]
            source.execute("BEGIN")
            # First read establishes the generation the backup will copy.
            source.execute("SELECT name FROM sqlite_master LIMIT 1").fetchone()
            target = sqlite3.connect(snapshot_path)
            try:
                source.backup(
                    target,
                    pages=_SNAPSHOT_PROGRESS_PAGES,
                    sleep=0.05,
                    progress=_deadline,
                )
                target.execute("PRAGMA journal_mode=DELETE")
            finally:
                target.close()
        finally:
            try:
                source.rollback()
            except sqlite3.Error:
                pass
            source.close()
    except SnapshotUnavailable:
        raise
    except sqlite3.Error as failure:
        raise SnapshotUnavailable(f"cannot snapshot {db_path}: {failure}") from failure
    os.chmod(snapshot_path, 0o600)
    return snapshot_path


class CaptureError(Exception):
    def __init__(self, code: str, status: int = 503):
        super().__init__(code)
        self.code, self.status = code, status


class Capture:
    """One owned artifact. No global current-generation pointer.

    Namespace identifies a registered source; digest identifies bytes; token
    identifies this acquisition/lifetime. All three are intentionally distinct.
    """
    VERSION = "sqlite_capture_v1"

    def __init__(self, directory: Path, path: Path, digest: str,
                 namespace: str, timings: dict[str, float]):
        self.directory, self.snapshot_path = directory, path
        self.digest, self.source_namespace = digest, namespace
        self.generation = "gen1_" + secrets.token_urlsafe(24)
        self.captured_at = datetime.now(timezone.utc).isoformat()
        self.timings = timings
        self._signature = self._stat()
        self._lock = threading.RLock()
        self._users = 0
        self._retired = False
        self._cleaned = False

    @classmethod
    def acquire(cls, producer: Path, *, namespace: str | None = None,
                deadline_s: float = SNAPSHOT_DEADLINE_S,
                prefix: str = "knowledge-inspector-source-",
                max_bytes: int | None = None) -> "Capture":
        if not math.isfinite(deadline_s) or deadline_s < 0:
            raise ValueError("finite nonnegative capture deadline required")
        started = time.monotonic()
        directory = Path(tempfile.mkdtemp(prefix=prefix))
        os.chmod(directory, 0o700)
        path = directory / "snapshot.sqlite"
        try:
            # Deadline covers opening/first read as well as backup. Busy timeout
            # is bounded by the remaining acquisition budget below.
            path = acquire_snapshot(producer, directory, deadline_s=deadline_s, max_bytes=max_bytes)
            backup_s = time.monotonic() - started
            if max_bytes is not None and path.stat().st_size > max_bytes:
                raise SnapshotUnavailable("capture exceeds configured byte limit")
            hash_start = time.monotonic()
            digest = file_sha256(path, deadline_at=started+deadline_s)
            if time.monotonic() - started > deadline_s:
                raise SnapshotUnavailable("capture deadline exceeded during hashing")
            timings = {"backup_s": backup_s,
                       "fingerprint_s": time.monotonic() - hash_start,
                       "total_s": time.monotonic() - started}
            return cls(directory, path, digest,
                       namespace or "src1_" + secrets.token_urlsafe(24), timings)
        except BaseException:
            _remove_snapshot(directory, path)
            raise

    def _stat(self) -> tuple:
        s = self.snapshot_path.stat(follow_symlinks=False)
        if not self.snapshot_path.is_file() or self.snapshot_path.is_symlink():
            raise CaptureError("source_capture_damaged")
        return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

    def check(self) -> None:
        # Check even when a response uses cached metadata. A changed private
        # artifact is a failure, never a reason to recapture the live producer.
        try:
            current = self._stat()
        except OSError as failure:
            raise CaptureError("source_capture_missing") from failure
        if current != self._signature:
            raise CaptureError("source_capture_damaged")

    @contextmanager
    def consumer(self):
        with self._lock:
            if self._retired:
                raise CaptureError("source_generation_retired", 410)
            self.check()
            self._users += 1
        try:
            yield self
        finally:
            with self._lock:
                self._users -= 1
                self._cleanup_if_unused()

    @contextmanager
    def lease(self):
        with self.consumer():
            db = None
            try:
                db = connect_snapshot(self.snapshot_path)
                # Force a schema read before any cached consumer response.
                db.execute("SELECT count(*) FROM sqlite_schema").fetchone()
                yield db
                self.check()
            except sqlite3.Error as failure:
                code = getattr(failure, "sqlite_errorcode", 0) & 0xff
                if code in {sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT,
                            sqlite3.SQLITE_CANTOPEN, sqlite3.SQLITE_NOTADB}:
                    raise CaptureError("source_capture_damaged") from failure
                raise
            finally:
                if db is not None:
                    db.close()

    def retire(self) -> None:
        with self._lock:
            self._retired = True
            self._cleanup_if_unused()

    def _cleanup_if_unused(self) -> None:
        if self._retired and not self._users and not self._cleaned:
            _remove_snapshot(self.directory, self.snapshot_path)
            self._cleaned = True

    def metadata(self) -> dict:
        return {"source_namespace": self.source_namespace,
                "generation": self.generation, "capture_digest": self.digest,
                "capture_version": self.VERSION, "captured_at": self.captured_at,
                "time_basis": "capture_observation_not_producer_commit",
                "sqlite_version": sqlite3.sqlite_version}

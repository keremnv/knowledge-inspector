"""KI-003 disposable evidence probes for the snapshot-consistency design memo.

Creates throwaway SQLite databases in a fresh temp directory and checks the
mechanisms the memo relies on. Never opens an existing database file.

Run: python3 snapshot_consistency_probe.py
Prints one line per probe; all fixtures are deleted with the temp directory.
"""
import hashlib
import sqlite3
import tempfile
import time
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def fill(path: Path, rows: int, journal_mode: str) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.execute(f"PRAGMA journal_mode={journal_mode}")
    db.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
    db.executemany(
        "INSERT INTO t VALUES(?,?)",
        [(i, "x" * 180 + str(i)) for i in range(rows)],
    )
    db.commit()
    return db


def backup(source: Path, target: Path, read_only: bool) -> float:
    """Copy `source` to `target` with the SQLite backup API; return seconds."""
    if target.exists():
        target.unlink()
    if read_only:
        src = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)
    else:
        src = sqlite3.connect(source)
    dst = sqlite3.connect(target)
    started = time.perf_counter()
    src.backup(dst)
    elapsed = time.perf_counter() - started
    dst.close()
    src.close()
    return elapsed


def main() -> None:
    print("sqlite", sqlite3.sqlite_version)
    with tempfile.TemporaryDirectory(prefix="ki003-probe-") as tmp:
        root = Path(tmp)

        # P1: repeated backups of one quiesced source are byte-identical, so a
        # fingerprint of the copy is stable across restarts of unchanged data.
        wal = root / "wal.db"
        writer = fill(wal, 2000, "WAL")
        writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        writer.close()
        backup(wal, root / "b1.db", read_only=True)
        backup(wal, root / "b2.db", read_only=False)
        print("P1 backups byte-identical:", sha256(root / "b1.db") == sha256(root / "b2.db"))

        # P2: a read-only backup still captures commits that exist only in WAL.
        writer = sqlite3.connect(wal)
        writer.execute("INSERT INTO t VALUES(900001,'live')")
        writer.commit()  # deliberately not checkpointed
        main_before = sha256(wal)
        backup(wal, root / "b3.db", read_only=True)
        seen = sqlite3.connect(root / "b3.db").execute(
            "SELECT COUNT(*) FROM t WHERE id=900001"
        ).fetchone()[0]
        print("P2 WAL live row in copy:", seen == 1, "| source hash untouched:", sha256(wal) == main_before)
        writer.close()

        # P3: backup proceeds while a rollback-journal writer holds an
        # uncommitted RESERVED transaction; it reads the committed state.
        rb = root / "rb.db"
        fill(rb, 2000, "DELETE").close()
        hold = sqlite3.connect(rb, timeout=0)
        hold.execute("BEGIN IMMEDIATE")
        hold.execute("INSERT INTO t VALUES(900002,'uncommitted')")
        backup(rb, root / "b4.db", read_only=True)
        hold.rollback()
        hold.close()
        print("P3 copy excludes uncommitted row:",
              sqlite3.connect(root / "b4.db").execute("SELECT COUNT(*) FROM t").fetchone()[0] == 2000)

        # P4: the copy, served immutable, ignores later source mutation.
        snap = root / "snap.db"
        backup(wal, snap, read_only=True)
        view = sqlite3.connect(f"{snap.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
        before = view.execute("SELECT COUNT(*) FROM t").fetchone()[0]
        wipe = sqlite3.connect(wal)
        wipe.execute("DELETE FROM t")
        wipe.commit()
        wipe.close()
        after = view.execute("SELECT COUNT(*) FROM t").fetchone()[0]
        print("P4 immutable copy stable across source wipe:", before == after == 2001)

        # P5: copy cost on a moderately sized source (45 MB class).
        moderate = root / "moderate.db"
        fill(moderate, 200000, "DELETE").close()
        seconds = backup(moderate, root / "moderate-copy.db", read_only=True)
        print(f"P5 45MB-class copy: {seconds:.3f}s size={moderate.stat().st_size}B")


if __name__ == "__main__":
    main()

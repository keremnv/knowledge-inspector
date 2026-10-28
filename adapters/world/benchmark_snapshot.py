"""Disposable KI-003 snapshot-acquisition benchmark.

Reports backup, fingerprint, Model-validation, and total startup time
separately (backup cost is never hidden inside Model timing), plus snapshot
size and producer commit behavior while acquisition runs against WAL and
rollback-journal sources. No archived source is opened; fixtures are
generated in a temp directory and deleted with it.
"""

import argparse
import importlib.util
import json
import os
import platform
import resource
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from contextlib import closing
from pathlib import Path


def load_world(server_path: Path):
    spec = importlib.util.spec_from_file_location("bench_snapshot_world", server_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def build_fixture(path: Path, rows: int, journal: str) -> None:
    with closing(sqlite3.connect(path)) as db:
        db.execute(f"PRAGMA journal_mode={journal}")
        db.execute("CREATE TABLE entity(id TEXT COLLATE NOCASE PRIMARY KEY, label TEXT)")
        db.execute("INSERT INTO entity VALUES('ABC', 'target')")
        db.execute("CREATE TABLE event(id INTEGER PRIMARY KEY, participant TEXT)")
        db.executemany(
            "INSERT INTO event VALUES(?, 'abc')", ((n,) for n in range(1, rows + 1))
        )
        # Undeclared filler gives the file representative byte weight
        # (~200 B/row) so backup and hashing costs scale with size, not
        # just with validated occurrence count.
        db.execute("CREATE TABLE filler(id INTEGER PRIMARY KEY, payload TEXT)")
        db.executemany(
            "INSERT INTO filler VALUES(?, ?)",
            ((n, "x" * 200) for n in range(1, rows + 1)),
        )
        db.commit()


def declaration(world) -> dict:
    return world.validate_declaration(
        {
            "version": 1,
            "world": {"id_prefix": "bench"},
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


def producer_pings(path: Path, stop: threading.Event, samples: list, failures: list) -> None:
    # Fail-fast commits: a held write transaction (busy_timeout spinning in
    # RESERVED) would starve a rollback-mode backup indefinitely, which the
    # acquisition deadline then refuses — the documented outcome, measured
    # in the adapter tests. Here we measure ordinary brief commits instead.
    db = sqlite3.connect(path, timeout=0)
    db.execute("PRAGMA busy_timeout=0")
    next_id = 10_000_000
    try:
        while not stop.is_set():
            started = time.perf_counter()
            try:
                db.execute("INSERT INTO event VALUES(?, 'abc')", (next_id,))
                db.commit()
                samples.append((time.perf_counter() - started) * 1000)
                next_id += 1
            except sqlite3.OperationalError as failure:
                db.rollback()
                failures.append(str(failure))
            time.sleep(0.002)
    finally:
        db.close()


def measure_case(world, rows: int, journal: str, repeats: int) -> dict:
    runs = []
    for _ in range(repeats):
        with tempfile.TemporaryDirectory(prefix="ki-snapshot-bench-") as directory:
            source = Path(directory) / "source.sqlite"
            build_fixture(source, rows, journal)
            source_bytes = source.stat().st_size
            stop = threading.Event()
            samples: list[float] = []
            failures: list[str] = []
            writer = threading.Thread(
                target=producer_pings, args=(source, stop, samples, failures)
            )
            writer.start()
            try:
                prepared = world.prepare_world(source, declaration(world))
            finally:
                stop.set()
                writer.join()
            snapshot_bytes = prepared.snapshot_path.stat().st_size
            world_id = prepared.world_id
            prepared.cleanup()
            runs.append(
                {
                    "source_bytes": source_bytes,
                    "snapshot_bytes": snapshot_bytes,
                    "backup_s": prepared.timings["backup_s"],
                    "fingerprint_s": prepared.timings["fingerprint_s"],
                    "validation_s": prepared.timings["validation_s"],
                    "total_s": prepared.timings["total_s"],
                    "world_id": world_id,
                }
            )
    def median(key: str) -> float:
        return statistics.median(run[key] for run in runs)

    return {
        "rows": rows,
        "journal": journal,
        "repeats": repeats,
        "source_bytes": runs[0]["source_bytes"],
        "snapshot_bytes": runs[0]["snapshot_bytes"],
        "backup_s_median": median("backup_s"),
        "fingerprint_s_median": median("fingerprint_s"),
        "validation_s_median": median("validation_s"),
        "total_s_median": median("total_s"),
        "producer_commits_during_acquisition": len(samples),
        "producer_busy_failures": len(failures),
        "producer_commit_latency_ms_median": statistics.median(samples) if samples else None,
        "producer_commit_latency_ms_max": max(samples) if samples else None,
        "producer_failures": failures[:3],
        "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "environment": {
            "python": platform.python_version(),
            "sqlite": sqlite3.sqlite_version,
            "platform": platform.platform(),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", type=Path, default=Path(__file__).with_name("server.py"))
    parser.add_argument("--rows", type=int, nargs="+", default=[32000, 200000])
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    world = load_world(args.server)
    for rows in args.rows:
        for journal in ("WAL", "DELETE"):
            print(json.dumps(measure_case(world, rows, journal, args.repeats)))


if __name__ == "__main__":
    main()

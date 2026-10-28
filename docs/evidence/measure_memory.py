#!/usr/bin/env python3
"""Python memory a table's verification keeps, and its peak, per reader design.

    python3 docs/evidence/measure_memory.py DATABASE.sqlite TABLE [--rows N]

A fresh launch per run. After schema discovery, `tracemalloc` starts; the
table's first row window is read (which verifies it), and the run reports the
allocations still held afterwards and the peak during the read, then reads
N more windows of 100 rows to show what handing rows out keeps. tracemalloc
slows Python down several times over, so the reader's wall-clock limits are
raised (`query_seconds` 600) to let verification reach the verdict it reaches
untraced; the VM-step limit, which does not depend on Python's speed, is
unchanged. Time is not reported here (see bench_identity.py).
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
import tracemalloc
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset")
    parser.add_argument("table")
    parser.add_argument("--reader")
    parser.add_argument("--rows", type=int, default=0)
    args = parser.parse_args()
    from adapters.source import server
    if args.reader:
        module, _, name = args.reader.partition(":")
        server.SourceReader = getattr(importlib.import_module(module), name)
    manager = server.SessionManager(Path(args.dataset).resolve(), ttl_s=None, reader_options={"query_seconds": 600})
    try:
        token = manager.initial_session
        generation = manager.descriptor(token)["generation"]
        def get(route, **query):
            q = {"session": [token], "generation": [generation], **{k: [str(v)] for k, v in query.items()}}
            return server.dispatch(manager, "/source/v1/" + route, q)["data"]
        get("overview", limit=1)
        reader = manager.sessions[token]["reader"]
        reader.columns_cache.clear()
        tracemalloc.start()
        base = tracemalloc.get_traced_memory()[0]
        first = get("rows", table=args.table, limit=100)
        held, peak = tracemalloc.get_traced_memory()
        tracemalloc.reset_peak()
        for n in range(1, args.rows + 1):
            get("rows", table=args.table, limit=100, offset=100 * n)
        held_after, peak_after = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        print(json.dumps({"dataset": args.dataset, "table": args.table, "reader": args.reader or "production",
                          "identity": {k: first["identity"][k] for k in ("status", "reason", "verified_rows")},
                          "registry_entries": len(reader.records), "accounted_bytes": reader._registered_bytes,
                          "held_after_verification_bytes": held - base, "peak_during_verification_bytes": peak - base,
                          "more_windows": args.rows, "held_after_windows_bytes": held_after - base,
                          "peak_during_windows_bytes": peak_after - base}))
    finally:
        manager.close()


if __name__ == "__main__":
    main()

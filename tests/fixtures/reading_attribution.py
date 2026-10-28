"""Disposable real SQLite + external CLI readings; also a labelled dictionary API path.

No production artifact is touched. Used by both backend and actual-browser tests.
"""
from __future__ import annotations

import copy
import json
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from adapters.world import server as world
from adapters.world.fixture import build


def declarations():
    neutral = {
        "version": 1, "world": {"id_prefix": "attribution", "description": "A reader note, not a producer statement."},
        "entities": [{"kind": "flow", "source": "flow", "key_columns": ["id"], "label_column": "name"}],
        "relations": [{"name": "step", "source": "v_hop", "key_columns": ["flow_id", "seq"],
                       "description": "Reader interpretation of a hop.",
                       "roles": [{"role": "flow", "column_name": "flow_id", "target_kind": "flow"},
                                 {"role": "order", "column_name": "seq"},
                                 {"role": "participant", "column_name": "who"},
                                 {"role": "action", "column_name": "what"}]}],
    }
    a, b = copy.deepcopy(neutral), copy.deepcopy(neutral)
    a["relations"][0].update(origin="SEMANTIC", occurrence_state="ADOPTED")
    b["relations"][0].update(name="passage", origin="MECHANICAL", occurrence_state="REJECTED")
    b["relations"][0]["roles"][2]["role"] = "operator"
    return {"a": a, "b": b, "neutral": neutral}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get(port, path):
    with urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as response:
        return json.load(response)


@contextmanager
def serve_readings(directory: Path, server_root: Path = ROOT):
    path = build(directory / "producer.sqlite")
    with sqlite3.connect(path) as db:
        db.execute("CREATE VIEW v_hop AS SELECT * FROM hop")
    before = {"sha256": world.file_sha256(path), "mtime_ns": path.stat().st_mtime_ns}
    children = []
    ports = {}
    try:
        for name, decl in declarations().items():
            declaration_path = directory / f"{name}.json"
            declaration_path.write_text(json.dumps(decl))
            port = free_port()
            child = subprocess.Popen([sys.executable, str(server_root / "adapters/world/server.py"),
                                      "--db", str(path), "--declaration", str(declaration_path), "--port", str(port)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            children.append(child)
            ports[name] = port
        # Legacy/API path: receives a dictionary; no external-file ownership known.
        port = free_port()
        script = '''
import json,sys
from pathlib import Path
from http.server import ThreadingHTTPServer
from adapters.world import server as w
p=Path(sys.argv[1]);decl=json.loads(Path(sys.argv[2]).read_text())
d=w.connect(p)
try:m=w.Model(d,decl)
finally:d.close()
w.Handler.model=m;w.Handler.db_path=p;w.Handler.world_id="legacy-dictionary-fixture"
ThreadingHTTPServer(("127.0.0.1",int(sys.argv[3])),w.Handler).serve_forever()
'''
        children.append(subprocess.Popen([sys.executable, "-c", script, str(path), str(directory / "neutral.json"), str(port)],
                                         cwd=server_root, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE))
        ports["legacy"] = port
        for port, child in zip(ports.values(), children):
            deadline = time.monotonic() + 15
            while True:
                if child.poll() is not None:
                    raise RuntimeError(child.stderr.read().decode())
                try:
                    get(port, "/world/overview")
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.05)
        yield {"ports": ports, "source": str(path), "before": before,
               "digests": {name: world.declaration_fingerprint(decl) for name, decl in declarations().items()}}
    finally:
        for child in children:
            if child.poll() is None:
                child.send_signal(signal.SIGINT)
            child.wait(timeout=10)
            child.stderr.close()
        assert world.file_sha256(path) == before["sha256"]
        assert path.stat().st_mtime_ns == before["mtime_ns"]


if __name__ == "__main__":
    with serve_readings(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT) as info:
        print(json.dumps(info), flush=True)
        sys.stdin.read()

"""Test-only operator channel. Production source HTTP routes are unchanged.

The browser talks to the real SourceHTTPServer/SourceReader. stdin controls only
server-owned captures, never the producer, to demonstrate fail-closed reads.
"""
import hashlib
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters.source.server import SessionManager, SourceHTTPServer

manager = SessionManager(Path(sys.argv[1]), reader_options=json.loads(sys.argv[2]))
server = SourceHTTPServer(("127.0.0.1", 0), manager)
thread = threading.Thread(target=server.serve_forever)
thread.start()
print(server.server_port, flush=True)
try:
    for line in sys.stdin:
        command = line.strip()
        if command == "stop":
            break
        session = manager.sessions[manager.initial_session]
        if command == "fingerprint":
            path = session["capture"].snapshot_path
            print(json.dumps({"sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                              "mtime_ns": str(path.stat().st_mtime_ns),
                              "sidecars": sorted(p.name for p in path.parent.glob(path.name + "-*"))}), flush=True)
            continue
        if command == "retire":
            manager.retire(manager.initial_session)
        elif command == "delete":
            session["capture"].snapshot_path.unlink()
        elif command == "damage":
            with session["capture"].snapshot_path.open("r+b") as artifact:
                artifact.write(b"damaged capture")
        print("done", flush=True)
finally:
    server.shutdown()
    thread.join()
    server.server_close()
    manager.close()

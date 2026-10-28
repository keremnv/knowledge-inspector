"""Captured SQLite source reads, without a conceptual declaration.

    python3 adapters/source/server.py --db /operator/selected/database.sqlite --port 8159

GET /source/v1/session bootstraps the initial, fixed session. All other reads
require its exact session AND generation parameters. No browser path/SQL or
session mutation endpoints exist. Restart is the CLI's explicit new capture.
"""
from __future__ import annotations

import argparse
import json
import math
import secrets
import signal
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from adapters.capture import Capture, CaptureError, SnapshotUnavailable
from adapters.sqlite.server import request_allowed
from adapters.source.model import SourceReader, SourceError, MAX_PAGE, MAX_RESPONSE_BYTES, PROJECTION_VERSION

CAPABILITIES = {"schema": True, "row_windows": True, "verified_pk_records": True,
                "outgoing_fk_observations": True, "incoming_fk_observations": True,
                "conceptual_readings": False, "browser_refresh": False,
                "query_mappings": False, "keyless_record_handles": False,
                "view_record_handles": False}


class SessionManager:
    """Small safe manager: <=2 live captures, operator-selected source only.

    ttl_s=None explicitly disables idle expiry; close/retire still release captures.
    The standalone service keeps its bounded default.
    Explicit tokens never redirect to a current generation. Expiry/retirement
    refuses new consumers, while existing capture leases defer file deletion.
    No automatic orphan scavenging: normal/error cleanup owns exact paths;
    SIGKILL leftovers require an operator (never delete another process's data).
    """
    def __init__(self, producer: Path, *, ttl_s: float | None = 3600.0, max_sessions=2,
                 capture_deadline_s=120.0, max_capture_bytes=2*1024**3,
                 reader_options=None):
        if (ttl_s is not None and (not math.isfinite(ttl_s) or ttl_s <= 0)) or max_sessions not in (1, 2):
            raise ValueError("positive finite TTL or None, and 1 or 2 sessions required")
        self.producer, self.ttl_s, self.max_sessions = producer, ttl_s, max_sessions
        self.capture_deadline_s, self.max_capture_bytes = capture_deadline_s, max_capture_bytes
        self.reader_options = reader_options or {}
        self.namespace = "src1_" + secrets.token_urlsafe(24)
        self.sessions = {}
        self._captures = []
        self._lock = threading.RLock()
        self._closed = False
        self.initial_session = self.new_generation()

    def new_generation(self):
        # Serialize acquisition/reservation, including quota checks. Existing
        # leases do not hold this lock while doing database work.
        with self._lock:
            if self._closed:
                raise CaptureError("source_manager_closed", 410)
            self.expire()
            self._captures = [c for c in self._captures if not c._cleaned]
            if len(self._captures) >= self.max_sessions:
                raise SourceError("source_session_limit", 429)
            capture = Capture.acquire(self.producer, namespace=self.namespace,
                                      deadline_s=self.capture_deadline_s,
                                      max_bytes=self.max_capture_bytes)
            try:
                reader = SourceReader(capture, **self.reader_options)
                token = "ses1_" + secrets.token_urlsafe(24)
                self.sessions[token] = {"capture": capture, "reader": reader,
                                        "last_used": time.monotonic()}
                self._captures.append(capture)
                return token
            except BaseException:
                capture.retire()
                raise

    def expire(self):
        with self._lock:
            if self.ttl_s is None:
                return
            for token, session in list(self.sessions.items()):
                if time.monotonic() - session["last_used"] >= self.ttl_s:
                    self.retire(token)

    def retire(self, token):
        with self._lock:
            session = self.sessions.pop(token, None)
            if session:
                session["capture"].retire()

    def descriptor(self, token):
        with self._lock:
            self.expire()
            session = self.sessions.get(token)
            if session is None:
                raise CaptureError("source_session_missing_or_expired", 410)
            session["capture"].check()
            session["last_used"] = time.monotonic()
            return {**session["capture"].metadata(), "session": token,
                    "projection_version": PROJECTION_VERSION,
                    "capabilities": dict(CAPABILITIES), "idle_ttl_seconds": self.ttl_s}

    @contextmanager
    def lease(self, token, generation):
        with self._lock:
            self.expire()
            session = self.sessions.get(token)
            if session is None:
                raise CaptureError("source_session_missing_or_expired", 410)
            if session["capture"].generation != generation:
                raise SourceError("source_generation_mismatch", 409)
            session["last_used"] = time.monotonic()
            descriptor = self.descriptor(token)
            # Enter while holding manager lock: expiry cannot retire between
            # selecting the session and acquiring its consumer reference.
            lease = session["capture"].lease()
            db = lease.__enter__()
        try:
            yield descriptor, session["reader"], db
        except BaseException:
            lease.__exit__(*sys.exc_info())
            raise
        else:
            lease.__exit__(None, None, None)

    def close(self):
        with self._lock:
            self._closed = True
            for token in list(self.sessions):
                self.retire(token)


def parameter(query, key, default=None):
    values = query.get(key)
    if values is None:
        if default is None:
            raise SourceError("missing_parameter", detail=key)
        return default
    if len(values) != 1 or not values[0]:
        raise SourceError("invalid_parameter", detail=key)
    return values[0]


def window(query):
    try:
        limit = int(parameter(query, "limit", "50"))
        offset = int(parameter(query, "offset", "0"))
    except ValueError as failure:
        raise SourceError("invalid_pagination") from failure
    if not 1 <= limit <= MAX_PAGE or not 0 <= offset <= 1_000_000:
        raise SourceError("pagination_limit_exceeded")
    return limit, offset


def dispatch(manager, path, query):
    if path == "/source/v1/session":
        if query:
            raise SourceError("unknown_parameter")
        return manager.descriptor(manager.initial_session)
    allowed = {"session", "generation", "limit", "offset"}
    if path in {"/source/v1/search", "/source/v1/records"}:
        allowed |= {"table", "mode", "text", "column", "key", "record", "fk", "order", "desc", "case"}
    elif path == "/source/v1/rows":
        allowed |= {"table", "order", "desc"}
    elif path == "/source/v1/record":
        allowed |= {"id"}
    elif path == "/source/v1/references":
        allowed |= {"record", "direction"}
    elif path == "/source/v1/reference":
        allowed |= {"record", "fk"}
    elif path == "/source/v1/find":
        # Find continues by its cursor, never by an offset.
        allowed = (allowed - {"offset"}) | {"text", "cursor", "case"}
    elif path not in {"/source/v1/overview", "/source/v1/schema"}:
        raise SourceError("source_route_not_found", 404)
    if set(query) - allowed:
        raise SourceError("unknown_parameter")
    token, generation = parameter(query, "session"), parameter(query, "generation")
    limit, offset = window(query)
    # A sort column is exactly one of the table's columns (checked by the
    # reader); `desc` is "1" or absent.
    order_by = parameter(query, "order") if "order" in query else None
    if "desc" in query and (order_by is None or parameter(query, "desc") not in {"0", "1"}):
        raise SourceError("invalid_parameter", detail="desc")
    desc = "desc" in query and parameter(query, "desc") == "1"
    with manager.lease(token, generation) as (context, reader, db):
        with reader.operation(db):
            if path in {"/source/v1/overview", "/source/v1/schema"}:
                data = reader.catalogue(db, limit=limit, offset=offset, schema=path.endswith("/schema"))
            elif path in {"/source/v1/search", "/source/v1/records"}:
                def optional(key):
                    if key not in query:
                        return None
                    if len(query[key]) != 1:
                        raise SourceError("invalid_parameter", detail=key)
                    return query[key][0]
                # Records without a mode is the plain table window, as `rows`.
                if path == "/source/v1/records" and "mode" not in query:
                    if {"text", "column", "key", "record", "fk", "case"} & set(query):
                        raise SourceError("invalid_search_parameters")
                    data = reader.record_window(db, parameter(query, "table"), limit=limit, offset=offset, order_by=order_by, desc=desc)
                    return {"context": context, "data": data}
                mode = parameter(query, "mode", "literal")
                if ((mode == "literal" and "key" in query) or (mode == "primary_key" and ({"text", "column"} & set(query)))
                        or (mode == "reference" and ({"text", "column", "key"} & set(query)))
                        or (mode != "reference" and ({"record", "fk"} & set(query)))):
                    raise SourceError("invalid_search_parameters")
                raw_key = optional("key")
                try:
                    key = json.loads(raw_key) if raw_key is not None else None
                except (ValueError, RecursionError) as failure:
                    raise SourceError("invalid_search_key") from failure
                read = reader.record_window if path == "/source/v1/records" else reader.search
                data = read(db, parameter(query, "table"),
                            mode=mode,
                            text=optional("text"), column=optional("column"), key=key,
                            record=optional("record"), fk=optional("fk"), case=optional("case"),
                            limit=limit, offset=offset, order_by=order_by, desc=desc)
            elif path == "/source/v1/find":
                data = reader.find(db, parameter(query, "text"), limit=limit,
                                   cursor=parameter(query, "cursor") if "cursor" in query else None,
                                   case=parameter(query, "case") if "case" in query else None)
            elif path == "/source/v1/rows":
                data = reader.rows(db, parameter(query, "table"), limit, offset, order_by=order_by, desc=desc)
            elif path == "/source/v1/record":
                data = reader.record(db, parameter(query, "id"))
            elif path == "/source/v1/references":
                data = reader.references(db, parameter(query, "record"), limit=limit, offset=offset,
                                         direction=parameter(query, "direction", "outgoing"))
            else:
                data = reader.reference(db, parameter(query, "record"), parameter(query, "fk"))
        return {"context": context, "data": data}


_BUSY_BODY = b'{"error":"source_server_busy"}'
ADMISSION_BUSY = (b"HTTP/1.0 429 Too Many Requests\r\nContent-Type: application/json\r\n"
                  b"Cache-Control: no-store\r\nRetry-After: 1\r\nConnection: close\r\n"
                  b"Content-Length: " + str(len(_BUSY_BODY)).encode() + b"\r\n\r\n" + _BUSY_BODY)


class SourceHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, address, manager):
        self.manager = manager
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        request.settimeout(5)
        if not self.slots.acquire(blocking=False):
            # Admission overload is temporary and says nothing about the
            # capture: a structured busy response, never a capture failure.
            try:
                # Drain what has already arrived without waiting, so closing
                # does not reset the connection before the reply is read.
                request.setblocking(False)
                request.recv(16384)
            except OSError:
                pass
            try:
                request.settimeout(5)
                request.sendall(ADMISSION_BUSY)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "SQLiteSource/1.0"

    def log_message(self, *args):
        pass

    def send_json(self, status, payload):
        body = json.dumps(payload, allow_nan=False, ensure_ascii=True).encode("utf-8")
        if len(body) > MAX_RESPONSE_BYTES:
            status, body = 413, b'{"error":"source_response_budget_exceeded"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not request_allowed(self.headers):
            self.send_json(403, {"error": "source_loopback_origin_required"})
            return
        if len(self.path) > 8192 or sum(len(k)+len(v) for k,v in self.headers.items()) > 16384:
            self.send_json(414, {"error": "source_request_too_large"})
            return
        if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0") != "0":
            self.send_json(400, {"error": "source_get_body_refused"})
            return
        parsed = urlparse(self.path)
        try:
            query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=12)
            payload = dispatch(self.server.manager, parsed.path, query)
            self.send_json(200, payload)
        except (CaptureError, SourceError) as failure:
            self.send_json(failure.status, {"error": failure.code,
                                          **({"detail": failure.detail} if isinstance(failure, SourceError) and failure.detail else {})})
        except sqlite3.Error as failure:
            self.send_json(422, {"error": "source_schema_unavailable", "detail": str(failure)})
        except ValueError:
            self.send_json(400, {"error": "invalid_source_query"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reject_write(self):
        self.send_json(405, {"error": "source_read_only"})

    do_POST = do_PUT = do_PATCH = do_DELETE = reject_write


def main():
    if sys.version_info < (3, 11):
        raise SystemExit("captured source v1 requires Python 3.11 or newer")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8159)
    parser.add_argument("--session-ttl", type=float, default=3600)
    parser.add_argument("--capture-deadline", type=float, default=120)
    args = parser.parse_args()
    manager = server = reaper = None
    stop = threading.Event()
    def terminate(signum, frame):
        raise KeyboardInterrupt
    # Install before acquisition, so ordinary termination during a blocked
    # startup read also unwinds the capture owner's error cleanup.
    signal.signal(signal.SIGTERM, terminate)
    try:
        manager = SessionManager(args.db, ttl_s=args.session_ttl, capture_deadline_s=args.capture_deadline)
        def reap():
            while not stop.wait(0.5):
                manager.expire()
        reaper = threading.Thread(target=reap, daemon=True)
        reaper.start()
        server = SourceHTTPServer(("127.0.0.1", args.port), manager)
        print(f"sqlite source: http://127.0.0.1:{server.server_port}/source/v1/session", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (SnapshotUnavailable, ValueError, OSError) as failure:
        raise SystemExit(f"cannot serve selected source: {failure}")
    finally:
        stop.set()
        if reaper is not None:
            reaper.join(timeout=1)
        if server is not None:
            server.server_close()
        if manager is not None:
            manager.close()


if __name__ == "__main__":
    main()

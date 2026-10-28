# Historical baseline SourceReader retained for the identity-memory comparison.
# It is evidence only and is not part of the installed application.
"""Version-1 source records and FK observations; no conceptual World types.

All SQL is generated from recorded, allowlisted identifiers. Typed IDs address
verified primary keys, not offsets, labels, inferred keys or whole-row hashes.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import struct
import threading
import time
import unicodedata
from collections import defaultdict
from contextlib import contextmanager

PROJECTION_VERSION = "sqlite_source_v1"
MAX_PAGE = 100
# Ordinary finding and filtering ignore case (owner decision O11): TEXT cells
# and the searched text are compared after Python's full Unicode case folding,
# with no normalization. `exact_v1` is the previous code-point comparison,
# kept for `case=match`. Versioned so a later rule cannot pass for this one.
TEXT_COMPARISON = {"ignore": "casefold_v1", "match": "exact_v1"}


def casefold(value):
    """The SQL side of casefold_v1: TEXT folded, anything else no match."""
    return value.casefold() if type(value) is str else None
MAX_CELL_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class SourceError(Exception):
    def __init__(self, code: str, status: int = 400, detail: str | None = None):
        super().__init__(code)
        self.code, self.status, self.detail = code, status, detail


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def identifier_fold(name: str) -> str:
    # SQLite folds ASCII identifiers, not general Unicode casefolding.
    return name.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))


def framed(value) -> bytes:
    """Canonical v1 binary framing: tag + u64 length/count + framed payload.

    S=UTF-8 string, I=decimal integer, R=binary64 big-endian, L=ordered list.
    No normalization, display conversion, JSON float, or separator ambiguity.
    """
    if isinstance(value, (tuple, list)):
        return b"L" + struct.pack(">Q", len(value)) + b"".join(framed(v) for v in value)
    if type(value) is str:
        data, tag = value.encode("utf-8"), b"S"
    elif type(value) is int:
        data, tag = str(value).encode("ascii"), b"I"
    elif type(value) is float and math.isfinite(value):
        data, tag = struct.pack(">d", value), b"R"
    else:
        raise SourceError("unsupported_identity_component", 422)
    return tag + struct.pack(">Q", len(data)) + data


def storage(value) -> str:
    return {type(None): "null", int: "integer", float: "real", str: "text", bytes: "blob"}[type(value)]


def observation_id(child_handle: str, declaration_id: str) -> str:
    # One identity for "this child row's FK k", whichever end discovered it.
    return "so1:" + hashlib.sha256(framed(
        ["ki.source.observation.v1", child_handle, declaration_id])).hexdigest()


def scalar(value) -> dict:
    kind = storage(value)
    if kind == "null":
        return {"storage_class": kind, "exact": None}
    if kind == "integer":
        return {"storage_class": kind, "exact": str(value)}
    if kind == "real":
        return {"storage_class": kind, "ieee754_hex": struct.pack(">d", value).hex(),
                "display": repr(value), "finite": math.isfinite(value)}
    if kind == "text":
        # Ensure ordinary UTF-8 transports can retain every code point.
        value.encode("utf-8")
        return {"storage_class": kind, "exact": value}
    return {"storage_class": "blob", "bytes": len(value),
            "sha256": hashlib.sha256(value).hexdigest(), "preview_only": True}


# Only tokenize schema DDL, never execute it. This small lexer retains quoted
# identifiers/strings and skips comments so COLLATE inside DEFAULT/CHECK/AS
# expressions cannot masquerade as a column's declared collation.
_TOKEN = re.compile(r'''\s+|--[^\n]*(?:\n|$)|/\*[\s\S]*?\*/|"(?:""|[^"])*"|'(?:''|[^'])*'|`(?:``|[^`])*`|\[[^\]]*\]|[(),]|[^\s(),"'`\[]+''')


def declared_collations(sql: str, columns: list[str]) -> dict[str, str]:
    tokens = []
    for match in _TOKEN.finditer(sql):
        raw = match.group()
        if raw.isspace() or raw.startswith(("--", "/*")):
            continue
        quoted = raw[0] in "\"'`["
        value = raw[1:-1].replace(raw[0] * 2, raw[0]) if quoted else raw
        tokens.append((value, quoted))
    groups, group, depth = [], [], 0
    for value, quoted in tokens:
        if not quoted and value == "(":
            depth += 1
            if depth == 1:
                continue
        if not quoted and value == ")":
            depth -= 1
            if depth == 0:
                groups.append(group)
                break
        if depth == 1 and value == "," and not quoted:
            groups.append(group)
            group = []
        elif depth >= 1:
            group.append((value, quoted))
    result = {name: "BINARY" for name in columns}
    canonical = {identifier_fold(c): c for c in columns}
    for group in groups:
        if not group or (not group[0][1] and group[0][0].upper() in
                         {"CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"}):
            continue
        name = canonical.get(identifier_fold(group[0][0]))
        if name is None:
            continue
        depth = 0
        for i, (value, quoted) in enumerate(group[1:], 1):
            if not quoted and value == "(":
                depth += 1
            elif not quoted and value == ")":
                depth -= 1
            elif not quoted and depth == 0 and value.upper() == "COLLATE":
                if i + 1 >= len(group):
                    raise SourceError("unsupported_schema_collation", 422)
                result[name] = group[i + 1][0]
    return result


class SourceReader:
    def __init__(self, capture, *, query_seconds: float = 5.0,
                 vm_steps: int = 10_000_000, key_rows: int = 200_000,
                 key_bytes: int = 64 * 1024 * 1024,
                 incoming_page_seconds: float = 1.0, incoming_page_steps: int | None = None):
        if (not math.isfinite(query_seconds) or query_seconds <= 0 or
                not math.isfinite(incoming_page_seconds) or incoming_page_seconds <= 0 or
                vm_steps < 0 or key_rows < 0 or key_bytes < 0 or (incoming_page_steps or 0) < 0):
            raise ValueError("positive finite query time and nonnegative resource limits required")
        if sqlite3.sqlite_version_info < (3, 37, 0):
            raise ValueError("captured source v1 requires SQLite 3.37 or newer")
        self.capture = capture
        self.query_seconds, self.vm_steps = query_seconds, vm_steps
        self.key_rows, self.key_bytes = key_rows, key_bytes
        # One incoming page's counts share this total (by default about a
        # second, and two ordinary work budgets), so the reader lock is held
        # for at most this much counting whatever the page size.
        self.incoming_page_seconds = incoming_page_seconds
        self.incoming_page_steps = 2 * vm_steps if incoming_page_steps is None else incoming_page_steps
        self._lock = threading.RLock()
        # A request-wide cap every budget window inside it draws from; see `_capped`.
        self._cap: dict | None = None
        self.objects: dict[str, dict] | None = None
        self.columns_cache: dict[str, list[dict]] = {}
        self.identities: dict[str, dict] = {}
        self.records: dict[str, tuple[str, tuple, bytes]] = {}
        self.fks: dict[str, list[dict]] = {}
        self._registered_bytes = 0
        self.metrics: dict[str, float] = {}

    def reset_budget(self, db, seconds=None, steps=None):
        """Start one budget window: the ordinary budget, or a smaller one.

        Returns its usage: VM steps run (in the handler's 1000-instruction
        units) and which limit, if any, interrupted it.
        """
        seconds = self.query_seconds if seconds is None else seconds
        steps = self.vm_steps if steps is None else steps
        cap = self._cap
        if cap is not None:
            seconds = min(seconds, cap["deadline"] - time.monotonic())
            steps = min(steps, cap["steps"])
        started, usage = time.monotonic(), {"steps": 0, "stopped_by": None}
        def progress():
            usage["steps"] += 1000
            if cap is not None:
                cap["steps"] -= 1000
            if usage["steps"] > steps:
                usage["stopped_by"] = "steps"
            elif time.monotonic() - started > seconds:
                usage["stopped_by"] = "time"
            return usage["stopped_by"] is not None
        db.set_progress_handler(progress, 1000)
        return usage

    @contextmanager
    def operation(self, db):
        """One bounded operation/connection. No submitted SQL or extensions."""
        if not self._lock.acquire(timeout=self.query_seconds):
            raise SourceError("source_reader_busy", 429)
        self.reset_budget(db)
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 8 * 1024 * 1024)
        try:
            self._discover(db)
            # Built-in deterministic functions plus stable aggregates/window
            # functions are supported. Date/time and current-time functions can
            # be volatile even when SQLite marks some signatures deterministic.
            allowed = {r[0].lower() for r in db.execute("PRAGMA function_list")
                       if r[1] and r[5] & 0x800}
            allowed |= {"count", "sum", "total", "avg", "min", "max", "group_concat",
                        "row_number", "rank", "dense_rank", "first_value", "last_value",
                        "lag", "lead", "ntile", "percent_rank", "cume_dist", "nth_value"}
            allowed -= {"date", "time", "datetime", "julianday", "unixepoch", "strftime",
                        "timediff", "current_date", "current_time", "current_timestamp"}
            allowed -= {"load_extension", "readfile", "writefile"}
            # The one function of ours: deterministic, pure, used by casefold_v1.
            db.create_function("ki_casefold", 1, casefold, deterministic=True)
            allowed.add("ki_casefold")
            unavailable = {identifier_fold(n) for n, o in self.objects.items()
                           if o["kind"] in {"virtual", "shadow"}}
            def authorize(action, arg1, arg2, database, via):
                if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() not in allowed:
                    return sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_READ and identifier_fold(arg1 or "") in unavailable:
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            db.set_authorizer(authorize)
            yield
        except sqlite3.Error as failure:
            code = getattr(failure, "sqlite_errorcode", 0) & 0xff
            if code == sqlite3.SQLITE_INTERRUPT:
                raise SourceError("source_query_budget_exceeded", 422) from failure
            if code in {sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT,
                        sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_CANTOPEN}:
                from adapters.capture import CaptureError
                raise CaptureError("source_capture_damaged") from failure
            raise SourceError("unsupported_source_operation", 422, str(failure)) from failure
        finally:
            db.set_authorizer(None)
            db.set_progress_handler(None, 0)
            self._lock.release()

    def _discover(self, db):
        with self._lock:
            if self.objects is not None:
                return
            started = time.monotonic()
            objects, schema_bytes = {}, 0
            for r in db.execute("SELECT name,type,sql FROM sqlite_schema "
                                "WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY name"):
                schema_bytes += len((r["sql"] or "").encode("utf-8"))
                if len(objects) >= 4096 or schema_bytes > 8*1024*1024:
                    raise SourceError("source_schema_budget_exceeded", 422)
                objects[r["name"]] = {"name": r["name"], "kind": r["type"], "sql": r["sql"]}
            # table_list classifies shadow/virtual tables without guessing from
            # names; unavailable modules may prevent it, in which case refuse
            # virtual objects by their recorded CREATE VIRTUAL TABLE syntax.
            try:
                for r in db.execute("PRAGMA table_list"):
                    if r["schema"] == "main" and r["name"] in objects:
                        objects[r["name"]]["kind"] = r["type"]
            except sqlite3.Error:
                for obj in objects.values():
                    if re.match(r"\s*CREATE\s+VIRTUAL\s+TABLE\b", obj["sql"] or "", re.I):
                        obj["kind"] = "virtual"
            self.objects = objects
            self.metrics["schema_discovery_s"] = time.monotonic() - started

    def object(self, name):
        # Public source names must use recorded spelling. FK resolution below
        # uses SQLite identifier matching and retains raw spelling separately.
        if self.objects is None or name not in self.objects:
            raise SourceError("source_relation_not_found", 404)
        obj = self.objects[name]
        if obj["kind"] in {"virtual", "shadow"}:
            raise SourceError("unsupported_virtual_source", 422)
        return obj

    def columns(self, db, name):
        with self._lock:
            self.object(name)
            if name not in self.columns_cache:
                self.columns_cache[name] = [
                    {"name": r["name"], "declared_type": r["type"] or "",
                     "notnull": bool(r["notnull"]), "pk_order": r["pk"],
                     "default_sql": r["dflt_value"],
                     "generated": {2: "VIRTUAL", 3: "STORED"}.get(r["hidden"])}
                    for r in db.execute(f"PRAGMA table_xinfo({quote(name)})") if r["hidden"] != 1]
            return self.columns_cache[name]

    def pk(self, db, name):
        return [c["name"] for c in sorted(self.columns(db, name), key=lambda c: c["pk_order"])
                if c["pk_order"]]

    def identity(self, db, name, *, verify=False):
        with self._lock:
            obj = self.object(name)
            if name not in self.identities:
                keys = self.pk(db, name)
                status = "view_table_only" if obj["kind"] == "view" else (
                    "not_started" if keys else "no_declared_key")
                self.identities[name] = {"status": status, "key_columns": keys,
                                         "verified_rows": None, "reason": None}
            state = self.identities[name]
            if verify and state["status"] == "not_started":
                started = time.monotonic()
                state["status"] = "checking"
                try:
                    self._verify(db, name, state)
                except (SourceError, sqlite3.Error, UnicodeError) as failure:
                    if isinstance(failure, sqlite3.Error) and (getattr(failure, "sqlite_errorcode", 0) & 0xff) in {
                            sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB}:
                        raise
                    code = failure.code if isinstance(failure, SourceError) else str(failure)
                    budget = "budget" in code or getattr(failure, "sqlite_errorcode", 0) == sqlite3.SQLITE_INTERRUPT
                    cap = self._cap
                    if budget and cap is not None and (cap["steps"] <= 0 or time.monotonic() >= cap["deadline"]) \
                            and code != "identity_registry_budget_exceeded":
                        # Cut short by the request-wide cap of the operation
                        # that happened to touch this table first (a find, say),
                        # not by the table: nothing was registered, so the
                        # table goes back to unchecked and a later read retries
                        # under its own budget. This answer still says it is
                        # not verified.
                        state.update(status="not_started", reason=None)
                        return {**state, "status": "interrupted", "reason": "verification_interrupted_by_request_budget"}
                    state.update(status="budget_exceeded" if budget else "unsupported", reason=code)
                finally:
                    self.metrics[f"key_verification:{name}:s"] = time.monotonic() - started
            return dict(state)

    def _where(self, keys, values):
        where, params = [], []
        for k, v in zip(keys, values):
            where.append(f"{quote(k)} = ? AND typeof({quote(k)}) = ?")
            params.extend([v, storage(v)])
        return " AND ".join(where), params

    def _preimage(self, table, keys, values):
        return framed(["ki.source.record.v1", self.capture.source_namespace,
                       self.capture.digest, "main", table, keys, values])

    def _verify(self, db, name, state):
        keys = state["key_columns"]
        fields = ",".join(map(quote, keys))
        nulls = " OR ".join(f"{quote(k)} IS NULL" for k in keys)
        if db.execute(f"SELECT 1 FROM {quote(name)} WHERE {nulls} LIMIT 1").fetchone():
            state.update(status="invalid", reason="null_primary_key_component")
            return
        if db.execute(f"SELECT 1 FROM {quote(name)} GROUP BY {fields} HAVING count(*)>1 LIMIT 1").fetchone():
            state.update(status="invalid", reason="duplicate_primary_key")
            return
        unsupported = " OR ".join(f"typeof({quote(k)}) NOT IN ('integer','real','text')" for k in keys)
        if db.execute(f"SELECT 1 FROM {quote(name)} WHERE {unsupported} LIMIT 1").fetchone():
            raise SourceError("unsupported_identity_component", 422)
        oversized = " OR ".join(f"typeof({quote(k)})='text' AND length(CAST({quote(k)} AS BLOB))>{MAX_CELL_BYTES}" for k in keys)
        if db.execute(f"SELECT 1 FROM {quote(name)} WHERE {oversized} LIMIT 1").fetchone():
            raise SourceError("identity_component_budget_exceeded", 422)
        pending, used = {}, 0
        started = time.monotonic()
        for row in db.execute(f"SELECT {fields} FROM {quote(name)}"):
            if time.monotonic() - started > self.query_seconds:
                raise SourceError("identity_verification_budget_exceeded", 422)
            values = tuple(row)
            preimage = self._preimage(name, keys, values)
            handle = "sr1:" + hashlib.sha256(preimage).hexdigest()
            for registry in (pending, self.records):
                if handle in registry and registry[handle][2] != preimage:
                    raise SourceError("identity_hash_collision", 422)
            if handle in pending:
                state.update(status="invalid", reason="duplicate_typed_key")
                return
            used += len(preimage) + len(handle) + 128
            if len(pending) + len(self.records) >= self.key_rows or used + self._registered_bytes > self.key_bytes:
                raise SourceError("identity_registry_budget_exceeded", 422)
            where, params = self._where(keys, values)
            # Base table PK indexes make exact probes bounded; refuse a scan
            # instead of turning full-table verification into quadratic work.
            sql = f"SELECT {fields} FROM {quote(name)} WHERE {where} LIMIT 2"
            if not pending and not any("SEARCH" in r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, params)):
                raise SourceError("identity_lookup_plan_unsupported", 422)
            matches = db.execute(sql, params).fetchall()
            if len(matches) != 1 or framed(tuple(matches[0])) != framed(values):
                state.update(status="invalid", reason="typed_key_lookup_not_exact")
                return
            pending[handle] = (name, values, preimage)
        self.records.update(pending)
        self._registered_bytes += used
        state.update(status="verified", verified_rows=len(pending), reason=None)

    def _row(self, db, name, values):
        columns = self.columns(db, name)
        keys = self.pk(db, name)
        where, params = self._where(keys, values)
        rows = self._select(db, name, where=where, params=params, limit=2)
        if len(rows) != 1 or framed(tuple(rows[0][k][0] for k in keys)) != framed(values):
            raise SourceError("source_record_lookup_not_exact", 409)
        return rows[0]

    def _select(self, db, name, *, where="", params=(), limit=MAX_PAGE, offset=0, order=""):
        columns = self.columns(db, name)
        if len(columns) > 512:
            raise SourceError("source_column_budget_exceeded", 422)
        # Bound allocation before loading TEXT/BLOB cells. Oversized BLOBs are
        # represented by length-only previews; oversized TEXT is an explicit
        # budget refusal, never truncated and called an exact scalar.
        projections = []
        for c in columns:
            q = quote(c["name"])
            projections += [f"CASE WHEN typeof({q})='blob' AND length({q})>{MAX_CELL_BYTES} THEN NULL ELSE {q} END",
                            f"typeof({q})", f"length(CAST({q} AS BLOB))"]
        sql = f"SELECT {','.join(projections)} FROM {quote(name)}"
        if where:
            sql += " WHERE " + where
        if order:
            sql += " ORDER BY " + order
        # First query lengths so a huge TEXT cannot be allocated in Python.
        sizes = [f"max(CASE WHEN typeof({quote(c['name'])})='text' THEN length(CAST({quote(c['name'])} AS BLOB)) ELSE 0 END)" for c in columns]
        sums = [f"sum(CASE WHEN typeof({quote(c['name'])})='text' THEN length(CAST({quote(c['name'])} AS BLOB)) "
                f"WHEN typeof({quote(c['name'])})='blob' AND length({quote(c['name'])})<={MAX_CELL_BYTES} THEN length({quote(c['name'])}) ELSE 0 END)"
                for c in columns]
        size_sql = f"SELECT {','.join(sizes+sums)} FROM (SELECT * FROM {quote(name)}" + (
            " WHERE " + where if where else "") + (" ORDER BY " + order if order else "") + " LIMIT ? OFFSET ?)"
        size_row = db.execute(size_sql, [*params, limit, offset]).fetchone()
        if any(v is not None and v > MAX_CELL_BYTES for v in tuple(size_row)[:len(columns)]):
            raise SourceError("source_cell_budget_exceeded", 413)
        if sum(v or 0 for v in tuple(size_row)[len(columns):]) > MAX_RESPONSE_BYTES:
            raise SourceError("source_page_budget_exceeded", 413)
        rows = []
        for r in db.execute(sql + " LIMIT ? OFFSET ?", [*params, limit, offset]):
            row = {}
            for i, c in enumerate(columns):
                value, kind, size = r[3*i:3*i+3]
                row[c["name"]] = (value, kind, size)
            rows.append(row)
        return rows

    def encode_row(self, db, name, row, identity):
        cells = []
        for c in self.columns(db, name):
            value, kind, size = row[c["name"]]
            cell = ({"storage_class": "blob", "bytes": size, "preview_only": True,
                     "sha256": None, "reason": "blob_digest_budget_exceeded"}
                    if kind == "blob" and value is None else scalar(value))
            cells.append({"column": c["name"], **cell})
        handle = None
        key = []
        if identity["status"] == "verified":
            values = tuple(row[k][0] for k in identity["key_columns"])
            preimage = self._preimage(name, identity["key_columns"], values)
            handle = "sr1:" + hashlib.sha256(preimage).hexdigest()
            if self.records.get(handle) != (name, values, preimage):
                raise SourceError("source_record_not_verified", 409)
            key = [{"column": k, **scalar(v)} for k, v in zip(identity["key_columns"], values)]
        return {"record_id": handle, "key": key, "cells": cells}

    def _order(self, db, name, state, column=None, desc=False):
        """The window's order, its `ordering` label and, when sorted, `order`.

        Unsorted, the verified key orders the window, or nothing does. Sorted
        by a column, SQLite compares as it always does (storage class, then
        the column's declared collation) and ties are broken by the verified
        key, or failing that by the row's stored location, so a page is the
        same page every time it is read. A view has no stored location: its
        ties keep no fixed order, and the response says so.
        """
        key = ",".join(map(quote, state["key_columns"])) if state["status"] == "verified" else ""
        if column is None:
            return key, "verified_primary_key" if key else "unspecified_window_only", None
        if column not in [c["name"] for c in self.columns(db, name)]:
            raise SourceError("invalid_parameter", detail="order")
        locator = None if key or self.object(name)["kind"] != "table" else self._row_locator(db, name)
        tiebreak = key or (",".join(locator) if locator else "")
        clause = quote(column) + (" DESC" if desc else "") + ("," + tiebreak if tiebreak else "")
        return clause, "column", {"column": column, "desc": bool(desc),
                                  "tiebreak": "verified_primary_key" if key else "row_location" if locator else "unspecified"}

    def rows(self, db, name, limit=50, offset=0, *, order_by=None, desc=False):
        obj = self.object(name)
        state = self.identity(db, name, verify=True)
        # Verification can exhaust its own budget; a fresh bounded window
        # remains available rather than inheriting an interrupted VM budget.
        self.reset_budget(db)
        order, ordering, sorted_by = self._order(db, name, state, order_by, desc)
        found = self._select(db, name, limit=limit, offset=offset, order=order)
        # Look ahead for existence only: the next page's oversized/unsupported
        # cell must not prevent reading an otherwise supported current page.
        more = bool(db.execute(f"SELECT 1 FROM {quote(name)}" +
                               (" ORDER BY " + order if order else "") +
                               " LIMIT 1 OFFSET ?", (offset+len(found),)).fetchone())
        return {"name": name, "kind": obj["kind"], "columns": self.columns(db, name),
                "identity": state, "rows": [self.encode_row(db, name, r, state) for r in found[:limit]],
                "offset": offset, "returned": len(found), "has_more": more,
                "next_offset": offset+len(found) if more else None,
                "ordering": ordering, "order": sorted_by,
                "lineage": "not_recorded" if obj["kind"] == "view" else None}

    def search(self, db, name, *, mode="literal", text=None, column=None,
               key=None, record=None, fk=None, limit=50, offset=0, order_by=None, desc=False, case=None):
        """Bounded literal discovery; identity still comes only from verification."""
        obj = self.object(name)
        columns = self.columns(db, name)
        names = [c["name"] for c in columns]
        if len(names) > 512:
            raise SourceError("source_column_budget_exceeded", 422)
        if type(limit) is not int or type(offset) is not int or not 1 <= limit <= MAX_PAGE or not 0 <= offset <= 1_000_000:
            raise SourceError("invalid_pagination")
        if column is not None and (type(column) is not str or column not in names):
            raise SourceError("invalid_search_column")
        if mode != "reference" and (record is not None or fk is not None):
            raise SourceError("invalid_search_parameters")
        if case is not None and (mode != "literal" or case not in TEXT_COMPARISON):
            raise SourceError("invalid_search_parameters", detail="case")
        case = case or "ignore"
        predicates, params = [], []
        integer = real = None
        parent = declaration = None
        if mode == "reference":
            # Rows whose declared FK resolves to one verified parent record:
            # the same matching as outgoing, never a cell filter.
            if text is not None or column is not None or key is not None or type(record) is not str or type(fk) is not str:
                raise SourceError("invalid_search_parameters")
            parent = self.record(db, record)
            declaration = next((f for f in self.declarations(db, name) if f["declaration_id"] == fk), None)
            if declaration is None:
                raise SourceError("source_fk_not_found", 404)
            if declaration["parent_table"] != parent["name"]:
                raise SourceError("source_fk_parent_mismatch")
            if declaration["validation"]["status"] != "verified_declaration":
                raise SourceError("incoming_declaration_not_verified", 422, declaration["validation"]["reason"])
            searched = [p["child_column"] for p in declaration["pairs"]]
            where, params = self._incoming_match(db, declaration, record)
        elif mode == "literal":
            if type(text) is not str or len(text.encode("utf-8")) > 1024 or key is not None:
                raise SourceError("invalid_search_text")
            if re.fullmatch(r"-?(?:0|[1-9][0-9]*)", text):
                candidate = int(text)
                if -(2**63) <= candidate < 2**63:
                    integer = candidate
            if re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
                candidate = float(text)
                if math.isfinite(candidate):
                    real = candidate
            searched = [column] if column is not None else names
            folded = text.casefold() if case == "ignore" else text
            for field in searched:
                q = quote(field)
                cell = f"ki_casefold({q})" if case == "ignore" else q
                parts = [f"(typeof({q})='text' AND instr({cell}, ?) > 0)"]
                params.append(folded)
                if integer is not None:
                    parts.append(f"(typeof({q})='integer' AND {q}=?)")
                    params.append(integer)
                if real is not None:
                    parts.append(f"(typeof({q})='real' AND {q}=?)")
                    params.append(real)
                predicates.append("(" + " OR ".join(parts) + ")")
            where = " OR ".join(predicates)
        elif mode == "primary_key":
            if text is not None or column is not None:
                raise SourceError("invalid_search_parameters")
            searched = self.pk(db, name)
            if obj["kind"] != "table" or not searched:
                raise SourceError("unsupported_search_key", 422)
            if type(key) is not list or len(key) != len(searched):
                raise SourceError("invalid_search_key")
            values = []
            for field, component in zip(searched, key):
                if (type(component) is not dict or set(component) != {"column", "storage_class", "exact"}
                        or component["column"] != field or type(component["exact"]) is not str
                        or len(component["exact"].encode("utf-8")) > 1024):
                    raise SourceError("invalid_search_key")
                kind, value = component["storage_class"], component["exact"]
                if kind == "integer":
                    if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value) or not -(2**63) <= int(value) < 2**63:
                        raise SourceError("invalid_search_key")
                    value = int(value)
                elif kind != "text":
                    raise SourceError("unsupported_search_key_type", 422)
                values.append(value)
            # Keep index-eligible declared comparisons, then reject collation
            # equivalents: an exact TEXT key is its recorded bytes, not a label.
            where, params = self._where(searched, values)
            for field, value in zip(searched, values):
                if type(value) is str:
                    where += f" AND {quote(field)} COLLATE BINARY = ?"
                    params.append(value)
        else:
            raise SourceError("unsupported_search_mode", 422)
        state = self.identity(db, name, verify=True)
        # Same separate identity-verification/read budgets as ordinary rows.
        self.reset_budget(db)
        order, ordering, sorted_by = self._order(db, name, state, order_by, desc)
        locator = self._row_locator(db, name) if mode == "reference" else None
        if locator:
            # One scan of the FK predicate finds this window and whether a next
            # row exists; the rows are then read by location. The general path
            # below repeats the scan for size preflight and lookahead, which a
            # sparse match in a large unindexed child table cannot afford.
            # Without a verified key the window order is still unspecified,
            # but stays the same between the scan and the read.
            sequence = order or ",".join(locator)
            located = db.execute(f"SELECT {','.join(locator)} FROM {quote(name)} WHERE {where} ORDER BY {sequence} LIMIT ? OFFSET ?",
                                 [*params, limit + 1, offset]).fetchall()
            more, located = len(located) > limit, located[:limit]
            tuples = ",".join("(" + ",".join("?" * len(locator)) + ")" for _ in located)
            found = self._select(db, name, where=f"({','.join(locator)}) IN (VALUES {tuples})",
                                 params=[v for row in located for v in row], limit=limit, order=sequence) if located else []
            if len(found) != len(located):
                raise SourceError("source_window_lookup_not_exact", 409)
        else:
            found = self._select(db, name, where=where, params=params, limit=limit, offset=offset, order=order)
            more = bool(db.execute(f"SELECT 1 FROM {quote(name)} WHERE {where}" +
                                  (" ORDER BY " + order if order else "") + " LIMIT 1 OFFSET ?",
                                  [*params, offset + len(found)]).fetchone())
        unchecked = self._incoming_unchecked(db, declaration, parent) if mode == "reference" else None
        rows = []
        for row in found:
            encoded = self.encode_row(db, name, row, state)
            encoded["matched_columns"] = searched if mode in {"primary_key", "reference"} else [
                field for field in searched if
                (row[field][1] == "text" and (text.casefold() in row[field][0].casefold() if case == "ignore" else text in row[field][0])) or
                (row[field][1] == "integer" and integer is not None and row[field][0] == integer) or
                (row[field][1] == "real" and real is not None and row[field][0] == real)]
            if mode == "reference":
                # An unverified child has no handle, so no observation identity.
                encoded["observation_id"] = observation_id(encoded["record_id"], fk) if encoded["record_id"] else None
            rows.append(encoded)
        result = {"name": name, "kind": obj["kind"], "columns": columns,
                  "identity": state, "rows": rows, "offset": offset, "returned": len(rows),
                  "has_more": more, "next_offset": offset + len(rows) if more else None,
                  "ordering": ordering, "order": sorted_by,
                  "lineage": "not_recorded" if obj["kind"] == "view" else None,
                  "search": {"mode": mode, "text": text, "column": column, "key": key,
                             **({"case": case} if mode == "literal" else {})},
                  "completion": "window" if more else "complete",
                  "searched_columns": searched, "excluded_storage_classes": ["null", "blob"]}
        if mode == "literal":
            result["text_comparison"] = {"policy": TEXT_COMPARISON[case], "unicode_version": unicodedata.unidata_version}
        if mode == "reference":
            result["search"].update(record=record, fk=fk)
            result["excluded_storage_classes"] = ["null"]
            result["reference"] = {"record_id": record, "declaration": declaration,
                                   "comparison_basis": "sqlite_fk_parent_affinity_and_collation",
                                   "unchecked_rows": unchecked,
                                   "unchecked_reason": "child_blob_matching_budget_exceeded" if unchecked else None}
        if len(json.dumps(result, ensure_ascii=True).encode("utf-8")) > MAX_RESPONSE_BYTES:
            raise SourceError("source_response_budget_exceeded", 413)
        return result

    def record(self, db, handle):
        with self._lock:
            entry = self.records.get(handle)
        if entry is None:
            raise SourceError("source_record_not_found_in_generation", 404)
        name, values, _ = entry
        row = self._row(db, name, values)
        state = self.identity(db, name)
        encoded = self.encode_row(db, name, row, state)
        return {**encoded, "name": name, "kind": "source_record", "schema": "main",
                "columns": self.columns(db, name), "identity": state,
                "grounding": {**self.capture.metadata(), "schema": "main", "table": name,
                              "key": encoded["key"], "basis": "stored_row_verified_declared_pk"},
                "actions": {"outgoing_references": True, "incoming_references": True}}

    def record_window(self, db, name, *, mode=None, limit=50, offset=0, order_by=None, desc=False, **criteria):
        """A window of rows as verified records, for placing many at once.

        The window is exactly the one `rows`, or `search` in `mode`, reads under
        the same order. Each row with a verified handle comes back as the record
        a single `record` read returns, and in reference mode with its exact
        observation, so the browser places nothing it has not been handed
        whole. A row without a handle is counted in `skipped`, never placed.
        """
        page = (self.search(db, name, mode=mode, limit=limit, offset=offset, order_by=order_by, desc=desc, **criteria)
                if mode else self.rows(db, name, limit, offset, order_by=order_by, desc=desc))
        fk = criteria.get("fk") if mode == "reference" else None
        entries, skipped = [], 0
        for row in page["rows"]:
            if not row["record_id"]:
                skipped += 1
                continue
            record = self.record(db, row["record_id"])
            entry = {"record": record}
            if fk:
                entry["observation"] = self.reference(db, row["record_id"], fk, record=record)
            entries.append(entry)
        return {"name": page["name"], "identity": page["identity"], "records": entries, "skipped": skipped, "offset": offset,
                "returned": page["returned"], "has_more": page["has_more"], "next_offset": page["next_offset"],
                "ordering": page["ordering"], "order": page["order"], "search": page.get("search")}

    @contextmanager
    def _capped(self, seconds, steps):
        """Every budget window opened inside draws from one total: the
        request holds the reader lock for at most about `seconds`, however many
        tables it reads, as an incoming page does."""
        self._cap = {"deadline": time.monotonic() + seconds, "steps": steps}
        try:
            yield self._cap
        finally:
            self._cap = None

    def find(self, db, text, *, limit=20, cursor=None, case=None):
        """Tables, then records across every table and view, matching `text`.

        Records (O8.11): exactly the per-table literal search, table after
        table in catalogue order, under one request-wide cap (`_capped`). When
        the cap runs out the answer says where it stopped (`budget_exceeded`,
        `next_cursor`), never "no matches"; a table that cannot be searched is
        named with its reason. `next_cursor` continues where this answer ended.

        Tables (O10): the first answer also lists every table and view whose
        recorded name matches under the same text comparison, from the
        catalogue already read; continuations do not repeat them.
        """
        if type(text) is not str or not text or len(text.encode("utf-8")) > 1024:
            raise SourceError("invalid_search_text")
        if case is not None and case not in TEXT_COMPARISON:
            raise SourceError("invalid_search_parameters", detail="case")
        case = case or "ignore"
        if type(limit) is not int or not 1 <= limit <= 50:
            raise SourceError("invalid_pagination")
        tables = [n for n, o in self.objects.items() if o["kind"] in {"table", "view"}]
        start, offset = 0, 0
        if cursor is not None:
            match = re.fullmatch(r"(0|[1-9][0-9]{0,5}):(0|[1-9][0-9]{0,6})", cursor) if type(cursor) is str else None
            if not match or int(match[1]) >= len(tables) or int(match[2]) > 1_000_000:
                raise SourceError("invalid_parameter", detail="cursor")
            start, offset = int(match[1]), int(match[2])
        hits, skipped, completion, next_cursor = [], [], "complete", None
        with self._capped(self.incoming_page_seconds, self.incoming_page_steps) as cap:
            index = start
            while index < len(tables):
                name = tables[index]
                if cap["steps"] <= 0 or time.monotonic() >= cap["deadline"]:
                    completion, next_cursor = "budget_exceeded", f"{index}:{offset}"
                    break
                try:
                    page = self.search(db, name, mode="literal", text=text, limit=limit - len(hits), offset=offset, case=case)
                except (SourceError, sqlite3.Error) as failure:
                    code = getattr(failure, "sqlite_errorcode", 0) & 0xff if isinstance(failure, sqlite3.Error) else None
                    if code in {sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_CANTOPEN}:
                        raise
                    budget = code == sqlite3.SQLITE_INTERRUPT or (isinstance(failure, SourceError) and "budget" in failure.code)
                    spent = cap["steps"] <= 0 or time.monotonic() >= cap["deadline"]
                    if budget and spent and index != start:
                        # It had only what the tables before it left: the next
                        # request gives it the whole cap.
                        completion, next_cursor = "budget_exceeded", f"{index}:{offset}"
                        break
                    # A table that ran out with the whole cap to itself cannot
                    # be searched here at all: named, and the cursor moves on,
                    # so the person knows to use that table's own filter.
                    skipped.append({"table": name, "reason": "find_budget_exceeded" if budget and spent else
                                    failure.code if isinstance(failure, SourceError) else "unsupported_source_operation"})
                    index, offset = index + 1, 0
                    continue
                for row in page["rows"]:
                    hits.append({"table": name, "record_id": row["record_id"], "key": row["key"],
                                 "matched_columns": row["matched_columns"],
                                 "cells": [cell for cell in row["cells"] if cell["column"] in row["matched_columns"]]})
                if page["has_more"]:
                    completion, next_cursor = "more", f"{index}:{page['next_offset']}"
                    break
                index, offset = index + 1, 0
                if len(hits) >= limit and index < len(tables):
                    completion, next_cursor = "more", f"{index}:0"
                    break
        needle = text.casefold() if case == "ignore" else text
        named = [] if cursor is not None else [
            {"name": n, "kind": o["kind"]} for n, o in self.objects.items()
            if needle in (n.casefold() if case == "ignore" else n)]
        return {"text": text, "case": case, "relations": named, "hits": hits, "completion": completion,
                "next_cursor": next_cursor, "skipped": skipped, "tables": len(tables),
                "text_comparison": {"policy": TEXT_COMPARISON[case], "unicode_version": unicodedata.unidata_version}}

    def _resolve_name(self, names, raw):
        matches = [n for n in names if identifier_fold(n) == identifier_fold(raw)]
        return matches[0] if len(matches) == 1 else None

    def declarations(self, db, name):
        with self._lock:
            if name in self.fks:
                return self.fks[name]
            obj = self.object(name)
            groups = defaultdict(list)
            if obj["kind"] == "table":
                for r in db.execute(f"PRAGMA foreign_key_list({quote(name)})"):
                    groups[r["id"]].append(dict(r))
            found = []
            for number, group in sorted(groups.items()):
                group.sort(key=lambda r: r["seq"])
                raw = [{"seq": r["seq"], "from": r["from"], "table": r["table"],
                        "to": r["to"]} for r in group]
                preimage = framed(["ki.source.fk.v1", self.capture.source_namespace,
                                   self.capture.digest, "main", name, number,
                                   [[r["seq"], r["from"], r["table"], r["to"] or ""] for r in group],
                                   group[0]["on_update"], group[0]["on_delete"], group[0]["match"]])
                fk = {"declaration_id": "sf1:" + hashlib.sha256(preimage).hexdigest(),
                      "child_table": name, "recorded_id": number, "recorded_pairs": raw,
                      "on_update": group[0]["on_update"], "on_delete": group[0]["on_delete"],
                      "match": group[0]["match"], "parent_table": None, "pairs": [],
                      "validation": {"status": "invalid", "reason": None},
                      "historical_enforcement": "not_established"}
                try:
                    self._validate_fk(db, fk, group)
                except (SourceError, sqlite3.Error) as failure:
                    if isinstance(failure, sqlite3.Error) and (getattr(failure, "sqlite_errorcode", 0) & 0xff) in {
                            sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB,
                            sqlite3.SQLITE_INTERRUPT}:
                        raise
                    fk["validation"] = {"status": "unsupported", "reason": str(failure)}
                found.append(fk)
            self.fks[name] = found
            return found

    def _validate_fk(self, db, fk, group):
        def invalid(reason):
            fk["validation"] = {"status": "invalid", "reason": reason}
        if [r["seq"] for r in group] != list(range(len(group))):
            return invalid("malformed_component_order")
        parent = self._resolve_name(self.objects, group[0]["table"])
        if parent is None:
            return invalid("missing_parent_table")
        fk["parent_table"] = parent
        if self.object(parent)["kind"] != "table":
            return invalid("parent_is_not_base_table")
        child_columns = [c["name"] for c in self.columns(db, fk["child_table"])]
        parent_columns = [c["name"] for c in self.columns(db, parent)]
        implicit = [r["to"] is None for r in group]
        parent_pk = self.pk(db, parent)
        if any(implicit) and (not all(implicit) or len(parent_pk) != len(group)):
            return invalid("implicit_parent_key_arity_mismatch")
        for i, r in enumerate(group):
            child = self._resolve_name(child_columns, r["from"])
            target = parent_pk[i] if all(implicit) else self._resolve_name(parent_columns, r["to"])
            fk["pairs"].append({"seq": i, "child_column": child, "parent_column": target,
                                "target_basis": "resolved_parent_pk" if all(implicit) else "recorded_target"})
        if any(p["child_column"] is None or p["parent_column"] is None for p in fk["pairs"]):
            return invalid("missing_constraint_column")
        targets = [p["parent_column"] for p in fk["pairs"]]
        if len(set(targets)) != len(targets):
            return invalid("duplicate_parent_target_column")
        collations = declared_collations(self.objects[parent]["sql"] or "", parent_columns)
        available = {identifier_fold(r[1]) for r in db.execute("PRAGMA collation_list")}
        if any(identifier_fold(collations[c]) not in available for c in targets):
            fk["validation"] = {"status": "unsupported", "reason": "parent_collation_unavailable"}
            return
        try:
            for column in targets:
                db.execute(f"EXPLAIN SELECT {quote(column)} = ? FROM {quote(parent)} NOT INDEXED", (None,)).fetchall()
        except sqlite3.OperationalError as failure:
            if "no such collation sequence" not in str(failure):
                raise
            fk["validation"] = {"status": "unsupported", "reason": "parent_collation_unavailable"}
            return
        indexes = list(db.execute(f"PRAGMA index_list({quote(parent)})"))
        if all(implicit):
            for index in indexes:
                if index["origin"] != "pk":
                    continue
                components = [r for r in db.execute(f"PRAGMA index_xinfo({quote(index['name'])})") if r["key"]]
                if any(r["name"] is None or
                       identifier_fold(r["coll"] or "BINARY") != identifier_fold(collations[r["name"]])
                       for r in components):
                    # SQLite's implicit PK path can use the PK index's
                    # COLLATE override even when explicit REFERENCES(cols)
                    # is a mismatch. A bare-column predicate is not proof
                    # for this domain; refuse instead of inventing a result.
                    fk["validation"] = {"status": "unsupported",
                                        "reason": "implicit_pk_collation_differs_from_column"}
                    return
        # INTEGER PRIMARY KEY rowid alias has no backing PK index. Named
        # columns only: implicit rowid is never selected or exposed as a key.
        metadata = {c["name"]: c for c in self.columns(db, parent)}
        eligible = (targets == parent_pk and len(targets) == 1 and
                    metadata[targets[0]]["declared_type"].upper() == "INTEGER" and
                    not any(r["origin"] == "pk" for r in indexes))
        for index in indexes:
            if not index["unique"] or index["partial"]:
                continue
            components = [r for r in db.execute(f"PRAGMA index_xinfo({quote(index['name'])})") if r["key"]]
            if (len(components) == len(targets) and all(r["name"] is not None for r in components)
                    and {r["name"] for r in components} == set(targets)
                    and all(identifier_fold(r["coll"] or "BINARY") == identifier_fold(collations[r["name"]])
                            for r in components)):
                eligible = True
        if not eligible:
            return invalid("parent_key_not_eligible_unique_constraint")
        fk["validation"] = {"status": "verified_declaration", "reason": None}

    def reference(self, db, handle, declaration_id, *, record=None, row=None):
        record = record if record is not None else self.record(db, handle)
        fk = next((f for f in self.declarations(db, record["name"])
                   if f["declaration_id"] == declaration_id), None)
        if fk is None:
            raise SourceError("source_fk_not_found", 404)
        values = {v["column"]: v for v in record["cells"]}
        # Decode from actual source values, not transport display strings.
        name, keys, _ = self.records[handle]
        row = row if row is not None else self._row(db, name, keys)
        raw_children = []
        for p in fk["recorded_pairs"]:
            column = self._resolve_name(row, p["from"])
            if column is not None:
                raw_children.append({"column": column, **values[column]})
        result = {"observation_id": observation_id(handle, declaration_id),
                  "child_record_id": handle, "declaration": fk,
                  "child_values": raw_children, "status": None, "reason": None,
                  "parent": None, "grounding": record["grounding"],
                  "comparison_basis": "sqlite_fk_parent_affinity_and_collation",
                  "historical_enforcement": "not_established"}
        # Nulls describe the observed tuple; invalid declaration metadata stays
        # independently visible even when the tuple requires no parent match.
        if any(v["storage_class"] == "null" for v in raw_children):
            result["status"] = "null_reference"
            return result
        status = fk["validation"]["status"]
        if status != "verified_declaration":
            result.update(status="invalid_declaration" if status == "invalid" else "unsupported",
                          reason=fk["validation"]["reason"])
            return result
        pairs, parent = fk["pairs"], fk["parent_table"]
        params = [row[p["child_column"]][0] for p in pairs]
        if any(row[p["child_column"]][1] == "blob" and v is None for p, v in zip(pairs, params)):
            result.update(status="budget_exceeded", reason="child_blob_matching_budget_exceeded")
            return result
        # Bound parameters have no column affinity. Each parent expression is
        # a bare column on the LEFT; SQLite applies its affinity/collation.
        where = " AND ".join(f"{quote(p['parent_column'])} = ?" for p in pairs)
        try:
            plan = list(db.execute(f"EXPLAIN QUERY PLAN SELECT 1 FROM {quote(parent)} WHERE {where} LIMIT 2", params))
            if not any("SEARCH" in r[3] for r in plan):
                result.update(status="budget_exceeded", reason="parent_indexed_lookup_required")
                return result
            matches = self._select(db, parent, where=where, params=params, limit=2)
            if not matches:
                result["status"] = "dangling"
                return result
            if len(matches) != 1:
                result.update(status="ambiguous", reason="multiple_parent_matches")
                return result
            identity = self.identity(db, parent, verify=True)
            encoded = self.encode_row(db, parent, matches[0], identity)
            result.update(status="resolved" if encoded["record_id"] else "resolved_unaddressable",
                          parent={"name": parent, "record_id": encoded["record_id"],
                                  "key": encoded["key"], "identity": identity,
                                  "target_values": [{"column": p["parent_column"], **scalar(matches[0][p["parent_column"]][0])}
                                                    for p in pairs]})
        except SourceError as failure:
            result.update(status="budget_exceeded" if "budget" in failure.code else "unsupported", reason=failure.code)
        except sqlite3.Error as failure:
            code = getattr(failure, "sqlite_errorcode", 0) & 0xff
            if code in {sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT,
                        sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_CANTOPEN}:
                raise
            result.update(status="budget_exceeded" if code == sqlite3.SQLITE_INTERRUPT else "unsupported",
                          reason="parent_query_budget_exceeded" if code == sqlite3.SQLITE_INTERRUPT else str(failure))
        return result

    def _row_locator(self, db, name):
        """Expressions that address one stored row of a base table, or None.

        rowid (under an alias no column shadows), or the declared key of a
        WITHOUT ROWID table, which SQLite keeps unique and non-NULL.
        """
        listed = next((r for r in db.execute("PRAGMA table_list") if r["schema"] == "main" and r["name"] == name), None)
        if listed is not None and listed["wr"]:
            return [quote(k) for k in self.pk(db, name)] or None
        taken = {identifier_fold(r["name"]) for r in db.execute(f"PRAGMA table_xinfo({quote(name)})")}
        return next(([alias] for alias in ("rowid", "_rowid_", "oid") if alias not in taken), None)

    def incoming_declarations(self, db, parent):
        """Every recorded declaration that names `parent`, whatever its validation."""
        found = []
        for name, obj in self.objects.items():
            if obj["kind"] == "table":
                found += [fk for fk in self.declarations(db, name) if fk["parent_table"] == parent]
        return found

    def _incoming_match(self, db, fk, parent_handle):
        """WHERE over the child table: rows whose FK resolves to this parent record.

        The parent row is pinned by its verified typed key. Each parent column is
        a bare column on the LEFT and the child column carries unary `+`, which
        removes its affinity; the left column's collation takes precedence. That
        is exactly the outgoing `parent_column = ?(child value)` comparison, so
        SQLite, not this adapter, decides affinity and collation. No child index
        is consulted: an indexed child equality can disagree with it (see the
        contract). A child FK BLOB beyond the cell limit is never matched
        outgoing, so it is not matched here either.
        """
        child, parent = fk["child_table"], fk["parent_table"]
        _, values, _ = self.records[parent_handle]
        alias = "ki_parent"
        while identifier_fold(alias) == identifier_fold(child):
            alias += "_"
        inner, params = [], []
        for k, v in zip(self.pk(db, parent), values):
            inner.append(f"{alias}.{quote(k)} = ? AND typeof({alias}.{quote(k)}) = ?")
            params.extend([v, storage(v)])
        cells = [f"{quote(child)}.{quote(p['child_column'])}" for p in fk["pairs"]]
        inner += [f"{alias}.{quote(p['parent_column'])} = +{c}" for p, c in zip(fk["pairs"], cells)]
        bounded = " AND ".join(f"NOT (typeof({c})='blob' AND length({c})>{MAX_CELL_BYTES})" for c in cells)
        return f"{bounded} AND EXISTS (SELECT 1 FROM {quote(parent)} AS {alias} WHERE {' AND '.join(inner)})", params

    def _incoming_unchecked(self, db, fk, parent):
        """Child rows that might match but that the outgoing read cannot check.

        Only FK BLOBs beyond the cell limit are excluded above. A BLOB equals
        only a BLOB of the same length, never an INTEGER, REAL or TEXT value, so
        such a row can match only a parent BLOB beyond the limit as well.
        """
        targets = {c["column"]: c for c in parent["cells"]}
        candidates = [(quote(p["child_column"]), targets[p["parent_column"]]["bytes"]) for p in fk["pairs"]
                      if targets[p["parent_column"]]["storage_class"] == "blob"
                      and targets[p["parent_column"]]["bytes"] > MAX_CELL_BYTES]
        if not candidates:
            return 0
        condition = " OR ".join(f"(typeof({c})='blob' AND length({c})=?)" for c, _ in candidates)
        return db.execute(f"SELECT count(*) FROM {quote(fk['child_table'])} WHERE {condition}",
                          [n for _, n in candidates]).fetchone()[0]

    def _incoming_count(self, db, fk, parent, page):
        status, reason = fk["validation"]["status"], fk["validation"]["reason"]
        if status == "invalid":
            return {"status": "invalid_declaration", "value": None, "reason": reason}
        if status != "verified_declaration":
            return {"status": "unavailable", "value": None, "reason": reason}
        # Its own ordinary budget, cut to what is left of the page's: one
        # exhausted declaration leaves the others countable while the page
        # lasts, and none is started once it is spent.
        seconds, steps = page["deadline"] - time.monotonic(), page["steps"]
        if seconds <= 0 or steps <= 0:
            return {"status": "not_checked", "value": None, "reason": "incoming_page_budget_exceeded"}
        usage = self.reset_budget(db, min(self.query_seconds, seconds), min(self.vm_steps, steps))
        page_limited = {"time": seconds < self.query_seconds, "steps": steps < self.vm_steps}
        try:
            if self._incoming_unchecked(db, fk, parent):
                return {"status": "unavailable", "value": None, "reason": "child_blob_matching_budget_exceeded"}
            where, params = self._incoming_match(db, fk, parent["record_id"])
            value = db.execute(f"SELECT count(*) FROM {quote(fk['child_table'])} WHERE {where}", params).fetchone()[0]
            return {"status": "exact", "value": value, "reason": None}
        except SourceError as failure:
            return {"status": "unavailable", "value": None, "reason": failure.code}
        except sqlite3.Error as failure:
            code = getattr(failure, "sqlite_errorcode", 0) & 0xff
            if code in {sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT,
                        sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_CANTOPEN}:
                raise
            if code != sqlite3.SQLITE_INTERRUPT:
                return {"status": "unavailable", "value": None, "reason": "unsupported_source_operation"}
            return {"status": "unavailable", "value": None,
                    "reason": "incoming_page_budget_exceeded" if page_limited.get(usage["stopped_by"])
                    else "source_query_budget_exceeded"}
        finally:
            page["steps"] -= usage["steps"]

    def references(self, db, handle, *, limit=50, offset=0, direction="outgoing"):
        if direction not in {"outgoing", "incoming"}:
            raise SourceError("invalid_parameter", detail="direction")
        record = self.record(db, handle)
        if direction == "incoming":
            # One group per declaration naming this record's table. A group is
            # the observations (child, k) that resolve here; it has no identity.
            fks = self.incoming_declarations(db, record["name"])
            selected = fks[offset:offset+limit]
            # The page's counts share one aggregate budget; see _incoming_count.
            page = {"deadline": time.monotonic() + self.incoming_page_seconds, "steps": self.incoming_page_steps}
            return {"record_id": handle, "direction": "incoming", "total": len(fks),
                    # The child table's identity as already known: read, never
                    # verified here, so a count never stands for placeability.
                    "groups": [{"declaration": f, "count": self._incoming_count(db, f, record, page),
                                "child_identity": self.identity(db, f["child_table"]) if f["child_table"] in self.objects else None}
                               for f in selected],
                    "comparison_basis": "sqlite_fk_parent_affinity_and_collation",
                    "offset": offset, "has_more": offset+limit < len(fks),
                    "next_offset": offset+limit if offset+limit < len(fks) else None}
        fks = self.declarations(db, record["name"])
        selected = fks[offset:offset+limit]
        name, keys, _ = self.records[handle]
        row = self._row(db, name, keys)
        return {"record_id": handle, "direction": "outgoing", "total": len(fks),
                "observations": [self.reference(db, handle, f["declaration_id"], record=record, row=row) for f in selected],
                "offset": offset, "has_more": offset+limit < len(fks),
                "next_offset": offset+limit if offset+limit < len(fks) else None}

    def catalogue(self, db, *, limit=50, offset=0, schema=False):
        names = list(self.objects)
        found = []
        for name in names[offset:offset+limit]:
            obj = self.objects[name]
            entry = {"name": name, "kind": obj["kind"], "identity": None,
                     "row_count": None, "row_count_status": "not_computed",
                     "read_status": "available", "reason": None}
            if schema and obj["kind"] == "view":
                entry.update(view_sql=obj["sql"], lineage="not_recorded")
            try:
                entry["identity"] = self.identity(db, name)
                if obj["kind"] == "view":
                    # Compile only, with the same authorizer used by rows.
                    # Metadata existence alone is not a row-read capability.
                    db.execute(f"EXPLAIN QUERY PLAN SELECT * FROM {quote(name)} LIMIT 0").fetchall()
                if schema:
                    entry.update(columns=self.columns(db, name),
                                 primary_key=self.pk(db, name),
                                 foreign_keys=self.declarations(db, name),
                                 view_sql=obj["sql"] if obj["kind"] == "view" else None,
                                 lineage="not_recorded" if obj["kind"] == "view" else None)
            except (SourceError, sqlite3.Error) as failure:
                if isinstance(failure, sqlite3.Error) and (getattr(failure, "sqlite_errorcode", 0) & 0xff) in {
                        sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB,
                        sqlite3.SQLITE_INTERRUPT}:
                    raise
                entry.update(read_status="unsupported", reason=str(failure),
                             identity={"status": "unsupported", "reason": str(failure),
                                       "key_columns": [], "verified_rows": None})
            found.append(entry)
        return {"relations": found, "total": len(names), "offset": offset,
                "has_more": offset+limit<len(names),
                "next_offset": offset+limit if offset+limit<len(names) else None,
                "counts": {"tables": sum(o["kind"] == "table" for o in self.objects.values()),
                           "views": sum(o["kind"] == "view" for o in self.objects.values()),
                           "unsupported_virtual_or_shadow": sum(o["kind"] in {"virtual", "shadow"} for o in self.objects.values())}}

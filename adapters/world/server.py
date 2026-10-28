"""Serve the World read plane from an external reader-owned declaration. Stdlib only.

The producer database is never modified. At startup this adapter copies it
once — through SQLite's online backup API from a read-only connection, WAL
content included — into a private immutable snapshot held in a server-owned
temporary directory, and serves only that snapshot: producer-nonmodifying,
privately snapshotted conceptual reading (KI-003; the contract, evidence, and
limits are in docs/SNAPSHOT_CONSISTENCY.md). One serving process therefore
presents exactly one validated database generation. Later producer commits,
WAL updates, file replacement, or deletion cannot leak into its responses;
a restart is the v0 reopen operation and the only way to read newer data.
The snapshot is a private internal serving artifact, not a new producer
dataset, and grounding still attributes rows to the producer's own tables,
views, and columns. Serving never falls back to the live producer file.

The conceptual layer — which sources carry entities, which
carry relation instances, and which columns play which participant roles —
comes from a JSON declaration supplied by the READER via --declaration, not
from tables embedded in the producer file. The producer file stays
independently queryable and byte-identical; the declaration is explicit
reader configuration, and serving it is not evidence that the reader's
interpretation is correct.

Declaration format (version 1, experimental — not a producer format or
ontology standard) reuses the minimum semantics of the ki_entity /
ki_relation / ki_role sketch, with roles nested under their relation:

    {"version": 1,
     "world": {"id_prefix": "knowledge", "description": "..."},
     "entities": [{"kind": ..., "source": ..., "key_columns": [...],
                   "label_column": ...}],
     "relations": [{"name": ..., "source": ..., "key_columns": [...],
                    "description": ..., "origin": ...|null,
                    "occurrence_state": ...|null,
                    "roles": [{"role": ..., "column_name": ...,
                               "target_kind": ...|null}]}]}

Only "version", each entity's kind/source/key_columns, each relation's
name/source/key_columns/roles, and each role's role/column_name are
required. Everything else is optional: "world" (world_id prefix, default
"sqlite"), "label_column" (default: first key column), "description",
"origin", "occurrence_state", and each role's "target_kind" (null means
the role is a scalar, not a referent). Unknown keys are refused, so a
typo fails loud at startup instead of silently changing the reading.
Entity kinds and relation names share one `namespace:key` identifier
space: a kind equal to a relation name, or either containing ':', is
refused, since the decoder splits on the first colon.

World identity is `<prefix>:<file-sha12>+<declaration-sha12>`: the
startup snapshot fingerprint stays independently identifiable, and the
declaration digest is taken over the canonical semantic declaration
(version, entities, relations — formatting normalized, role order kept).
Two readings of one file never share persisted frontend state, while a
mere reformatting or reader-note edit keeps it.

What this adapter refuses to do: serve without a declaration, read any
declaration from the producer file itself, mint identities without
verified keys, turn unmatched source rows into assertions, or present the
snapshot as evidence that the reader's interpretation is correct — it
guarantees consistent source bytes and a validated interpretation within
the session, not epistemic authority or semantic completeness. Without a declared demand
model there is no demand: /world/demand answers {"demand": null} and the
overview carries demand null — absence, never a fabricated empty purpose.

On origins and states: "origin" and "occurrence_state" are reader-authored
claims, optional per relation. An undeclared occurrence_state is omitted
from the API and readers show nothing. An undeclared origin has no honest
string, but the World contract requires the scalar "origin" field, so the
adapter sends the reserved placeholder "UNSTATED" there (documented here
as claiming nothing) and leaves "origins" empty. "UNSTATED" can never be
declared. Likewise the legacy "assertion_state" field always carries
"UNKNOWN", and every assertion carries a minimally filled warrant whose
empty bases mean "none recorded" — mandated shapes, documented as
placeholders, never as adoption, provenance, or authority.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import tempfile
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, quote, unquote, urlparse

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

# Scalar preview per relation on a referent read; the relations[] counts
# already answer the full cost, so fields stay a bounded sample.
FIELDS_PER_RELATION = 100


class BadRequest(Exception):
    """400: the request names something this backend has no record of."""


class NotFound(Exception):
    """404: no such read in this contract."""


def _host_of(authority: str) -> str:
    host = authority.strip().lower()
    if host.startswith("["):
        host = host[1:].split("]", 1)[0]
    else:
        host = host.split(":", 1)[0]
    return host.rstrip(".")


def request_allowed(headers) -> bool:
    """True only for callers that arrived as loopback.

    Same rule as the structural adapter: binding to 127.0.0.1 does not stop
    a rebinding browser, so the requested Host is checked, and a present
    Origin must be loopback too. Plain callers send no Origin; the local
    Vite proxy forwards a loopback Origin with a rewritten loopback Host.
    """
    if _host_of(headers.get("Host", "")) not in LOOPBACK_HOSTS:
        return False
    origin = headers.get("Origin", "")
    if not origin:
        return True
    parsed = urlparse(origin)
    if parsed.scheme not in ("http", "https"):
        return False
    return _host_of(parsed.netloc.rsplit("@", 1)[-1]) in LOOPBACK_HOSTS


def quote_ident(name: str) -> str:
    """Quote one SQLite identifier. Callers validate against the schema first."""
    return '"' + name.replace('"', '""') + '"'


def json_value(value: object) -> object:
    if isinstance(value, bytes):
        digest = hashlib.sha256(value).hexdigest()[:14]
        return f"[BLOB {len(value)} bytes; sha256={digest}]"
    return value


def label_out(value: object) -> str | None:
    """Display text only; never a conversion of the source identity.

    Preserve text and NULL; numbers become text and BLOBs use the existing
    size/digest preview rather than pretending their bytes are an identifier.
    """
    return None if value is None else str(json_value(value))


# Re-export the historical helpers; capture ownership is independent of Model.
# The root bootstrap preserves direct `python adapters/world/server.py` usage.
import sys
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from adapters.capture import (  # noqa: E402
    Capture, SnapshotUnavailable, SNAPSHOT_DEADLINE_S,
    file_sha256, connect, connect_snapshot, acquire_snapshot,
    _snapshot_directory, _remove_snapshot,
)


class PreparedWorld:
    """One validated snapshot reading: Model, identity, and temp artifacts."""

    def __init__(
        self,
        *,
        model: "Model",
        world_id: str,
        fingerprint: str,
        snapshot_path: Path,
        directory: Path,
        timings: dict[str, float],
        capture: Capture | None = None, release=None,
        owns_capture: bool = True,
    ) -> None:
        self.model = model
        self.world_id = world_id
        self.fingerprint = fingerprint
        self.snapshot_path = snapshot_path
        self.directory = directory
        self.timings = timings
        self._cleaned = False
        self.capture, self._release = capture, release
        self._owns_capture = owns_capture

    def cleanup(self) -> None:
        if not self._cleaned:
            self._cleaned = True
            if self._release is not None:
                self._release.__exit__(None, None, None)
            if self.capture is not None:
                if self._owns_capture:
                    self.capture.retire()
            else:
                _remove_snapshot(self.directory, self.snapshot_path)


def prepare_world(
    db_path: Path, declaration: dict, *, deadline_s: float = SNAPSHOT_DEADLINE_S,
    declaration_source: Literal["external_file"] | None = None,
) -> PreparedWorld:
    """Snapshot first, then validate: the Model describes served bytes.

    Identity is derived from the completed snapshot plus the declaration,
    so identical content restarts to the same World and any content change
    reopens under a different one. On any failure the private directory is
    removed before the error propagates; no live fallback exists.
    """
    if declaration_source not in (None, "external_file"):
        raise ValueError("unsupported declaration source")
    capture = Capture.acquire(db_path, deadline_s=deadline_s,
                              prefix="knowledge-inspector-world-")
    try:
        return prepare_world_from_capture(capture, declaration,
                                          declaration_source=declaration_source,
                                          owns_capture=True)
    except BaseException:
        capture.retire()
        raise


def prepare_world_from_capture(
    capture: Capture, declaration: dict, *,
    declaration_source: Literal["external_file"] | None = None,
    owns_capture: bool = False,
) -> PreparedWorld:
    """Validate a reading of existing captured bytes; never acquire again.

    The returned reading holds a consumer reference until cleanup. By default
    the caller still owns the capture and controls retirement. Serving code
    must use capture leases to respect retirement, rather than a global model.
    Existing CLI/prepare_world retain their ownership and public World IDs.
    """
    if declaration_source not in (None, "external_file"):
        raise ValueError("unsupported declaration source")
    hold = capture.consumer()
    hold.__enter__()
    try:
        started = time.monotonic()
        with capture.lease() as db:
            model = Model(db, declaration)
            if declaration_source == "external_file":
                model.reading = external_reading(db, model, declaration)
        validation_s = time.monotonic() - started
        timings = {**capture.timings, "validation_s": validation_s,
                   "total_s": capture.timings["total_s"] + validation_s}
        return PreparedWorld(
            model=model,
            world_id=build_world_id(declaration["world"]["id_prefix"], capture.digest, declaration),
            fingerprint=capture.digest, snapshot_path=capture.snapshot_path,
            directory=capture.directory, timings=timings, capture=capture,
            release=hold, owns_capture=owns_capture,
        )
    except BaseException:
        hold.__exit__(*sys.exc_info())
        raise


def split_columns(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


def coerce(column_type: str, text: str) -> object:
    kind = (column_type or "").upper()
    if "INT" in kind:
        return int(text)
    if any(tag in kind for tag in ("REAL", "FLOAT", "DOUBLE")):
        return float(text)
    return text


# Placeholder for the contract-mandated scalar "origin" when the reader
# declared no construction origin. Documented as claiming nothing; it can
# never be declared (validation refuses it), so its presence always means
# "unstated", never a recorded value.
UNSTATED_ORIGIN = "UNSTATED"

DECLARATION_VERSION = 1


def _refuse_unknown(where: str, mapping: dict, known: frozenset[str]) -> None:
    for key in mapping:
        if key not in known:
            raise ValueError(f"declaration {where}: unknown key {key!r}")


def _require_text(where: str, mapping: dict, key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"declaration {where}: {key!r} must be a non-empty string")
    return value


def _optional_text(where: str, mapping: dict, key: str) -> str | None:
    if key not in mapping or mapping[key] is None:
        return None
    value = mapping[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"declaration {where}: {key!r} must be a non-empty string or null")
    if value.strip() == UNSTATED_ORIGIN:
        raise ValueError(f"declaration {where}: {key!r} must not be the reserved {UNSTATED_ORIGIN!r}")
    return value


def _require_columns(where: str, mapping: dict) -> list[str]:
    raw = mapping.get("key_columns")
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"declaration {where}: 'key_columns' must be a non-empty list")
    columns = []
    for entry in raw:
        if not isinstance(entry, str) or not entry.strip():
            raise ValueError(f"declaration {where}: 'key_columns' entries must be non-empty strings")
        columns.append(entry)
    if len(set(columns)) != len(columns):
        raise ValueError(f"declaration {where}: 'key_columns' lists {columns[0]!r} twice")
    return columns


def _check_namespaces(kinds: list[str], names: list[str]) -> None:
    """Entity kinds and relation names share one `namespace:key` identifier.

    A kind equal to a relation name would mint ambiguous ids, and a colon
    inside either would confuse the decoder, which splits on the first one.
    """
    for kind in kinds:
        if ":" in kind:
            raise ValueError(f"declaration: entity kind {kind!r} must not contain ':'")
    for name in names:
        if ":" in name:
            raise ValueError(f"declaration: relation name {name!r} must not contain ':'")
    for kind in kinds:
        if kind in names:
            raise ValueError(
                f"declaration: entity kind {kind!r} collides with a relation name"
            )


def declaration_fingerprint(declaration: dict) -> str:
    """SHA-256 over the canonical semantic declaration.

    Object keys are sorted and whitespace is normalized, so equivalent
    JSON formatting yields the same digest; array order is preserved
    because role order is meaningful. Only the semantic subset is hashed —
    version, entities, relations — so a changed reader note (`world.*`)
    keeps the World's identity while any entity, relation, role, origin,
    or occurrence-state change moves it.
    """
    semantic = {
        "version": declaration.get("version", DECLARATION_VERSION),
        "entities": declaration.get("entities", []),
        "relations": declaration.get("relations", []),
    }
    canonical = json.dumps(semantic, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_world_id(prefix: str, file_fingerprint: str, declaration: dict) -> str:
    """A World identity stable per (snapshot bytes, declaration meaning).

    `<prefix>:<file-sha12>+<declaration-sha12>`: the snapshot fingerprint
    stays independently identifiable as the segment after the colon, and
    the declaration digest keeps two readings of one snapshot from sharing
    persisted frontend state. The file half names the private snapshot
    acquired at startup (KI-003): repeated backups of an unchanged source
    are measured byte-identical on this SQLite version (including across
    WAL checkpointing), so unchanged restarts reproduce the identity and
    any content change reopens under a different one — without claiming
    every logically identical database must yield identical backup bytes
    under every physical reorganization; a differing backup would simply
    mint a fresh identity (saved state misses, the safe direction). It no
    longer names producer-file bytes — backup output is a logically equal
    but physically distinct file, so pre-snapshot World IDs are not
    preserved (see docs/SNAPSHOT_CONSISTENCY.md for the measured break).
    """
    return f"{prefix}:{file_fingerprint[:12]}+{declaration_fingerprint(declaration)[:12]}"


def validate_declaration(raw: object) -> dict:
    """Check an external declaration's shape; the Model checks it against the file.

    Strict on purpose: unknown keys fail loud, so a misspelled key never
    silently narrows the reading. Raises ValueError describing the problem.
    """
    if not isinstance(raw, dict):
        raise ValueError("declaration must be a JSON object")
    _refuse_unknown("top level", raw, frozenset({"version", "world", "entities", "relations"}))
    if raw.get("version") != DECLARATION_VERSION:
        raise ValueError(f"declaration 'version' must be {DECLARATION_VERSION}")
    world = raw.get("world") or {}
    if not isinstance(world, dict):
        raise ValueError("declaration 'world' must be an object")
    _refuse_unknown("world", world, frozenset({"id_prefix", "description"}))
    id_prefix = world.get("id_prefix", "sqlite")
    if not isinstance(id_prefix, str) or not id_prefix.strip():
        raise ValueError("declaration world 'id_prefix' must be a non-empty string")
    description = world.get("description")
    if description is not None and not isinstance(description, str):
        raise ValueError("declaration world 'description' must be a string")
    entities = raw.get("entities", [])
    relations = raw.get("relations")
    if not isinstance(entities, list):
        raise ValueError("declaration 'entities' must be a list")
    if not isinstance(relations, list) or not relations:
        raise ValueError("declaration 'relations' must be a non-empty list")
    kinds: set[str] = set()
    for index, entry in enumerate(entities):
        where = f"entities[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"declaration {where} must be an object")
        _refuse_unknown(where, entry, frozenset({"kind", "source", "key_columns", "label_column"}))
        kind = _require_text(where, entry, "kind")
        if kind in kinds:
            raise ValueError(f"declaration {where}: duplicate kind {kind!r}")
        kinds.add(kind)
        _require_text(where, entry, "source")
        _require_columns(where, entry)
        label = entry.get("label_column")
        if label is not None and (not isinstance(label, str) or not label.strip()):
            raise ValueError(f"declaration {where}: 'label_column' must be a non-empty string")
    names: set[str] = set()
    for index, entry in enumerate(relations):
        where = f"relations[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"declaration {where} must be an object")
        _refuse_unknown(
            where,
            entry,
            frozenset({"name", "source", "key_columns", "description", "origin",
                       "occurrence_state", "roles"}),
        )
        name = _require_text(where, entry, "name")
        if name in names:
            raise ValueError(f"declaration {where}: duplicate name {name!r}")
        names.add(name)
        _require_text(where, entry, "source")
        _require_columns(where, entry)
        entry_description = entry.get("description")
        if entry_description is not None and not isinstance(entry_description, str):
            raise ValueError(f"declaration {where}: 'description' must be a string")
        _optional_text(where, entry, "origin")
        _optional_text(where, entry, "occurrence_state")
        roles = entry.get("roles")
        if not isinstance(roles, list) or not roles:
            raise ValueError(f"declaration {where}: 'roles' must be a non-empty list")
        seen: set[str] = set()
        for position, role in enumerate(roles):
            spot = f"{where} roles[{position}]"
            if not isinstance(role, dict):
                raise ValueError(f"declaration {spot} must be an object")
            _refuse_unknown(spot, role, frozenset({"role", "column_name", "target_kind"}))
            role_name = _require_text(spot, role, "role")
            if role_name in seen:
                raise ValueError(f"declaration {spot}: duplicate role {role_name!r}")
            seen.add(role_name)
            _require_text(spot, role, "column_name")
            target = role.get("target_kind")
            if target is not None and (not isinstance(target, str) or not target.strip()):
                raise ValueError(f"declaration {spot}: 'target_kind' must be a string or null")
    _check_namespaces(sorted(kinds), sorted(names))
    return {
        "version": DECLARATION_VERSION,
        "world": {"id_prefix": id_prefix, "description": description},
        "entities": entities,
        "relations": relations,
    }


def load_declaration(path: Path) -> dict:
    """Read and shape-check an external declaration file. Raises ValueError."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError(f"no conceptual declaration: {path} does not exist")
    except json.JSONDecodeError as failure:
        raise ValueError(f"no conceptual declaration: {path} is not valid JSON ({failure})")
    try:
        return validate_declaration(raw)
    except ValueError as failure:
        raise ValueError(f"{path}: {failure}")


class Model:
    """The declared interpretation, loaded and verified once at startup."""

    def __init__(self, db: sqlite3.Connection, declaration: dict) -> None:
        if not isinstance(declaration, dict):
            raise ValueError("no conceptual declaration: a reader declaration is required")
        # A declaration-shaped dictionary alone establishes no ownership channel.
        self.reading: dict | None = None
        entities = declaration.get("entities", [])
        relations = declaration.get("relations")
        if not isinstance(relations, list) or not relations:
            raise ValueError("no conceptual declaration: 'relations' must be a non-empty list")
        if not isinstance(entities, list):
            raise ValueError("no conceptual declaration: 'entities' must be a list")
        _check_namespaces(
            [entry["kind"] for entry in entities if isinstance(entry, dict) and "kind" in entry],
            [entry["name"] for entry in relations if isinstance(entry, dict) and "name" in entry],
        )
        tables = {
            row["name"]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        }
        self.entities: dict[str, dict] = {}
        for entry in sorted(entities, key=lambda item: item["kind"]):
            self.entities[entry["kind"]] = self._entity(db, tables, dict(entry))
        self.relations: dict[str, dict] = {}
        for entry in sorted(relations, key=lambda item: item["name"]):
            self.relations[entry["name"]] = self._relation(db, tables, dict(entry))

    @staticmethod
    def _columns(db: sqlite3.Connection, source: str) -> dict[str, str]:
        return {
            row["name"]: row["type"] or ""
            # table_xinfo, not table_info: generated columns (hidden
            # 2/3) are nameable source columns, while hidden virtual-
            # table implementation columns (hidden 1) are not.
            for row in db.execute(f"PRAGMA table_xinfo({quote_ident(source)})")
            if row["hidden"] != 1
        }

    def _check_keys(
        self, db: sqlite3.Connection, source: str, keys: list[str], what: str
    ) -> dict[str, list[object]]:
        if not keys:
            raise ValueError(f"{what} declares no key columns")
        context = f"{what} (source {source!r}, key columns {keys!r})"
        nulls = " OR ".join(f"{quote_ident(column)} IS NULL" for column in keys)
        if db.execute(f"SELECT 1 FROM {quote_ident(source)} WHERE {nulls} LIMIT 1").fetchone():
            raise ValueError(f"{context} has null key components: identity refused")
        fields = ", ".join(quote_ident(column) for column in keys)
        total = db.execute(f"SELECT COUNT(*) FROM {quote_ident(source)}").fetchone()[0]
        unique = db.execute(
            f"SELECT COUNT(*) FROM (SELECT {fields} FROM {quote_ident(source)} GROUP BY {fields})"
        ).fetchone()[0]
        if total != unique:
            raise ValueError(f"{context} has duplicate keys: identity refused")

        # SQLite uniqueness alone is insufficient: str(1) == str('1'), even
        # when SQLite distinguishes their storage classes. Check components
        # as well as complete IDs so a second composite component cannot hide
        # an ambiguous first one. Keep the existing codec, not a typed-ID map.
        entry = {"source": source, "keys": keys, "columns": self._columns(db, source)}
        components: list[dict[str, tuple]] = [{} for _ in keys]
        identities: dict[str, list[object]] = {}
        for row in db.execute(f"SELECT {fields} FROM {quote_ident(source)}"):
            values = list(row)
            for column, value in zip(keys, values):
                if not isinstance(value, (str, int, float)) or (
                    isinstance(value, float) and not math.isfinite(value)
                ):
                    raise ValueError(
                        f"{context}: unsupported identity component {column!r}"
                        f" ({type(value).__name__}); TEXT, INTEGER or finite REAL required"
                    )
            identifier = encode_id("key", values)
            for column, value, encoded, seen in zip(
                keys, values, identifier.partition(":")[2].split("/"), components
            ):
                signature = (type(value), value)
                if encoded in seen and seen[encoded] != signature:
                    raise ValueError(
                        f"{context}: encoded identifier collision in component {column!r}"
                    )
                seen[encoded] = signature
            if identifier in identities:
                raise ValueError(f"{context}: encoded identifier collision")
            identities[identifier] = values

        # Use the actual decoder and SQLite equality/affinity, then compare
        # returned storage classes and values with the original key. Reject a
        # second match; never resolve identity by choosing an arbitrary row.
        _check_identity_lookups(db, entry, list(identities.values()), context, match_keys=True)
        return identities

    def _entity(self, db: sqlite3.Connection, tables: set[str], entry: dict) -> dict:
        kind, source = entry["kind"], entry["source"]
        if not isinstance(source, str) or source not in tables or source.startswith("sqlite_"):
            raise ValueError(f"entity {kind}: unknown source {source!r}")
        columns = self._columns(db, source)
        keys = entry.get("key_columns")
        if not isinstance(keys, list) or not keys:
            raise ValueError(f"entity {kind} declares no key columns")
        for column in keys:
            if column not in columns:
                raise ValueError(f"entity {kind}: missing key column {column!r}")
        # The reader either named a label column or did not; when it did not,
        # the first key column stands in. Remember which, so the reading
        # descriptor never presents the adapter's default as a declaration.
        declared_label = entry.get("label_column")
        label_declared = isinstance(declared_label, str) and bool(declared_label)
        label = declared_label if label_declared else keys[0]
        if label not in columns:
            raise ValueError(f"entity {kind}: missing label column {label!r}")
        identifiers = self._check_keys(db, source, keys, f"entity {kind}")
        return {
            "kind": kind, "source": source, "keys": keys, "label": label,
            "label_declared": label_declared, "columns": columns,
            "canonical_ids": {
                kind + ":" + identifier.partition(":")[2]: _key_signature(values)
                for identifier, values in identifiers.items()
            },
        }

    def _relation(self, db: sqlite3.Connection, tables: set[str], entry: dict) -> dict:
        name, source = entry["name"], entry["source"]
        if not isinstance(source, str) or source not in tables or source.startswith("sqlite_"):
            raise ValueError(f"relation {name}: unknown source {source!r}")
        columns = self._columns(db, source)
        keys = entry.get("key_columns")
        if not isinstance(keys, list) or not keys:
            raise ValueError(f"relation {name} declares no key columns")
        for column in keys:
            if column not in columns:
                raise ValueError(f"relation {name}: missing key column {column!r}")
        # Declaration order is the presentation order: the JSON array keeps
        # the roles exactly as the reader listed them.
        roles = entry.get("roles")
        if not isinstance(roles, list) or not roles:
            raise ValueError(f"relation {name} declares no roles")
        # The one normalization boundary for optional role targets:
        # omitted and explicit-null both become a present null here, so
        # every read path can rely on the key. This touches only the
        # Model's copies — the declaration (and its fingerprint) keeps
        # exactly the shape the reader supplied.
        roles = [{**role, "target_kind": role.get("target_kind")} for role in roles]
        for role in roles:
            if role.get("column_name") not in columns:
                raise ValueError(f"relation {name}: missing role column {role.get('column_name')!r}")
            if role.get("target_kind") is not None and role.get("target_kind") not in self.entities:
                raise ValueError(f"relation {name}: unknown target kind {role.get('target_kind')!r}")
        origin = entry.get("origin")
        if origin is not None and (not isinstance(origin, str) or not origin.strip()):
            raise ValueError(f"relation {name}: 'origin' must be a non-empty string or null")
        if origin == UNSTATED_ORIGIN:
            raise ValueError(f"relation {name}: 'origin' must not be the reserved {UNSTATED_ORIGIN!r}")
        occurrence = entry.get("occurrence_state")
        if occurrence is not None and (not isinstance(occurrence, str) or not occurrence.strip()):
            raise ValueError(f"relation {name}: 'occurrence_state' must be a non-empty string or null")
        if occurrence == UNSTATED_ORIGIN:
            raise ValueError(
                f"relation {name}: 'occurrence_state' must not be the reserved {UNSTATED_ORIGIN!r}"
            )
        self._check_keys(db, source, keys, f"relation {name}")
        references = self._check_roles(db, name, source, roles)
        return {
            "name": name,
            "source": source,
            "keys": keys,
            "origin": origin,
            "occurrence_state": occurrence,
            "description": entry.get("description"),
            "roles": [dict(role) for role in roles],
            "columns": columns,
            "references": references,
        }

    def _check_roles(
        self, db: sqlite3.Connection, name: str, source: str, roles: list[dict]
    ) -> dict[str, dict[tuple, str]]:
        references = {}
        for role in roles:
            if role["target_kind"] is None:
                continue
            target = self.entities[role["target_kind"]]
            if len(target["keys"]) != 1:
                raise ValueError(
                    f"relation {name}: role {role['role']} targets composite keys,"
                    " which this slice does not map"
                )
            column = role["column_name"]
            if db.execute(
                f"SELECT 1 FROM {quote_ident(source)} WHERE {quote_ident(column)} IS NULL LIMIT 1"
            ).fetchone():
                raise ValueError(
                    f"relation {name}: role {role['role']} has null participants:"
                    " tuples must be complete to be assertions"
                )
            context = (
                f"relation {name} (source {source!r}, role {role['role']!r},"
                f" column {column!r}, target {role['target_kind']!r},"
                f" target source {target['source']!r}, key columns {target['keys']!r})"
            )
            references[role["role"]] = _resolve_references(db, source, column, target, context)
        return references

    # No per-model coverage rule here: interpretation completeness ("every
    # source record is asserted or obligated") is an expedition-specific
    # check that lives in the expedition example, not in the generic
    # adapter. A generic world serves exactly what the declaration names.


def encode_id(head: str, values: list[object]) -> str:
    return head + ":" + "/".join(quote(str(value), safe="") for value in values)


def decode_id(identifier: str, pool: dict[str, dict], kind: str) -> tuple[dict, list[object]]:
    head, sep, rest = identifier.partition(":")
    if not sep or head not in pool:
        raise NotFound(f"no {kind} {identifier!r} in this world")
    entry = pool[head]
    try:
        parts = [coerce(entry["columns"][column], unquote(text)) for column, text in zip(entry["keys"], rest.split("/"))]
    except (ValueError, KeyError):
        raise NotFound(f"no {kind} {identifier!r} in this world")
    if len(parts) != len(entry["keys"]) or len(rest.split("/")) != len(entry["keys"]):
        raise NotFound(f"no {kind} {identifier!r} in this world")
    return entry, parts


def _key_signature(values) -> tuple:
    """SQLite storage class matters: Python's 1 == 1.0 is not identity."""
    return tuple((type(value), value) for value in values)


def _reference_query(source: str, column: str, target: dict, *, reverse: bool = False) -> tuple[str, str]:
    """Keep BOTH bare column operands, unlike decoder/parameter probes.

    A window ordinal distinguishes repeated occurrence participants from a
    second target match. Noncompound SELECTs preserve the bare columns'
    affinity and collation. The plan guard excludes compound/recursive
    sources and requires indexed target searches before this query runs.
    """
    token = uuid.uuid4().hex
    probes, targets = [quote_ident(f"_ki_{name}_{token}") for name in ("roles", "targets")]
    alias = f"_ki_match_{token}"
    key = quote_ident(target["keys"][0])
    sql = (
        f"WITH {probes} AS MATERIALIZED (SELECT row_number() OVER () AS n,"
        f" {quote_ident(column)} AS v FROM {quote_ident(source)}),"
        f" {targets} AS MATERIALIZED (SELECT {key} AS k FROM {quote_ident(target['source'])})"
    )
    if reverse:
        # Some affinities cannot index the target side (TEXT target, INTEGER
        # participant). Keep target = participant operand order, but search
        # the participant index instead. CROSS JOIN fixes the scan direction.
        sql += (f" SELECT {alias}.n,{alias}.v,t.k FROM {targets} AS t"
                f" CROSS JOIN {probes} AS {alias} ON t.k = {alias}.v")
    else:
        sql += (f" SELECT p.n,p.v,{alias}.k FROM {probes} AS p"
                f" LEFT JOIN {targets} AS {alias} ON {alias}.k = p.v")
    return sql, alias


def _resolve_references(
    db: sqlite3.Connection, source: str, column: str, target: dict, context: str,
) -> dict[tuple, str]:
    """Verified, startup-scoped typed participant -> canonical directory ID.

    SQL chooses the target; Python keys only cache that verified decision.
    No producer writes, per-value SQL lookup, or participant decoder occurs.
    """
    sql, alias = _reference_query(source, column, target)
    reverse = False
    try:
        indexed = _require_lookup_plan(db, sql, (), target, context, alias, source)
    except ValueError as failure:
        if "cannot plan indexed identity validation" not in str(failure):
            raise
        sql, alias = _reference_query(source, column, target, reverse=True)
        indexed = _require_lookup_plan(db, sql, (), target, context, alias, source)
        reverse = True
    total = db.execute(f"SELECT COUNT(*) FROM {quote_ident(source)}").fetchone()[0] if reverse else None
    if not indexed:
        # Exhaustive original column predicate, only <=64 rows on each side.
        # Select the complete source row to distinguish repeated participants.
        # Its validated occurrence key makes that typed tuple unique. Neither
        # side is materialized/redeclared, including bounded compound views.
        key = quote_ident(target["keys"][0])
        columns = list(Model._columns(db, source))
        raw_index = columns.index(column)
        fields = ",".join(f"s.{quote_ident(c)}" for c in columns)
        sql = (
            f"SELECT {fields},t.{key} FROM {quote_ident(source)} AS s"
            f" LEFT JOIN {quote_ident(target['source'])} AS t"
            f" ON t.{key} = s.{quote_ident(column)}"
        )
    references = {}
    seen = set()
    cursor = None
    try:
        cursor = db.execute(sql)
        for row in cursor:
            if indexed:
                ordinal, raw, key_value = row
                matches = 0 if key_value is None else 2 if ordinal in seen else 1
                seen.add(ordinal)
            else:
                values, key_value = tuple(row)[:-1], row[-1]
                ordinal = _key_signature(values)
                raw = values[raw_index]
                matches = 0 if key_value is None else 2 if ordinal in seen else 1
                seen.add(ordinal)
            if matches != 1:
                reason = "dangling participant" if matches == 0 else "ambiguous participant"
                raise ValueError(f"{context}: {reason}; reference must match exactly one target record")
            identifier = encode_id(target["kind"], [key_value])
            if target["canonical_ids"].get(identifier) != _key_signature([key_value]):
                raise ValueError(f"{context}: resolved target is not a verified canonical identity")
            signature = _key_signature([raw])
            if signature in references and references[signature] != identifier:
                raise ValueError(f"{context}: participant has inconsistent target identity")
            references[signature] = identifier
        if reverse and len(seen) != total:
            raise ValueError(f"{context}: dangling participant; reference must match exactly one target record")
    except sqlite3.Error as failure:
        raise ValueError(f"{context}: SQLite cannot resolve references: {failure}; identity refused") from failure
    finally:
        if cursor is not None:
            cursor.close()
    return references


def _count_dangling(db: sqlite3.Connection, source: str, column: str, target: dict, name: str) -> int:
    # Non-null target keys were already verified. A LEFT JOIN counts exactly
    # the rows for which the old NOT EXISTS predicate had no match. Keep both
    # operands as source columns: their affinities matter to this comparison.
    token = uuid.uuid4().hex
    rows = quote_ident(f"_ki_target_{token}")
    alias = f"_ki_match_{token}"
    key = quote_ident(target["keys"][0])
    sql = (
        f"WITH {rows} AS MATERIALIZED (SELECT {key} FROM {quote_ident(target['source'])})"
        f" SELECT COUNT(*) FROM {quote_ident(source)} AS s"
        f" LEFT JOIN {rows} AS {alias} ON {alias}.{key} = s.{quote_ident(column)}"
        f" WHERE {alias}.{key} IS NULL"
    )
    if not _require_lookup_plan(db, sql, (), target, f"relation {name}", alias, source):
        return db.execute(
            f"SELECT COUNT(*) FROM {quote_ident(source)} AS s"
            f" WHERE NOT EXISTS (SELECT 1 FROM {quote_ident(target['source'])} AS t"
            f" WHERE t.{key} = s.{quote_ident(column)})"
        ).fetchone()[0]
    return db.execute(sql).fetchone()[0]


def _require_lookup_plan(
    db: sqlite3.Connection, sql: str, parameters: tuple, entry: dict,
    context: str, alias: str, probe_source: str | None = None,
) -> bool:
    try:
        plan = db.execute("EXPLAIN QUERY PLAN " + sql, parameters).fetchall()
    except sqlite3.Error as failure:
        raise ValueError(f"{context}: SQLite cannot plan identity validation: {failure}; identity refused") from failure
    # Compound SELECT affinity can depend on the chosen query plan, and
    # materialization may change both comparison and returned storage types.
    # Do not infer equivalence from a successful automatic-index search.
    compound = any(
        row[3] == "COMPOUND QUERY"
        or row[3].startswith(("MERGE (", "UNION", "INTERSECT", "EXCEPT"))
        for row in plan
    )
    # The verifier itself contributes one recursive sequence. Additional
    # recursive steps belong to source SELECTs and have the same uncertain
    # compound-affinity domain; dangling validation contributes none.
    compound = compound or sum(row[3] == "RECURSIVE STEP" for row in plan) > (
        1 if probe_source is None else 0
    )
    if not compound and any(row[3].startswith(f"SEARCH {alias} USING") for row in plan):
        return True
    # A bounded fallback checks every record; it never samples or bypasses
    # validation. Do not accidentally turn automatic_index=OFF into O(N²).
    total = db.execute(f"SELECT COUNT(*) FROM {quote_ident(entry['source'])}").fetchone()[0]
    probes = parameters[0] if probe_source is None else db.execute(
        f"SELECT COUNT(*) FROM {quote_ident(probe_source)}"
    ).fetchone()[0]
    if total <= 64 and probes <= 64:
        return False
    reason = "compound SELECT identity semantics require bounded verification" if compound else "SQLite cannot plan indexed identity validation"
    raise ValueError(f"{context}: {reason}; identity refused")


def _check_identity_lookups(
    db: sqlite3.Connection, entry: dict, values: list[list[object]],
    context: str, *, match_keys: bool = False,
) -> None:
    """One read-only indexed SQL join, with the original decoder/comparison.

    Probe values come from a private scalar function, preserving exactly the
    SQLite bound-value types (including NUL text). The function has no SQL
    affinity; unary + also explicitly removes probe affinity. Source columns
    keep their affinity/collation through the materialized SELECT, unlike a
    Python equality map or a copied/redeclared temporary table.
    """
    if not values:
        return
    decoded = []
    try:
        for value in values:
            _, parts = decode_id(encode_id("key", value), {"key": entry}, "identity")
            # sqlite3 binds signed 64-bit integers; callback return values must
            # have the same bound-value domain as the original parameter path.
            if any(isinstance(part, int) and not -(2**63) <= part < 2**63 for part in parts):
                raise OverflowError
            decoded.append(parts)
    except (NotFound, ValueError, OverflowError) as failure:
        raise ValueError(f"{context}: identifier cannot round-trip through the current decoder") from failure
    token = uuid.uuid4().hex
    function = f"_ki_probe_{token}"
    alias = f"_ki_match_{token}"
    sequence, probes, source = [quote_ident(f"_ki_{name}_{token}") for name in ("seq", "probes", "source")]
    fields = ", ".join(f"{quote_ident(key)} AS k{i}" for i, key in enumerate(entry["keys"]))
    probe_fields = ", ".join(f"{function}(n,{i}) AS v{i}" for i in range(len(entry["keys"])))
    output = ", ".join(f"{alias}.k{i}" for i in range(len(entry["keys"])))
    where = " AND ".join(f"{alias}.k{i} = +p.v{i}" for i in range(len(entry["keys"])))
    sql = (
        f"WITH RECURSIVE {sequence}(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM {sequence} WHERE n+1<?),"
        f" {probes} AS MATERIALIZED (SELECT n,{probe_fields} FROM {sequence}),"
        f" {source} AS MATERIALIZED (SELECT {fields} FROM {quote_ident(entry['source'])})"
        f" SELECT p.n,{output} FROM {probes} AS p LEFT JOIN {source} AS {alias} ON {where}"
    )
    db.create_function(function, 2, lambda row, column: decoded[row][column])
    cursor = None
    try:
        if not _require_lookup_plan(db, sql, (len(values),), entry, context, alias):
            for value in values:
                found = _check_identity_lookup(db, entry, value, context)
                if match_keys and _key_signature(found) != _key_signature(value):
                    raise ValueError(f"{context}: identifier does not round-trip to its source key")
            return
        seen = set()
        cursor = db.execute(sql, (len(values),))
        # Stream results; at the second match refuse immediately. No GROUP BY
        # or result-wide sort can materialize an enormous ambiguous join first.
        for row in cursor:
            ordinal, found = row[0], tuple(row)[1:]
            if found[0] is None or ordinal in seen:
                raise ValueError(f"{context}: identifier must round-trip to exactly one source record")
            seen.add(ordinal)
            if match_keys and _key_signature(found) != _key_signature(values[ordinal]):
                raise ValueError(f"{context}: identifier does not round-trip to its source key")
        if len(seen) != len(values):
            raise ValueError(f"{context}: identifier must round-trip to exactly one source record")
    except sqlite3.Error as failure:
        raise ValueError(f"{context}: SQLite cannot verify identity round-trips: {failure}; identity refused") from failure
    finally:
        if cursor is not None:
            cursor.close()
        db.create_function(function, 2, None)


def _check_identity_lookup(
    db: sqlite3.Connection, entry: dict, values: list[object], context: str
) -> sqlite3.Row:
    """Prove startup codec addressability without changing keys or IDs."""
    try:
        _, decoded = decode_id(encode_id("key", values), {"key": entry}, "identity")
        fields = ", ".join(quote_ident(column) for column in entry["keys"])
        where = " AND ".join(f"{quote_ident(column)} = ?" for column in entry["keys"])
        found = db.execute(
            f"SELECT {fields} FROM {quote_ident(entry['source'])} WHERE {where} LIMIT 2",
            decoded,
        ).fetchall()
    except (NotFound, ValueError, OverflowError) as failure:
        raise ValueError(f"{context}: identifier cannot round-trip through the current decoder") from failure
    if len(found) != 1:
        raise ValueError(
            f"{context}: identifier must round-trip to exactly one source record"
            f" (resolved {len(found)})"
        )
    return found[0]


def fetch_row(db: sqlite3.Connection, entry: dict, keys: list[object]) -> sqlite3.Row:
    where = " AND ".join(f"{quote_ident(column)} = ?" for column in entry["keys"])
    row = db.execute(
        f"SELECT * FROM {quote_ident(entry['source'])} WHERE {where} LIMIT 1", keys
    ).fetchone()
    if row is None:
        raise NotFound("row not in this world")
    return row


def sqlite_affinity(declared_type: str) -> str:
    """The type affinity SQLite itself assigns to a declared column type.

    SQLite's published rules, applied in its order (datatype3.html §3.1).
    This is a property of the *column declaration*: it says how SQLite tries
    to coerce values stored there, not what a given row holds. A NUMERIC
    column can store INTEGER, REAL, TEXT or BLOB; a DATETIME column is
    NUMERIC affinity and holds whatever was inserted, usually text.
    """
    kind = (declared_type or "").upper()
    if "INT" in kind:
        return "INTEGER"
    if any(tag in kind for tag in ("CHAR", "CLOB", "TEXT")):
        return "TEXT"
    if "BLOB" in kind or not kind:
        return "BLOB"
    if any(tag in kind for tag in ("REAL", "FLOA", "DOUB")):
        return "REAL"
    return "NUMERIC"


def storage_class(value: object) -> str:
    """The SQLite storage class a Python value read from a row came from."""
    return {str: "text", int: "integer", float: "real", bytes: "blob", type(None): "null"}[type(value)]


def role_out(role: dict, columns: dict[str, str]) -> dict:
    if role["target_kind"] is not None:
        return {
            "name": role["role"],
            "type": "REFERENT",
            "column": role["column_name"],
            "referent": True,
            "kinds": [role["target_kind"]],
        }
    declared = columns.get(role["column_name"], "") or ""
    # `type` is the column's SQLite affinity, never a claim about row values:
    # `declared_type` is the declaration as written (empty when none), and the
    # per-row storage class is in the assertion's source grounding.
    return {
        "name": role["role"],
        "type": sqlite_affinity(declared),
        "type_basis": "sqlite_affinity",
        "declared_type": declared,
        "column": role["column_name"],
        "referent": False,
    }


def values_out(model: Model, relation: dict, row: sqlite3.Row) -> dict:
    values: dict[str, object] = {}
    for role in relation["roles"]:
        raw = row[role["column_name"]]
        if role["target_kind"] is not None:
            try:
                values[role["role"]] = relation["references"][role["role"]][_key_signature([raw])]
            except KeyError:
                raise BadRequest("reference was not validated at startup; reopen the stable source")
        else:
            values[role["role"]] = json_value(raw)
    return values


def tuple_out(model: Model, relation: dict, row: sqlite3.Row) -> dict:
    keys = [row[column] for column in relation["keys"]]
    found: dict[str, object] = {
        "assertion_id": encode_id(relation["name"], keys),
        # The scalar is contract-mandated, so an undeclared origin is the
        # documented UNSTATED placeholder; "origins" is omitted then, and
        # readers fall back to the placeholder instead of inventing a layer.
        "origin": relation["origin"] if relation["origin"] is not None else UNSTATED_ORIGIN,
        "values": values_out(model, relation, row),
    }
    if relation["origin"] is not None:
        found["origins"] = [relation["origin"]]
    # The declaration's recorded occurrence state, carried at the same
    # granularity the assertion read already serves it. Undeclared means
    # the key is absent — never a substitute value.
    if relation["occurrence_state"] is not None:
        found["occurrence_state"] = relation["occurrence_state"]
    return found


def view_sql(db: sqlite3.Connection, source: str) -> str | None:
    row = db.execute(
        "SELECT type, sql FROM sqlite_master WHERE name = ?", (source,)
    ).fetchone()
    if row is None or row["type"] != "view":
        return None
    return row["sql"]


def grounding_out(db: sqlite3.Connection, source: str, keys: list[str], row: sqlite3.Row) -> list[dict]:
    keyed = ", ".join(f"{column}={row[column]}" for column in keys)
    sql = view_sql(db, source)
    if sql is None:
        location = f"row {keyed} in {source}"
        detail: dict[str, object] = {"source": source, "key": {column: row[column] for column in keys}}
    else:
        # A view computes its rows; citing one as a stored row would invent
        # lineage. The definition is what's recorded, so that's what's cited.
        location = f"output of view {source} for {keyed} — defined, not stored"
        detail = {
            "source": source,
            "key": {column: row[column] for column in keys},
            "derivation_definition": sql,
            "lineage": "not recorded",
        }
    return [{
        "kind": "SOURCE",
        "reference": f"{source}:{keyed}",
        "native_handle": "SQLite",
        "native_location": location,
        "detail": detail,
    }]


def external_reading(db: sqlite3.Connection, model: Model, declaration: dict) -> dict:
    """Filtered attribution, only when the caller knows the input was external.

    Structural checks establish addressability, not author identity or meaning.
    No path is exposed; the digest uses the actual, unmodified declaration.
    """
    def source(name: str) -> dict:
        kind = db.execute("SELECT type FROM sqlite_master WHERE name = ?", (name,)).fetchone()[0]
        return {"name": name, "kind": kind}

    return {
        "interpretation_source": "external_reader_declaration",
        "declaration_digest": declaration_fingerprint(declaration),
        "reader_note": declaration.get("world", {}).get("description"),
        "adapter": "generic_sqlite_v1",
        "entities": [
            {"kind": ent["kind"], "source": source(ent["source"]),
             "key_columns": ent["keys"], "label_column": ent["label"],
             # "declared": the reader named this column. "adapter_default":
             # the declaration named none and the first key column stands in.
             "label_column_source": "declared" if ent["label_declared"] else "adapter_default"}
            for ent in model.entities.values()
        ],
        "relations": [
            {"name": rel["name"], "source": source(rel["source"]),
             "key_columns": rel["keys"], "description": rel["description"],
             "roles": [{"name": role["role"], "column": role["column_name"],
                        "target_kind": role["target_kind"]} for role in rel["roles"]],
             "origin": rel["origin"], "occurrence_state": rel["occurrence_state"]}
            for rel in model.relations.values()
        ],
    }


def mentions(model: Model, relation: dict, values: dict, referent: str) -> bool:
    names = {role["role"] for role in relation["roles"] if role["target_kind"] is not None}
    return any(values.get(name) == referent for name in names)


def extension(db: sqlite3.Connection, model: Model, relation: dict) -> list[dict]:
    order = ", ".join(quote_ident(column) for column in relation["keys"])
    return [
        tuple_out(model, relation, row)
        for row in db.execute(f"SELECT * FROM {quote_ident(relation['source'])} ORDER BY {order}")
    ]


def sort_key(value: object) -> tuple:
    if value is None:
        return (2, "")
    if isinstance(value, bool):
        return (1, str(value))
    if isinstance(value, (int, float)):
        return (0, value)
    return (1, str(value))


def relation_out(db: sqlite3.Connection, relation: dict) -> dict:
    roles = [role_out(role, relation["columns"]) for role in relation["roles"]]
    count = db.execute(f"SELECT COUNT(*) FROM {quote_ident(relation['source'])}").fetchone()[0]
    return {
        "name": relation["name"],
        "description": relation["description"],
        "mode": "BASE",
        "arity": len(roles),
        "referent_arity": sum(1 for role in roles if role["referent"]),
        "roles": roles,
        "count": count,
        "stale": False,
        # No declared origin means no origins: an empty list, never a
        # fabricated default. Readers render that as the mechanical layer.
        "origins": [relation["origin"]] if relation["origin"] is not None else [],
        "scope": None,
        "completeness": None,
    }


def overview(db: sqlite3.Connection, model: Model, world_id: str) -> dict:
    counts = {
        name: db.execute(f"SELECT COUNT(*) FROM {quote_ident(rel['source'])}").fetchone()[0]
        for name, rel in model.relations.items()
    }
    referents = sum(
        db.execute(f"SELECT COUNT(*) FROM {quote_ident(ent['source'])}").fetchone()[0]
        for ent in model.entities.values()
    )
    # Only declared origins are counted: undeclared ones stay unstated
    # rather than inflating a placeholder bucket.
    origins: dict[str, int] = {}
    for name, count in counts.items():
        origin = model.relations[name]["origin"]
        if origin is not None:
            origins[origin] = origins.get(origin, 0) + count
    return {
        "world_id": world_id,
        "revision": 1,
        **({"reading": model.reading} if model.reading is not None else {}),
        "relations": len(model.relations),
        "referents": referents,
        "assertions": sum(counts.values()),
        "origins": origins,
        "stale": [],
        "incomplete": [],
        # No demand model is declared in this format, so there is no
        # demand: null absence, not an empty purpose.
        "demand": None,
        # No governance model is supplied by this adapter: the nullable
        # field says so, rather than advertising a synthetic zero-count
        # collection. The obligations reads still answer empty.
        "governed_obligations": None,
    }


def schema(db: sqlite3.Connection, model: Model) -> dict:
    return {"relations": [relation_out(db, rel) for rel in model.relations.values()]}


def referents(db: sqlite3.Connection, model: Model) -> dict:
    found = []
    for entity in model.entities.values():
        order = ", ".join(quote_ident(column) for column in entity["keys"])
        for row in db.execute(f"SELECT * FROM {quote_ident(entity['source'])} ORDER BY {order}"):
            keys = [row[column] for column in entity["keys"]]
            found.append({
                "id": encode_id(entity["kind"], keys),
                "label": label_out(row[entity["label"]]),
            })
    return {"referents": found, "total": len(found), "truncated": False}


def labels(db: sqlite3.Connection, model: Model, ids: str | list[str]) -> dict:
    # Strings retain the legacy comma-list helper contract. A framed list
    # contains whole opaque IDs: never split or normalize its identifiers.
    identifiers = ids.split(",") if isinstance(ids, str) else ids
    out = {}
    for identifier in identifiers:
        if not identifier:
            continue
        try:
            entity, keys = canonical_referent(model, identifier)
            out[identifier] = label_out(fetch_row(db, entity, keys)[entity["label"]])
        except NotFound:
            out[identifier] = None
    return {"labels": out}


def search(db: sqlite3.Connection, model: Model, query: str, limit: int) -> dict:
    needle = query.strip().lower()
    if not needle:
        return {"results": []}
    results = []
    for item in referents(db, model)["referents"]:
        if needle in item["id"].lower() or needle in str(item["label"] or "").lower():
            # Source namespace is optional detail, separate from result category.
            results.append({"kind": "referent", "entity_kind": item["id"].split(":", 1)[0], **item})
        if len(results) >= limit:
            break
    return {"results": results}


def canonical_referent(model: Model, identifier: str) -> tuple[dict, list[object]]:
    entity, keys = decode_id(identifier, model.entities, "referent")
    if identifier not in entity["canonical_ids"]:
        raise NotFound(f"no canonical referent {identifier!r}; use an ID from /world/referents")
    return entity, keys


def referent(db: sqlite3.Connection, model: Model, identifier: str) -> dict:
    entity, keys = canonical_referent(model, identifier)
    row = fetch_row(db, entity, keys)
    fields: list[dict] = []
    relations = []
    for relation in model.relations.values():
        items = [item for item in extension(db, model, relation) if mentions(model, relation, item["values"], identifier)]
        relations.append({
            "name": relation["name"],
            "arity": len(relation["roles"]),
            "mode": "BASE",
            "stale": False,
            "count": len(items),
        })
        roles = [role_out(role, relation["columns"]) for role in relation["roles"]]
        scalars = {role["name"] for role in roles if not role["referent"]}
        referent_roles = [role["name"] for role in roles if role["referent"]]
        for item in items[:FIELDS_PER_RELATION]:
            # The roles of this occurrence that this referent fills, in
            # declared order. Several are possible (a self-relation), and
            # none of them makes the referent the owner of the occurrence's
            # scalars: the values belong to the occurrence, `assertion_id`.
            participates = [name for name in referent_roles if item["values"][name] == identifier]
            for name in sorted(scalars):
                field: dict[str, object] = {
                    "relation": relation["name"],
                    "role": name,
                    "value": item["values"][name],
                    "assertion_id": item["assertion_id"],
                    "referent_roles": participates,
                    "origin": item["origin"],
                }
                if "origins" in item:
                    field["origins"] = item["origins"]
                if "occurrence_state" in item:
                    field["occurrence_state"] = item["occurrence_state"]
                fields.append(field)
    return {
        "id": identifier,
        "label": label_out(row[entity["label"]]),
        "grounding": grounding_out(db, entity["source"], entity["keys"], row),
        "fields": fields,
        "relations": relations,
    }


def expand(db: sqlite3.Connection, model: Model, identifier: str, relation: str, limit: int) -> dict:
    if relation not in model.relations:
        raise BadRequest(f"no relation {relation!r} in this world")
    canonical_referent(model, identifier)
    rel = model.relations[relation]
    found = [
        item for item in extension(db, model, rel)
        if mentions(model, rel, item["values"], identifier)
    ][:limit]
    return {
        "relation": relation,
        "arity": len(rel["roles"]),
        "roles": [role_out(role, rel["columns"]) for role in rel["roles"]],
        "tuples": found,
    }


ROWS_DEFAULT_LIMIT = 200
ROWS_MAX_LIMIT = 1000


def _page_parameter(query: dict[str, list[str]], name: str, default: int) -> int:
    """One pagination parameter: absent or empty keeps the default; a
    present value must be a plain integer or the request is refused."""
    raw = query.get(name, [None])[0]
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise BadRequest(f"{name} must be an integer") from None


def rows(db: sqlite3.Connection, model: Model, query: dict[str, list[str]]) -> dict:
    name = query.get("relation", [""])[0]
    if name not in model.relations:
        raise BadRequest(f"no relation {name!r} in this world")
    limit = _page_parameter(query, "limit", ROWS_DEFAULT_LIMIT)
    offset = _page_parameter(query, "offset", 0)
    if limit < 1:
        raise BadRequest("limit must be a positive integer")
    if offset < 0:
        raise BadRequest("offset must not be negative")
    limit = min(limit, ROWS_MAX_LIMIT)
    relation = model.relations[name]
    items = extension(db, model, relation)
    subject = (query.get("subject", [""])[0] or "").strip()
    if subject:
        canonical_referent(model, subject)
        items = [item for item in items if mentions(model, relation, item["values"], subject)]
    needle = (query.get("search", [""])[0] or "").strip().lower()
    if needle:
        items = [item for item in items if needle in json.dumps(item["values"]).lower()]
    order = (query.get("order", [""])[0] or "").strip()
    if order:
        names = [role["role"] for role in relation["roles"]]
        if order not in names:
            raise BadRequest(f"no role {order!r} on {name!r}")
        items = sorted(items, key=lambda item: sort_key(item["values"][order]))
        if query.get("desc", [""])[0].lower() in ("1", "true", "yes"):
            items = list(reversed(items))
    return {
        "relation": name,
        "mode": "BASE",
        "stale": False,
        "total": len(items),
        "offset": offset,
        "roles": [role_out(role, relation["columns"]) for role in relation["roles"]],
        "rows": items[offset:offset + limit],
    }


def assertion(db: sqlite3.Connection, model: Model, identifier: str) -> dict:
    relation, keys = decode_id(identifier, model.relations, "assertion")
    row = fetch_row(db, relation, keys)
    item = tuple_out(model, relation, row)
    roles = [role_out(role, relation["columns"]) for role in relation["roles"]]
    grounding = grounding_out(db, relation["source"], relation["keys"], row)
    # Source-attributed disclosure, separate from canonical projected values.
    # For a view these are output values, not invented stored-row lineage.
    grounding[0]["detail"]["reference_participants"] = {
        role["role"]: {
            "column": role["column_name"],
            "value": json_value(row[role["column_name"]]),
            "storage_class": storage_class(row[role["column_name"]]),
        }
        for role in relation["roles"] if role["target_kind"] is not None
    }
    # The runtime storage class of each scalar's source column in this row,
    # beside (not instead of) the column's declared type and affinity in the
    # role metadata. Keyed by source column, not by the reader's role name:
    # grounding describes the source and must not change with the reading.
    # The projected value is unchanged; a BLOB's value stays its size/digest
    # preview.
    grounding[0]["detail"]["scalar_storage"] = {
        role["column_name"]: storage_class(row[role["column_name"]])
        for role in relation["roles"] if role["target_kind"] is None
    }
    found: dict[str, object] = {
        **item,
        "relation": relation["name"],
        "mode": "BASE",
        "arity": len(roles),
        "roles": roles,
        # Legacy compatibility token only: this adapter records no legacy
        # assertion-state, so it sends UNKNOWN rather than a word that
        # would imply an adoption decision it never made.
        "assertion_state": "UNKNOWN",
        "created_revision": 1,
        "relation_stale": False,
        "completeness": None,
        "grounding": grounding,
        # Mandated shape, minimally filled: ids echo the assertion, origins
        # echo the relation (or the UNSTATED placeholder), and no evidential
        # bases are invented — an empty list means none recorded.
        "warrant": {
            "commitment_id": identifier,
            "relation": relation["name"],
            "assertion_origin": (
                relation["origin"] if relation["origin"] is not None else UNSTATED_ORIGIN
            ),
            "recorded_construction_origin": (
                relation["origin"] if relation["origin"] is not None else UNSTATED_ORIGIN
            ),
            "construction_origins": [relation["origin"]] if relation["origin"] is not None else [],
            "created_revision": 1,
            "bases": [],
        },
        "commitment_id": identifier,
        "candidate_for": [],
        "governing_obligations": [],
        "candidate_assessments": [],
    }
    if relation["occurrence_state"] is not None:
        found["occurrence_state"] = relation["occurrence_state"]
    return found


def derivation(db: sqlite3.Connection, model: Model, name: str) -> dict:
    if name not in model.relations:
        raise BadRequest(f"no relation {name!r} in this world")
    relation = model.relations[name]
    count = db.execute(f"SELECT COUNT(*) FROM {quote_ident(relation['source'])}").fetchone()[0]
    return {
        "relation": name,
        "mode": "BASE",
        "rests_on": {item: [] for item in model.relations},
        "supports": {item: [] for item in model.relations},
        "nodes": {
            item: {
                "name": item,
                "mode": "BASE",
                "arity": len(rel["roles"]),
                "count": db.execute(
                    f"SELECT COUNT(*) FROM {quote_ident(rel['source'])}"
                ).fetchone()[0],
                "stale": False,
                "state": None,
            }
            for item, rel in model.relations.items()
        },
        "run": None,
    }


def support(db: sqlite3.Connection, model: Model, identifier: str) -> dict:
    found = assertion(db, model, identifier)
    names = {
        role["role"]
        for role in model.relations[found["relation"]]["roles"]
        if role["target_kind"] is not None
    }
    return {
        "assertion_id": identifier,
        "relation": found["relation"],
        "derived": False,
        "referents": sorted(found["values"][name] for name in names),
        "inputs": [],
    }


# No demand builder here: the declaration format carries no demand model,
# and this adapter invents none. Example-specific demand (such as the
# expedition's herbarium frontier) lives in the example's own extension.


def route(
    path: str, query: dict[str, list[str]], db: sqlite3.Connection, model: Model, world_id: str
) -> tuple[int, object]:
    if path == "/world/overview":
        return 200, overview(db, model, world_id)
    if path == "/world/schema":
        return 200, schema(db, model)
    if path == "/world/referents":
        return 200, referents(db, model)
    if path == "/world/labels":
        if "id" in query and "ids" in query:
            raise BadRequest("use repeated 'id' parameters or legacy 'ids', not both")
        # parse_qs has already decoded URL framing. Only the legacy ids form
        # is comma-delimited; each repeated id is a complete opaque string.
        return 200, labels(db, model, query["id"] if "id" in query else query.get("ids", [""])[0])
    if path == "/world/search":
        try:
            limit = int(query.get("limit", ["10"])[0] or 10)
        except ValueError:
            raise BadRequest("limit must be an integer")
        return 200, search(db, model, query.get("q", [""])[0], max(1, min(limit, 100)))
    if path == "/world/referent":
        identifier = query.get("id", [""])[0]
        if not identifier:
            raise BadRequest("id is required")
        return 200, referent(db, model, identifier)
    if path == "/world/expand":
        identifier, relation = query.get("id", [""])[0], query.get("relation", [""])[0]
        if not identifier or not relation:
            raise BadRequest("id and relation are required")
        try:
            limit = int(query.get("limit", ["200"])[0] or 200)
        except ValueError:
            raise BadRequest("limit must be an integer")
        return 200, expand(db, model, identifier, relation, max(1, min(limit, 2000)))
    if path == "/world/rows":
        return 200, rows(db, model, query)
    if path == "/world/assertion":
        identifier = query.get("id", [""])[0]
        if not identifier:
            raise BadRequest("id is required")
        return 200, assertion(db, model, identifier)
    if path == "/world/derivation":
        name = query.get("relation", [""])[0]
        if not name:
            raise BadRequest("relation is required")
        return 200, derivation(db, model, name)
    if path == "/world/support":
        identifier = query.get("id", [""])[0]
        if not identifier:
            raise BadRequest("id is required")
        return 200, support(db, model, identifier)
    if path == "/world/demand":
        return 200, {"demand": None}
    if path == "/world/obligations":
        return 200, {"contract": None, "governance": None, "obligations": []}
    if path == "/world/obligation":
        return 200, None
    raise NotFound(f"no read {path!r} in this contract")


# Primary SQLite result codes (sqlite_errorcode & 0xFF) that mean the
# private snapshot file itself failed: I/O error reading it, corrupt disk
# image, cannot open, or not a database. Ordinary query failures carry
# SQLITE_ERROR (no such column/table, invalid SQL) and are application or
# programming defects — never reclassified as snapshot loss. Classification
# uses the structured error code only, never message text.
_SNAPSHOT_STORAGE_PRIMARY_CODES = frozenset(
    {
        sqlite3.SQLITE_IOERR,
        sqlite3.SQLITE_CORRUPT,
        sqlite3.SQLITE_CANTOPEN,
        sqlite3.SQLITE_NOTADB,
    }
)


def _is_snapshot_storage_error(failure: BaseException) -> bool:
    """True only for structured storage failures of the snapshot file."""
    if not isinstance(failure, sqlite3.Error):
        return False
    code = getattr(failure, "sqlite_errorcode", None)
    return code is not None and (code & 0xFF) in _SNAPSHOT_STORAGE_PRIMARY_CODES


class Handler(BaseHTTPRequestHandler):
    server_version = "SQLiteWorld/1.0"
    db_path: Path = Path("missing.sqlite")
    fingerprint: str = ""
    model: Model | None = None
    world_id: str = ""
    # Snapshot serving (set by main): requests open the private snapshot
    # through db_connect; only genuine snapshot storage failures map to
    # 503 (see _is_snapshot_storage_error). Extensions that configure the
    # Handler directly keep the historical live behavior.
    snapshot_mode: bool = False
    db_connect = staticmethod(connect)
    # Example extensions (such as the expedition's demand read) override
    # this to serve their own reads; the loopback gate and cleanup stay.
    route_fn = staticmethod(route)

    def log_message(self, *args: object) -> None:
        pass

    def _send(self, status: int, payload: object) -> None:
        # No CORS headers, deliberately, and a loopback-only gate below: an
        # untrusted page must not read the user's database through this plane.
        body = json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if not request_allowed(self.headers):
            self._send(403, {"error": "refused: this adapter serves loopback callers only"})
            return
        assert self.model is not None
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        # Explicit close: a sqlite3 connection's context manager commits but
        # does not release the handle. Each request opens its own connection
        # to the same snapshot; no connection is shared across threads.
        db: sqlite3.Connection | None = None
        try:
            db = self.db_connect(self.db_path)
            try:
                status, payload = self.route_fn(parsed.path, query, db, self.model, self.world_id)
            except BadRequest as failure:
                status, payload = 400, {"error": str(failure)}
            except NotFound as failure:
                status, payload = 404, {"error": str(failure)}
        except (sqlite3.Error, OSError) as failure:
            # 503 is reserved for the private snapshot itself failing: the
            # serving store could not be opened at all (db is None — file
            # missing or inaccessible), or SQLite reports a storage-level
            # failure of that file by structured error code (cannot open,
            # not a database, corrupt image, I/O error), including
            # failures that surface on the first read after a successful
            # open. Fail closed: never re-read the producer, never
            # recreate a snapshot under this World, never serve partial
            # data. Ordinary SQL and programming errors keep raising —
            # they are never misreported as world_snapshot_lost.
            if self.snapshot_mode and (
                db is None or _is_snapshot_storage_error(failure)
            ):
                status, payload = 503, {"error": "world_snapshot_lost"}
            else:
                raise
        finally:
            if db is not None:
                db.close()
        self._send(status, payload)

    def _reject_write(self) -> None:
        self._send(405, {"error": "this plane is read-only"})

    do_POST = _reject_write
    do_PUT = _reject_write
    do_PATCH = _reject_write
    do_DELETE = _reject_write


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True, help="existing producer database file; snapshotted read-only at startup, never modified")
    parser.add_argument(
        "--declaration",
        type=Path,
        required=True,
        help="reader-owned JSON declaration (version 1); never read from the database",
    )
    parser.add_argument("--port", type=int, default=8139)
    args = parser.parse_args()
    if not args.db.is_file():
        raise SystemExit(f"no database file: {args.db}")
    try:
        declaration = load_declaration(args.declaration)
    except ValueError as failure:
        raise SystemExit(f"cannot serve {args.db}: {failure}")
    try:
        prepared = prepare_world(args.db, declaration, declaration_source="external_file")
    except (SnapshotUnavailable, ValueError, OSError) as failure:
        raise SystemExit(f"cannot serve {args.db}: {failure}")
    Handler.db_path = prepared.snapshot_path
    Handler.fingerprint = prepared.fingerprint
    Handler.model = prepared.model
    Handler.world_id = prepared.world_id
    Handler.snapshot_mode = True
    Handler.db_connect = staticmethod(connect_snapshot)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except BaseException:
        prepared.cleanup()
        raise
    print(
        f"sqlite world: http://127.0.0.1:{args.port}/ ({args.db} + {args.declaration})",
        flush=True,
    )
    timings = prepared.timings
    print(
        "snapshot: backup={backup_s:.3f}s fingerprint={fingerprint_s:.3f}s "
        "validation={validation_s:.3f}s total={total_s:.3f}s".format(**timings),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # Normal shutdown removes this process's private artifacts. After
        # an abnormal termination the server-owned temp directory (named
        # knowledge-inspector-world-*) may remain for the operator to
        # remove; no process ever deletes another's snapshot directory.
        prepared.cleanup()


if __name__ == "__main__":
    main()

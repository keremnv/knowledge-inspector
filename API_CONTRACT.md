# Read-plane API contract

The Knowledge Inspector is a read-only UI. A compatible backend serves JSON
over HTTP on the same origin (in development, Vite proxies `/world/*` to
`VITE_WORLD_TARGET`, default `http://127.0.0.1:8139`). There are no writes:
no route to write to, and the UI issues only `GET` requests.

The executable shape reference is `src/api/world.ts`. Where this document
and that file disagree, that file wins.

## Auth

- Requests carry `Authorization: Bearer <token>` when a token is available.
- The token is read from the URL: the query of `#/world?apiToken=...`, or
  the page query `?apiToken=...`.
- Dev builds default to `devtoken` on localhost hostnames only; nothing is
  ever invented for non-local origins.

## Errors

Failures return an object with an `error` string. The UI maps status codes
to user-facing notices: 401 refresh-the-link, 403 access denied, 404 gone,
429 back off, 5xx retry-or-check-terminal. A non-JSON body is still a
failure worth reporting.

One 503 is contractual: the generic conceptual adapter serves a private
startup snapshot (KI-003); if that snapshot becomes unavailable it answers
every `/world/*` read with `503 {"error": "world_snapshot_lost"}`. It never
falls back to the live producer file, never recreates a snapshot under the
same World identity, and never substitutes an empty World.

## Conventions

- Collections paginate with `limit` / `offset` and report `total`.
- Identifiers are opaque strings; labels are human-readable or null.
- `origin` is a scalar compatibility summary; `origins` carries every
  support-path origin. Prefer `origins` where present. The generic SQLite
  world sends `origin: "UNSTATED"` (with `origins` omitted or empty) when
  the reader declared no construction origin — a documented placeholder
  that claims nothing, never a recorded value.
- A missing completeness receipt is `null`, distinct from a recorded
  `UNKNOWN` status.

The generic SQLite adapter projects reference roles using the verified
target's canonical directory ID. `/world/referent`, `/world/expand` and
`/world/rows?subject=` require an exact ID from `/world/referents`; a
noncanonical alias returns 404 with an explicit canonical-ID diagnostic.
`/world/labels` returns null for such an alias. This policy does not change
the identifier codec or impose alias behavior on other backends.
Assertion SOURCE grounding additionally discloses original participant
values and SQLite storage classes in `detail.reference_participants`.
See the generic reference contract.

## Endpoints

- `GET /world/overview` — snapshot identity and counts: `world_id`,
  `revision`, optional `contract` / `governance` / authority identities,
  `relations` / `referents` / `assertions` counts, `origins` histogram,
  `stale[]`, `incomplete[]`, `demand` (`purpose.statement`, `obligations`,
  `demanded`) or null, `governed_obligations` counts or null.
- `GET /world/schema` — `{ relations[] }`. Each relation: `name`,
  `description|null`, `mode` (`BASE` | `DERIVED`), `arity`,
  `referent_arity`, `roles[]` (`name`, `type`, `type_basis?`, `declared_type?`,
  `column?`, `referent`, `kinds?`), `count`, `stale`, `origins[]`, `scope`
  (`WORLD` | `PURPOSE` | null), `completeness|null`
  (`status`, `universe`, `current`, `known_gaps`), optional `derivation`
  (`state?`, `inputs[]`).
  For a scalar role the generic SQLite adapter sets `type_basis:
  "sqlite_affinity"`: `type` is the column's SQLite type affinity (`INTEGER`,
  `REAL`, `TEXT`, `NUMERIC`, `BLOB`, by SQLite's own rules) and
  `declared_type` is the column type as declared (`NUMERIC(10,2)`; `""` when
  none). Neither says what a given row holds: a NUMERIC column can store an
  INTEGER, REAL, TEXT or BLOB, and `DATETIME` is only a declaration (affinity
  NUMERIC), usually holding text. No temporal or decimal type is ever
  reported, and values are never converted. The per-row storage class is in
  the assertion's source grounding (`detail.scalar_storage`, keyed by source
  column). Without `type_basis`, `type` keeps the producer's own meaning.
- `GET /world/referents` — the entity directory:
  `{ referents[{id, label|null}], total, truncated }`. When `truncated` is
  true the UI must ask the plane instead of filtering locally.
- `GET /world/labels?ids=a,b` — `{ labels: { id: label|null } }`. A lookup
  for ids the directory did not carry, not a search. The generic adapter
  retains this legacy comma-list form for IDs without raw commas. It also
  accepts separately URL-encoded repeated parameters, `?id=a&id=b`, where
  each decoded `id` is one complete opaque identifier, including namespace
  commas. Do not combine `id` and `ids` (400). Legacy `ids` splits after URL
  decoding, so encoding a namespace comma does not disambiguate that form.
  The frontend keeps legacy `ids` for comma-free batches and uses repeated
  `id` for the whole batch if any ID contains a raw comma. Key components
  already escaped by the identifier codec remain opaque; apply ordinary
  URL transport encoding once to the complete ID, without decoding it first.
  Requested IDs retain spelling and order; unknown or noncanonical IDs map
  to null under their complete original keys. No identity is normalized.
- `GET /world/search?q=&limit=` — `{ results[{kind, id, label|null}] }`.
  `kind` is the result category: referent candidates use `"referent"`, not
  the source entity namespace. The generic adapter preserves IDs and labels
  and supplies that category, with the source namespace as optional
  `entity_kind` detail. Existing producers using `"referent"` remain
  compatible; the finder continues to exclude other result categories.
  Substring candidates are not a claim about which was meant.
- `GET /world/referent?id=` — one entity: `id`, `label`, `grounding[]`,
  `fields[]` (`relation`, `role`, `value`, `assertion_id`, `origin`,
  `origins?`, `occurrence_state?`), `relations[]` (`name`, `arity`, `mode`, `stale`, `count`).
  The per-relation counts answer "what would this expansion cost" before it
  is drawn. A relation with `count: 0` is a count of zero matching occurrences
  *in this reading*, not a statement that none could exist; the reader lists
  it as such and offers no expansion for it.

  **`fields[]` are occurrences' scalars, not referent properties.** Each entry
  belongs to the occurrence named by its `assertion_id` and carries that
  occurrence's relation, named role, recorded value (including null, zero and
  empty string), `origin`/`origins` and supplied `occurrence_state`. An
  occurrence can mention several referents and still has one identity; its
  scalar values are not attributes of any of them, and no ownership is
  inferred from a relation's or role's name. Optional `referent_roles[]`
  names the role(s) of that occurrence this referent fills, in declared order
  (more than one for a self-relation). Absent means the producer did not say:
  never derive it from an id. Referent-level data is only `id`, `label` and
  `grounding[]` (the referent's own source row).

  The generic adapter samples up to 100 occurrences per relation; one
  occurrence may supply several scalar fields. The reader groups fields by
  relation, then occurrence, then role, compares distinct field assertion IDs
  with the relation's full count and discloses an incomplete preview without
  inventing a completeness receipt. Full expansion remains available.
- `GET /world/expand?id=&relation=&limit=` — tuples of one relation
  mentioning one entity: `{ relation, arity, roles, tuples[] }`.
- `GET /world/rows?relation=&limit=&offset=&search=&order=&desc=&subject=` —
  a window of one relation's extension:
  `{ relation, mode, stale, total, offset, roles, rows[] }`. Ordering is the
  database's: the UI never client-sorts a windowed table. `subject` narrows
  the extension to one entity's tuples. Each row: `assertion_id`, `origin`,
  `origins?`, optional `occurrence_state` (present only where the source
  supplied one; never substituted from `assertion_state`), `values` keyed
  by role name. Pagination: `limit` defaults to 200 and is clamped to a
  1000-row ceiling; `offset` defaults to 0. A present `limit` below 1, a
  negative `offset`, or a non-integer value for either is a 400, and
  `offset` reports the effective offset used.
- `GET /world/assertion?id=` — one fact: the row plus `relation`, `mode`,
  `arity`, `roles`, `assertion_state`, optional `occurrence_state`,
  `created_revision`,
  `relation_stale`, `completeness`, `grounding[]`, `warrant`
  (`commitment_id`, origins, `created_revision`, `bases[]`),
  `commitment_id`, `candidate_for[]`, `governing_obligations[]`,
  `candidate_assessments[]`, optional `derivation.inputs[]`. The generic adapter
  adds `detail.scalar_storage` (source column → SQLite storage class of this
  row's value) beside `detail.reference_participants` in its SOURCE grounding.
- `GET /world/derivation?relation=` — the computation around one relation:
  `relation`, `mode`, `rests_on` and `supports` adjacency over the whole
  closure, `nodes{}`, and `run|null` (`sql`, `state`,
  `definition_revision`, `last_run_world_revision`,
  `output_cardinality`, `last_error`, per-input
  `relation` / `declared` / `version_at_run` / `count_at_run` /
  `version_now` / `count_now` / `moved`). Adjacency, not a nested tree: a
  relation can sit at more than one place in the closure.
- `GET /world/support?id=` — tuple-level drill-down for a derived fact:
  `assertion_id`, `relation`, `derived`, `referents[]`, and per-input
  `relation` / `mode` / `stale` / `count` / `matched` / `roles` / `tuples[]`
  with `mentions`. Candidates (input tuples mentioning the same entities),
  never recorded row lineage: derivation is recorded per relation.
- `GET /world/demand` — `{ demand|null }`: the legacy purpose frontier.
  `purpose.statement`, `rule|null`, `demanded`, tuple-level `obligations[]`
  (`relation`, `values`, `demanded_by`, `state`, `assertion_id`,
  `record_id?`, `reason?`, `grounding_ref?`), and relation-level
  `requirements[]` (`name`, `kind`, `relation|null`, `note`, `failures`).
- `GET /world/obligations` — durable governed questions:
  `{ contract, governance, obligations[] }` with per-obligation
  `obligation_id`, `question`, `state`, contract identity, candidate links,
  and optional `resolution`.
- `GET /world/obligation?obligation_id=` — one governed question inspected:
  full candidates with commitments, warrants, grounding and assessments,
  adjudications, and contract/governance/authority context. Null where the
  backend has no such obligation.

## Grounding shape

Each grounding: `kind`, `reference`, and optional `native_handle`,
`native_location`, `provider`, `source_revision`, `construction_method`,
`construction_origin`, `detail`, `detail_text`. The assertion reader shows
`SOURCE` handles and locations, with an expandable disclosure of supplied
source metadata, including SQL definitions and source-reported lineage
qualifications. Missing fields remain absent; `WORLD` groundings contribute methods.

## Compatibility guidance

- A backend may omit `demand`, `obligations`, scope, or authority
  documents; the UI treats absence as absence, never as a negative claim.
- A backend must not invent `WORLD` scope where no admission document was
  recorded: report `null`.
- Keep `MAX_ROWS`-style ceilings server-side; the UI pages and never wants
  a whole extension in one response.

## Optional reading attribution

`/world/overview` may add `reading: WorldReading` (see `src/api/world.ts`).
Its initial `interpretation_source: "external_reader_declaration"` identifies a
known external input channel, not a human author or producer endorsement.
`declaration_digest` is the existing full semantic SHA-256, computed from the
actual declaration, excluding `world.*`. `reader_note` is nullable declaration
wording. Filtered `entities` and `relations` identify declared namespaces, label
selection, keys, conceptual names, descriptions, role/column/target mappings and
SQLite source name/type. An entity's `label_column_source` is `"declared"` when
the declaration names `label_column` and `"adapter_default"` when it names none
and the first key column stands in; absent from older adapters, which say
nothing either way. It is disclosure only: the digest, identities and labels
do not change. Nullable relation `origin` and `occurrence_state` mean
no value declared; supplied values remain unchanged. Source existence is checked
against SQLite, but successful validation does not establish semantic correctness.

`adapter: "generic_sqlite_v1"` identifies the existing compatibility defaults:
revision/created_revision 1, BASE, stale false, assertion_state UNKNOWN,
commitment IDs echoing assertion IDs, empty warrant bases/candidate collections,
and absent scope/completeness/governance/demand. These do not establish evidence
or negative decisions. Source grounding remains separate from warrants.

The API reports these values exactly as before. A consumer decides how to
display them: the reference UI does not print revision 1 or BASE mode (in the
World header, catalogue, table bars and readers) when, and only when, this
descriptor is verified, because there they are the adapter's and not
something the producer recorded. A different revision or mode is printed, and a
World without the verified descriptor prints its revision and mode as recorded;
neither an id prefix, a revision number nor the word BASE is evidence of the
bridge. The "Adapter compatibility values" disclosure says this in the UI.

Scalar values are served exactly as the World supplies them: JSON `null` is a
null value, `""` is the empty string, `0` is zero, and a key absent from
`values` was not sent. Whether a null is a SQLite NULL, or a value was ever
stored, is not said by the value; a World that is a verified generic SQLite
reading says it in its source grounding (`scalar_storage`), and the
reference UI makes no storage claim from a value, an id prefix or a revision.
It marks the first two, whitespace-only text and an unsent value so that none
can be read as another (`NULL`, `""`, a quoted whitespace string, `not
supplied`), names each marker for assistive technology ("null value supplied
by the World", "empty string value", "whitespace-only text, N characters",
"value not supplied by the API"), and prints every other value as sent. Text
that would read as a marker (`null`, `NULL`, `not supplied`, `—`) or that
starts or ends with a quote character is printed quoted (`"NULL"`, `"—"`,
`"\"\""`) in cells, readers and one-line summaries alike, so the characters
alone tell a marker from the text that imitates it; the value itself is
unchanged. Numeric-looking and boolean-looking text is not quoted. Referent
roles are never null: the adapter refuses a tuple with a null participant.

The UI shows a persistent "Reader-declared interpretation" qualifier whenever,
and only when, this descriptor is present and verified. It states that the
names, roles and labels are an interpretation supplied by an external reader
declaration; it does not name an author, assert that a person wrote it, or
imply that the interpretation is correct or endorsed by the database's
producer.

The generic CLI opts in because it receives `--declaration`; Model dictionaries
and snapshot preparation without an explicit external source omit the descriptor.
Expedition's embedded `ki_*` reading and legacy authoritative metadata acquire
no external attribution. Missing `reading` establishes no ownership fact and
older backends continue working. No absolute declaration path or raw declaration
is served. See the candidate architecture
for the future core/extension boundary; this PR does not migrate that contract.

## Captured structural source v1 (additive backend foundation)

Implemented by `adapters/source/server.py`; DTOs are in `src/api/source.ts`.
Supported runtime: Python 3.11+ and SQLite 3.37+; validation below records the
actual tested versions.
This is a separate service/contract from both the unchanged live `/sqlite/*`
plane and conceptual `/world/*` plane. The `/source` workspace uses this
contract through `src/api/sourceClient.ts`; source-first startup is an explicit
frontend configuration (see README). No
source row is emitted as a World referent/assertion. No endpoint accepts SQL,
producer paths, declaration JSON, source writes or browser session mutation.
The legacy Chinook launcher still starts its original two adapters; it does
not yet unify their generations.

Start without a declaration:

```bash
python3 adapters/source/server.py --db examples/chinook/data/Chinook_Sqlite.sqlite --port 8159
curl 'http://127.0.0.1:8159/source/v1/session'
```

`GET /source/v1/session` returns the **fixed initial** `SourceContext`, not a
new session/capture. It is the bootstrap exception to context parameters. It
contains `session`, `source_namespace`, `generation`, full `capture_digest`,
`capture_version: sqlite_capture_v1`, `projection_version: sqlite_source_v1`,
`captured_at` (UTC capture-completion observation, **not** producer commit
time), `time_basis: capture_observation_not_producer_commit`, `sqlite_version`,
`idle_ttl_seconds` (positive seconds, or `null` for no idle expiry), and explicit
`capabilities`. `ki open` reports `null`; the standalone Source adapter defaults
to 3600 seconds. It exposes no filesystem path.
Capabilities true: schema, row_windows, verified_pk_records,
outgoing_fk_observations, incoming_fk_observations. False: conceptual_readings,
browser_refresh, query_mappings, keyless_record_handles, view_record_handles.

Every other successful read is `{context: SourceContext, data: ...}` and
requires exactly one nonempty `session` and `generation` query parameter from
that descriptor. Values are opaque; apply URL transport encoding once. No
request redirects to a newer/global generation. Errors are `{error: code,
detail?: string}` and do not substitute an empty successful result.

| Implemented GET | Additional parameters | `data` |
| --- | --- | --- |
| `/source/v1/overview` | `limit`, `offset` | SourceCatalogue: paged relation summaries, total object count, table/view/unsupported counts and identity/read states |
| `/source/v1/schema` | `limit`, `offset` | SourceCatalogue with visible column metadata, ordered `primary_key`, grouped `foreign_keys`, recorded view SQL and lineage qualification where accessible |
| `/source/v1/rows` | required `table` (exact recorded name); optional `order` (one column) and `desc=1`; `limit`, `offset` | SourceRows: typed row window, optional verified handles, complete column metadata, identity state, returned count, has_more/next_offset and ordering qualification |
| `/source/v1/search` | required `table`; `mode=literal` with `text` and optional `column`, `mode=primary_key` with typed `key`, or `mode=reference` with `record` and `fk`; optional `order` and `desc=1`; `limit`, `offset` | SourceSearch: typed row window with matched columns and explicit completion; see table-scoped discovery and incoming references below |
| `/source/v1/record` | required `id` | SourceRecord: exact registered handle/key/cells, columns, generation-scoped stored-row grounding and supported reference actions |
| `/source/v1/references` | required `record`; `direction=outgoing` (default) or `incoming`; `limit`, `offset` | Outgoing: SourceReferences, observations of this record's declared outgoing constraints; total is number of constraints, not number of possible relationships. Incoming: SourceIncomingReferences, one group per declaration naming this record's table, each with its own count (see incoming references below) |
| `/source/v1/reference` | required `record` and `fk` (declaration ID) | One recomputed SourceFKObservation, whether or not it has ever been drawn |
| `/source/v1/records` | required `table`; no `mode` for the plain table window, or the parameters of `/search` in any mode; optional `order` and `desc=1`; `limit`, `offset` | SourceRecordWindow: the same window as `/rows` or `/search`, each row with a verified handle returned as the full SourceRecord (and, in reference mode, its exact SourceFKObservation); see sorting, record windows and find below |
| `/source/v1/find` | required `text`; optional `cursor`; `limit` 1–50 (no `offset`) | SourceGlobalFind: the literal search of every table and view under one request-wide cap; see sorting, record windows and find below |

All collection limits default to 50; accepted range 1–100 (not silently
clamped), offset 0–1,000,000. Duplicate, unknown, missing/empty or invalid
parameters are 400. Record/reference reads also accept the common pagination
parameters but do not paginate their single result. Another `direction`
is `400 invalid_parameter`. Single-column sorting, the record window and find
(below) are the only additions; no arbitrary multi-column sort, keyless record API or HTTP refresh is
implemented. Offset reads are bounded by the VM/time budgets, not promised
efficient at arbitrary depth. Table/view summary `row_count` is null with
`row_count_status: not_computed`; row windows use an existence-only lookahead
and honest `has_more`, without an expensive unconditional total count.

### Sorting, record windows and find (owner decision O8)

Additive to captured source v1, for the World features adopted in Source
(the documented working-set rules).

**Sorting** (`/rows`, `/search`, `/records`). `order` names exactly one recorded
column of the table; any other value, or `desc` without `order`, or `desc` other
than `0`/`1`, is `400 invalid_parameter`. Rows are compared as SQLite compares
them (storage class first, then the column's declared collation; NULL first
ascending), never converted. Ties are broken so a page is the same page every
time it is read: by the verified primary key, or for a table without one by the
row's stored location; a view has no stored location and its ties keep no fixed
order. A sorted response says so: `ordering:"column"` and
`order:{column, desc, tiebreak}` with `tiebreak` one of `verified_primary_key`,
`row_location`, `unspecified`. Unsorted responses are unchanged (`order:null`,
`ordering` as before). The client checks that a window is in the order it asked
for; a different order is a different window.

**Record window** `GET /source/v1/records`. The window `/rows` (no `mode`) or
`/search` (any `mode`, same parameters and refusals) would read, under the same
order, with each row that has a verified handle returned as
`{record}` — exactly what `/record?id=` returns for it — and in
`mode=reference` as `{record, observation}`, the observation exactly what
`/reference?record=&fk=` returns. Rows without a handle are counted in
`skipped` and never returned. `data` is
`{name, identity, records, skipped, offset, returned, has_more, next_offset, ordering, order, search}`,
where `identity` is the state the window was read under (so a window of only
skipped rows says why).
It lets the browser place a page of records (place every row, expand a group)
without being handed anything it could not have read one at a time.

**Find** `GET /source/v1/find?text=`. The per-table literal search
(`mode=literal`, every column, same matching rules, including `case`) run over every table and
view, one after another in catalogue order, all under one request-wide cap: the lock is
held for at most about 1 s or twice the VM step budget, as an incoming page.
That includes verifying the key of a table it searches for the first time, the
first table of a request too; a verification the cap cuts short is
`interrupted`, not the table's verdict. Find hands out handles only for its hits.
`data` is `{text, case, relations, hits, completion, next_cursor, skipped, tables, text_comparison}`:

- `relations` (owner decision O10): `{name, kind}` for every table and view whose
  recorded name contains `text` under the same text comparison, from the catalogue
  already read. Only the first answer carries them; a continuation's is `[]`.

- `hits`: `{table, record_id, key, matched_columns, cells}`, `cells` holding only
  the matched cells; `record_id` is null for a row without a verified handle.
- `completion`: `complete` (every table was searched; `next_cursor` null), `more`
  (the answer is full) or `budget_exceeded` (the cap ran out first). Neither of
  the last two is a claim that nothing further matches.
- `next_cursor`: opaque `"<table index>:<offset>"`; pass it back as `cursor` to
  continue exactly where this answer ended. A malformed or out-of-range cursor is
  `400 invalid_parameter`.
- `skipped`: tables not searched, with the reason. `find_budget_exceeded` means
  the table could not be searched even with the whole cap to itself; the person
  should use that table's own search. `source_query_budget_exceeded` means the
  table's search ran out of its own budget window before the cap did. Other
  reasons are the table's own error code (for example an unsupported virtual
  table).

`text` is required, 1–1024 UTF-8 bytes (`400 invalid_search_text`). `limit` is
1–50 (`400 invalid_pagination` above 50); `offset` is not accepted. `case` is
`ignore` (default) or `match`, as for literal search below.

### Exact values and identities

A cell is `{column, storage_class, ...}`. Metadata and count integers remain
ordinary bounded JSON numbers; **SQLite INTEGER values always use decimal
strings** in `exact`, including signed 64-bit extremes. TEXT uses exact text
(no trimming/normalization); empty/whitespace/NUL are preserved. NULL is
`storage_class: null, exact: null`. REAL uses big-endian binary64
`ieee754_hex`, display text and `finite`; even nonfinite scalar values never
become invalid JSON numbers. REAL key components must be finite.

BLOB cells are explicitly previews: `bytes`, full `sha256`, `preview_only:
true`. Beyond 1 MiB the value is not loaded/hashed: `sha256: null`, reason
`blob_digest_budget_exceeded`, and exact byte length remain. No preview is
an identity. TEXT cells beyond 1 MiB refuse that window with 413 rather than
truncate; smaller windows can still inspect other rows. Page payload/raw
cell and 2 MiB serialized-response limits can require a smaller `limit`.

A table's first row request synchronously verifies its entire declared PK:
non-nullness, SQL uniqueness under column comparison, supported storage,
typed encoding, indexed exact lookup for every key and collision checks.
Only a verification that passes for every row makes the table `verified`. No
successful first-page sample can establish identity. States:
`not_started`, `checking`, `verified`, `no_declared_key`, `view_table_only`,
`invalid`, `unsupported`, `budget_exceeded`; each carries `key_columns`,
`verified_rows` (null until verified) and nullable `reason`. Validation failure
leaves rows table-only. There is no retry/eviction of a table's own failure in
this v1 session (its own budget: `interrupted` from SQLite's step or time
limit, `identity_verification_budget_exceeded` for the 5-second scan or the
200,000-key limit below; `invalid`, `unsupported`); a fresh session/capture is
required for a different budget.

**Each table is judged on its own.** A verification runs in a budget window of
its own (5 seconds, 10 million VM steps), never in what is left of the request
that triggered it, and the request continues in a fresh window afterwards. It
consults no other table's state: its verdict depends only on the table and that
budget, not on which tables were read before. While it runs it holds the
32-byte digests of the keys checked so far (at most 200,000, `verify_rows`), to
detect a repeated typed key, and frees them when it ends.

**Handles are kept from the moment they are handed out.** Verification keeps the
table's verdict, not its rows' handles. A row of a verified table receives its
handle when an answer hands that row out (a row window, a search, a find hit,
a resolved parent, a record), and the session keeps it from then on: every
later answer gives the same row the same handle, and `/record` reads it. The
session holds at most 200,000 handed-out handles and 64 MiB of accounted key
payload. The handles of one row window or search page are kept together or not
at all. When they do not fit, that answer's rows carry `record_id: null` and the
answer's `identity` is `{status: "budget_exceeded", reason:
"identity_registry_budget_exceeded"}`, for that answer only: the table stays
`verified` in `/overview`, and handles already handed out keep working. An
incoming group's `child_identity` says the same once the session holds no room
for another handle.

**Interrupted verification.** A verification cut short by a request-wide cap
(global find's; the cap an outgoing references page shares between the parent
tables it verifies) is not the table's verdict: nothing is recorded, the
table's remembered state returns to `not_started`, and that one answer reports
`status: "interrupted"`, `reason: "verification_interrupted_by_request_budget"`
(no handles; a parent read in it is `resolved_unaddressable`). The next read
that touches the table verifies it under its own budget. `interrupted`
therefore appears only in the answer of the interrupted request, never in
`/overview`.

`sr1:` handles use SHA-256 of recursively framed v1 data:
`[ki.source.record.v1, source_namespace, full_capture_digest, main,
recorded_table, ordered_pk_columns, ordered_actual_typed_values]`.
Framing in `adapters/source/model.py`: L + big-endian u64 element count +
framed children; S/I/R + big-endian u64 byte length + exact UTF-8 / canonical
signed decimal / big-endian binary64 bytes. No Unicode normalization. Types
are distinct, including INTEGER 1 versus TEXT "1" when SQLite permits both
keys. No rowid/offset/label/content hash/guessed key. BLOB keys remain
unsupported. Lookup requires a handle **that session** has handed out for a row
of a verified table; a handle never handed out (even one a client computes
from the framing above), an alias, an unknown or a wrong-context handle
returns 404. To reach a record by its key, use `/search` `mode=primary_key`,
which hands out its handle. An identical-content reacquisition in the
same registered namespace can mint the same handles after verification,
while its session/generation lifetime tokens always differ.

Columns report recorded `declared_type`, `notnull`, `pk_order`, `default_sql`
and `generated` (VIRTUAL/STORED/null). Declared types are not runtime scalar
interpretations. `sf1:` FK IDs additionally include namespace/digest, child
schema/table, pragma constraint ID, ordered raw pairs and actions; `so1:`
observation IDs domain-separate the child handle and declaration ID. Raw
pragma IDs are locators within a generation, not durable constraint names.

### FK observations and grounding

Declarations preserve `recorded_pairs` (`seq`, raw `from`, `table`, nullable
`to`), actions/match and their recorded constraint ID. Adapter-computed
`parent_table` and `pairs` use SQLite's identifier rules and canonical
recorded spelling. Implicit targets resolve the parent's ordered declared
PK only with matching arity. Validation is `verified_declaration`, `invalid`
or `unsupported`, with reason. Eligible parent keys are named PK/UNIQUE
keys, including non-PK and reordered UNIQUE targets; expression/partial
indexes and mismatched declared collations are not eligible. The v1 schema
lexer extracts top-level declared column collations, ignoring quoted text,
comments and nested expressions. Preparing a parent comparison additionally
checks that SQLite can evaluate the collation; `collation_list` alone is not
proof of availability.

Each observation retains child values, declaration, generation grounding,
comparison basis, status/reason and nullable parent. Statuses: `resolved`,
`resolved_unaddressable`, `null_reference`, `dangling`, `invalid_declaration`,
`ambiguous`, `unsupported`, `budget_exceeded`. A resolved parent's key/handle
uses its independently verified PK; matching a non-PK UNIQUE key does not
promote that key to a PK. An unaddressable parent retains observed target
values and an identity diagnostic without a fabricated handle.

One narrow verified SQLite exception is refused: an **implicit** parent PK
whose table-level PK index overrides the column's declared collation. SQLite
can accept that constraint and match through the PK index even though an
explicit REFERENCES(column) is a mismatch and bare-column comparison differs.
V1 returns `unsupported / implicit_pk_collation_differs_from_column`, preserving
raw evidence, rather than falsely reporting invalid or dangling. It is covered
by a disposable SQLite oracle test; supporting it needs a separate matching
proof. Ordinary declared-column BINARY/NOCASE/RTRIM keys remain supported.

Resolution uses **bare parent column = bound child value** for every pair,
so parent affinity/collation governs comparison. It does not reuse World's
ordinary two-column join resolver. BINARY/NOCASE/RTRIM, mixed affinities,
composites, null components, implicit keys and invalid declarations are
covered by differential disposable SQLite checks. Any null component means
`null_reference`; independent invalid metadata remains visible. Missing
parent tables and ineligible keys are invalid declarations. Unavailable
collations/functions, unindexed plans and resource limits produce explicit
refusals. Parent cardinality is checked with a two-result ceiling; never
choose the first ambiguous match. `historical_enforcement: not_established`
is invariant, even on a resolved reference.

Record grounding carries source namespace/full capture digest/generation,
exact schema/table, verified typed key and basis
`stored_row_verified_declared_pk`; cells preserve actual values. A view is
computed output, table-only, with `lineage: not_recorded` and recorded SQL
in schema reads. SQL text is not certified underlying row lineage. Source
view evaluation permits built-in deterministic functions and a small stable
aggregate/window set; known volatile/time functions, unknown functions,
extensions and virtual/shadow sources are refused. This is a conservative
supported domain, not a complete SQL determinism theorem. Existing World
view/declaration behavior is unchanged.

### Source UI outgoing exploration

The Source Reader uses the existing two FK endpoints, with ten declared
constraints per requested outgoing page and exact child/declaration reads for
observation inspection. `total` remains the declared outgoing FK constraint
count. Opening a matched parent reads its verified handle; it does not navigate
to a table's first row or place records. Explicit **Show reference on canvas**
reads the actual parent record before contributing endpoints and the exact
observation to a session-local Source working set. In that working set, records
and connections are independent. A record placed or reached individually stays
until it is removed. **hide connection** hides only that connection, and both
of its records stay. Removing a record takes it and its incident connections,
never another record. Showing a record or connection already on the canvas adds
nothing and moves nothing. Hiding and removal affect only the working set: the
recorded reference, its declaration and its observation are unchanged, and
neither action reads the source. No API write, alternate FK resolver,
conceptual assertion or historical-enforcement receipt is introduced. See outgoing exploration evidence.

### Source UI incoming exploration

The Reader lists **referenced by** below a record's outgoing **references**, ten
declarations per page, in World's relation-list form: `child table · FK
columns`, then the count and `table`. A declaration with an exact zero count is a
quiet note ("No rows in this capture reference this record through …"). An
unavailable count shows its reason and stays browsable. An invalid or unsupported
declaration is listed with its validation reason, no count and no rows. Choosing
a line opens the child table in the Tables dock in reference mode: Find is
replaced by `N rows referencing <parent table> · <key> through <FK columns>`, and
**whole table** (World's "whole relation") drops the narrowing. The Reader keeps
the parent until a row is chosen; **back to previous table** restores the
previous table, its Find and its selection. Nothing is placed on the canvas. Group
expansion is not implemented.

### Incoming references

On-demand reverse lookup over the immutable capture: no capture-time index,
sidecar or derived database, and no change to the capture lifecycle.

**Discovery.** `GET /source/v1/references?record=P&direction=incoming` pages over
declarations (`limit`, `offset`) and returns
`{record_id, direction: "incoming", total, groups, comparison_basis, offset, has_more, next_offset}`.
`total` counts every recorded declaration whose resolved `parent_table` is P's
table, in any validation state, ordered by child table name then pragma ID. A
declaration whose parent table does not resolve (`missing_parent_table`) names no
table and is never incoming. Each group is `{declaration, count, child_identity}`.
`child_identity` is the child table's identity as already known, read without
verifying anything: a count never stands for placeability, and a known terminal
state (`no_declared_key`, `budget_exceeded`, …) lets the Reader say before a
click that the group cannot be placed. A group has no
identity of its own: its members are the outgoing observations
`(child handle, declaration_id)` that resolve to P, with the same `so1:` IDs.

| `count.status` | `value` | Meaning |
| --- | --- | --- |
| `exact` | integer ≥ 0 | Child rows whose declared FK resolves to P in this capture. Zero is an observed absence in this capture only. |
| `unavailable` | null | Started but not completed; `reason` is `source_query_budget_exceeded` (its own budget), `incoming_page_budget_exceeded` (the page's budget ran out during it), `child_blob_matching_budget_exceeded`, `unsupported_source_operation` or an unsupported declaration's validation reason. Never zero. |
| `not_checked` | null | Not started, because the page's budget was already spent (`reason` `incoming_page_budget_exceeded`). Never zero. A page with fewer declarations (`limit`/`offset`) has its own budget. |
| `invalid_declaration` | null | The declaration is invalid (`reason` is its validation reason); no child resolves through it, so there is no count. |

**Page budget.** The counts of one response share an aggregate budget: by
default 1 second and 20 million VM steps (two ordinary work budgets; reader
options `incoming_page_seconds` and `incoming_page_steps`). Each count runs
under its own ordinary 5-second/10-million-step budget, cut to what remains of
the page's, so a refused count leaves the other groups intact while the page
lasts. Once the page's budget is spent, no further count starts: the remaining
verified declarations are `not_checked`, and invalid or unsupported ones are
reported as always. Whatever the page size, counting therefore holds the
generation's reader lock for at most about one second. Discovery (record read
and declaration validation for every table, cached per generation) uses the
request's ordinary first budget. A group whose count is `unavailable` or
`not_checked` stays browsable through **Rows** below, under that request's own
budget.

**Rows.** `GET /source/v1/search?table=<child>&mode=reference&record=P&fk=<declaration_id>`
(`limit`, `offset`; no `text`, `column` or `key`). `table` must be the
declaration's child table. The result is SourceSearch with `search.record` and
`search.fk`, `searched_columns` and every row's `matched_columns` set to the child
FK columns, `excluded_storage_classes: ["null"]` and
`reference: {record_id, declaration, comparison_basis, unchecked_rows, unchecked_reason}`.
Each row adds `observation_id`: the `so1:` ID of `(record_id, fk)` when the child
row has a verified handle, otherwise null. One scan of the predicate locates the
window's rows and whether a next row exists. The rows are located by `rowid`, or
by the declared key of a WITHOUT ROWID table, and then read by that location. So
a page costs about one count, where the general search path repeats its scan for
size preflight and lookahead. If columns shadow every `rowid` alias, the general
path is used. Rows are ordered by the verified key; without one, by that location.
Either way they are reported as `unspecified_window_only`. Completion, paging,
budgets and size limits are those of search. No total is computed, because
discovery supplies the count. Errors: unknown record `404 source_record_not_found_in_generation`;
declaration not recorded on `table` `404 source_fk_not_found`; declaration whose
parent is not P's table `400 source_fk_parent_mismatch`; invalid or unsupported
declaration `422 incoming_declaration_not_verified` with the validation reason as
detail; `record`/`fk` with another mode, or `text`/`column`/`key` with this mode,
`400 invalid_search_parameters`.

**Matching.** Counts and rows use one predicate over the child table:

```sql
NOT (typeof(child.c1)='blob' AND length(child.c1)>1048576) AND …
AND EXISTS (SELECT 1 FROM parent AS ki_parent
            WHERE ki_parent.k1 = ? AND typeof(ki_parent.k1) = ? AND …   -- P by its verified typed key
              AND ki_parent.p1 = +child.c1 AND …)                       -- each FK pair
```

The parent column is the left operand, unary `+` removes the child column's
affinity, and the left column's collation takes precedence. That is the outgoing
`parent_column = ?` comparison applied to the stored child value, so SQLite, not
the adapter, applies parent affinity and collation in both directions. The
alias is changed if a child table has the same name. Differential tests compare it
with each child's outgoing observation: NOCASE parents; INTEGER parents with TEXT
and no-affinity children (`'01'`, `'1.0'`, `'+1'`); REAL children of TEXT parents
(`0.1+0.2` renders as `'0.3'`); the public Spider `phone_1` TEXT child of a REAL
key; composite keys; NULL components; dangling values; parallel declarations;
self-references; STRICT `ANY`; stored values that no longer conform to their
declared affinity; WITHOUT ROWID tables; and generated child and parent key
columns.

Never used: child-column equality, the literal Find filter, a child-column index
or Python comparison. Child-column equality is wrong across affinities and
collations. In the investigation corpus it was wrong for 8 of 156 verified
declarations: 7 constructed counterexamples and the public `phone_1`, where it
misses all 8 references. A child-index seek also misses stored values that do not
conform to the column's affinity. An index-assisted variant, guarded by that
proof, is not implemented. Its largest measured gain was Northwind
`Order Details` (609,283 rows): 1.8 ms instead of 52 ms per page and 1.2 ms
instead of 25 ms per count, both well within budget. It was slower for some deep
pages (Sakila `payment.staff_id`: 26 ms against 5 ms). It would change an outcome
only beyond about 1.1 million child rows, where its own safety check (a scan for
nonconforming stored values) is itself a full scan. A scan costs about 8.5 VM
steps per child row, so a single count covers about 1.1 million child rows before
it is `unavailable`.

**Oversized BLOBs.** The outgoing read does not match an FK BLOB over 1 MiB
(`budget_exceeded / child_blob_matching_budget_exceeded`), so incoming never
lists or counts one. A BLOB equals only a BLOB of the same length, so such a row
could resolve to P only when P's target value is itself a BLOB over 1 MiB. In that
case, with a same-length child BLOB present, the count is `unavailable` and rows
report `unchecked_rows`. Otherwise the exclusion is exact.

**Invariant.** Every listed row with a handle is a `resolved` outgoing
observation to P with the same `observation_id`, and every resolved outgoing
observation to P is listed. It holds by construction (one comparison) and is
tested over every record of the fixtures and `phone_1`; it is not re-checked per
row at runtime.

**Identity.** Children in tables without verified identity (no declared key,
invalid key, or verification beyond its budget), or beyond the session's
200,000 handed-out handles, are counted and listed with
`record_id: null` and `observation_id: null`; the table-level `identity` gives
the reason. They are readable, never placeable.

### Generation lifecycle, limits and integration handoff

The producer is opened `mode=ro`, `query_only`; capture pins a read, uses
SQLite backup (including committed WAL data), closes the private artifact,
and hashes it. Private directory/file permissions are 0700/0600. Serving
uses only immutable read-only capture connections; no producer fallback,
checkpoint, source DDL/DML or source indexing. Read-only SQLite acquisition
may create its own WAL/SHM sidecars on a hot WAL source, as already documented
in SNAPSHOT_CONSISTENCY.md. It never intentionally changes original DB bytes.

The source service owns at most two live **or retiring** captures, each at
most 2 GiB, with 120-second acquisition/hash deadline; CLI flags
`--capture-deadline` and (standalone only) `--session-ttl` configure deadline/idle expiry.
The standalone adapter defaults to a 3600-second idle TTL, reaped every 0.5
seconds and checked on access. `ki open` explicitly disables idle expiry and
keeps its session until process shutdown, without browser heartbeats. Ctrl+C
and SIGTERM still retire the capture. Retirement refuses new consumers, while
active leases hold the file until completion. All successful source responses, including cached ones,
check the captured file's device/inode/size/mtime/ctime signature; a changed
private artifact is refused, never rehashed into a new generation silently.
Storage read failures also fail closed. This is not protection from a
privileged attacker forging process memory/filesystem state.

Per generation: at most 200,000 handed-out record handles and 64 MiB
accounted key payload (not a process-RSS claim); one verification holds at most
200,000 key digests while it runs; schema discovery ceiling
4096 objects/8 MiB recorded SQL; at most 512 visible columns per row read.
SQLite operations have 5-second/10-million-VM-step budgets and 8 MiB SQLite
value limit. Each table verification has a budget window of its own and the
request continues in a fresh one, so failed identity checking does not prevent
supported row inspection. One
source reader operation runs at a time per generation, with a bounded
5-second lock wait (`429 source_reader_busy`); the HTTP server admits at most
eight request threads and refuses the rest at once with
`429 {"error": "source_server_busy"}` and `Retry-After: 1`. It also limits URLs to
8 KiB and headers to 16 KiB, and refuses GET bodies. Both busy refusals are temporary and say
nothing about the capture: the UI keeps its context and canvas and offers
**try again**, with no automatic retry. There are no CORS grants. Existing
loopback Host/Origin protection is retained.

Errors: 404 missing relation/record/FK/route; 409 wrong generation or failed
exact record lookup; 410 unknown/expired/retired session; 413 cell/page/response
size; 422 unsupported source/matching/query budget/unverified incoming declaration;
429 session limit, busy reader or HTTP admission (`source_session_limit`,
`source_reader_busy`, `source_server_busy`); 503 missing/damaged capture.
Unsupported evidence is not an empty graph or a conceptual obligation.

`SessionManager.new_generation()` is an **operator/Python-only** explicit
capture operation; callers receive a new token and must use it explicitly.
It never changes the initial bootstrap target or services an old token from
new bytes. The CLI's refresh is restart. Namespace registration is currently
manager/process-lifetime; restart safely creates a new source namespace.
Persistent server-owned source registration and browser refresh are future
work, not implicit path-derived identity. Normal/error/SIGINT/SIGTERM cleanup
removes exact owned artifacts; SIGKILL can leave an orphan requiring operator
cleanup. No automatic cross-process temp scavenging is implemented.

`adapters/capture.py` owns acquisition/lifetime independently of Model.
Legacy `prepare_world` retains its signature, captured bytes, World ID codec,
declaration digest and CLI. Additive
`prepare_world_from_capture(capture, declaration, ...)` validates exactly
that artifact, holding a consumer reference until reading cleanup; it never
backs up the producer again. Future session-specific reading routes must
lease that capture and key caches by full source+reading context; this PR
implements neither reading routes nor declaration POSTs. The existing
World-only field/camera slots and UI remain untouched.

### Table-scoped discovery: `GET /source/v1/search`

Additive to captured source v1. Required: `session`, `generation`, `table` (exact
recorded spelling). The response retains the complete `{context,data}` envelope.
`limit` defaults to 50 (1–100); `offset` defaults to 0 (0–1,000,000). No total match
count is computed. Parameters may occur only once; unknown parameters fail.

Three operations are accepted:

- `mode=literal` (default), required `text`, optional `column` (exact recorded
  column name), optional `case` (`ignore`, the default, or `match`; any other
  value, or `case` in another mode, is `400 invalid_search_parameters`). Omitting
  column searches all visible recorded columns using each
  cell's actual storage class, including generated columns under the existing
  deterministic-read authorizer. `text` is at most 1024 UTF-8 bytes.
- `mode=primary_key`, required `key`: JSON array in recorded PK order, each entry
  exactly `{column,storage_class,exact}`. All components are required. INTEGER
  exact values are signed decimal strings in SQLite's 64-bit range; TEXT values
  are exact strings. Each value is at most 1024 UTF-8 bytes. No text/column filter
  is allowed in this mode. REAL/NULL/BLOB keys return
  `422 unsupported_search_key_type`; views/keyless tables return
  `422 unsupported_search_key`. This lookup does not independently authorize a
  source record: only a verified table's row can be handed a handle.
- `mode=reference`, required `record` and `fk`: rows of `table` whose declared FK
  `fk` resolves to the verified record `record`. See incoming references above.
  It is not a literal filter and accepts no `text`, `column` or `key`.

Literal TEXT is a substring test under a versioned text comparison, named in the
response as `text_comparison:{policy, unicode_version}` (owner decision O11, the
target set by the product scope):

- `casefold_v1` (default, `case=ignore`): both the cell and `text` are compared
  after Python's full Unicode case folding (`str.casefold`, the Unicode version
  given), through `instr(ki_casefold(cell), casefold(text))>0`. `ki_casefold` is
  a deterministic function the reader registers and allows; nothing else is
  added to the authorizer. Folding is full, not simple: `ß` matches `SS`, final
  and medial sigma match, the `ﬁ` ligature matches `fi`, and `İ` folds to `i`
  followed by U+0307, so `istanbul` does not find `İstanbul`. There is **no
  normalization**: a composed `é` and `e` + U+0301 do not match each other.
- `exact_v1` (`case=match`): the code points as recorded, `instr(cell, text)>0`;
  the comparison every literal search used before O11.

In both, `%`, `_`, quotes, backslashes and NUL are literal. Empty `text` matches
all TEXT cells, including empty strings. Whitespace is not trimmed. The UI clears
back to browsing for empty Find. Canonical INTEGER input matching
`-?(0|[1-9][0-9]*)` in signed 64-bit range also matches INTEGER cells by equality.
Finite decimal REAL input (optional sign, decimal point, exponent) matches REAL
cells using binary64 numeric equality; conversion rounds to binary64 and does
not imply decimal or bitwise equality. NULL/BLOB contents are excluded; nonfinite
REAL input is not supported as a numeric comparison. Returned scalar types and
values are never converted. Exact-key TEXT comparison adds BINARY equality to
SQLite's indexed declared comparison, so collation-equivalent labels do not
count as exact keys. No input is SQL or a LIKE/FTS pattern.

`data` extends `SourceRows` with `search:{mode,text,column,key}` (unused fields
null; literal mode adds `case`), `text_comparison` in literal mode, `searched_columns`, `excluded_storage_classes:["null","blob"]`, and
`completion:"complete"|"window"`. Every row adds `matched_columns`, and keeps
its typed cells, registered handle/key when available, and table-level identity
qualification. Duplicate values/rows are separate occurrences; no DISTINCT or
label-derived identity is used. Readable base tables and authorized deterministic
views are supported; virtual/shadow tables and disallowed functions fail explicitly.

- `complete`, zero rows, offset zero: no matches under this policy in the selected
  table of this capture. It says nothing about excluded types or other tables.
- `window`: a further match was observed; `has_more:true` and `next_offset` support
  another bounded request. Results are not a complete match set.
- `complete` at a nonzero offset: no further matches after the returned window;
  it does not claim the earlier match set was empty. Unverified rows retain
  `unspecified_window_only` ordering; no durable continuation identity is implied.
- Any failure: no successful completion/absence claim and no partial results.
  In particular `422 source_query_budget_exceeded` must never become “No matches.”

Execution reuses the source lock, immutable capture, authorizer, existing identity
verification and budget reset between verification and row reads. The entire
search phase (size preflight, row retrieval, existence-only lookahead) shares one
5-second/10-million-VM-step budget checked every 1000 instructions. These are
cooperative SQLite limits, not a hard real-time guarantee for a single opcode.
Existing cell/page/serialized-response limits apply. Lookahead reads existence
only, so an oversized next match does not poison the current page. Continuation
reexecutes the predicate and may hit the work/offset limit; LIMIT alone is never
the execution budget. Existing PK indexes remain eligible for exact probes.
No producer or capture index is created, no FTS virtual table is used, and no
source refresh or World-generation coupling is introduced.

See record discovery decision
for the product authority and future indexing reconsideration criteria.

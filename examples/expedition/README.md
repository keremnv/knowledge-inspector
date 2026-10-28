# Expedition: a SQL-backed conceptual slice

A herbarium expedition in one SQLite file: collection records plus a
conceptual interpretation — free-text determination names resolved to taxa
through an alias map and SQL views — navigated in the existing graph
explorer without changing the frontend.

## The story in brief

Collectors gather specimens at sites (`specimen`, raw foreign keys).
Later, botanists determine them: each `determination` row records who
asserted what name for which specimen, when, on what basis, and whether
the claim is `proposed`, `adopted`, or `rejected`. The asserted name is
free text as written — `S. globulifera`, a misspelled `Maesopsis emini`
— so no foreign key can say which taxon a determination concerns. The
`taxon_alias` mapping plus the `v_determination*` views say it, in
ordinary SQL.

K-118 carries the slice's tension: Okello's open proposal (Maesopsis)
competes with Lindqvist's adopted claim (Symphonia). K-201 carries its
honesty: one proposal names a taxon nobody recorded and stays an
unresolved obligation, while the rejected decision is served as a
recorded rejection — never as an adopted claim.

## Run it

```bash
python3 examples/expedition/seed.py /tmp/expedition.sqlite
python3 examples/expedition/consumer.py --db /tmp/expedition.sqlite
python3 examples/expedition/server.py --db /tmp/expedition.sqlite --port 8139
npm run dev   # :5173, proxies /world/* to :8139; the World explorer is at /
```

The consumer answers the same questions from raw SQL that the graph
answers visually. The adapter opens the file read-only, by reference,
binds to localhost, sends no CORS headers, and refuses non-loopback
`Host`/`Origin` callers. `examples/expedition/server.py` is now a thin
example-specific extension over the generic `adapters/world/server.py`: it
adds the embedded `ki_*` loader, the determination coverage rule, the
herbarium demand frontier, and the expedition world identity — all World
reads are generic. Checks:

```bash
python3 examples/expedition/test_expedition.py   # 19 backend checks
KI_LIVE_CONCEPTUAL=1 npx playwright test tests/conceptual.spec.ts
```

## The declaration candidate (experimental, not a standard)

Views carry no foreign keys and no stable row identity, so a generic
Inspector cannot discover participants or tuple identity from schema
introspection alone. The `ki_*` tables declare exactly that, as plain
relational rows:

- `ki_entity(kind, source, key_columns, label_column)` — which sources
  carry conceptual identities, and which columns identify and name them.
- `ki_relation(name, source, key_columns, origin, occurrence_state,
  description)` — which sources carry relation instances, their tuple
  identity, the construction origin the SHOW layers read, and the
  independently authored epistemic stance API readers see (`ADOPTED`,
  `PROPOSED`, `RECORDED`, `REJECTED`), or NULL when unstated.
- `ki_role(relation, role, column_name, target_kind)` — which columns
  play which participant roles, and which entity kind each referent role
  points at (`NULL` target = scalar role).

Which fields are genuinely necessary:

| Field | Necessary? | Why |
|---|---|---|
| `source` | Yes | Views and tables are indistinguishable otherwise; nothing says what to expose. |
| `key_columns` | Yes | No verified key, no identity: the adapter refuses keys with nulls or duplicates at startup. |
| `role` + `column_name` | Yes | A view's columns have no role names; the graph needs them. |
| `target_kind` | Yes | Views record no references; without it a column cannot become an edge. |
| `origin` | Yes, with default | SHOW layers and the reader chip key off the per-tuple origin. It describes construction only: this fixture declares `SEMANTIC` for every relation because all tuples were constructed the same way, even though their stances differ. Defaults to `SEMANTIC`. |
| `occurrence_state` | Yes, nullable | The independently authored stance; NULL omits the API field, and readers show nothing. Never inferred from origin. |
| legacy `assertion_state` | Compatibility only | The contract requires the string, but legacy producers fill it from stored origins, not adoption decisions — so this adapter always sends `UNKNOWN` and documents it as claiming nothing. |
| `label_column` | No | Convenience; defaults to the first key column. Composite labels are deferred. |
| `description` | No | Human blurb for the relation reader. |

The adapter validates the declaration at startup and fails loud on
unknown sources or columns, unverified keys, null participants, and
dangling role values. Role order follows declaration order.

Interpretation completeness is *not* declared: the rule "every
determination row is asserted or obligated" is explicit expedition code
(`Model._check_determination_coverage` plus the demand builder), because
inventing a second declaration table for coverage would freeze more
standard than one fixture can justify.

One contract friction is unavoidable: every assertion must carry
`commitment_id` and a `warrant`, including proposals, so the adapter
fills them minimally — ids echo the assertion, origins echo the
relation, `bases` stays empty to mean "none recorded". No evidential
content is invented, but the shape itself overstates what a proposal
commits to; that is a limitation of today's World contract, pinned in
`test_warrant_shape_is_mandated_not_recorded`.

## What each surface shows

- `determination` (adopted): three-participant tuples — specimen, taxon,
  determiner — plus date and basis. Origin `SEMANTIC`, state `ADOPTED`.
- `determination_proposed`: same shape, open proposals only. Origin
  `SEMANTIC`, state `PROPOSED`: constructed exactly like the adopted
  tuples, but never adopted. The relation name and the reader's
  occurrence chip carry the distinction — never the origin. (Row
  payloads carry no state, so the table itself shows origin only.)
- `determination_rejected`: recorded rejections, same shape. Origin
  `SEMANTIC`, state `REJECTED`: a negative decision, neither adopted
  nor open. The plate and reader name the relation, so the negation
  travels with the mark.
- `collection`: recorded collection events, table-backed. Origin `SEMANTIC`,
  state `RECORDED`: the occurrence exists, distinct from adopting content.
- The demand frontier obligates the one unserved record: det 4, whose
  name matches no alias. Obligations here mean exactly that.
- Every assertion grounds to its source. Table-backed groundings cite
  the stored row; view-backed groundings cite the view definition and
  say lineage is not recorded — a computed output is not a stored row,
  and support inputs are likewise unrecorded (`inputs: []`).

## Reading occurrence state

The assertion reader shows two chips side by side and never merges them:
the construction origin (`semantic` for every expedition relation) and
the recorded state (`adopted`, `proposal`, `rejection`, `recorded`),
with plain-language tooltips. The state chip reads `occurrence_state`
exclusively: a legacy `assertion_state` of `ASSERTED` with no occurrence
state shows no chip at all, because legacy producers assign that field
from stored origins, not adoption decisions. Unknown explicit states
render raw. `commitment_id` and `warrant` are never presented as
established grounds in the assertion reader — they surface only in the
governed-candidate UI, which this adapter does not serve. SHOW layers
are unchanged: with a single construction origin, all four relations
render on the semantic layer, and only the state chip tells them apart.

## Remaining semantic uncertainties

1. **Rejected plates depict the bare tuple shape.** The relation name,
   origin chip, and assertion state carry the negation, but the discs
   themselves draw the same geometry an adoption would. True negative
   depiction would need frontend work this slice deliberately avoids.
2. **Referent roles assume single-column target keys.** Composite keys
   identify entities and tuples, but a role maps one column; composite
   references are refused at startup rather than mapped.
3. **Mode is BASE throughout, and support inputs are unrecorded.**
   View-backed relations are received as-recorded here, but one could
   argue they are DERIVED with the view SQL as the run record. The
   derivation panel shows the trivial closure; the SQL instead rides in
   grounding detail, and support answers with participants but no inputs.
4. **No per-tuple origins.** Origin is per relation; a mixed view would
   need an origin column in the declaration or a split into views.
5. **Coverage rules are code, not data.** The next fixture needing
   "asserted or obligated" would duplicate the demand builder; that
   duplication — not this fixture — should shape any coverage declaration.
6. **Labels are single-column.** Multi-column display names need a
   label rule the declaration does not have.
7. **The startup fingerprint is opening metadata**, not a per-read
   guarantee; a live file may change between reads.
8. **Warrants and commitments are mandated, not recorded.** Every
   assertion must carry them, so proposals bear commitment ids and empty
   warrants. The shape overstates; only the emptiness is honest.
9. **SHOW has no proposal or rejection layer.** All four expedition
   relations render on the semantic layer, so stance travels only via
   `occurrence_state` (see the stacked reader chip) and relation names —
   never via origin. A backend that needs default-hidden proposals must
   use a non-named origin; that is a visibility choice, not a stance.

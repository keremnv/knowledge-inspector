# knowledge-flow: an external declaration over a frozen producer file

The first acceptance case for the generic World adapter
(`adapters/world/server.py`): the frozen `knowledge.sqlite` artifact from
Interoperability Run 000, served in place — never modified, copied, or
imported — through the reader-owned `declaration.json` beside this file.

## Run it

```bash
python3 adapters/world/server.py \
  --db /path/to/knowledge.sqlite \
  --declaration examples/knowledge-flow/declaration.json \
  --port 8181
npm run dev   # :5173, proxies /world/* to the world target; the explorer is at /
```

With the world target pointed at :8181, the graph shows 1 relation
(`flow_step`), 5 referents (`data_flow` rows), and 19 tuples (`flow_hop`
rows), each grounded to its source row. The world id is
`knowledge:a5a64ac74fda+d8a605942f43` — the reader's prefix, the frozen
file's SHA-256 prefix (proof the bytes served are the frozen bytes), and
the canonical declaration digest (proof of which reading is served). Both
halves are startup metadata, not per-read freshness.

```bash
python3 adapters/world/test_world.py   # backend checks (31; +frozen case with KI_KNOWLEDGE_SQLITE=1)
KI_LIVE_GENERIC=1 KI_KNOWLEDGE_SQLITE=/path/to/knowledge.sqlite \
  VITE_WORLD_TARGET=http://127.0.0.1:8181 VITE_SQLITE_TARGET=http://127.0.0.1:8182 \
  npx playwright test tests/generic-world.spec.ts
```

## The external declaration format (version 1, experimental)

Not a producer format, not an ontology standard: a small reader-owned
configuration that reuses the minimum `ki_entity` / `ki_relation` /
`ki_role` semantics, with roles nested under their relation. The adapter
refuses to serve without one, never reads one from the producer file, and
validates every named source, column, key, and referent target against the
file at startup.

```json
{"version": 1,
 "world": {"id_prefix": "knowledge", "description": "..."},
 "entities": [{"kind": "data_flow", "source": "data_flow",
               "key_columns": ["id"], "label_column": "name"}],
 "relations": [{"name": "flow_step", "source": "flow_hop",
                "key_columns": ["flow_id", "seq"], "description": "...",
                "origin": null, "occurrence_state": null,
                "roles": [{"role": "flow", "column_name": "flow_id",
                           "target_kind": "data_flow"},
                          {"role": "seq", "column_name": "seq",
                           "target_kind": null}]}]}
```

| Field | Required? | Meaning |
|---|---|---|
| `version` | Yes | Must be `1`. |
| `world.id_prefix` | No | World-id prefix; default `sqlite`. The id is always `<prefix>:<file-sha12>+<declaration-sha12>`. |
| `world.description` | No | Reader's note about the reading. Never served as producer fact. |
| `entities[].kind` | Yes | Entity namespace; unique. |
| `entities[].source` | Yes | Table or view carrying the entities; must exist. |
| `entities[].key_columns` | Yes | Verified identity: refused on nulls or duplicates. |
| `entities[].label_column` | No | Display label; default is the first key column. |
| `relations[].name` | Yes | Relation name; unique. |
| `relations[].source` | Yes | Table or view carrying the tuples; must exist. |
| `relations[].key_columns` | Yes | Verified tuple identity: refused on nulls or duplicates. |
| `relations[].description` | No | Human blurb for the reader. |
| `relations[].origin` | No | Reader-claimed construction origin, or null when unstated. |
| `relations[].occurrence_state` | No | Reader-claimed stance (`ADOPTED`, `PROPOSED`, `RECORDED`, …), or null when unstated. |
| `roles[].role` | Yes | Role name; unique within the relation, in presentation order. |
| `roles[].column_name` | Yes | Source column; must exist. |
| `roles[].target_kind` | No | Entity kind for referent roles; null means a scalar role. |

Unknown keys are refused at every level, so a typo fails loud instead of
silently narrowing the reading. `UNSTATED` is reserved and can never be
declared. Serving a declaration is not evidence the reading is correct.

## What this declaration interprets, and what it restates

| Declaration | Fact (restated) or interpretation (reader-authored)? |
|---|---|
| `data_flow` entity over `data_flow(id)` | Fact: restates the declared primary key. |
| `label_column: name` | Interpretation: the label choice is the reader's. Harmless. |
| `flow_step` relation over `flow_hop(flow_id, seq)` | Fact for source + keys (the declared composite PK, verified 19/19 unique, 0 nulls); the relation NAME is interpretation. |
| `flow` role → `data_flow` | Fact: mirrors the declared `flow_hop.flow_id → data_flow.id` foreign key (0 dangling, 0 nulls). The role NAME is interpretation. |
| `seq` / `participant` / `action` scalar roles | Fact-preserving: no referents invented. Role names are interpretation. |
| `description` text | Interpretation: reader wording. |
| `id_prefix: knowledge` | Interpretation: the reader's label for the reading. |
| `origin` / `occurrence_state` | Deliberately UNDECLARED: the producer records no construction origin or stance for hops, so the adapter sends the documented `UNSTATED` origin placeholder, omits `occurrence_state`, and readers show no stance chip. |

No expedition shim tables or views, no producer rows changed, no copied
database. Anything not declared (the other 14 tables and 6 views) is
simply absent from the world — correctly, not silently.

## World contract fields that remain problematic

Kept for compatibility, documented honestly in `adapters/world/server.py`:

- `origin` (scalar, required): `UNSTATED` when undeclared. A placeholder
  that claims nothing; `origins` stays empty and the UI renders the
  mechanical layer.
- `assertion_state` (required): always `UNKNOWN`. Legacy producers fill it
  from stored origins, not adoption decisions, so it is never read as
  stance; `occurrence_state` (omitted when unstated) is the only stance.
- `warrant` / `commitment_id` (required): ids echo the assertion, origins
  echo the relation (or `UNSTATED`), `bases` stays empty to mean "none
  recorded". The shape overstates what a recorded step commits to; only
  the emptiness is honest.
- `scope` / `completeness`: always null (no admission document recorded).
- `revision: 1`, `stale: false`: adapter defaults, not producer claims.
- `demand`: null absence. The declaration format carries no demand model,
  and the adapter invents none; per-model demand stays example-side code.
- Roles still map one column to single-column entity keys; composite-key
  referents are refused rather than mapped.

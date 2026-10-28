# SQLite compatibility investigation

The application requires SQLite 3.37 or newer. A minimum version does not guarantee identical query plans or numeric-to-text conversion across SQLite releases. Before the test corrections, two incoming-reference tests had different outcomes on the environments below:

| Python / SQLite | Matching test | Sparse-page test |
|---|---|---|
| Python 3.13.12 / SQLite 3.51.1 | Pass | Pass |
| Python 3.11.16 / SQLite 3.53.1 | Fail | Error: `source_query_budget_exceeded` |

After correction, both tests pass on both tested environments. Reproduce with interpreters linked to the relevant SQLite versions:

```bash
python3 scripts/sqlite_compatibility_probe.py
python3 -m unittest -v \
  adapters.source.test_incoming.TestIncomingMatching.test_parent_affinity_and_collation_not_child_equality \
  adapters.source.test_incoming.TestIncomingBudgets.test_a_sparse_page_costs_about_one_count
```

The standalone probe creates its own in-memory database. On SQLite 3.51.1, casting the REAL value of `0.1 + 0.2` to TEXT yields `0.3`; on 3.53.1 it yields `0.30000000000000004`. The probe's `PRAGMA foreign_key_check` and parent-affinity comparison agree: the row resolves to a parent containing `0.3` on 3.51.1 and does not on 3.53.1. The original test hard-codes the former result. This finding concerns the tested SQLite builds and does not by itself establish a defect in the application's matching logic. The test now derives expected matches independently from SQLite’s foreign-key checker for each parent value.

The sparse fixture has 30,000 rows and two matching rows at the end. With the same parent-affinity query and data, the probe observed approximately 240,000 SQLite VM instructions on 3.51.1 and 510,000 on 3.53.1; their query plans differ. The application's 400,000-step test budget therefore allows this particular query on the former and refuses it on the latter. A bounded refusal is preferable to an unbounded read or an incorrect complete result, but the practical coverage regression remains. The test now uses an 800,000-step success budget and separately asserts explicit refusal at 100,000 steps and on the general path at 400,000 steps. The application’s default 10,000,000-step operation limit and explicit refusal behavior are unchanged.

Other databases and query plans may still exhaust bounded reads; such refusals are reported explicitly rather than treated as empty results. Linux was tested; macOS and Windows remain untested.

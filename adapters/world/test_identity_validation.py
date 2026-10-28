"""Read-only set verification versus the unchanged per-probe SQL verifier."""
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
import server as world


def memory_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    return db


class TestSetVerification(unittest.TestCase):
    def test_unindexed_table_and_view_lookup_steps_scale_without_repeated_scans(self):
        for view in (False, True):
            steps = []
            for count in (1500, 3000):
                with self.subTest(view=view, count=count), closing(memory_db()) as db:
                    db.execute("CREATE TABLE items(k INTEGER)")
                    db.executemany("INSERT INTO items VALUES(?)", [(n,) for n in range(count)])
                    source = "items"
                    if view:
                        db.execute("CREATE VIEW v AS SELECT k FROM items")
                        source = "v"
                    entry = {"source": source, "keys": ["k"], "columns": world.Model._columns(db, source)}
                    ticks = [0]

                    def progress():
                        ticks[0] += 1
                        # Abort an accidental per-probe scan, independent of
                        # wall-clock scheduling and CPU contention in CI.
                        return ticks[0] > 1000

                    db.execute("PRAGMA query_only=ON")
                    db.set_progress_handler(progress, 1000)
                    world._check_identity_lookups(db, entry, [[n] for n in range(count)], "test", match_keys=True)
                    db.set_progress_handler(None, 0)
                    steps.append(ticks[0])
            self.assertLess(steps[1], steps[0] * 3, (view, steps))

    def compare(self, db, source, keys, values, match_keys=False):
        entry = {
            "source": source,
            "keys": keys,
            "columns": world.Model._columns(db, source),
        }

        def original():
            for value in values:
                found = world._check_identity_lookup(db, entry, value, "test")
                if match_keys and world._key_signature(found) != world._key_signature(
                    value
                ):
                    raise ValueError("wrong key")

        results = []
        for check in (
            original,
            lambda: world._check_identity_lookups(
                db, entry, values, "test", match_keys=match_keys
            ),
        ):
            try:
                check()
                results.append("accepted")
            except ValueError:
                results.append("refused")
        self.assertEqual(results[0], results[1], (source, values, match_keys))
        return results[0]

    def test_storage_affinity_collation_and_views_match_original_parameters(self):
        for declared in (
            "INTEGER",
            "NUMERIC",
            "REAL",
            "REAL TEXT",
            "TEXT",
            "BLOB",
            "TEXT COLLATE NOCASE",
            "TEXT COLLATE RTRIM",
        ):
            with self.subTest(declared=declared), closing(memory_db()) as db:
                db.execute("CREATE TABLE items(k " + declared + ", tail TEXT)")
                db.executemany(
                    "INSERT INTO items VALUES(?,?)",
                    [
                        (v, str(n))
                        for n, v in enumerate(
                            (
                                1,
                                1.0,
                                "1",
                                "1.0",
                                "01",
                                "ABC",
                                "abc",
                                "abc ",
                                "/% Ω",
                                "nul\0key",
                                "Inf",
                                "NaN",
                                2**63 - 1,
                                "9223372036854775808",
                            )
                        )
                    ],
                )
                db.execute("CREATE VIEW v AS SELECT k,tail FROM items")
                db.execute("PRAGMA query_only=ON")
                for source in ("items", "v"):
                    for value in (
                        1,
                        1.0,
                        "1",
                        "1.0",
                        "01",
                        "ABC",
                        "abc",
                        "abc ",
                        "/% Ω",
                        "nul\0key",
                        "missing",
                        "Inf",
                        "NaN",
                        2**63 - 1,
                        "9223372036854775808",
                    ):
                        self.compare(db, source, ["k"], [[value]])
                    records = [
                        list(r) for r in db.execute("SELECT k,tail FROM " + source)
                    ]
                    self.compare(db, source, ["k", "tail"], records, True)

    def test_mixed_affinity_compound_view_matches_original(self):
        with closing(memory_db()) as db:
            db.executescript(
                "CREATE TABLE integers(k INTEGER); CREATE TABLE texts(k TEXT); INSERT INTO integers VALUES(1),(2); INSERT INTO texts VALUES('01'),('2.0');"
            )
            for query in (
                "SELECT k FROM integers UNION ALL SELECT k FROM texts",
                "SELECT k FROM texts UNION ALL SELECT k FROM integers",
            ):
                db.execute("DROP VIEW IF EXISTS v")
                db.execute("CREATE VIEW v AS " + query)
                for value in (1, 2, "1", "01", "2.0"):
                    self.compare(db, "v", ["k"], [[value]], True)

    def test_multiple_matches_are_refused_without_materializing_a_cross_product(self):
        with closing(memory_db()) as db:
            db.execute("CREATE TABLE items(k NUMERIC)")
            db.executemany("INSERT INTO items VALUES(?)", [(1,)] * 5000)
            self.assertEqual(self.compare(db, "items", ["k"], [[1]] * 5000), "refused")

    def test_compound_real_affinity_uses_original_lookup_when_bounded(self):
        # Materializing this UNION and building an automatic index rounds the
        # INTEGER boundary value to REAL, changing lookup cardinality. The
        # bounded path must run the original parameter query, not that join.
        with closing(memory_db()) as db:
            db.executescript(
                "CREATE TABLE reals(k REAL); CREATE TABLE integers(k INTEGER);"
                "INSERT INTO reals VALUES(9223372036854775807);"
                "INSERT INTO integers VALUES(9223372036854775807);"
                "CREATE VIEW v AS SELECT k FROM reals UNION SELECT k FROM integers;"
            )
            self.assertEqual(self.compare(db, "v", ["k"], [[2**63 - 1]]), "accepted")
            entry = {"source": "v", "keys": ["k"], "columns": world.Model._columns(db, "v")}
            with self.assertRaisesRegex(ValueError, "compound SELECT"):
                world._check_identity_lookups(db, entry, [[2**63 - 1]] * 65, "test")

    def test_large_compound_sources_refuse_uncertain_materialized_semantics(self):
        with closing(memory_db()) as db:
            db.execute("CREATE TABLE items(k INTEGER)")
            db.executemany("INSERT INTO items VALUES(?)", [(n,) for n in range(65)])
            db.execute("CREATE VIEW v AS SELECT k FROM items UNION ALL SELECT k FROM items WHERE 0")
            entry = {"source": "v", "keys": ["k"], "columns": world.Model._columns(db, "v")}
            # This remains supported by the old verifier, but large compound
            # shapes are explicitly refused rather than inferred equivalent.
            self.assertEqual(tuple(world._check_identity_lookup(db, entry, [1], "test")), (1,))
            with self.assertRaisesRegex(ValueError, "compound SELECT"):
                world._check_identity_lookups(db, entry, [[1]], "test", match_keys=True)

    def test_recursive_source_is_distinguished_from_private_probe_sequence(self):
        with closing(memory_db()) as db:
            db.execute(
                "CREATE VIEW v AS WITH RECURSIVE r(k) AS "
                "(SELECT CAST(1 AS INTEGER) UNION ALL SELECT k+1 FROM r WHERE k<65) "
                "SELECT k FROM r"
            )
            entry = {"source": "v", "keys": ["k"], "columns": world.Model._columns(db, "v")}
            with self.assertRaisesRegex(ValueError, "compound SELECT"):
                world._check_identity_lookups(db, entry, [[1]], "test")

    def test_internal_indexed_alias_cannot_hide_unindexed_outer_lookup(self):
        with closing(memory_db()) as db:
            db.execute("CREATE TABLE items(k INTEGER PRIMARY KEY)")
            db.executemany("INSERT INTO items VALUES(?)", [(n,) for n in range(65)])
            db.execute("CREATE VIEW v AS SELECT t.k FROM items AS t WHERE t.k>=0")
            db.execute("PRAGMA automatic_index=OFF")
            entry = {"source": "v", "keys": ["k"], "columns": world.Model._columns(db, "v")}
            with self.assertRaisesRegex(ValueError, "cannot plan indexed identity validation"):
                world._check_identity_lookups(db, entry, [[1]], "test")

    def test_unindexed_dangling_fallback_retains_original_predicate(self):
        with closing(memory_db()) as db:
            db.executescript(
                "CREATE TABLE target(k TEXT COLLATE NOCASE);"
                "INSERT INTO target VALUES('ABC');"
                "CREATE TABLE events(v TEXT); INSERT INTO events VALUES('abc'),('missing');"
                "PRAGMA automatic_index=OFF; PRAGMA query_only=ON;"
            )
            self.assertEqual(world._count_dangling(db, "events", "v", {"source": "target", "keys": ["k"]}, "test"), 1)

    def test_large_affinity_join_without_indexed_plan_refuses(self):
        # TEXT target keys can be separately addressable, while an INTEGER
        # participant column compares numerically with many of them. SQLite
        # cannot use its TEXT index for that predicate. Preserve equality on
        # small inputs and explicitly refuse an unbounded source scan.
        with closing(memory_db()) as db:
            db.executescript("CREATE TABLE target(k TEXT); CREATE TABLE events(v INTEGER); INSERT INTO events VALUES(1);")
            db.executemany("INSERT INTO target VALUES(?)", [("0" * n + "1",) for n in range(65)])
            expected = db.execute("SELECT COUNT(*) FROM events s WHERE NOT EXISTS(SELECT 1 FROM target t WHERE t.k=s.v)").fetchone()[0]
            self.assertEqual(expected, 0)
            with self.assertRaisesRegex(ValueError, "cannot plan indexed identity validation"):
                world._count_dangling(db, "events", "v", {"source": "target", "keys": ["k"]}, "test")
            db.execute("DELETE FROM target WHERE k=?", ("0" * 64 + "1",))
            db.execute("PRAGMA query_only=ON")
            self.assertEqual(world._count_dangling(db, "events", "v", {"source": "target", "keys": ["k"]}, "test"), expected)

    def test_wrong_existing_record_at_late_probe_is_refused(self):
        with closing(memory_db()) as db:
            db.execute("CREATE TABLE items(k REAL TEXT)")
            db.executemany(
                "INSERT INTO items VALUES(?)", [(str(n) + ".0",) for n in range(1000)]
            )
            db.execute("INSERT INTO items VALUES('1000'),('1000.0')")
            values = [[str(n) + ".0"] for n in range(1000)] + [["1000"]]
            self.assertEqual(self.compare(db, "items", ["k"], values, True), "refused")

    def test_late_component_collision_is_not_hidden_by_distinct_composite_ids(self):
        with closing(memory_db()) as db:
            db.execute("CREATE TABLE items(k BLOB,tail TEXT)")
            db.executemany(
                "INSERT INTO items VALUES(?,?)", [(str(n), "text") for n in range(1100)]
            )
            db.execute('INSERT INTO items VALUES(1000,"integer")')
            declaration = {
                "entities": [
                    {"kind": "item", "source": "items", "key_columns": ["k", "tail"]}
                ],
                "relations": [
                    {
                        "name": "record",
                        "source": "items",
                        "key_columns": ["k", "tail"],
                        "roles": [
                            {"role": "tail", "column_name": "tail", "target_kind": None}
                        ],
                    }
                ],
            }
            with self.assertRaisesRegex(ValueError, "collision in component 'k'"):
                world.Model(db, declaration)

    def test_late_ambiguous_view_probe_with_distinct_storage_classes_is_refused(self):
        with closing(memory_db()) as db:
            db.executescript(
                "CREATE TABLE integers(k INTEGER); CREATE TABLE reals(k REAL);"
            )
            db.executemany(
                "INSERT INTO integers VALUES(?)", [(n,) for n in range(1100)]
            )
            db.executescript(
                "INSERT INTO integers VALUES(2000); INSERT INTO reals VALUES(2000.0); CREATE VIEW v AS SELECT k FROM integers UNION ALL SELECT k FROM reals;"
            )
            rows = db.execute("SELECT k,typeof(k) FROM v WHERE k=?", (2000,)).fetchall()
            self.assertEqual([r[1] for r in rows], ["integer", "real"])
            self.assertEqual(
                self.compare(db, "v", ["k"], [[n] for n in range(1100)] + [[2000]]),
                "refused",
            )

    def test_one_parameter_preserves_wide_composites_and_reserved_text(self):
        with closing(memory_db()) as db:
            db.execute("CREATE TABLE items(a TEXT,b INTEGER,c TEXT)")
            values = [["nul\0/% Ω", 1, "comma,:"], ["other", 2, ""]]
            db.executemany("INSERT INTO items VALUES(?,?,?)", values)
            db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 1)
            db.execute("PRAGMA query_only=ON")
            entry = {
                "source": "items",
                "keys": ["a", "b", "c"],
                "columns": world.Model._columns(db, "items"),
            }
            world._check_identity_lookups(db, entry, values, "test", match_keys=True)
            self.assertEqual(db.execute("PRAGMA query_only").fetchone()[0], 1)

    def test_automatic_indexes_disabled_use_bounded_fallback_or_refuse(self):
        with closing(memory_db()) as db:
            db.execute("CREATE TABLE items(k INTEGER)")
            db.executemany("INSERT INTO items VALUES(?)", [(n,) for n in range(65)])
            entry = {
                "source": "items",
                "keys": ["k"],
                "columns": world.Model._columns(db, "items"),
            }
            db.execute("PRAGMA automatic_index=OFF")
            with self.assertRaisesRegex(
                ValueError, "cannot plan indexed identity validation"
            ):
                world._check_identity_lookups(
                    db, entry, [[n] for n in range(65)], "test", match_keys=True
                )
            db.execute("DELETE FROM items WHERE k=64")
            db.execute("PRAGMA query_only=ON")
            world._check_identity_lookups(
                db, entry, [[n] for n in range(64)], "test", match_keys=True
            )

    def test_column_to_column_reference_equality_matches_original(self):
        for target_type in (
            "TEXT COLLATE NOCASE",
            "TEXT COLLATE RTRIM",
            "INTEGER",
            "NUMERIC",
            "BLOB",
        ):
            for participant_type in ("TEXT", "INTEGER", "BLOB"):
                with self.subTest(
                    target=target_type, participant=participant_type
                ), closing(memory_db()) as db:
                    db.execute("CREATE TABLE target(k " + target_type + ")")
                    db.execute("CREATE TABLE events(v " + participant_type + ")")
                    db.executemany(
                        "INSERT INTO target VALUES(?)",
                        [(v,) for v in ("ABC", "one ", 1)],
                    )
                    db.executemany(
                        "INSERT INTO events VALUES(?)",
                        [(v,) for v in ("abc", "one", "01", 1, "absent")],
                    )
                    db.execute("CREATE VIEW tv AS SELECT k FROM target")
                    db.execute("CREATE VIEW ev AS SELECT v FROM events")
                    for target in ("target", "tv"):
                        for source in ("events", "ev"):
                            expected = db.execute(
                                f"SELECT COUNT(*) FROM {source} s WHERE NOT EXISTS(SELECT 1 FROM {target} t WHERE t.k=s.v)"
                            ).fetchone()[0]
                            self.assertEqual(
                                world._count_dangling(
                                    db,
                                    source,
                                    "v",
                                    {"source": target, "keys": ["k"]},
                                    "test",
                                ),
                                expected,
                            )

    def test_callback_and_quoted_identifiers_leave_source_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.sqlite"
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE "weird""name"("key" TEXT)')
                db.execute('INSERT INTO "weird""name" VALUES(?)', ("nul\0/% Ω",))
                db.commit()
            before = path.read_bytes()
            with closing(world.connect(path)) as db:
                self.assertEqual(
                    self.compare(db, 'weird"name', ["key"], [["nul\0/% Ω"]], True),
                    "accepted",
                )
                functions_before = {
                    r[0]
                    for r in db.execute("PRAGMA function_list")
                    if r[0].startswith("_ki_probe_")
                }
                entry = {
                    "source": 'weird"name',
                    "keys": ["key"],
                    "columns": world.Model._columns(db, 'weird"name'),
                }
                with self.assertRaises(ValueError):
                    world._check_identity_lookups(db, entry, [["absent"]], "test")
                # Unregistering a Python function leaves a NULL implementation
                # in SQLite's function registry, but none remains callable.
                for name in {
                    r[0]
                    for r in db.execute("PRAGMA function_list")
                    if r[0].startswith("_ki_probe_")
                } - functions_before:
                    with self.assertRaises(sqlite3.OperationalError):
                        db.execute("SELECT " + name + "(0,0)").fetchone()
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute('DELETE FROM "weird""name"')
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(path.parent.glob(path.name + "-*")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

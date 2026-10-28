"""Reproducible bounded discovery measurements; disposable unindexed fixture.

Run: python3 -m adapters.source.benchmark_search
Instrumentation replaces only the progress callback, retaining its thresholds.
Counts are 1000-instruction ticks, not exact instruction counts. Timing includes
metadata, identity verification when cold, size preflight, query and lookahead.
"""
import hashlib
import json
import sqlite3
import tempfile
import time
from pathlib import Path
from adapters.source.server import SessionManager, dispatch
from adapters.source.model import SourceError


def fingerprint(path):
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'mtime_ns': path.stat().st_mtime_ns,
            'sidecars': sorted(p.name for p in path.parent.glob(path.name + '-*'))}


def measure(path, cases):
    before = fingerprint(path)
    manager = SessionManager(path)
    token = manager.initial_session
    reader = manager.sessions[token]['reader']
    phases = []
    def instrument(db):
        phase = {'vm_tick_steps': 0}
        phases.append(phase)
        started = time.monotonic()
        def progress():
            phase['vm_tick_steps'] += 1000
            return phase['vm_tick_steps'] > reader.vm_steps or time.monotonic() - started > reader.query_seconds
        db.set_progress_handler(progress, 1000)
    reader.reset_budget = instrument
    results = []
    try:
        for label, params, budget in cases:
            reader.vm_steps = budget
            for repeat in range(3):
                phases.clear()
                started = time.perf_counter()
                try:
                    result = dispatch(manager, '/source/v1/search', {
                        'session':[token], 'generation':[manager.descriptor(token)['generation']],
                        **{k:[str(v)] for k,v in params.items()}})['data']
                    outcome = {'returned':result['returned'], 'completion':result['completion'],
                               'identity':result['identity']['status']}
                except SourceError as error:
                    outcome = {'error':error.code}
                results.append({'case':label, 'repeat':repeat, 'ms':round((time.perf_counter()-started)*1000,3),
                                'vm_budget_per_phase':budget, 'phases':list(phases), **outcome})
        plans = {}
        with manager.lease(token, manager.descriptor(token)['generation']) as (_, _, db):
            table = 'Track' if path.name.startswith('Chinook') else 'indexed'
            field = 'TrackId' if table == 'Track' else 'id'
            plans['exact'] = [r[3] for r in db.execute(f'EXPLAIN QUERY PLAN SELECT * FROM "{table}" WHERE "{field}"=? AND typeof("{field}")=? LIMIT 50', (10,'integer'))]
            if table == 'indexed':
                plans['substring'] = [r[3] for r in db.execute("EXPLAIN QUERY PLAN SELECT * FROM unindexed WHERE typeof(v)='text' AND instr(v,?)>0 LIMIT 50", ('needle',))]
    finally:
        manager.close()
    after = fingerprint(path)
    assert before == after
    return {'producer':str(path), 'before':before, 'after':after, 'plans':plans, 'measurements':results}


def main():
    key = lambda field: json.dumps([{'column':field,'storage_class':'integer','exact':'10'}])
    reports = []
    chinook = Path('examples/chinook/data/Chinook_Sqlite.sqlite')
    if chinook.exists():
        reports.append(measure(chinook, [
            ('Chinook broad Evil Walks', {'table':'Track','text':'Evil Walks'},10_000_000),
            ('Chinook exact TrackId', {'table':'Track','mode':'primary_key','key':key('TrackId')},10_000_000)]))
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)/'large.sqlite'
        db = sqlite3.connect(path)
        db.executescript('CREATE TABLE indexed(id INTEGER PRIMARY KEY,v); CREATE TABLE unindexed(v);')
        db.executemany('INSERT INTO indexed VALUES(?,?)', ((i, 'needle' if i % 10000 == 0 else 'haystack') for i in range(50000)))
        db.execute('INSERT INTO unindexed SELECT v FROM indexed')
        db.commit(); db.close()
        reports.append(measure(path, [
            ('50k indexed exact cold then warm', {'table':'indexed','mode':'primary_key','key':key('id')},10_000_000),
            ('50k unindexed sparse substring', {'table':'unindexed','text':'needle'},10_000_000),
            ('50k unindexed absent substring', {'table':'unindexed','text':'absent'},10_000_000),
            ('50k unindexed forced VM refusal', {'table':'unindexed','text':'absent'},10000)]))
    print(json.dumps({'sqlite_version':sqlite3.sqlite_version, 'rows_in_large_fixture':50000, 'reports':reports}, indent=2))

if __name__ == '__main__':
    main()

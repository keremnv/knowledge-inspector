"""Reproducible capture/read probes. No frozen-source writes.

python3 adapters/source/benchmark_source.py --chinook examples/chinook/data/Chinook_Sqlite.sqlite --repeats 3 --fanout 100000
"""
from __future__ import annotations
import argparse
import hashlib
import json
import resource
import sqlite3
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))
from adapters.source.server import SessionManager,dispatch
from adapters.source.model import SourceError


def state(path):
    return {'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'mtime_ns':path.stat().st_mtime_ns,
            'sidecars':sorted(p.name for p in path.parent.glob(path.name+'-*'))}


def measure(path,table,record_index,repeats):
    before=state(path);runs=[]
    for _ in range(repeats):
        m=SessionManager(path)
        try:
            token=m.initial_session;c=m.sessions[token]['capture'];r=m.sessions[token]['reader']
            context=m.descriptor(token)
            q={'session':[token],'generation':[c.generation]}
            def read(route,**options):
                return dispatch(m,'/source/v1/'+route,{**q,**{k:[str(v)] for k,v in options.items()}})
            def clock(fn):
                started=time.perf_counter();value=fn();return value,time.perf_counter()-started
            schema,schema_s=clock(lambda:read('schema',limit=100))
            rows,first_page_s=clock(lambda:read('rows',table=table,limit=100))
            handle=rows['data']['rows'][record_index]['record_id']
            _,page_s=clock(lambda:read('rows',table=table,limit=100))
            record,record_s=clock(lambda:read('record',id=handle))
            refs,refs_s=clock(lambda:read('references',record=handle))
            started=time.perf_counter()
            try:read('references',record=handle,direction='incoming')
            except SourceError as failure:incoming=failure.code
            incoming_s=time.perf_counter()-started
            runs.append({'capture_bytes':c.snapshot_path.stat().st_size,
                         'capture_digest':c.digest,**c.timings,
                         'schema_response_s':schema_s,'schema_discovery_s':r.metrics['schema_discovery_s'],
                         'first_page_including_verification_s':first_page_s,
                         'full_key_verification_s':r.metrics.get(f'key_verification:{table}:s'),
                         'warm_page_s':page_s,'record_s':record_s,'outgoing_s':refs_s,
                         'page_json_bytes':len(json.dumps(rows).encode()),
                         'registered_records':len(r.records),
                         'registered_key_payload_bytes':r._registered_bytes,
                         'incoming_refusal':incoming,'incoming_refusal_s':incoming_s})
        finally:m.close()
    after=state(path)
    assert before==after,'producer changed'
    numeric={k:statistics.median(run[k] for run in runs) for k,v in runs[0].items() if type(v) in (int,float)}
    # Separate memory probe: do not mix tracemalloc overhead into timings.
    tracemalloc.start();m=SessionManager(path,reader_options={"query_seconds":60})
    try:
        q={'session':[m.initial_session],'generation':[m.sessions[m.initial_session]['capture'].generation],'table':[table],'limit':['100']}
        memory_page=dispatch(m,'/source/v1/rows',q)
        assert memory_page['data']['identity']['status']=='verified',memory_page['data']['identity']
        peak=tracemalloc.get_traced_memory()[1]
    finally:m.close();tracemalloc.stop()
    return {'source_state_before':before,'source_state_after':after,'table':table,
            'runs':runs,'medians':numeric,'python_tracemalloc_peak_bytes_separate_run':peak,
            'process_maxrss_kib_cumulative':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--chinook',type=Path,required=True);p.add_argument('--repeats',type=int,default=3)
    p.add_argument('--fanout',type=int,default=100000);args=p.parse_args()
    result={'python':sys.version,'sqlite':sqlite3.sqlite_version,'chinook':measure(args.chinook,'Track',9,args.repeats)}
    with tempfile.TemporaryDirectory() as tmp:
        path=Path(tmp)/'fanout.sqlite';db=sqlite3.connect(path)
        db.executescript('CREATE TABLE Hub(id INTEGER PRIMARY KEY);INSERT INTO Hub VALUES(1);CREATE TABLE Fan(id INTEGER PRIMARY KEY,hub INTEGER REFERENCES Hub(id),payload TEXT);CREATE INDEX fan_hub ON Fan(hub);')
        db.executemany('INSERT INTO Fan VALUES(?,1,?)',((i,'x'*256) for i in range(args.fanout)))
        db.commit();db.close()
        result['fanout']=measure(path,'Fan',0,args.repeats)
        from contextlib import closing
        with closing(sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)) as oracle:
            started=time.perf_counter();page=oracle.execute('SELECT id FROM Fan WHERE hub=? ORDER BY id LIMIT 100',(1,)).fetchall()
            result['fanout']['homogeneous_integer_probe']={'page_rows':len(page),'page_s':time.perf_counter()-started,
                'plan':[r[3] for r in oracle.execute('EXPLAIN QUERY PLAN SELECT id FROM Fan WHERE hub=? ORDER BY id LIMIT 100',(1,))]}
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()

import sqlite3
print('SQLite',sqlite3.sqlite_version)
db=sqlite3.connect(':memory:')
db.executescript("CREATE TABLE p(code TEXT PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY, code REAL REFERENCES p(code)); INSERT INTO p VALUES ('0.3'); INSERT INTO c(code) VALUES(0.3),(0.1+0.2);")
print('real-to-text',list(db.execute('SELECT id,CAST(code AS TEXT) FROM c')))
print('foreign_key_check',list(db.execute('PRAGMA foreign_key_check')))
print('parent-affinity matches',list(db.execute('SELECT c.id FROM p,c WHERE p.code=+c.code ORDER BY c.id')))
db.executescript("CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1),(2); CREATE TABLE big(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id), pad TEXT);")
db.executemany('INSERT INTO big(p,pad) VALUES (?,?)',[(2,'x'*20)]*29998+[(1,'x'*20)]*2)
sql='''SELECT rowid FROM big WHERE NOT (typeof(big.p)='blob' AND length(big.p)>1048576) AND EXISTS (SELECT 1 FROM parent AS ki_parent WHERE ki_parent.id = ? AND typeof(ki_parent.id) = ? AND ki_parent.id = +big.p) ORDER BY id LIMIT ? OFFSET ?'''
counter=[0]
def count():counter[0]+=100;return 0
db.set_progress_handler(count,100)
rows=list(db.execute(sql,(1,'integer',51,0)));db.set_progress_handler(None,0)
print('sparse result',rows,'approx VM steps',counter[0]);print('plan',list(db.execute('EXPLAIN QUERY PLAN '+sql,(1,'integer',51,0))))

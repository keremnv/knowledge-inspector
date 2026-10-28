-- Disposable acceptance fixture. Never applied to a producer database.
CREATE TABLE Parent(id INTEGER PRIMARY KEY, child_id INTEGER REFERENCES Child(id));
CREATE TABLE Child(id INTEGER PRIMARY KEY,
 parent_slot_0 INTEGER REFERENCES Parent(id), parent_slot_1 INTEGER REFERENCES Parent(id),
 parent_slot_2 INTEGER REFERENCES Parent(id), parent_slot_3 INTEGER REFERENCES Parent(id),
 parent_slot_4 INTEGER REFERENCES Parent(id), parent_slot_5 INTEGER REFERENCES Parent(id),
 parent_slot_6 INTEGER REFERENCES Parent(id), parent_slot_7 INTEGER REFERENCES Parent(id));
INSERT INTO Parent VALUES(1,1);
INSERT INTO Child VALUES(1,1,1,1,1,1,1,1,1);
CREATE TABLE SelfLinks(id INTEGER PRIMARY KEY,
 self_0 INTEGER REFERENCES SelfLinks(id), self_1 INTEGER REFERENCES SelfLinks(id),
 self_2 INTEGER REFERENCES SelfLinks(id), self_3 INTEGER REFERENCES SelfLinks(id),
 self_4 INTEGER REFERENCES SelfLinks(id), self_5 INTEGER REFERENCES SelfLinks(id));
INSERT INTO SelfLinks VALUES(1,1,1,1,1,1,1);
CREATE TABLE LongUnnamed(a TEXT, b INTEGER, PRIMARY KEY(a,b));
INSERT INTO LongUnnamed VALUES('An exact recorded key with a deliberately long name / spaces / Ω / and no inferred display label',9007199254740993);
CREATE TABLE Track(TrackId INTEGER PRIMARY KEY, Name TEXT);
INSERT INTO Track VALUES(10,'This must not be inferred without the explicit demo policy');
CREATE TABLE ParentA(id INTEGER PRIMARY KEY); INSERT INTO ParentA VALUES(1);
CREATE TABLE ParentB(id INTEGER PRIMARY KEY); INSERT INTO ParentB VALUES(1);
CREATE TABLE Crowded(id INTEGER PRIMARY KEY,
 a_recorded_reference_with_a_deliberately_long_column_name INTEGER REFERENCES ParentA(id),
 another_recorded_reference_with_a_deliberately_long_column_name INTEGER REFERENCES ParentB(id));
INSERT INTO Crowded VALUES(1,1,1);

-- A synthetic source for the delta writer, SQLiteDeltaTests': items reply to items and belong
-- to parents, links tie items to tags, notes, refs, measures and lookups hang off items. Each
-- table is one of the rowid cases VACUUM tells apart, and delta-cascade.json names the tables
-- the delta holds, with predicates that read a table filled earlier, the table being filled, a
-- table filled later, a table held whole and a table left out (`left_out`, with its index and
-- the view). Every value is fake.
PRAGMA page_size=8192;
PRAGMA auto_vacuum=INCREMENTAL;
PRAGMA journal_mode=WAL;
PRAGMA user_version=7;
PRAGMA application_id=1515;
CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, parent INTEGER, reply INTEGER, body BLOB);
CREATE INDEX item_parent ON item (parent);
CREATE TABLE tag (id INTEGER PRIMARY KEY, label TEXT);
CREATE TABLE link (item INTEGER, tag INTEGER, PRIMARY KEY (item, tag));
CREATE TABLE note (item INTEGER, text TEXT);
CREATE TABLE loose (k TEXT, v REAL);
CREATE TABLE ref (k TEXT PRIMARY KEY, item INTEGER) WITHOUT ROWID;
CREATE TABLE measure (id INTEGER PRIMARY KEY, a INTEGER, twice INTEGER GENERATED ALWAYS AS (a * 2) STORED);
CREATE TABLE emptied (id INTEGER PRIMARY KEY, x TEXT);
CREATE TABLE lookup (item INTEGER REFERENCES item (id) ON DELETE CASCADE, k TEXT);
CREATE INDEX lookup_item ON lookup (item);
CREATE TABLE left_out (n INTEGER, why TEXT);
CREATE INDEX left_out_n ON left_out (n);
CREATE VIEW item_names AS SELECT item.id, parent.name FROM item JOIN parent ON parent.id = item.parent;
CREATE TRIGGER item_gone AFTER DELETE ON item BEGIN SELECT application_only_function(OLD.id); END;
INSERT INTO parent (id, name) VALUES (1, 'keep-one'), (2, 'other'), (5, 'other'), (8, 'keep-two');
DELETE FROM parent WHERE id = 8;
INSERT INTO tag VALUES (1, 'pinned'), (2, 'plain'), (3, 'plain');
INSERT INTO loose VALUES ('a', 1.5), ('b', 2.0), ('c', 1), ('d', NULL);
DELETE FROM loose WHERE k = 'b';
INSERT INTO emptied VALUES (1, 'gone'), (2, 'gone');
INSERT INTO left_out VALUES (5, 'a parent no item names'), (40, 'nothing');
INSERT INTO item (id, parent, reply, body) VALUES (1, 2, NULL, X'010001'), (2, 5, NULL, X'020002'), (3, NULL, NULL, X'030003'), (4, 1, NULL, X'040004'), (5, 2, NULL, X'050005'), (6, 5, 2, X'060006'), (7, NULL, NULL, X'070007'), (8, 1, NULL, X'080008'), (9, 2, 5, X'090009'), (10, 5, NULL, X'0a000a'), (11, NULL, NULL, X'0b000b'), (12, 1, 8, X'0c000c');
INSERT INTO link VALUES (1, 2), (2, 3), (3, 1), (4, 2), (5, 3), (6, 1), (7, 2), (8, 3), (9, 1), (10, 2), (11, 3), (12, 1);
INSERT INTO note VALUES (2, 'note 2'), (4, 'note 4'), (6, 'note 6'), (8, 'note 8'), (10, 'note 10'), (12, 'note 12');
INSERT INTO ref VALUES ('ref-01', 1), ('ref-02', 2), ('ref-03', 3), ('ref-04', 4), ('ref-05', NULL), ('ref-06', 6), ('ref-07', 7), ('ref-08', 8), ('ref-09', 9), ('ref-10', NULL), ('ref-11', 11), ('ref-12', 12);
INSERT INTO measure (id, a) VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12);
INSERT INTO lookup VALUES (1, 'k1'), (2, 'k2'), (3, 'k3'), (4, 'k4'), (5, 'k5'), (6, 'k6'), (7, 'k7'), (8, 'k8'), (9, 'k9'), (10, 'k10'), (11, 'k11'), (12, 'k12');
-- Rowids with gaps, where VACUUM keeps them and where it numbers them again.
DELETE FROM link WHERE item IN (2, 7);
DELETE FROM note WHERE item = 4;
INSERT INTO link VALUES (NULL, 3);
INSERT INTO note VALUES (NULL, 'orphan');
ANALYZE;

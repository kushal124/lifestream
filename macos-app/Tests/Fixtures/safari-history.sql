-- A synthetic store written by the home connector's own fixture builder
-- (packages/connect/browser/safari/test/fixture.ts), dumped, read by the Mac domain's tests and sealed
-- into the connector's changes fixture (packages/connect/browser/safari/test/changes-bundle.zip).
-- Every value is fake.
CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL UNIQUE,domain_expansion TEXT NULL,visit_count INTEGER NOT NULL,daily_visit_counts BLOB NOT NULL,weekly_visit_counts BLOB NULL,autocomplete_triggers BLOB NULL,should_recompute_derived_visit_counts INTEGER NOT NULL,visit_count_score INTEGER NOT NULL,status_code INTEGER NOT NULL DEFAULT 0);
INSERT INTO history_items VALUES(1,'https://example.com/a','example',2,X'00',NULL,NULL,0,20,200);
INSERT INTO history_items VALUES(2,'https://example.com/b','example',1,X'00',NULL,NULL,0,10,200);
INSERT INTO history_items VALUES(3,'https://example.org/c','example',1,X'00',NULL,NULL,0,10,200);
CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT,history_item INTEGER NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,visit_time REAL NOT NULL,title TEXT NULL,load_successful BOOLEAN NOT NULL DEFAULT 1,http_non_get BOOLEAN NOT NULL DEFAULT 0,synthesized BOOLEAN NOT NULL DEFAULT 0,redirect_source INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,redirect_destination INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,origin INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,attributes INTEGER NOT NULL DEFAULT 0,score INTEGER NOT NULL DEFAULT 0);
INSERT INTO history_visits VALUES(1,1,811584000.25,'Page A',1,0,0,NULL,NULL,0,1,0,10);
INSERT INTO history_visits VALUES(2,2,811584060.5,'Page B',1,0,0,NULL,NULL,1,1,0,10);
INSERT INTO history_visits VALUES(3,1,811584120.0,'Page A',1,0,0,NULL,NULL,1,1,0,10);
INSERT INTO history_visits VALUES(4,3,811584180.125,NULL,1,0,0,NULL,NULL,0,1,0,10);
CREATE TABLE history_tombstones (id INTEGER PRIMARY KEY AUTOINCREMENT,start_time REAL NOT NULL,end_time REAL NOT NULL,url TEXT,generation INTEGER NOT NULL DEFAULT 0, udid TEXT, attributes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value);
INSERT INTO metadata VALUES('current_generation',2);
CREATE TABLE history_tags (id INTEGER PRIMARY KEY,type INTEGER NOT NULL,level INTEGER NOT NULL,identifier TEXT NOT NULL,title TEXT NOT NULL,modification_timestamp REAL NOT NULL,item_count INTEGER NOT NULL DEFAULT 0);
INSERT INTO history_tags VALUES(1,0,0,'synthetic-topic','Synthetic',811584000.0,0);
CREATE TABLE history_items_to_tags (history_item INTEGER NOT NULL,tag_id INTEGER NOT NULL,timestamp REAL NOT NULL,FOREIGN KEY(tag_id) REFERENCES history_tags(id) ON DELETE CASCADE,FOREIGN KEY(history_item) REFERENCES history_items(id) ON DELETE CASCADE,UNIQUE(history_item, tag_id) ON CONFLICT REPLACE);
INSERT INTO history_items_to_tags VALUES(1,1,811584000.0);
INSERT INTO sqlite_sequence VALUES('history_items',3);
INSERT INTO sqlite_sequence VALUES('history_visits',4);
CREATE INDEX history_visits__last_visit ON history_visits (history_item, visit_time DESC, synthesized ASC);
CREATE INDEX history_tombstones__end_time ON history_tombstones (end_time);

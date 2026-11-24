CREATE TABLE reports (id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, report TEXT NOT NULL, shot INTEGER NOT NULL);
CREATE INDEX reports_at ON reports (at_ms);

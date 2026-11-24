

CREATE TABLE versions (
  id         TEXT PRIMARY KEY,
  text       ANY NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  start_ms   INTEGER,
  end_ms     INTEGER,
  offset_min INTEGER,
  precision  TEXT
) STRICT;

CREATE TABLE statements (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  version    TEXT NOT NULL,
  stated_ms  INTEGER NOT NULL,
  run        INTEGER NOT NULL,
  device     TEXT,
  locator    TEXT,
  origin     TEXT NOT NULL CHECK (origin IN ('source', 'repair')),
  late       INTEGER NOT NULL CHECK (late IN (0, 1))
) STRICT;
CREATE INDEX statements_record ON statements(kind, key, source, stated_ms);
CREATE INDEX statements_source ON statements(source, kind, seq);
CREATE INDEX statements_run ON statements(run);

CREATE TABLE heads (
  source    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  key       TEXT NOT NULL,
  version   TEXT NOT NULL,
  stated_ms INTEGER NOT NULL,
  since_ms  INTEGER NOT NULL,
  start_ms  INTEGER,
  end_ms    INTEGER,
  PRIMARY KEY (source, kind, key)
) STRICT, WITHOUT ROWID;
CREATE INDEX heads_time ON heads(source, kind, start_ms) WHERE version <> 'gone';

CREATE TABLE spans (
  source TEXT NOT NULL,
  kind   TEXT NOT NULL,
  max_ms INTEGER NOT NULL,
  day_ms INTEGER NOT NULL DEFAULT 0,
  live   INTEGER,
  PRIMARY KEY (source, kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE version_blobs (
  version TEXT NOT NULL,
  blob    TEXT NOT NULL,
  PRIMARY KEY (version, blob)
) STRICT, WITHOUT ROWID;
CREATE INDEX version_blobs_blob ON version_blobs(blob);

CREATE TABLE claims (
  source TEXT NOT NULL,
  kind   TEXT NOT NULL,
  key    TEXT NOT NULL,
  at_ms  INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (source, kind, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE wanted_blobs (
  blob   TEXT NOT NULL,
  source TEXT NOT NULL,
  kind   TEXT NOT NULL,
  key    TEXT NOT NULL,
  PRIMARY KEY (blob, source, kind, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE rereads (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  kind   TEXT,
  key    TEXT,
  family TEXT,
  unit   TEXT,
  CHECK ((source IS NOT NULL AND kind IS NOT NULL AND key IS NOT NULL AND family IS NULL AND unit IS NULL)
      OR (source IS NULL AND kind IS NULL AND key IS NULL AND family IS NOT NULL AND unit IS NOT NULL))
) STRICT;


CREATE TABLE sources (
  id              TEXT PRIMARY KEY,
  product         TEXT NOT NULL,
  vendor          TEXT NOT NULL,
  account         TEXT NOT NULL,
  copy            TEXT NOT NULL,
  connector       TEXT NOT NULL,
  options         TEXT NOT NULL,
  read_through_ms INTEGER,
  added_ms        INTEGER NOT NULL
) STRICT;

CREATE TABLE devices (
  unit       TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  added_ms   INTEGER NOT NULL,
  retired_ms INTEGER
) STRICT;

CREATE TABLE polls (
  acquirer     TEXT PRIMARY KEY,
  state        TEXT NOT NULL,
  next_ms      INTEGER NOT NULL,
  last_ok_ms   INTEGER,
  error        TEXT,
  paged_ms     INTEGER,
  page_error   TEXT,
  page_next_ms INTEGER,
  held_ms      INTEGER,
  source       TEXT,
  pages        INTEGER,
  hand         INTEGER
) STRICT;

CREATE TABLE deliveries (
  id        TEXT NOT NULL,
  source    TEXT NOT NULL,
  sealed_ms INTEGER NOT NULL,
  stated_ms INTEGER NOT NULL,
  facts     TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('sealed', 'importing', 'imported', 'failed', 'dead', 'superseded')),
  run       INTEGER,
  failures  INTEGER NOT NULL DEFAULT 0,
  error     TEXT,
  retry_ms  INTEGER,
  pass      TEXT,
  seal      INTEGER,
  lost      TEXT,
  refused   INTEGER NOT NULL DEFAULT 0,
  read_by   TEXT,
  PRIMARY KEY (id, source)
) STRICT;
CREATE INDEX deliveries_state ON deliveries(state, sealed_ms);
CREATE INDEX deliveries_source ON deliveries(source, state);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  subject       TEXT NOT NULL,
  started_ms    INTEGER NOT NULL,
  ended_ms      INTEGER,
  outcome       TEXT,
  counts        TEXT,
  changed_paths TEXT,
  error         TEXT
) STRICT;

CREATE TABLE cursors (
  name        TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  reread      INTEGER NOT NULL DEFAULT 0,
  at_ms       INTEGER NOT NULL,
  fingerprint TEXT,
  generation  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  key           TEXT NOT NULL,
  lane          INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'dead')),
  not_before_ms INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  requeue       INTEGER NOT NULL DEFAULT 0,
  progress      TEXT,
  created_ms    INTEGER NOT NULL,
  started_ms    INTEGER,
  ended_ms      INTEGER,
  error         TEXT,
  connector     TEXT,
  UNIQUE (kind, key)
) STRICT;
CREATE INDEX jobs_due ON jobs(state, lane, not_before_ms, id);

CREATE TABLE controls (
  target TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  at_ms  INTEGER NOT NULL,
  by     TEXT
) STRICT;

CREATE TABLE grants (
  id         INTEGER PRIMARY KEY,
  family     TEXT NOT NULL,
  from_ms    INTEGER,
  to_ms      INTEGER,
  unit       TEXT,
  newest     INTEGER NOT NULL CHECK (newest IN (0, 1)),
  measure    TEXT NOT NULL CHECK (measure IN ('calls', 'usd')),
  per_day    REAL,
  total      REAL,
  rank       INTEGER NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('active', 'paused', 'cancelled')),
  reason     TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  changed_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms  INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  key    TEXT NOT NULL,
  detail TEXT
) STRICT;
CREATE INDEX events_at ON events(at_ms);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;


CREATE TABLE extracts (
  family   TEXT NOT NULL,
  unit     TEXT NOT NULL,
  reading  TEXT NOT NULL,
  code     TEXT NOT NULL,
  content  ANY NOT NULL,
  start_ms INTEGER,
  end_ms   INTEGER,
  days     TEXT NOT NULL,
  items    TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (family, unit)
) STRICT;
CREATE INDEX extracts_time ON extracts(family, start_ms, end_ms);

CREATE TABLE extract_days (
  family TEXT NOT NULL,
  unit   TEXT NOT NULL,
  day    TEXT NOT NULL,
  PRIMARY KEY (family, unit, day)
) STRICT, WITHOUT ROWID;
CREATE INDEX extract_days_day ON extract_days(family, day);

CREATE TABLE extract_items (
  family TEXT NOT NULL,
  item   TEXT NOT NULL,
  unit   TEXT NOT NULL,
  PRIMARY KEY (family, item, unit)
) STRICT, WITHOUT ROWID;
CREATE INDEX extract_items_unit ON extract_items(family, unit);

CREATE TABLE day_units (
  family  TEXT NOT NULL,
  unit    TEXT NOT NULL,
  day     TEXT NOT NULL,
  reading TEXT NOT NULL,
  code    TEXT NOT NULL,
  shown   INTEGER NOT NULL CHECK (shown IN (0, 1)),
  PRIMARY KEY (family, unit, day)
) STRICT, WITHOUT ROWID;
CREATE INDEX day_units_day ON day_units(day);


CREATE TABLE dirty_days (
  day   TEXT PRIMARY KEY,
  marks INTEGER NOT NULL DEFAULT 1,
  error TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX dirty_days_set_aside ON dirty_days(day) WHERE error IS NOT NULL;
CREATE TABLE dirty_units (
  family TEXT NOT NULL,
  unit   TEXT NOT NULL,
  end_ms INTEGER,
  woken  INTEGER NOT NULL DEFAULT 0 CHECK (woken IN (0, 1)),
  marks  INTEGER NOT NULL DEFAULT 1,
  error  TEXT,
  PRIMARY KEY (family, unit)
) STRICT, WITHOUT ROWID;
CREATE INDEX dirty_units_urgency ON dirty_units(family, woken, coalesce(end_ms, 9007199254740991)) WHERE error IS NULL;
CREATE INDEX dirty_units_set_aside ON dirty_units(family, unit) WHERE error IS NOT NULL;

CREATE TRIGGER extracts_insert AFTER INSERT ON extracts BEGIN
  INSERT INTO extract_days (family, unit, day) SELECT new.family, new.unit, value FROM json_each(new.days) WHERE true ON CONFLICT DO NOTHING;
  INSERT INTO extract_items (family, item, unit) SELECT new.family, value, new.unit FROM json_each(new.items) WHERE true ON CONFLICT DO NOTHING;
  INSERT INTO dirty_days (day) SELECT value FROM json_each(new.days) UNION SELECT day FROM day_units WHERE family = new.family AND unit = new.unit
    ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
  INSERT INTO dirty_units (family, unit, end_ms) VALUES (new.family, new.unit, new.end_ms) ON CONFLICT DO UPDATE SET end_ms = excluded.end_ms, marks = marks + 1, error = NULL;
END;
CREATE TRIGGER extracts_update AFTER UPDATE ON extracts BEGIN
  DELETE FROM extract_days WHERE family = old.family AND unit = old.unit;
  INSERT INTO extract_days (family, unit, day) SELECT new.family, new.unit, value FROM json_each(new.days) WHERE true ON CONFLICT DO NOTHING;
  DELETE FROM extract_items WHERE family = old.family AND unit = old.unit;
  INSERT INTO extract_items (family, item, unit) SELECT new.family, value, new.unit FROM json_each(new.items) WHERE true ON CONFLICT DO NOTHING;
  INSERT INTO dirty_days (day) SELECT value FROM json_each(old.days) UNION SELECT value FROM json_each(new.days)
    UNION SELECT day FROM day_units WHERE family = new.family AND unit = new.unit ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
  INSERT INTO dirty_units (family, unit, end_ms) VALUES (new.family, new.unit, new.end_ms) ON CONFLICT DO UPDATE SET end_ms = excluded.end_ms, marks = marks + 1, error = NULL;
END;
CREATE TRIGGER extracts_delete AFTER DELETE ON extracts BEGIN
  DELETE FROM extract_days WHERE family = old.family AND unit = old.unit;
  DELETE FROM extract_items WHERE family = old.family AND unit = old.unit;
  INSERT INTO dirty_days (day) SELECT value FROM json_each(old.days) UNION SELECT day FROM day_units WHERE family = old.family AND unit = old.unit
    ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
END;

CREATE TABLE enrichments (
  family      TEXT NOT NULL,
  item        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  input_hash  TEXT NOT NULL,
  reply_key   TEXT,
  reused_from TEXT,
  content     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'done', 'refused', 'given-up')),
  unit        TEXT,
  at_ms       INTEGER,
  started     INTEGER NOT NULL DEFAULT 0 CHECK (started IN (0, 1)),
  model       TEXT,
  PRIMARY KEY (family, item, prompt)
) STRICT;
CREATE INDEX enrichments_waiting ON enrichments(family, reply_key) WHERE state = 'pending';
CREATE INDEX enrichments_owed ON enrichments(family, started, coalesce(at_ms, 9007199254740991), unit, item, prompt) WHERE state = 'pending';

CREATE TRIGGER enrichments_insert AFTER INSERT ON enrichments BEGIN
  INSERT INTO dirty_days (day) SELECT d.day FROM extract_items i JOIN extract_days d ON d.family = i.family AND d.unit = i.unit
    WHERE i.family = new.family AND i.item = new.item ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
END;
CREATE TRIGGER enrichments_update AFTER UPDATE ON enrichments BEGIN
  INSERT INTO dirty_days (day) SELECT d.day FROM extract_items i JOIN extract_days d ON d.family = i.family AND d.unit = i.unit
    WHERE i.family = new.family AND i.item = new.item ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
END;
CREATE TRIGGER enrichments_delete AFTER DELETE ON enrichments BEGIN
  INSERT INTO dirty_days (day) SELECT d.day FROM extract_items i JOIN extract_days d ON d.family = i.family AND d.unit = i.unit
    WHERE i.family = old.family AND i.item = old.item ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
  INSERT INTO dirty_units (family, unit, end_ms) SELECT e.family, e.unit, e.end_ms FROM extract_items i
    JOIN extracts e ON e.family = i.family AND e.unit = i.unit WHERE i.family = old.family AND i.item = old.item
    ON CONFLICT DO UPDATE SET end_ms = excluded.end_ms, marks = marks + 1, error = NULL;
END;

CREATE INDEX deliveries_custody ON deliveries(source, pass, state, seal);
CREATE INDEX deliveries_lost ON deliveries(sealed_ms) WHERE lost IS NOT NULL;

CREATE TABLE inbox_days (lane TEXT NOT NULL, day INTEGER NOT NULL, deliveries INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (lane, day)) STRICT, WITHOUT ROWID;
CREATE INDEX enrichments_given_up ON enrichments(family, item) WHERE state = 'given-up';
CREATE INDEX deliveries_sealed ON deliveries(source, sealed_ms);
CREATE INDEX deliveries_pass ON deliveries(pass, sealed_ms) WHERE pass IS NOT NULL;
CREATE INDEX runs_started ON runs(kind, started_ms);
CREATE INDEX heads_long ON heads(source, kind, start_ms) WHERE version <> 'gone' AND end_ms - start_ms > 86400000;
CREATE INDEX deliveries_lane ON deliveries(source, id);
CREATE INDEX wanted_blobs_record ON wanted_blobs(source, kind, key);
CREATE TABLE landed (source TEXT PRIMARY KEY, records INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE landed_minutes (source TEXT NOT NULL, minute INTEGER NOT NULL, records INTEGER NOT NULL, PRIMARY KEY (source, minute)) STRICT, WITHOUT ROWID;
CREATE INDEX deliveries_seals ON deliveries(pass, sealed_ms) WHERE seal IS NOT NULL;
CREATE INDEX extracts_reading ON extracts(family, unit, reading, code);
CREATE TABLE extracts_next (family TEXT NOT NULL, unit TEXT NOT NULL, reading TEXT NOT NULL, code TEXT NOT NULL, content ANY NOT NULL,
         start_ms INTEGER, end_ms INTEGER, days TEXT NOT NULL, items TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (family, unit)) STRICT;
CREATE INDEX extracts_next_time ON extracts_next(family, start_ms, end_ms);
CREATE INDEX deliveries_unread ON deliveries(source, read_by) WHERE (refused > 0 OR state = 'dead');
CREATE TABLE start_minutes (source TEXT NOT NULL, kind TEXT NOT NULL, minute INTEGER NOT NULL, records INTEGER NOT NULL, PRIMARY KEY (source, kind, minute)) STRICT, WITHOUT ROWID;
CREATE TABLE backfills (source TEXT PRIMARY KEY, acquirer TEXT NOT NULL, left INTEGER, unit TEXT, reach TEXT NOT NULL, recent TEXT NOT NULL, last TEXT) STRICT;
CREATE TABLE custody (pass TEXT NOT NULL, source TEXT NOT NULL, imported INTEGER NOT NULL, PRIMARY KEY (pass, source)) STRICT, WITHOUT ROWID;
CREATE INDEX deliveries_seal ON deliveries(pass, source, seal) WHERE seal IS NOT NULL;
CREATE TABLE days (day TEXT NOT NULL, inputs TEXT NOT NULL, counts TEXT NOT NULL, PRIMARY KEY (day)) STRICT, WITHOUT ROWID;
CREATE TABLE attempts (target TEXT NOT NULL, source TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, facts TEXT NOT NULL,
        detail TEXT, since_ms INTEGER NOT NULL, at_ms INTEGER NOT NULL, contact_ms INTEGER, fails INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (target, source)) STRICT, WITHOUT ROWID;
CREATE INDEX deliveries_waiting ON deliveries(source, CASE WHEN pass IS NULL THEN stated_ms ELSE sealed_ms END, sealed_ms, id) WHERE state IN ('sealed', 'importing', 'failed');
CREATE INDEX deliveries_left ON deliveries(source, sealed_ms) WHERE json_extract(facts, '$.left') IS NOT NULL;
CREATE INDEX deliveries_owed ON deliveries(source, sealed_ms) WHERE json_extract(facts, '$.owed') IS NOT NULL;
CREATE INDEX deliveries_losses ON deliveries(source, run) WHERE lost IS NOT NULL;
CREATE TABLE erasures (account TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, at_ms INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (account, kind, key)) STRICT, WITHOUT ROWID;
CREATE TABLE extracts_aside (family TEXT NOT NULL, unit TEXT NOT NULL, error TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (family, unit)) STRICT;
CREATE INDEX extracts_aside_since ON extracts_aside(family, at_ms);
CREATE TABLE asks (family TEXT NOT NULL, item TEXT NOT NULL, prompt TEXT NOT NULL, prompt_hash TEXT NOT NULL, input_hash TEXT NOT NULL,
        unit TEXT NOT NULL, work_id TEXT, at_key INTEGER NOT NULL, started INTEGER NOT NULL CHECK (started IN (0, 1)), waits TEXT,
        retry_ms INTEGER, given_up TEXT, state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'given-up')), prompt_version INTEGER,
        PRIMARY KEY (family, item, prompt)) STRICT, WITHOUT ROWID;
CREATE INDEX asks_pick ON asks(work_id, started, at_key, unit, item, prompt, family) WHERE state = 'pending';
CREATE INDEX asks_hashes ON asks(input_hash) WHERE state = 'pending';
CREATE INDEX asks_waits ON asks(waits) WHERE waits IS NOT NULL;
CREATE INDEX asks_given_up ON asks(work_id) WHERE state = 'given-up';
CREATE INDEX asks_units ON asks(family, unit);
CREATE TABLE item_routes (family TEXT NOT NULL, item TEXT NOT NULL, prompt TEXT NOT NULL, route TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (family, item)) STRICT, WITHOUT ROWID;

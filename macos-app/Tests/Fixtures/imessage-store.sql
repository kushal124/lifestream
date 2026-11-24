-- A synthetic chat.db in the columns the home's connector reads, read by the iMessage domain's
-- tests and sealed into the connector's changes fixture
-- (packages/connect/messages/imessage/test/changes-bundle.zip). Seals are made at
-- 2026-09-23T04:00:00Z; message 101 is older than the live span, 102 inside it. Chat 2 holds no
-- message. The attachment files are written by the test. Every value is fake.
CREATE TABLE _SqliteDatabaseProperties (key TEXT, value TEXT, UNIQUE(key));
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT,
  properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0,
  last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER, successful_query INTEGER,
  last_read_message_timestamp INTEGER DEFAULT 0
);
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT NOT NULL, text TEXT, replace INTEGER DEFAULT 0,
  service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0,
  type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER,
  date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0,
  is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0,
  is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
  is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0,
  did_notify_recipient INTEGER DEFAULT 0, cache_roomnames TEXT, associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0, message_summary_info BLOB, date_edited INTEGER DEFAULT 0,
  date_retracted INTEGER DEFAULT 0, flags INTEGER DEFAULT 0
);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, filename TEXT,
  uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, transfer_name TEXT, total_bytes INTEGER DEFAULT 0
);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
CREATE TABLE sync_chat_slice (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, service_name TEXT, chat_id TEXT, slice BLOB);
CREATE INDEX chat_message_join_idx_message_id_only ON chat_message_join (message_id);
CREATE INDEX message_attachment_join_idx_message_id ON message_attachment_join (message_id);
CREATE INDEX chat_handle_join_idx_handle_id ON chat_handle_join (handle_id);
CREATE TRIGGER after_delete_on_message AFTER DELETE ON message BEGIN SELECT after_delete_message_plugin(OLD.ROWID); END;
INSERT INTO _SqliteDatabaseProperties (key, value) VALUES ('_ClientVersion', '19201'), ('counter_in_all', '9');
INSERT INTO handle (ROWID, id, country, service) VALUES (1, '+15550000002', 'us', 'iMessage'), (2, 'person-b@example.com', NULL, 'iMessage');
INSERT INTO chat (ROWID, guid, style, state, chat_identifier, service_name, display_name) VALUES
  (1, 'iMessage;-;+15550000002', 45, 3, '+15550000002', 'iMessage', NULL),
  (2, 'iMessage;+;chat000000000000000001', 43, 3, 'chat000000000000000001', 'iMessage', 'Synthetic Group');
INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2);
INSERT INTO message (ROWID, guid, text, handle_id, service, account, date, is_from_me, is_read, flags) VALUES
  (101, 'SYNTH-MSG-101', 'synthetic old message', 1, 'iMessage', 'e:person-a@example.com', 800000000123456789, 0, 1, 5),
  (102, 'SYNTH-MSG-102', 'synthetic new message', 0, 'iMessage', 'e:person-a@example.com', 811500000123456789, 1, 0, 5);
INSERT INTO chat_message_join VALUES (1, 101, 800000000123456789), (1, 102, 811500000123456789);
INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES
  (1, 'SYNTH-ATTACHMENT-1', '~/Library/Messages/Attachments/aa/01/old.jpg', 'image/jpeg', 'old.jpg', 9),
  (2, 'SYNTH-ATTACHMENT-2', '~/Library/Messages/Attachments/bb/02/new.jpg', 'image/jpeg', 'new.jpg', 9);
INSERT INTO message_attachment_join VALUES (101, 1), (102, 2);
INSERT INTO sync_chat_slice (service_name, chat_id, slice) VALUES ('iMessage', 'chat000000000000000001', X'00');

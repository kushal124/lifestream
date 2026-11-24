import Database from "better-sqlite3";
import type { Fixture } from "../../../test/drive.js";

export const UNIT = "macbook-pro-0001";
export const SOURCE = `apple-calendar:person-a@example.com:${UNIT}`;
export const DAY0 = 811_555_200;
export const DAY = 86_400;
export const SEQUENCE = 41;

const SCHEMA = [
  "CREATE TABLE Store (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, notes TEXT, " +
    "default_alarm_offset INTEGER, type INTEGER, constraint_path TEXT, disabled INTEGER, external_id " +
    "TEXT, persistent_id TEXT, flags INTEGER, creator_bundle_id TEXT, creator_code_signing_identity TEXT, " +
    "only_creator_can_modify INTEGER, external_mod_tag TEXT, preferred_event_private_value INTEGER, " +
    "strictest_event_private_value INTEGER, last_sync_start REAL, last_sync_end REAL, " +
    "delegated_account_owner_store_id TEXT, delegated_account_default_calendar_for_new_events_id INTEGER, " +
    "shows_notifications INTEGER, flags2 INTEGER, display_order INTEGER, owner_name TEXT, " +
    "default_all_day_alarm_offset INTEGER, error_id INTEGER, cached_external_info BLOB, app_group_id TEXT " +
    "UNIQUE)",
  "CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, title TEXT, flags " +
    "INTEGER, color TEXT, symbolic_color_name TEXT, color_is_display INTEGER, type TEXT, " +
    "supported_entity_types INTEGER, external_id TEXT, external_mod_tag TEXT, external_id_tag TEXT, " +
    "external_rep BLOB, display_order INTEGER, UUID TEXT, shared_owner_name TEXT, shared_owner_address " +
    "TEXT, cached_external_info BLOB, sharing_status INTEGER, sharing_invitation_response INTEGER, " +
    "published_URL TEXT, is_published INTEGER, invitation_status INTEGER, sync_token TEXT, " +
    "self_identity_id INTEGER, self_identity_email TEXT, self_identity_phone_number TEXT, " +
    "owner_identity_id INTEGER, owner_identity_email TEXT, owner_identity_phone_number TEXT, notes TEXT, " +
    "bulk_requests BLOB, subcal_account_id TEXT, push_key TEXT, digest BLOB, refresh_date REAL, " +
    "subscription_id TEXT, last_sync_start REAL, last_sync_end REAL, subcal_url TEXT, refresh_interval " +
    "INTEGER, pubcal_account_id TEXT, error_id INTEGER, max_attendees INTEGER, last_sync_title TEXT, " +
    "locale TEXT, image_id INTEGER)",
  "CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, location_id " +
    "INTEGER, client_location_id INTEGER, description TEXT, start_date REAL, start_tz TEXT, end_date " +
    "REAL, end_tz TEXT, all_day INTEGER, calendar_id INTEGER, orig_item_id INTEGER, orig_date REAL, " +
    "organizer_id INTEGER, self_attendee_id INTEGER, status INTEGER, invitation_status INTEGER, " +
    "availability INTEGER, privacy_level INTEGER, url TEXT, last_modified REAL, sequence_num INTEGER, " +
    "birthday_id INTEGER, modified_properties INTEGER, external_tracking_status INTEGER, external_id " +
    "TEXT, external_mod_tag TEXT, unique_identifier TEXT, external_schedule_id TEXT, external_rep BLOB, " +
    "response_comment TEXT, last_synced_response_comment TEXT, hidden INTEGER, has_recurrences INTEGER, " +
    "has_attachment INTEGER, has_attendees INTEGER, UUID TEXT, entity_type INTEGER, priority INTEGER, " +
    "due_date REAL, due_tz TEXT, due_all_day INTEGER, completion_date REAL, creation_date REAL, action " +
    "TEXT, app_link BLOB, display_order INTEGER, created_by_id INTEGER, modified_by_id INTEGER, " +
    "shared_item_created_date REAL, shared_item_created_tz TEXT, shared_item_modified_date REAL, " +
    "shared_item_modified_tz TEXT, invitation_changed_properties INTEGER, default_alarm_removed INTEGER, " +
    "phantom_master INTEGER, participation_status_modified_date REAL, calendar_scale TEXT, travel_time " +
    "INTEGER, travel_advisory_behavior INTEGER, start_location_id INTEGER, end_location_id INTEGER, " +
    "suggested_event_info_id INTEGER, first_alert_date REAL, proposed_start_date REAL, can_forward " +
    "INTEGER, location_prediction_state INTEGER, fired_ttl INTEGER, disallow_propose_new_time INTEGER, " +
    "structured_data BLOB, local_structured_data BLOB, junk_status INTEGER, conference_url TEXT, " +
    "contact_identifier TEXT, recurrence_set TEXT, flags INTEGER, contact_name TEXT, error_id INTEGER, " +
    "image_id INTEGER, color_id INTEGER, conference_url_detected TEXT, creator_identity TEXT, " +
    "creator_team_identity TEXT, special_day TEXT)",
  "CREATE TABLE Location (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, address TEXT, latitude " +
    "INTEGER, longitude INTEGER, reference_frame INTEGER, address_book_id TEXT, mapkit_handle BLOB, " +
    "radius INTEGER, routing TEXT, derived_from TEXT, item_owner_id INTEGER, alarm_owner_id INTEGER, " +
    "start_loc_owner_id INTEGER, end_loc_owner_id INTEGER, client_loc_owner_id INTEGER)",
  "CREATE TABLE Participant (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, entity_type INTEGER, type " +
    "INTEGER, status INTEGER, pending_status INTEGER, role INTEGER, identity_id INTEGER, owner_id " +
    "INTEGER, external_rep BLOB, UUID TEXT, email TEXT, phone_number TEXT, is_self INTEGER, comment TEXT, " +
    "schedule_agent INTEGER, flags INTEGER, last_modified REAL, proposed_start_date REAL, invited_by " +
    "TEXT, proposed_start_date_status INTEGER, schedule_status INTEGER, schedule_force_send INTEGER, " +
    "comment_last_modified REAL)",
  "CREATE TABLE Identity (display_name TEXT, address TEXT, first_name TEXT, last_name TEXT, UNIQUE " +
    "(display_name, address, first_name, last_name))",
  "CREATE TABLE Recurrence (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, frequency INTEGER, interval " +
    "INTEGER, week_start INTEGER, count INTEGER, cached_end_date REAL, cached_end_date_tz TEXT, end_date " +
    "REAL, specifier TEXT, by_month_months INTEGER, owner_id INTEGER, external_id TEXT, external_mod_tag " +
    "TEXT, external_id_tag TEXT, external_rep BLOB, UUID TEXT)",
  "CREATE TABLE Alarm (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, trigger_date REAL, trigger_interval " +
    "INTEGER, type INTEGER, calendaritem_owner_id INTEGER, calendar_owner_id INTEGER, external_mod_tag " +
    "TEXT, external_id_tag TEXT, external_rep BLOB, UUID TEXT, proximity INTEGER, disabled INTEGER, " +
    "location_id INTEGER, acknowledgedDate REAL, default_alarm INTEGER, orig_alarm_id INTEGER, " +
    "email_address TEXT, bookmark BLOB, has_long_interval INTEGER)",
  "CREATE TABLE ExceptionDate (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, date REAL, " +
    "sync_order INTEGER)",
  "CREATE TABLE Attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, external_rep " +
    "BLOB, file_id INTEGER)",
  "CREATE TABLE AttachmentFile (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT, " +
    "external_mod_tag TEXT, url TEXT, UUID TEXT, format TEXT, flags INTEGER, filename TEXT, local_path " +
    "TEXT, file_size INTEGER, store_id INTEGER, download_start REAL, download_tries INTEGER)",
  "CREATE TABLE Conference (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, owner_id INTEGER, url " +
    "TEXT, feature TEXT, info TEXT, language TEXT, region TEXT)",
  "CREATE TABLE Category (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, entity_type INTEGER, " +
    "hidden INTEGER)",
  "CREATE TABLE CategoryLink (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, category_id " +
    "INTEGER, group_id INTEGER)",
  "CREATE TABLE EventAction (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, external_id " +
    "TEXT, external_mod_tag TEXT, external_folder_id TEXT, external_schedule_id TEXT, external_rep BLOB)",
  "CREATE TABLE Contact (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, contact_id TEXT)",
  "CREATE TABLE SuggestedEventInfo (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, " +
    "opaque_key TEXT, unique_key TEXT, changed_fields INTEGER, changes_acknowledged INTEGER, timestamp " +
    "REAL, extraction_group_identifier TEXT)",
  "CREATE TABLE Error (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_owner_id INTEGER, " +
    "calendar_owner_id INTEGER, calendaritem_owner_id INTEGER, error_type INTEGER, error_code INTEGER, " +
    "user_info BLOB)",
  "CREATE TABLE Image (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, type INTEGER, name " +
    "TEXT, color BLOB, identifier TEXT)",
  "CREATE TABLE Color (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, data BLOB, " +
    "provider_id TEXT, uuid TEXT, external_id TEXT)",
  "CREATE TABLE OccurrenceCache (day REAL, event_id INTEGER, calendar_id INTEGER, store_id INTEGER, " +
    "occurrence_date REAL, occurrence_start_date REAL, occurrence_end_date REAL, latest_possible_alarm " +
    "REAL, earliest_possible_alarm REAL, next_reminder_date REAL)",
  "CREATE TABLE _SqliteDatabaseProperties (key TEXT, value TEXT, UNIQUE(key))",
];

const HOME = "/1/calendars/home/";
const GOOGLE = "/person-a@example.com/events/";
const HOLIDAYS = "SYNTH-SUBSCRIPTION";

export const KEYS = {
  meeting: `SYNTH-UID-0001:${HOME}`,
  series: `SYNTH-UID-0002@google.com:${GOOGLE}`,
  moved: `SYNTH-UID-0002@google.com:20260928T083000Z:${GOOGLE}`,
  holiday: `SYNTH-UID-0003:${HOLIDAYS}`,
  allDaySeries: `SYNTH-UID-0004:${HOLIDAYS}`,
  allDayMoved: `SYNTH-UID-0004:20261009:${HOLIDAYS}`,
  floating: `SYNTH-UID-0005:${HOME}`,
  meetingCopy: `SYNTH-UID-0001:${GOOGLE}`,
} as const;

export function createCalendarStore(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    for (const statement of SCHEMA) db.exec(statement);
    db.exec(`
      INSERT INTO Store (ROWID, name, type, external_id, persistent_id, constraint_path, last_sync_start, display_order)
        VALUES (1, 'iCloud', 2, 'SYNTH-STORE-ICLOUD', 'SYNTH-PERSIST-0001', 'CalDAVCalendarConstraints', 811555000.5, 1),
               (2, 'person-a@example.com', 2, 'SYNTH-STORE-GOOGLE', 'SYNTH-PERSIST-0002', 'CalDAVCalendarConstraints', 811555000.5, 2),
               (3, 'Subscribed Calendars', 4, 'SYNTH-STORE-SUBS', 'SYNTH-PERSIST-0003', NULL, NULL, 3);
      INSERT INTO Calendar (ROWID, store_id, title, type, color, external_id, UUID, sync_token, display_order, flags)
        VALUES (1, 1, 'Home', NULL, '#1BADF8', '/1/calendars/home/', 'SYNTH-CAL-0001', 'sync-token-1', 1, 0),
               (2, 2, 'person-a@example.com', NULL, '#0E61B9', '/person-a@example.com/events/', 'SYNTH-CAL-0002', 'sync-token-2', 2, 0),
               (3, 3, 'Holidays', NULL, '#CC73E1', 'SYNTH-SUBSCRIPTION', 'SYNTH-CAL-0003', NULL, 3, 0);
      INSERT INTO Identity (rowid, display_name, address, first_name, last_name)
        VALUES (1, 'Person A', 'mailto:person-a@example.com', NULL, NULL), (2, 'Person B', 'mailto:person-b@example.com', NULL, NULL);
      INSERT INTO Location (ROWID, title, address, latitude, longitude, item_owner_id)
        VALUES (1, 'Fake Room 1', '1 Example Street', 1.5, 2.5, 1);
      INSERT INTO CalendarItem (ROWID, summary, description, url, location_id, start_date, start_tz, end_date, end_tz, all_day,
                                calendar_id, orig_item_id, orig_date, organizer_id, status, availability, unique_identifier, UUID,
                                entity_type, has_recurrences, has_attendees, last_modified, creation_date, sequence_num, external_rep)
        VALUES (1, 'Fake meeting', 'Agenda: fake', 'https://example.com/meet', 1, ${DAY0 + DAY + 30_600}, 'America/New_York', ${DAY0 + DAY + 34_200}, 'America/New_York', 0,
                1, 0, NULL, 2, 0, 0, 'SYNTH-UID-0001', 'SYNTH-LOCAL-0001', 2, 0, 1, ${DAY0 - 3_600}, ${DAY0 - 7_200}, 1, X'62706C6973743030'),
               (2, 'Fake weekly', NULL, NULL, 0, ${DAY0 + DAY + 30_600}, 'America/New_York', ${DAY0 + DAY + 32_400}, 'America/New_York', 0,
                2, 0, NULL, 0, 0, 0, 'SYNTH-UID-0002@google.com', 'SYNTH-LOCAL-0002', 2, 1, 0, ${DAY0}, ${DAY0}, 0, NULL),
               (3, 'Fake weekly, moved', NULL, NULL, 0, ${DAY0 + 8 * DAY + 36_000}, 'America/New_York', ${DAY0 + 8 * DAY + 37_800}, 'America/New_York', 0,
                2, 2, ${DAY0 + 8 * DAY + 30_600}, 0, 0, 0, 'SYNTH-UID-0002@google.com', 'SYNTH-LOCAL-0003', 2, 0, 0, ${DAY0}, ${DAY0}, 1, NULL),
               (4, 'Fake holiday', NULL, NULL, 0, ${DAY0 + 12 * DAY}, '_float', ${DAY0 + 13 * DAY - 1}, '_float', 1,
                3, 0, NULL, 0, 0, 1, 'SYNTH-UID-0003', 'SYNTH-LOCAL-0004', 2, 0, 0, NULL, NULL, 0, NULL),
               (5, 'Fake all-day weekly', NULL, NULL, 0, ${DAY0 + 12 * DAY}, '_float', ${DAY0 + 14 * DAY - 1}, '_float', 1,
                3, 0, NULL, 0, 0, 1, 'SYNTH-UID-0004', 'SYNTH-LOCAL-0005', 2, 1, 0, NULL, NULL, 0, NULL),
               (6, 'Fake all-day weekly, moved', NULL, NULL, 0, ${DAY0 + 20 * DAY}, '_float', ${DAY0 + 21 * DAY}, '_float', 1,
                3, 5, ${DAY0 + 19 * DAY}, 0, 0, 1, 'SYNTH-UID-0004', 'SYNTH-LOCAL-0006', 2, 0, 0, NULL, NULL, 0, NULL),
               (7, 'Fake floating', NULL, NULL, 0, ${DAY0 + 2 * DAY + 32_400}, '_float', ${DAY0 + 2 * DAY + 36_000}, '_float', 0,
                1, 0, NULL, 0, 0, 0, 'SYNTH-UID-0005', 'SYNTH-LOCAL-0007', 2, 0, 0, NULL, ${DAY0}, 0, NULL),
               (8, 'Fake meeting', 'Agenda: fake', NULL, 0, ${DAY0 + DAY + 30_600}, 'America/New_York', ${DAY0 + DAY + 34_200}, 'America/New_York', 0,
                2, 0, NULL, 0, 0, 0, 'SYNTH-UID-0001', 'SYNTH-LOCAL-0008', 2, 0, 0, NULL, NULL, 0, NULL);
      INSERT INTO Participant (ROWID, entity_type, type, status, role, identity_id, owner_id, UUID, email, is_self)
        VALUES (1, 7, 1, 1, 1, 2, 1, 'SYNTH-PART-0001', 'person-b@example.com', 0),
               (2, 8, 1, 1, 0, 1, 1, 'SYNTH-PART-0002', 'person-a@example.com', 1);
      INSERT INTO Alarm (ROWID, trigger_interval, type, calendaritem_owner_id, calendar_owner_id, UUID, default_alarm)
        VALUES (1, -900, 0, 1, -1, 'SYNTH-ALARM-0001', 0);
      INSERT INTO Conference (ROWID, uuid, owner_id, url, feature) VALUES (1, 'SYNTH-CONF-0001', 1, 'https://example.com/call/1', 'video');
      INSERT INTO Recurrence (ROWID, frequency, interval, week_start, count, owner_id, UUID)
        VALUES (1, 2, 1, 1, 0, 2, 'SYNTH-RECUR-0001'), (2, 2, 1, 1, 4, 5, 'SYNTH-RECUR-0002');
      INSERT INTO ExceptionDate (ROWID, owner_id, date, sync_order) VALUES (1, 2, ${DAY0 + 15 * DAY + 30_600}, 0);
      INSERT INTO OccurrenceCache (day, event_id, calendar_id, store_id, occurrence_date) VALUES (${DAY0}, 1, 1, 1, ${DAY0});
      INSERT INTO _SqliteDatabaseProperties (key, value) VALUES ('__CPRecordSequenceNumber', '${SEQUENCE}'), ('_ClientVersion', '19002');
    `);
  } finally {
    db.close();
  }
}

export function write(path: string, sql: string): number {
  const db = new Database(path);
  try {
    db.exec(sql);
    db.exec("UPDATE _SqliteDatabaseProperties SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = '__CPRecordSequenceNumber'");
    return Number((db.prepare("SELECT value FROM _SqliteDatabaseProperties WHERE key = '__CPRecordSequenceNumber'").get() as { value: string }).value);
  } finally {
    db.close();
  }
}

export function reversed(path: string): number {
  return write(path, `
    UPDATE CalendarItem SET ROWID = 109 - ROWID;
    UPDATE CalendarItem SET orig_item_id = 109 - orig_item_id WHERE orig_item_id > 0;
    UPDATE Participant SET owner_id = 109 - owner_id WHERE owner_id > 0;
    UPDATE Alarm SET calendaritem_owner_id = 109 - calendaritem_owner_id WHERE calendaritem_owner_id > 0;
    UPDATE Conference SET owner_id = 109 - owner_id;
    UPDATE Recurrence SET owner_id = 109 - owner_id;
    UPDATE ExceptionDate SET owner_id = 109 - owner_id;
    UPDATE Location SET item_owner_id = 109 - item_owner_id WHERE item_owner_id > 0;
    UPDATE OccurrenceCache SET event_id = 109 - event_id;
  `);
}

export const fixture: Fixture = (folder) => {
  createCalendarStore(`${folder}/calendar.sqlite`);
  return {
    source: SOURCE, facts: { snapshot_taken_at: "2026-09-23T04:00:00.000Z", kind: "snapshot", through: SEQUENCE }, files: { "calendar.sqlite": "trust" },
    heads: [
      "event SYNTH-UID-0001:/1/calendars/home/", "event SYNTH-UID-0001:/person-a@example.com/events/",
      "event SYNTH-UID-0002@google.com:/person-a@example.com/events/",
      "event SYNTH-UID-0002@google.com:20260928T083000Z:/person-a@example.com/events/", "event SYNTH-UID-0003:SYNTH-SUBSCRIPTION",
      "event SYNTH-UID-0004:20261009:SYNTH-SUBSCRIPTION", "event SYNTH-UID-0004:SYNTH-SUBSCRIPTION",
      "event SYNTH-UID-0005:/1/calendars/home/",
    ],
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "calendar-mac": fixture,
};

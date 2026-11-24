import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "calendar-mac",
  name: "calendar",
  held: "~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb",
  account: "apple-id",
  engine: {
    kind: "sqlite",
    stores: [
      {
        identity: "calendar",
        member: "calendar.sqlite",
        path: "~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb",
        tables: [
          {
            keep: "ROWID IN (SELECT orig_item_id FROM CalendarItem WHERE ROWID IN (SELECT t_key FROM temp.selected WHERE t_name = 'CalendarItem'))",
            key: "ROWID",
            name: "CalendarItem",
            role: "changes",
            touched_by: [
              [
                "Calendar",
                "SELECT ROWID AS k FROM CalendarItem WHERE calendar_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Calendar')",
              ],
              ["Recurrence", "SELECT ROWID AS k FROM CalendarItem"],
              ["ExceptionDate", "SELECT ROWID AS k FROM CalendarItem"],
              ["Alarm", "SELECT ROWID AS k FROM CalendarItem"],
              ["Attachment", "SELECT ROWID AS k FROM CalendarItem"],
              ["Conference", "SELECT ROWID AS k FROM CalendarItem"],
              ["CategoryLink", "SELECT ROWID AS k FROM CalendarItem"],
              ["EventAction", "SELECT ROWID AS k FROM CalendarItem"],
              ["Contact", "SELECT ROWID AS k FROM CalendarItem"],
              ["Participant", "SELECT ROWID AS k FROM CalendarItem"],
              [
                "Location",
                "SELECT ROWID AS k FROM CalendarItem WHERE location_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Location') OR client_location_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Location') OR start_location_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Location') OR end_location_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Location')",
              ],
              [
                "SuggestedEventInfo",
                "SELECT ROWID AS k FROM CalendarItem WHERE suggested_event_info_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'SuggestedEventInfo')",
              ],
              [
                "Error",
                "SELECT ROWID AS k FROM CalendarItem WHERE error_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Error')",
              ],
              [
                "Image",
                "SELECT ROWID AS k FROM CalendarItem WHERE image_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Image')",
              ],
              [
                "Color",
                "SELECT ROWID AS k FROM CalendarItem WHERE color_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Color')",
              ],
              [
                "CalendarItem",
                "SELECT ROWID AS k FROM CalendarItem WHERE orig_item_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'CalendarItem')",
              ],
            ],
          },
          {
            keep: "ROWID IN (SELECT calendar_id FROM CalendarItem)",
            key: "ROWID",
            name: "Calendar",
            role: "follows",
            touched_by: [
              [
                "Store",
                "SELECT ROWID AS k FROM Calendar WHERE store_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Store')",
              ],
            ],
          },
          { keep: "ROWID IN (SELECT store_id FROM Calendar)", key: "ROWID", name: "Store", role: "follows" },
          {
            keep: "owner_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "Recurrence",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "owner_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "ExceptionDate",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "calendaritem_owner_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "Alarm",
            role: "follows",
            touched_by: [
              [
                "Location",
                "SELECT ROWID AS k FROM Alarm WHERE location_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Location')",
              ],
            ],
            when_declared: true,
          },
          {
            keep: "owner_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "Attachment",
            role: "follows",
            touched_by: [
              [
                "AttachmentFile",
                "SELECT ROWID AS k FROM Attachment WHERE file_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'AttachmentFile')",
              ],
            ],
            when_declared: true,
          },
          {
            keep: "owner_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "Conference",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "owner_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "CategoryLink",
            role: "follows",
            touched_by: [
              [
                "Category",
                "SELECT ROWID AS k FROM CategoryLink WHERE category_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Category')",
              ],
            ],
            when_declared: true,
          },
          {
            keep: "event_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "EventAction",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "owner_id IN (SELECT ROWID FROM CalendarItem)",
            key: "ROWID",
            name: "Contact",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "owner_id IN (SELECT ROWID FROM CalendarItem) OR ROWID IN (SELECT organizer_id FROM CalendarItem UNION SELECT self_attendee_id FROM CalendarItem)",
            key: "ROWID",
            name: "Participant",
            role: "follows",
            touched_by: [
              [
                "Identity",
                "SELECT ROWID AS k FROM Participant WHERE identity_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'Identity')",
              ],
            ],
            when_declared: true,
          },
          {
            keep: [{ sql: "ROWID IN (SELECT identity_id FROM Participant)", when: "Participant" }],
            key: "ROWID",
            name: "Identity",
            role: "follows",
            when_declared: true,
          },
          {
            keep: [{ sql: "ROWID IN (SELECT file_id FROM Attachment)", when: "Attachment" }],
            key: "ROWID",
            name: "AttachmentFile",
            role: "follows",
            when_declared: true,
          },
          {
            keep: [{ sql: "ROWID IN (SELECT category_id FROM CategoryLink)", when: "CategoryLink" }],
            key: "ROWID",
            name: "Category",
            role: "follows",
            when_declared: true,
          },
          {
            keep: [
              {
                sql: "ROWID IN (SELECT location_id FROM CalendarItem UNION SELECT client_location_id FROM CalendarItem UNION SELECT start_location_id FROM CalendarItem UNION SELECT end_location_id FROM CalendarItem UNION SELECT location_id FROM Alarm)",
                when: "Alarm",
              },
              {
                sql: "ROWID IN (SELECT location_id FROM CalendarItem UNION SELECT client_location_id FROM CalendarItem UNION SELECT start_location_id FROM CalendarItem UNION SELECT end_location_id FROM CalendarItem)",
              },
            ],
            key: "ROWID",
            name: "Location",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "ROWID IN (SELECT suggested_event_info_id FROM CalendarItem)",
            key: "ROWID",
            name: "SuggestedEventInfo",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "ROWID IN (SELECT error_id FROM CalendarItem)",
            key: "ROWID",
            name: "Error",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "ROWID IN (SELECT image_id FROM CalendarItem)",
            key: "ROWID",
            name: "Image",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "ROWID IN (SELECT color_id FROM CalendarItem)",
            key: "ROWID",
            name: "Color",
            role: "follows",
            when_declared: true,
          },
          { name: "_SqliteDatabaseProperties", role: "whole" },
        ],
      },
    ],
  },
} satisfies MacStore;

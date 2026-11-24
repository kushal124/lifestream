import Foundation
import DeviceFiles
import HomeLink
import XCTest
@testable import Shipping

final class DatabaseDomainTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("database-domain-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func store(_ fixture: String, _ id: String, _ member: String, folder: String? = nil) throws -> URL {
        try store(fixture, at: StoreFixtures.store(id, member: member, home: root, folder: folder))
    }

    private func store(_ fixture: String, at url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try DomainFixtures.sqlite(url, [try DomainFixtures.fixture(fixture)])
        return url
    }

    private func domain(_ source: String, folder: String? = nil) throws -> any ShippingDomain {
        try StoreFixtures.domain(source, home: root, ledgers: ledgers, state: root.appendingPathComponent("stores", isDirectory: true), folder: folder)
    }

    private static let messagesFile = "messages.db"

    private func seal(_ domain: any ShippingDomain, received: Int, minute: Int = 0, owesThrough: Bool = false, history: Bool = true,
                      held: @escaping @Sendable (Set<String>) -> Set<String> = { _ in [] }) throws -> [SealedBundle] {
        let at = try DomainFixtures.instant("2026-09-23T04:00:00.000Z").addingTimeInterval(Double(minute) * 60)
        return try domain.seal(SealRequest(fetchedAt: at, workDirectory: try DomainFixtures.directory(work), scratch: try DomainFixtures.directory(work),
                                           custody: SealCustody(pass: ShippingFixture.pass, received: received, imported: received,
                                                                history: history),
                                           owesThrough: owesThrough, held: held))
    }

    private func keys(_ bundle: SealedBundle, _ member: String) throws -> [String: [Int]] {
        try DomainFixtures.keys(in: try DomainFixtures.extract(member, of: bundle))
    }


    func testIMessage() throws {
        let messages = try StoreFixtures.fileRoot("imessage", member: Self.messagesFile, home: root)
        let database = try store("imessage-store", "imessage", Self.messagesFile)
        try DomainFixtures.write("old bytes", to: messages.appendingPathComponent("Attachments/aa/01/old.jpg"))
        try DomainFixtures.write("new bytes", to: messages.appendingPathComponent("Attachments/bb/02/new.jpg"))
        let domain = try domain(DomainFixtures.imessageSource)
        let first = try seal(domain, received: 0)
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"])
        let live = try keys(first[0], Self.messagesFile)
        XCTAssertEqual(live["message"], [102])
        XCTAssertEqual(live["chat"], [1, 2], "every chat: one holding no message among them")
        XCTAssertEqual(live["chat_handle_join"], [1, 2, 3])
        XCTAssertEqual(live["handle"], [1, 2])
        XCTAssertEqual(live["attachment"], [2])
        XCTAssertNotNil(live["_SqliteDatabaseProperties"])
        XCTAssertNil(live["sync_chat_slice"])
        XCTAssertEqual(try keys(first[1], Self.messagesFile)["message"], [101])
        XCTAssertEqual(try StoredZipReader(first[0].file).names.filter { $0.hasPrefix("blobs/") },
                       ["blobs/\(DomainFixtures.sha256("new bytes"))"])
        try DomainFixtures.connectorFixture(first[0], connector: "messages/imessage")

        try DomainFixtures.sqlite(database, ["UPDATE attachment SET transfer_state = 5 WHERE ROWID = 1"])
        let changed = try seal(domain, received: 2, minute: 1)
        XCTAssertEqual(changed.map(\.sidecar.kind), ["history"])
        XCTAssertEqual(try keys(changed[0], Self.messagesFile)["message"], [101])
        XCTAssertEqual(try keys(changed[0], Self.messagesFile)["attachment"], [1])

        try DomainFixtures.sqlite(database, ["UPDATE handle SET country = 'ca' WHERE ROWID = 1"])
        let handled = try seal(domain, received: 3, minute: 2)
        XCTAssertEqual(handled.map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(try keys(handled[0], Self.messagesFile)["message"], [102])
        XCTAssertEqual(try keys(handled[0], Self.messagesFile)["chat"], [1, 2])
        XCTAssertEqual(try keys(handled[1], Self.messagesFile)["message"], [101])

        try DomainFixtures.sqlite(database, ["INSERT INTO chat_handle_join VALUES (1, 2)"])
        let joined = try seal(domain, received: 5, minute: 3)
        XCTAssertEqual(try keys(joined[0], Self.messagesFile)["message"], [102])
        XCTAssertEqual(try keys(joined[0], Self.messagesFile)["chat"], [1])
    }

    func testAnAttachmentThatArrivesLaterShipsItsMessage() throws {
        let messages = try StoreFixtures.fileRoot("imessage", member: Self.messagesFile, home: root)
        _ = try store("imessage-store", "imessage", Self.messagesFile)
        try DomainFixtures.write("new bytes", to: messages.appendingPathComponent("Attachments/bb/02/new.jpg"))
        let domain = try domain(DomainFixtures.imessageSource)
        XCTAssertEqual(try seal(domain, received: 0).count, 2)
        try DomainFixtures.write("old bytes", to: messages.appendingPathComponent("Attachments/aa/01/old.jpg"))
        let arrived = try seal(domain, received: 2, minute: 1, owesThrough: true)
        XCTAssertEqual(arrived.map(\.sidecar.kind), ["history"])
        XCTAssertEqual(try keys(arrived[0], Self.messagesFile)["message"], [101])
        XCTAssertEqual(try StoredZipReader(arrived[0].file).names.filter { $0.hasPrefix("blobs/") },
                       ["blobs/\(DomainFixtures.sha256("old bytes"))"])
        XCTAssertEqual(try seal(domain, received: 3, minute: 2, owesThrough: true), [], "shipped once")
        XCTAssertNotNil(domain.through, "its read-through instead")
    }

    func testAnAttachmentTheHomeHoldsIsNamedNotCarriedAndNoPageWhileThePastIsHeldBack() throws {
        let messages = try StoreFixtures.fileRoot("imessage", member: Self.messagesFile, home: root)
        _ = try store("imessage-store", "imessage", Self.messagesFile)
        let attachment = messages.appendingPathComponent("Attachments/bb/02/new.jpg")
        try DomainFixtures.write("old bytes", to: messages.appendingPathComponent("Attachments/aa/01/old.jpg"))
        try DomainFixtures.write("new bytes", to: attachment)
        let domain = try domain(DomainFixtures.imessageSource)
        let homes = DomainFixtures.sha256("new bytes")
        let asked = Collected<Set<String>>()
        let first = try seal(domain, received: 0, history: false) { hexes in
            asked.append(hexes)
            return hexes.intersection([homes])
        }
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes"], "no history page while the past is held back")
        XCTAssertEqual(asked.all, [[homes]], "the door is asked of the files the bundle would carry")
        let zip = try StoredZipReader(first[0].file)
        XCTAssertEqual(zip.names.filter { $0.hasPrefix("blobs/") }, [], "the attachment the home holds is not carried")
        let index = String(decoding: try XCTUnwrap(zip.bytes("attachments.json")), as: UTF8.self)
        XCTAssertTrue(index.contains(homes), "and is named, so the home links the row to the bytes it holds")
        XCTAssertEqual(try String(contentsOf: attachment, encoding: .utf8), "new bytes", "the app's file is untouched")

        let resumed = try seal(domain, received: 1, minute: 1)
        XCTAssertEqual(resumed.map(\.sidecar.kind), ["history"], "let go, the page")
        XCTAssertEqual(try keys(resumed[0], Self.messagesFile)["message"], [101])
        try ShippingFixture.artifact("imessage-held.json", ["asked": asked.all.map { $0.sorted() },
                                                            "held_back": first.map(\.sidecar.kind), "let_go": resumed.map(\.sidecar.kind)])
    }


    func testCallHistory() throws {
        let database = try store("apple-calls-store", "apple-calls", "callhistory.sqlite")
        let domain = try domain("apple-calls:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"])
        let live = try keys(first[0], "callhistory.sqlite")
        XCTAssertEqual(live["ZCALLRECORD"], [2])
        XCTAssertEqual(live["ZHANDLE"], [2], "the handles the live call names")
        XCTAssertNil(live["ZCALLDBPROPERTIES"])
        XCTAssertEqual(try keys(first[1], "callhistory.sqlite")["ZCALLRECORD"], [1])
        try DomainFixtures.connectorFixture(first[0], connector: "calls/apple")

        try DomainFixtures.sqlite(database, ["INSERT INTO Z_2REMOTEPARTICIPANTHANDLES VALUES (2, 1)"])
        let changed = try seal(domain, received: 2, minute: 1)
        XCTAssertEqual(try keys(changed[0], "callhistory.sqlite")["ZCALLRECORD"], [2])

        try DomainFixtures.sqlite(database, ["UPDATE ZHANDLE SET ZVALUE = '555-000-0002' WHERE Z_PK = 1"])
        let handled = try seal(domain, received: 3, minute: 2)
        XCTAssertEqual(handled.map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(try keys(handled[0], "callhistory.sqlite")["ZCALLRECORD"], [2], "it joined call 2 above")
        XCTAssertEqual(try keys(handled[1], "callhistory.sqlite")["ZCALLRECORD"], [1], "it began call 1")
    }

    func testAHandleThatOnlyBeganACallShipsItsCall() throws {
        let database = try store("apple-calls-store", "apple-calls", "callhistory.sqlite")
        try DomainFixtures.sqlite(database, ["INSERT INTO ZHANDLE VALUES (3, 4, 1, 2, '+15550000004', '+15550000004')",
                                             "UPDATE ZCALLRECORD SET ZINITIATOR = 3 WHERE Z_PK = 1"])
        let domain = try domain("apple-calls:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(try keys(first[1], "callhistory.sqlite")["ZHANDLE"], [1, 3], "the handle that began call 1 ships with it")

        try DomainFixtures.sqlite(database, ["UPDATE ZHANDLE SET ZVALUE = '555-000-0004' WHERE Z_PK = 3"])
        let began = try seal(domain, received: 2, minute: 1)
        XCTAssertEqual(began.map(\.sidecar.kind), ["history"])
        XCTAssertEqual(try keys(began[0], "callhistory.sqlite")["ZCALLRECORD"], [1], "it began call 1, which names it no other way")
    }

    func testACallHistoryWithoutAnInitiatorShipsItsCalls() throws {
        let database = try store("apple-calls-store", "apple-calls", "callhistory.sqlite")
        try DomainFixtures.sqlite(database, ["DROP INDEX ZCALLRECORD_ZINITIATOR_INDEX", "ALTER TABLE ZCALLRECORD DROP COLUMN ZINITIATOR"])
        let domain = try domain("apple-calls:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"], "a macOS whose calls name no initiator")
        let live = try keys(first[0], "callhistory.sqlite")
        XCTAssertEqual(live["ZCALLRECORD"], [2])
        XCTAssertEqual(live["ZHANDLE"], [2])
        let page = try keys(first[1], "callhistory.sqlite")
        XCTAssertEqual(page["ZCALLRECORD"], [1])
        XCTAssertEqual(page["ZHANDLE"], [1])

        try DomainFixtures.sqlite(database, ["UPDATE ZHANDLE SET ZVALUE = '555-000-0003' WHERE Z_PK = 2"])
        let handled = try seal(domain, received: 2, minute: 1)
        XCTAssertEqual(handled.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(handled[0], "callhistory.sqlite")["ZCALLRECORD"], [2], "a remote handle's change still ships its call")
    }

    func testAReadThroughStatesWhatAnUnreadStoreStillOwes() throws {
        _ = try store("apple-calls-store", "apple-calls", "callhistory.sqlite")
        let domain = try domain("apple-calls:person-a@example.com:unit-0001")
        let at = try DomainFixtures.instant("2026-09-23T04:00:00.000Z")
        let request = { (received: Int, imported: Int, owesThrough: Bool) in
            SealRequest(fetchedAt: at, workDirectory: try DomainFixtures.directory(self.work), scratch: try DomainFixtures.directory(self.work),
                        custody: SealCustody(pass: ShippingFixture.pass, received: received, imported: imported), owesThrough: owesThrough)
        }
        let live = try domain.seal(try request(1, 0, false))
        XCTAssertEqual(live.map(\.sidecar.kind), ["changes"], "the page waits for the home's imports")
        XCTAssertEqual(try domain.seal(try request(2, 1, true)), [], "a read-through is no bundle")
        XCTAssertEqual(domain.through, Through(readThrough: at, statedAt: at, left: 1,
                                               months: ["2026-05": Through.Month(items: 1, bytes: 0), "2026-09": Through.Month(items: 1, bytes: 0)]),
                       "call 1, owed to a page; each call counted by its month, a store naming no files counting no bytes")
    }


    func testNotes() throws {
        let container = try StoreFixtures.fileRoot("apple-notes", member: "notes.sqlite", home: root)
        let database = try store("notes-store", "apple-notes", "notes.sqlite")
        let domain = try domain("apple-notes:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        XCTAssertEqual(first.count, 1, "notes have no pages")
        let live = try keys(first[0], "notes.sqlite")
        let all = try DomainFixtures.keys(in: database)
        XCTAssertEqual(live["ZICCLOUDSYNCINGOBJECT"], all["ZICCLOUDSYNCINGOBJECT"])
        XCTAssertEqual(live["ZICNOTEDATA"], all["ZICNOTEDATA"])
        XCTAssertNil(live["ATRANSACTION"])
        XCTAssertNil(live["ACHANGE"])
        try DomainFixtures.connectorFixture(first[0], connector: "notes/apple")

        let note = try XCTUnwrap(Int(try XCTUnwrap(DomainFixtures.read("SELECT min(ZNOTE) FROM ZICNOTEDATA", from: database).first?.first ?? nil)))
        try DomainFixtures.sqlite(database, ["UPDATE ZICNOTEDATA SET ZDATA = X'1F8B' WHERE ZNOTE = \(note)"])
        let changed = try keys(try seal(domain, received: 1, minute: 1)[0], "notes.sqlite")
        let notes = try DomainFixtures.read("SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = 12", from: database)
            .compactMap { $0.first.flatMap { $0 }.flatMap { Int($0) } }
        XCTAssertEqual(Set(changed["ZICCLOUDSYNCINGOBJECT"] ?? []).intersection(notes), [note])
        XCTAssertEqual(changed["ZICNOTEDATA"]?.count, 1)

        try DomainFixtures.sqlite(database, ["UPDATE ZICCLOUDSYNCINGOBJECT SET ZNAME = 'iCloud, renamed' WHERE Z_ENT = 14"])
        XCTAssertEqual(try seal(domain, received: 2, minute: 2), [])

        let locator = try XCTUnwrap(try StoreFixtures.locators("apple-notes", member: "notes.sqlite", in: database).first)
        try DomainFixtures.write("synced media bytes", to: container.appendingPathComponent(locator))
        let synced = try seal(domain, received: 2, minute: 3, owesThrough: true)
        XCTAssertEqual(synced.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try StoredZipReader(synced[0].file).names.filter { $0.hasPrefix("blobs/") },
                       ["blobs/\(DomainFixtures.sha256("synced media bytes"))"])

    }


    func testChrome() throws {
        let history = try store("chrome-history", "chrome", "history.sqlite", folder: "Default")
        let domain = try domain("chrome:default:unit-0001", folder: "Default")
        let first = try seal(domain, received: 0)
        XCTAssertEqual(first.count, 1, "every visit is within the live span")
        let live = try keys(first[0], "history.sqlite")
        XCTAssertEqual(live["visits"], [1, 2, 3, 4, 5])
        XCTAssertEqual(live["urls"], [1, 2, 3, 4])
        XCTAssertEqual(live["keyword_search_terms"]?.count, 2)
        XCTAssertEqual(live["downloads"], [1, 2])
        XCTAssertEqual(live["downloads_url_chains"]?.count, 3)
        XCTAssertEqual(live["context_annotations"], [1, 5])
        XCTAssertNil(live["segments"])
        XCTAssertNil(live["visited_links"])
        try DomainFixtures.connectorFixture(first[0], connector: "browser/chrome")

        try DomainFixtures.sqlite(history, ["UPDATE urls SET visit_count = visit_count + 1 WHERE id = 4"])
        let changed = try keys(try seal(domain, received: 1, minute: 1)[0], "history.sqlite")
        XCTAssertNil(changed["visits"])
        XCTAssertEqual(changed["urls"], [4])
        XCTAssertEqual(changed["keyword_search_terms"]?.count, 1)
    }


    func testSafari() throws {
        let history = try store("safari-history", "safari", "history.sqlite")
        let tabs = try store("safari-cloudtabs", "safari", "cloudtabs.sqlite")
        let domain = try domain("safari:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(try StoredZipReader(first[0].file).names.filter { $0.hasSuffix(".sqlite") },
                       ["history.sqlite", "cloudtabs.sqlite"])
        let live = try keys(first[0], "history.sqlite")
        XCTAssertEqual(live["history_visits"], [1, 2, 3, 4])
        XCTAssertEqual(live["history_items"], [1, 2, 3])
        XCTAssertNil(live["history_items_to_tags"])
        XCTAssertEqual(try keys(first[0], "cloudtabs.sqlite")["cloud_tabs"]?.count, 2)
        try DomainFixtures.connectorFixture(first[0], connector: "browser/safari")

        try DomainFixtures.sqlite(history, ["DELETE FROM history_visits WHERE id = 1",
                                            "INSERT INTO history_tombstones (id, start_time, end_time, url) VALUES (1, 811584000, 811584090, NULL)"])
        let changed = try seal(domain, received: 1, minute: 1)
        let kept = try keys(changed[0], "history.sqlite")
        XCTAssertEqual(kept["history_tombstones"], [1])
        XCTAssertEqual(kept["history_visits"], [2], "the visit in the span the store still holds")
        XCTAssertFalse(try StoredZipReader(changed[0].file).names.contains("cloudtabs.sqlite"), "the tabs did not change")

        try DomainFixtures.sqlite(tabs, ["UPDATE cloud_tab_devices SET device_name = 'Synthetic Phone, renamed'"])
        let renamed = try seal(domain, received: 2, minute: 2)
        XCTAssertEqual(try keys(renamed[0], "cloudtabs.sqlite")["cloud_tabs"]?.count, 2)
    }


    func testWisprFlow() throws {
        let database = try store("wispr-flow", "wispr-flow", "flow.sqlite")
        let domain = try domain("wispr-flow:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        let all = try DomainFixtures.keys(in: database)
        XCTAssertEqual(try keys(first[0], "flow.sqlite")["History"], all["History"])
        XCTAssertNil(try keys(first[0], "flow.sqlite")["Notes"])
        try DomainFixtures.connectorFixture(first[0], connector: "voice/wispr-flow")

        let rows = try XCTUnwrap(all["History"])
        try DomainFixtures.sqlite(database, ["UPDATE History SET editedText = 'synthetic edit' WHERE rowid = \(rows[0])"])
        XCTAssertEqual(try keys(try seal(domain, received: 1, minute: 1)[0], "flow.sqlite")["History"], [rows[0]])
    }


    func testCalendar() throws {
        let database = try store("calendar-store", "apple-calendar", "calendar.sqlite")
        let domain = try domain("apple-calendar:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        let all = try DomainFixtures.keys(in: database)
        let live = try keys(first[0], "calendar.sqlite")
        XCTAssertEqual(live["CalendarItem"], all["CalendarItem"])
        XCTAssertEqual(live["Calendar"], all["Calendar"])
        XCTAssertNil(live["OccurrenceCache"], "a cache Calendar derives is left out")
        try DomainFixtures.connectorFixture(first[0], connector: "calendar/apple")

        try DomainFixtures.sqlite(database, ["UPDATE Identity SET display_name = 'Synthetic Person, renamed' WHERE rowid = 1"])
        let changed = try keys(try seal(domain, received: 1, minute: 1)[0], "calendar.sqlite")
        let attending = try DomainFixtures.read("SELECT DISTINCT owner_id FROM Participant WHERE identity_id = 1 AND owner_id IS NOT NULL "
                                                + "UNION SELECT ROWID FROM CalendarItem WHERE organizer_id IN (SELECT ROWID FROM Participant WHERE identity_id = 1)",
                                                from: database).compactMap { $0.first.flatMap { $0 }.flatMap { Int($0) } }
        XCTAssertFalse(attending.isEmpty)
        XCTAssertTrue(Set(attending).isSubset(of: Set(changed["CalendarItem"] ?? [])))
        XCTAssertEqual(changed["Identity"], [1, 2], "the renamed identity, and the other attendee's, for lookup")

        let moved = try DomainFixtures.read("SELECT ROWID FROM CalendarItem WHERE orig_item_id > 0 ORDER BY ROWID", from: database)
            .compactMap { $0.first.flatMap { $0 }.flatMap { Int($0) } }
        XCTAssertFalse(moved.isEmpty)
        try DomainFixtures.sqlite(database, ["UPDATE CalendarItem SET unique_identifier = 'SYNTH-SERIES-CHANGED' "
                                             + "WHERE ROWID = (SELECT orig_item_id FROM CalendarItem WHERE ROWID = \(moved[0]))"])
        let series = try keys(try seal(domain, received: 2, minute: 2)[0], "calendar.sqlite")
        XCTAssertTrue((series["CalendarItem"] ?? []).contains(moved[0]))
    }

    func testAMovedCalendarAlarmRestatesBothOwners() throws {
        let database = try store("calendar-store", "apple-calendar", "calendar.sqlite")
        let domain = try domain("apple-calendar:local:unit-0001")
        _ = try seal(domain, received: 0)
        try DomainFixtures.sqlite(database, ["UPDATE Alarm SET calendaritem_owner_id = 7 WHERE ROWID = 1"])
        let changed = try XCTUnwrap(try seal(domain, received: 1, minute: 1).first)
        let items = try keys(changed, "calendar.sqlite")["CalendarItem"] ?? []
        XCTAssertTrue(items.contains(1), "the previous owner must lose its alarm")
        XCTAssertTrue(items.contains(7), "the current owner must gain its alarm")
        XCTAssertEqual(try DomainFixtures.read("SELECT calendaritem_owner_id FROM Alarm WHERE ROWID = 1",
                                              from: DomainFixtures.extract("calendar.sqlite", of: changed)), [["7"]])
    }

    func testCalendarShipsWithoutOptionalOwnerTables() throws {
        let database = try store("calendar-store", "apple-calendar", "calendar.sqlite")
        try DomainFixtures.sqlite(database, ["DROP TABLE Alarm", "DROP TABLE Participant", "DROP TABLE Attachment", "DROP TABLE CategoryLink"])
        let domain = try domain("apple-calendar:local:unit-0001")
        let first = try XCTUnwrap(try seal(domain, received: 0).first)
        XCTAssertEqual(try keys(first, "calendar.sqlite")["CalendarItem"], Array(1...8))
        XCTAssertEqual(try DomainFixtures.read("PRAGMA quick_check", from: DomainFixtures.extract("calendar.sqlite", of: first)), [["ok"]])
        XCTAssertEqual(try seal(domain, received: 1, minute: 1), [])
    }

    func testUnsetTimesShipLiveInEveryPagedStore() throws {
        let messages = try store("imessage-store", "imessage", Self.messagesFile)
        let calls = try store("apple-calls-store", "apple-calls", "callhistory.sqlite")
        let chrome = try store("chrome-history", "chrome", "history.sqlite", folder: "Default")
        let safari = try store("safari-history", "safari", "history.sqlite")
        let cases: [(any ShippingDomain, URL, String, String, String)] = [
            (try domain(DomainFixtures.imessageSource), messages, "message", "date", Self.messagesFile),
            (try domain("apple-calls:local:unit-0001"), calls, "ZCALLRECORD", "ZDATE", "callhistory.sqlite"),
            (try domain("chrome:default:unit-0001", folder: "Default"), chrome, "visits", "visit_time", "history.sqlite"),
            (try domain("safari:local:unit-0001"), safari, "history_visits", "visit_time", "history.sqlite"),
        ]
        for (domain, database, table, time, member) in cases {
            try DomainFixtures.sqlite(database, ["UPDATE \(table) SET \(time) = 0"])
            let first = try seal(domain, received: 0)
            XCTAssertEqual(first.map(\.sidecar.kind), ["changes"], domain.name)
            XCTAssertEqual(try keys(first[0], member)[table], try DomainFixtures.keys(in: database)[table], domain.name)
        }
    }

    func testFixtureDumpsDistinguishTypesAndBytes() throws {
        let database = root.appendingPathComponent("typed.db")
        try DomainFixtures.sqlite(database, ["CREATE TABLE cells (value)"])
        var dumps = Set<[String]>()
        for value in ["X'0001'", "X'0002'", "1", "'1'", "1.0", "NULL", "'NULL'", "''", "X''", "'a|b'", "CAST(X'610062' AS TEXT)"] {
            try DomainFixtures.sqlite(database, ["DELETE FROM cells", "INSERT INTO cells VALUES (\(value))"])
            XCTAssertTrue(dumps.insert(try DomainFixtures.dump(database)).inserted, value)
        }
    }


    func testReminders() throws {
        let stores = try StoreFixtures.store("apple-reminders", member: "<name>", home: root)
        let database = try store("reminders-store", at: stores.appendingPathComponent("Data-AAAAAAAA-0000-4000-8000-000000000001.sqlite"))
        let domain = try domain("apple-reminders:person-a@example.com:unit-0001")
        let first = try seal(domain, received: 0)
        let member = database.lastPathComponent
        let all = try DomainFixtures.keys(in: database)
        let live = try keys(first[0], member)
        XCTAssertEqual(live["ZREMCDREMINDER"], all["ZREMCDREMINDER"])
        XCTAssertEqual(live["ZREMCDOBJECT"], all["ZREMCDOBJECT"])
        XCTAssertNil(live["ACHANGE"])
        try DomainFixtures.connectorFixture(first[0], connector: "calendar/apple-reminders")

        let reminder = try XCTUnwrap(all["ZREMCDREMINDER"]?.first)
        let subtasks = try DomainFixtures.read("SELECT Z_PK FROM ZREMCDREMINDER WHERE ZPARENTREMINDER = \(reminder)", from: database)
            .compactMap { $0.first.flatMap { $0 }.flatMap { Int($0) } }
        XCTAssertFalse(subtasks.isEmpty)
        try DomainFixtures.sqlite(database, ["UPDATE ZREMCDREMINDER SET ZCOMPLETED = 1 WHERE Z_PK = \(reminder)"])
        let changed = try keys(try seal(domain, received: 1, minute: 1)[0], member)
        XCTAssertEqual(changed["ZREMCDREMINDER"], [reminder] + subtasks)
        XCTAssertEqual(changed["ZREMCDBASELIST"], all["ZREMCDBASELIST"])
    }


    func testTheSourceFindsItsProfileFolder() throws {
        _ = try store("chrome-history", "chrome", "history.sqlite", folder: "Profile 2")
        _ = try store("chrome-history", "chrome", "history.sqlite", folder: "Default")
        let userData = StoreFixtures.url("~/Library/Application Support/Google/Chrome", home: root)
        try FileManager.default.createDirectory(at: userData.appendingPathComponent("Profile 3"), withIntermediateDirectories: true)
        let held = StoreAccounts.read(try StoreFixtures.declaration("chrome").store, road: StoreFiles(home: root, lifestream: []))
        XCTAssertEqual(held.map(\.account).sorted(), ["default", "profile-2"])
        XCTAssertEqual(held.first { $0.account == "profile-2" }?.folder, "Profile 2")
        let stores = try StoreFixtures.stores(home: root, state: root.appendingPathComponent("stores", isDirectory: true))
        XCTAssertNotNil(stores.domain(for: "chrome:profile-2:unit-0001"))
        XCTAssertNotNil(stores.domain(for: "chrome:default:unit-0001"))
        XCTAssertNil(stores.domain(for: "chrome:profile-3:unit-0001"))
        XCTAssertNil(stores.domain(for: "chrome:profile-9:unit-0001"))
    }

    func testAStoreIsAFileNamedAsRemindersNamesOne() throws {
        guard case .sqlite(let declared) = try StoreFixtures.declaration("apple-reminders").store.engine,
              let match = declared.first?.match else { return XCTFail("Reminders declares its stores by a pattern") }
        XCTAssertTrue(StoreFiles.matches(match, "Data-AAAAAAAA-0000-4000-8000-000000000001.sqlite"))
        XCTAssertTrue(StoreFiles.matches(match, "Data-local.sqlite"))
        for name in ["Data-local.sqlite-wal", "Data-local.sqlite-shm", ".Data-local_SUPPORT", "Data-.sqlite", "Data-a/b.sqlite", "Other.sqlite"] {
            XCTAssertFalse(StoreFiles.matches(match, name), name)
        }
    }
}

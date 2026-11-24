import Foundation
import DeviceFiles
import HomeLink
import XCTest
@testable import Shipping

final class MacStoreGoldenTests: XCTestCase {
    static let connectors = ["imessage", "whatsapp", "apple-calls", "apple-notes", "apple-calendar", "apple-reminders", "safari",
                             "chrome", "wispr-flow", "aqua-voice", "screen-time", "now-playing", "claude-code", "codex"]
    static let macs = ["full", "bare", "strangers"]
    static let unit = "macbook-pro-0001"
    static let at = "2026-09-23T04:00:00.000Z"

    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("mac-store-goldens")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }


    func testEachDeclarationSealsItsGolden() throws {
        let declarations = try StoreFixtures.all()
        XCTAssertEqual(Set(declarations.keys), Set(Self.connectors), "one declaration per store connector, no other")
        for mac in Self.macs {
            let home = try lay(mac)
            let wakes = Collected<String>()
            let stores = try StoreFixtures.stores(home: home, state: root.appendingPathComponent("state-\(mac)", isDirectory: true),
                                                  applications: [applications(home)], wake: { wakes.append($0) })
            XCTAssertEqual(Set(stores.stated().states.values), [.allowed], "\(mac): the release's own stores ask no one")
            for id in Self.connectors {
                do { try resolve(id, on: mac, declarations[id]!, stores: stores, wakes: wakes) } catch {
                    XCTFail("\(id) on \(mac): \(error)")
                }
            }
        }
    }

    private func resolve(_ id: String, on mac: String, _ declaration: HomeLink.DeclaredStore, stores: DeclaredStores,
                         wakes: Collected<String>) throws {
        let golden = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: goldenFile(id))) as? [String: Any], id)
        XCTAssertEqual(declaration.store.name, golden["name"] as? String, "\(id): the lifecycle word")
        XCTAssertEqual(declaration.store.wake, golden["wake"] as? String, "\(id): the app woken")
        let expected = try XCTUnwrap((golden["macs"] as? [String: Any])?[mac] as? [String: Any], "\(id) on \(mac)")
        XCTAssertEqual(stores.found().contains(id), expected["found"] as? Bool, "\(id) found on \(mac)")
        XCTAssertEqual(stores.held(id), expected["held"] as? Bool, "\(id) held on \(mac)")
        let offers = stores.offers(unit: Self.unit).filter { ShippingDomains.product(of: $0) == id }
        XCTAssertEqual(offers, expected["offers"] as? [String], "\(id) offers on \(mac)")
        let local = declaration.store.account == .local
        let sources = local ? ["\(id):local:\(Self.unit)"] : offers
        XCTAssertEqual(sources, expected["sealed"] as? [String], "\(id) sealed on \(mac)")
        var bundles: [[String: Any]] = []
        for source in sources {
            let before = wakes.all.count
            let domain = try XCTUnwrap(stores.domain(for: source), source)
            let sealed = try domain.seal(request(id, mac))
            for bundle in sealed { try assertDeclaredOnly(bundle, declaration, "\(source) on \(mac)") }
            bundles += try sealed.map(summary)
            if let wake = declaration.store.wake { XCTAssertEqual(Array(wakes.all.dropFirst(before)), [wake], "\(source): woken before its read") }
        }
        XCTAssertTrue(NSArray(array: bundles).isEqual(to: expected["bundles"] as? [Any] ?? []),
                      "\(id) on \(mac): the shipper's bundles\n\(pretty(bundles))\nare not the golden's\n\(pretty(expected["bundles"] ?? []))")
    }

    func testTheDecoderRefusesWhatTheShapeHasNot() throws {
        let declaration = try JSONSerialization.jsonObject(with: Data(contentsOf: StoreFixtures.folder().appendingPathComponent("chrome.json")))
        XCTAssertNoThrow(try JSONDecoder().decode(HomeLink.DeclaredStore.self, from: JSONSerialization.data(withJSONObject: declaration)))
        let bent: [(String, ([String: Any]) -> [String: Any])] = [
            ("an unknown member", { var store = $0; store["paths"] = ["~/x"]; return store }),
            ("an account word", { var store = $0; store["account"] = "icloud"; return store }),
            ("no engine", { var store = $0; store["engine"] = nil; return store }),
        ]
        for (what, bend) in bent {
            var mac = try XCTUnwrap(declaration as? [String: Any])
            mac["store"] = bend(try XCTUnwrap(mac["store"] as? [String: Any]))
            XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.DeclaredStore.self, from: JSONSerialization.data(withJSONObject: mac)), what)
        }
    }

    private func applications(_ home: URL) -> URL { home.appendingPathComponent("Applications", isDirectory: true) }

    private func request(_ id: String, _ mac: String) throws -> SealRequest {
        let work = root.appendingPathComponent("work/\(mac)/\(id)-\(UUID().uuidString)", isDirectory: true)
        return SealRequest(fetchedAt: try DomainFixtures.instant(Self.at), workDirectory: try DomainFixtures.directory(work), scratch: try DomainFixtures.directory(work),
                           custody: SealCustody(pass: ShippingFixture.pass, received: 0, imported: 0, history: true))
    }


    private func summary(_ sealed: SealedBundle) throws -> [String: Any] {
        let zip = try StoredZipReader(sealed.file)
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(zip.bytes(BundleWriter.manifestFile))) as? [String: Any])
        var indexes: [String: Any] = [:]
        for name in zip.names where name.hasSuffix(".json") {
            guard let object = try? JSONSerialization.jsonObject(with: XCTUnwrap(zip.bytes(name))) as? [String: Any] else { continue }
            if object["format"] as? String == BlobIndex.format { indexes[name] = object["entries"] }
            if name == SessionLogShipper.partsFile { indexes[name] = object }
        }
        var summary: [String: Any] = ["source_id": manifest["source_id"] ?? NSNull(), "feeder": manifest["feeder"] ?? NSNull(),
                                      "members": zip.names.filter { $0 != BundleWriter.manifestFile }, "indexes": indexes]
        if let kind = sealed.sidecar.kind { summary["kind"] = kind }
        return summary
    }

    private func assertDeclaredOnly(_ sealed: SealedBundle, _ declaration: HomeLink.DeclaredStore, _ label: String) throws {
        guard case .sqlite(let stores) = declaration.store.engine else { return }
        let zip = try StoredZipReader(sealed.file)
        for name in zip.names {
            guard let store = stores.first(where: { $0.member == name }) ?? stores.first(where: { $0.member == "<name>" && $0.match != nil }),
                  let bytes = zip.bytes(name), bytes.starts(with: Data("SQLite format 3\u{0}".utf8)) else { continue }
            let file = root.appendingPathComponent("member-\(UUID().uuidString).sqlite")
            try bytes.write(to: file)
            defer { try? FileManager.default.removeItem(at: file) }
            let declared = Set(store.tables.map(\.name))
            for row in try DomainFixtures.read("SELECT type, name, tbl_name FROM sqlite_master WHERE tbl_name NOT GLOB 'sqlite_*'", from: file) {
                let (type, object, table) = (row[0] ?? "", row[1] ?? "", row[2] ?? "")
                XCTAssertTrue(["table", "index"].contains(type) && declared.contains(table),
                              "\(label): \(name) holds the \(type) \(object), which its declaration does not name")
            }
            XCTAssertEqual(try DomainFixtures.read("PRAGMA page_size", from: file), [[String(SQLiteDelta.pageSize)]], "\(label): \(name)")
        }
    }

    private func goldenFile(_ id: String) -> URL {
        StoreFixtures.folder().appendingPathComponent("goldens/\(id).json")
    }

    private func pretty(_ object: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]))
            .map { String(decoding: $0, as: UTF8.self) } ?? "\(object)"
    }


    private func lay(_ mac: String) throws -> URL {
        let home = root.appendingPathComponent("\(mac)-\(UUID().uuidString)", isDirectory: true)
        func at(_ path: String) -> URL { home.appendingPathComponent(path) }
        func store(_ fixture: String, _ path: String) throws {
            try FileManager.default.createDirectory(at: at(path).deletingLastPathComponent(), withIntermediateDirectories: true)
            try DomainFixtures.sqlite(at(path), [try DomainFixtures.fixture(fixture)])
        }
        func write(_ data: Data, _ path: String) throws {
            try FileManager.default.createDirectory(at: at(path).deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: at(path))
        }
        func text(_ text: String, _ path: String) throws { try write(Data(text.utf8), path) }
        func folder(_ path: String) throws { try FileManager.default.createDirectory(at: at(path), withIntermediateDirectories: true) }
        func plist(_ object: [String: Any], _ path: String) throws {
            try write(try PropertyListSerialization.data(fromPropertyList: object, format: .binary, options: 0), path)
        }
        func apps(_ names: [String]) throws { for name in names { try folder("Applications/\(name).app") } }

        let whatsapp = "Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
        let wispr = "Library/Application Support/Wispr Flow"
        let aqua = "Library/Application Support/Aqua Voice"
        let chrome = "Library/Application Support/Google/Chrome"
        let reminders = "Library/Group Containers/group.com.apple.reminders/Container_v1/Stores"
        let biome = "Library/Biome/streams/restricted"
        try folder("Applications")
        try write(Data(), "TCC.db")

        switch mac {
        case "full":
            try apps(["Messages", "WhatsApp", "FaceTime", "Notes", "Calendar", "Reminders", "Safari", "Google Chrome", "Wispr Flow", "Aqua Voice"])
            try plist(["Accounts": [["AccountID": "Person-A@Example.com", "AccountDescription": "iCloud"]]],
                      "Library/Preferences/MobileMeAccounts.plist")
            try store("imessage-store", "Library/Messages/chat.db")
            try text("old bytes", "Library/Messages/Attachments/aa/01/old.jpg")
            try text("new bytes", "Library/Messages/Attachments/bb/02/new.jpg")
            try store("whatsapp-store", "\(whatsapp)/ChatStorage.sqlite")
            try store("whatsapp-calls", "\(whatsapp)/CallHistory.sqlite")
            try store("whatsapp-business", "\(whatsapp)/Biz/Biz.sqlite")
            try DomainFixtures.sqlite(at("\(whatsapp)/ChatStorage.sqlite"), [
                "UPDATE ZWAMEDIAITEM SET ZXMPPTHUMBPATH = 'Media/15550000001-1700000000/new.thumb', "
                    + "ZTHUMBNAILLOCALPATH = 'Media/15550000001-1700000000/new-small.jpg' WHERE Z_PK = 2"])
            for (name, bytes) in [("new.jpg", "synthetic media"), ("new.thumb", "synthetic thumb"), ("new-small.jpg", "synthetic small")] {
                try text(bytes, "\(whatsapp)/Message/Media/15550000001-1700000000/\(name)")
            }
            try plist(["OwnJabberID": "15550000001@s.whatsapp.net", "OtherKey": 1],
                      "\(whatsapp)/Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist")
            try store("apple-calls-store", "Library/Application Support/CallHistoryDB/CallHistory.storedata")
            try store("notes-store", "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite")
            let media = try XCTUnwrap(try StoreFixtures.locators("apple-notes", member: "notes.sqlite",
                                                                 in: at("Library/Group Containers/group.com.apple.notes/NoteStore.sqlite")).first)
            try text("synthetic note media", "Library/Group Containers/group.com.apple.notes/\(media)")
            try store("calendar-store", "Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb")
            try store("reminders-store", "\(reminders)/Data-AAAAAAAA-0000-4000-8000-000000000001.sqlite")
            try store("reminders-store", "\(reminders)/Data-local.sqlite")
            try write(Data(), "\(reminders)/Data-local.sqlite-wal")
            try write(Data(), "\(reminders)/Other.sqlite")
            try folder("\(reminders)/.Data-local_SUPPORT")
            try store("safari-history", "Library/Safari/History.db")
            try store("safari-cloudtabs", "Library/Containers/com.apple.Safari/Data/Library/Safari/CloudTabs.db")
            try store("chrome-history", "\(chrome)/Default/History")
            try store("chrome-history", "\(chrome)/Profile 2/History")
            try folder("\(chrome)/Profile 3")
            try write(Data(), "\(chrome)/Guest Profile/History")
            try write(Data(), "\(chrome)/System Profile/History")
            try store("wispr-flow", "\(wispr)/flow.sqlite")
            try text(#"{"prefs":{"user":{"email":"Person-B@Example.com","firstName":"A"}}}"#, "\(wispr)/config.json")
            try text(aquaHistory(version: 1, accounts: ["100001", "100002", "", "a/b"]), "\(aqua)/history.json")
            for name in ["AQ_1", "AQ_9"] { try text("synthetic wav \(name)", "\(aqua)/audio/\(name).wav") }
            try layBiome(home, stream: "App.InFocus", torn: true)
            try layBiome(home, stream: "Media.NowPlaying", torn: false)
            try laySessions(onto: home)
        case "bare":
            try apps(["Messages", "WhatsApp", "Notes", "Calendar", "Reminders", "Google Chrome", "Aqua Voice"])
            try store("imessage-store", "Library/Messages/chat.db")
            try store("whatsapp-store", "\(whatsapp)/ChatStorage.sqlite")
            try plist(["OwnJabberID": "15550000002@s.whatsapp.net"], "\(whatsapp)/Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist")
            try store("notes-store", "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite")
            let calendar = "Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb"
            try store("calendar-store", calendar)
            try DomainFixtures.sqlite(at(calendar), ["DROP TABLE Alarm", "DROP TABLE Participant", "DROP TABLE Attachment", "DROP TABLE CategoryLink"])
            try folder(reminders)
            try store("safari-history", "Library/Safari/History.db")
            try store("chrome-history", "\(chrome)/Default/History")
            try store("wispr-flow", "\(wispr)/flow.sqlite")
            try text(aquaHistory(version: 1, accounts: ["100001"]), "\(aqua)/history.json")
            try folder("\(biome)/App.InFocus")
            try folder(".claude/projects")
            try folder(".codex/archived_sessions")
        default:
            try write(Data("not a property list".utf8), "Library/Preferences/MobileMeAccounts.plist")
            try store("imessage-store", "Library/Messages/chat.db")
            try store("whatsapp-store", "\(whatsapp)/ChatStorage.sqlite")
            try plist(["OwnJabberID": "15550000001-1700000000@g.us"], "\(whatsapp)/Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist")
            try store("wispr-flow", "\(wispr)/flow.sqlite")
            try text(#"{"prefs":{"user":{"email":"not-an-address-555"}}}"#, "\(wispr)/config.json")
            try text(aquaHistory(version: 2, accounts: ["100001"]), "\(aqua)/history.json")
            try write(Data(), "\(chrome)/Guest Profile/History")
            try folder("\(chrome)/Profile 3")
            try folder("\(biome)/App.InFocus")
            try folder("\(biome)/Media.NowPlaying")
        }
        return home
    }

    private func aquaHistory(version: Int, accounts: [String]) -> String {
        func entry(_ session: Int, _ file: String?) -> String {
            "{\"kind\":\"transcription\",\"timestamp\":\"2026-09-20T08:00:0\(session % 10).000Z\",\"content\":\"Synthetic \(session).\","
                + "\"sessionId\":\(session)" + (file.map { ",\"audioFilePath\":\"\($0)\"" } ?? "") + "}"
        }
        let users = accounts.enumerated().map { index, account in
            "\"\(account)\":[\(entry(190000002 + index * 10, "audio/AQ_\(2 + index * 7).wav")),\(entry(190000001 + index * 10, "audio/AQ_\(1 + index * 8).wav")),\(entry(190000003, nil))]"
        }
        return "{\"version\":\(version),\"historyByUserId\":{\(users.joined(separator: ","))},\"historySyncCursorByUserId\":{}}"
    }

    private func layBiome(_ home: URL, stream: String, torn: Bool) throws {
        let folder = home.appendingPathComponent("Library/Biome/streams/restricted/\(stream)", isDirectory: true)
        func write(_ data: Data, _ locator: String) throws {
            let file = folder.appendingPathComponent(locator)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: file)
        }
        let phone = "0000BBBB-0000-4000-8000-000000000002"
        try write(Self.segment([Self.record("com.example.mail"), Self.record("com.example.chat")]), "local/810000000000000")
        try write(Self.segment([Self.record("tombstone")]), "local/tombstone/810000050000000")
        try write(Self.segment([Self.record("com.example.maps")]), "remote/\(phone)/809990000000000")
        try write(Self.segment([Self.record("tombstone")]), "remote/\(phone)/tombstone/809990050000000")
        try write(Data(), "lock")
        try write(Data("not a segment".utf8), "local/notes.txt")
        if torn { try write(Self.segment([Self.record("com.example.torn")], crc: 1), "local/810000100000000") }
        let sync = home.appendingPathComponent("Library/Biome/sync/sync.db")
        if !FileManager.default.fileExists(atPath: sync.path) {
            try FileManager.default.createDirectory(at: sync.deletingLastPathComponent(), withIntermediateDirectories: true)
            try DomainFixtures.sqlite(sync, [
                "CREATE TABLE DevicePeer (device_identifier STRING NOT NULL, me BOOLEAN, protocol_version INTEGER NOT NULL)",
                "INSERT INTO DevicePeer VALUES ('\(phone)', 0, 5)",
                "INSERT INTO DevicePeer VALUES ('0000AAAA-0000-4000-8000-000000000001', 1, 5)",
            ])
        }
    }

    private static func segment(_ records: [Data], size: Int = 4096, crc: UInt32? = nil) -> Data {
        var file = Data(count: size)
        file.replaceSubrange(0..<4, with: Data("SEGB".utf8))
        put(UInt32(records.count), into: &file, at: 4)
        var end = 0
        for (index, record) in records.enumerated() {
            let start = 32 + ((end + 3) & ~3)
            put(crc ?? CRC32.update(0, record), into: &file, at: start)
            put(10, into: &file, at: start + 4)
            file.replaceSubrange((start + 8)..<(start + 8 + record.count), with: record)
            end = start - 32 + 8 + record.count
            let entry = size - 16 * (index + 1)
            put(UInt32(end), into: &file, at: entry)
            put(1, into: &file, at: entry + 4)
        }
        return file
    }

    private static func put(_ value: UInt32, into data: inout Data, at offset: Int) {
        withUnsafeBytes(of: value.littleEndian) { data.replaceSubrange(offset..<(offset + 4), with: $0) }
    }

    private static func record(_ app: String) -> Data { Data([0x32, UInt8(app.utf8.count)]) + Data(app.utf8) }

    private func laySessions(onto home: URL) throws {
        let claude = SessionLogDomainTests.fixtures("claude-code").appendingPathComponent("logs/projects", isDirectory: true)
        let codex = SessionLogDomainTests.fixtures("codex").appendingPathComponent("logs/codex", isDirectory: true)
        try copy(claude, onto: home.appendingPathComponent(".claude/projects", isDirectory: true))
        try copy(codex, onto: home.appendingPathComponent(".codex", isDirectory: true))
        let project = home.appendingPathComponent(".claude/projects/-Users-person-a-project", isDirectory: true)
        try DomainFixtures.write("synthetic notes", to: project.appendingPathComponent("memory/MEMORY.md"))
        try DomainFixtures.write("hidden", to: project.appendingPathComponent("00000000-0000-4000-8000-0000000000a1/tool-results/.cache/x.txt"))
        try DomainFixtures.write("{}\n", to: project.appendingPathComponent("notes.jsonl"))
        try DomainFixtures.write("stray", to: home.appendingPathComponent(".codex/sessions/2026/10/01/notes.txt"))
        let line = { (entrypoint: String) in "{\"type\":\"user\",\"entrypoint\":\(entrypoint),\"timestamp\":\"2026-10-01T09:00:00.000Z\"}\n" }
        try DomainFixtures.write(line("\"sdk-ts\""), to: project.appendingPathComponent("00000000-0000-4000-8000-0000000000e1.jsonl"))
        try DomainFixtures.write(line("\"claude-desktop\""), to: project.appendingPathComponent("00000000-0000-4000-8000-0000000000e2.jsonl"))
        try DomainFixtures.write(line("5") + line("\"sdk-cli\""), to: project.appendingPathComponent("00000000-0000-4000-8000-0000000000e3.jsonl"))
        let day = home.appendingPathComponent(".codex/sessions/2026/10/01", isDirectory: true)
        let meta = { (payload: String) in "{\"timestamp\":\"2026-10-01T11:00:00.000Z\",\"type\":\"session_meta\",\"payload\":\(payload)}\n" }
        for (name, first) in [("f1", meta("{\"originator\":\"codex_exec\",\"source\":\"vscode\"}")),
                              ("f2", "{\"timestamp\":\"2026-10-01T11:00:00.000Z\",\"type\":\"turn_context\",\"payload\":{}}\n"),
                              ("f3", meta("\"text\"")),
                              ("f4", meta("{\"originator\":\"codex_cli_rs\",\"source\":\"cli\",\"thread_source\":\"user\"}"))] {
            try DomainFixtures.write(first, to: day.appendingPathComponent("rollout-2026-10-01T11-00-00-00000000-0000-7000-8000-0000000000\(name).jsonl"))
        }
    }

    private func copy(_ from: URL, onto: URL) throws {
        let walk = try XCTUnwrap(FileManager.default.enumerator(atPath: from.path))
        while let relative = walk.nextObject() as? String {
            let source = from.appendingPathComponent(relative)
            guard FileFacts.isRegularFile(source.path) else { continue }
            let target = onto.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: target)
        }
    }
}

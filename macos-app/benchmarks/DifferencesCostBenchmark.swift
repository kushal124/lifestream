import Darwin
import Foundation
import HomeLink
import SQLite3
@testable import Shipping

@main
struct DifferencesCostBenchmark {
    let root: URL
    let rows: Int
    let real: Bool

    static func main() throws {
        let arguments = CommandLine.arguments.dropFirst()
        let rows = arguments.compactMap(Int.init).first ?? 30_000
        guard rows > 0 else { fatalError("rows must be positive") }
        let root = try Fixtures.scratch("differences-cost")
        defer { try? FileManager.default.removeItem(at: root) }
        try Self(root: root, rows: rows, real: arguments.contains("--real")).measure()
    }

    func measure() throws {
        let home = real ? FileManager.default.homeDirectoryForCurrentUser : root.appendingPathComponent("home", isDirectory: true)
        let ledgers = Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true))
        let declared = try ["whatsapp", "imessage"].reduce(into: [String: HomeLink.DeclaredStore]()) { $0[$1] = try Fixtures.declaration($1) }
        let shipper = DeclaredStores(file: root.appendingPathComponent("stores.json"),
                                     consent: StoreConsent(file: root.appendingPathComponent("allowed.json"), known: Set(declared.values.map(\.digest))),
                                     mac: DeclaredStores.Mac(home: home, lifestream: { [] }, applications: [], fullDiskAccess: { true }, wake: { _ in },
                                                             ledgers: ledgers, hashCacheDirectory: root.appendingPathComponent("hash-cache", isDirectory: true),
                                                             sessionDirectory: root.appendingPathComponent("sessions", isDirectory: true)))
        func file(_ id: String, _ member: String) throws -> URL {
            guard case .sqlite(let stores) = declared[id]?.store.engine, let path = stores.first(where: { $0.member == member })?.path else {
                throw CocoaError(.fileNoSuchFile)
            }
            return try StoreFiles(home: home, lifestream: []).path(path)
        }
        let whatsapp = (chats: try file("whatsapp", "chats.sqlite"), calls: try file("whatsapp", "calls.sqlite"))
        let chatDB = try file("imessage", "messages.db")
        if !real {
            _ = try Fixtures.directory(whatsapp.chats.deletingLastPathComponent())
            _ = try Fixtures.directory(chatDB.deletingLastPathComponent())
            try Fixtures.sqlite(whatsapp.chats, [try Fixtures.fixture("whatsapp-store")] + likeTheRealStore)
            try Fixtures.sqlite(whatsapp.calls, [try Fixtures.fixture("whatsapp-calls")])
            try Fixtures.sqlite(chatDB, [try Fixtures.fixture("imessage-store"),
                "WITH RECURSIVE n(x) AS (SELECT 1000 UNION ALL SELECT x + 1 FROM n WHERE x < \(999 + rows)) "
                    + "INSERT INTO message (ROWID, guid, text, service, date) "
                    + "SELECT x, 'SYNTH-' || x, 'synthetic message ' || x, 'iMessage', (700000000 + x * 200) * 1000000000 FROM n",
                "INSERT INTO chat_message_join SELECT 1, ROWID, date FROM message WHERE ROWID >= 1000"])
        }
        func engine(_ id: String) throws -> any ShippingDomain {
            try shipper.engine("\(id):measure:unit-0001", declared[id]!, StoreAccounts.Held(account: "measure", folder: nil))
        }

        let stores: [(name: String, domain: any ShippingDomain, main: URL, table: String)] = [
            ("whatsapp", try engine("whatsapp"), whatsapp.chats, "ZWAMESSAGE"),
            ("imessage", try engine("imessage"), chatDB, "message"),
        ]
        for store in stores {
            let source = try SQLiteSource(store.main)
            let rows = try SQLite.integer("SELECT count(*) FROM \(store.table)", in: source.url) ?? 0
            source.close()
            let work = root.appendingPathComponent("work-\(store.name)", isDirectory: true)
            var received = 0
            var pages = 0
            var bundleBytes = 0
            let firstSync = try cpu {
                while true {
                    let sealed = try store.domain.seal(SealRequest(fetchedAt: Date(), workDirectory: try Fixtures.directory(work),
                                                                   custody: SealCustody(pass: "p-measure", received: received, imported: received)))
                    guard !sealed.isEmpty else { break }
                    pages += sealed.filter { $0.sidecar.kind == "history" }.count
                    received += sealed.count
                    bundleBytes += sealed.compactMap { FileFacts.regularFileSize($0.file.path) }.reduce(0, +)
                    try FileManager.default.removeItem(at: work)
                }
            }
            let memory = ledgers.memory(pass: "p-measure", source: store.domain.sourceId)
            let files = try FileManager.default.contentsOfDirectory(atPath: memory.path).filter { $0.hasPrefix("memory-") }
            for file in files { try Fixtures.sqlite(memory.appendingPathComponent(file), ["UPDATE meta SET value = NULL WHERE name = 'stamp'"]) }
            var steadyBundles = 0
            let steady = try cpu {
                steadyBundles = try store.domain.seal(SealRequest(fetchedAt: Date(), workDirectory: try Fixtures.directory(work),
                                                                  custody: SealCustody(pass: "p-measure", received: received, imported: received))).count
            }
            let memoryBytes = files.compactMap { FileFacts.regularFileSize(memory.appendingPathComponent($0).path) }.reduce(0, +)
            print("differences-cost \(store.name) rows=\(rows) bundles=\(received) pages=\(pages) bundle_bytes=\(bundleBytes) "
                  + "first_sync_cpu_ms=\(firstSync) read_cpu_ms=\(steady) memory_bytes=\(memoryBytes)")
            print("differences-cost \(store.name) steady_bundles=\(steadyBundles)")
        }
    }

    var likeTheRealStore: [String] { [
        "CREATE TABLE ZWAMESSAGEDATAITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINDEX INTEGER, ZMESSAGE INTEGER, "
            + "ZCONTENT1 VARCHAR, ZCONTENT2 VARCHAR, ZMATCHEDTEXT VARCHAR, ZSUMMARY VARCHAR, ZTITLE VARCHAR, ZMETADATA BLOB)",
        "CREATE INDEX Z_WAMESSAGE_MESSAGEDATE ON ZWAMESSAGE (ZMESSAGEDATE)",
        "CREATE INDEX Z_WAMESSAGE_STANZAID ON ZWAMESSAGE (ZSTANZAID)",
        "CREATE INDEX Z_WAMESSAGE_MEDIAITEM ON ZWAMESSAGE (ZMEDIAITEM)",
        "CREATE INDEX Z_WAMESSAGE_MESSAGEINFO ON ZWAMESSAGE (ZMESSAGEINFO)",
        "CREATE INDEX Z_WAMESSAGE_PARENTMESSAGE ON ZWAMESSAGE (ZPARENTMESSAGE)",
        "CREATE INDEX Z_WAMESSAGE_GROUPMEMBER ON ZWAMESSAGE (ZGROUPMEMBER)",
        "CREATE INDEX Z_WAMEDIAITEM_MESSAGE ON ZWAMEDIAITEM (ZMESSAGE)",
        "CREATE INDEX Z_WAMESSAGEINFO_MESSAGE ON ZWAMESSAGEINFO (ZMESSAGE)",
        "BEGIN",
        "WITH RECURSIVE n(x) AS (SELECT 10 UNION ALL SELECT x + 1 FROM n WHERE x < 609) "
            + "INSERT INTO ZWACHATSESSION SELECT x, 5, 3 + x % 40, '1555' || printf('%07d', x) || '@s.whatsapp.net', "
            + "'9' || printf('%013d', x) || '@lid', 'Synthetic Person ' || x, x % 3, 0, 0, 0, 0, 1000 + x, x % 7, 1, 0, "
            + "810000000 + x, substr(hex(randomblob(60)), 1, 20 + abs(random()) % 90), NULL, hex(randomblob(8)), NULL, 1, NULL, "
            + "CASE WHEN x % 4 = 0 THEN x / 4 END, NULL, randomblob(80) FROM n",
        "WITH RECURSIVE n(x) AS (SELECT 10 UNION ALL SELECT x + 1 FROM n WHERE x < 159) "
            + "INSERT INTO ZWAGROUPINFO SELECT x, 7, 2, x * 4, NULL, 'Media/Profile/' || hex(randomblob(16)) || '.thumb', 2, "
            + "700000000.5 + x, 700000100.5 + x, '1555' || printf('%07d', x) || '@s.whatsapp.net', "
            + "'1555' || printf('%07d', x) || '@s.whatsapp.net', '9' || printf('%013d', x) || '@lid', "
            + "'1555' || printf('%07d', x) || '-1700000000@g.us', hex(randomblob(10)) FROM n",
        "WITH RECURSIVE n(x) AS (SELECT 10 UNION ALL SELECT x + 1 FROM n WHERE x < 2009) "
            + "INSERT INTO ZWAGROUPMEMBER SELECT x, 11, 1, '1555' || printf('%07d', x) || '@s.whatsapp.net', "
            + "'9' || printf('%013d', x) || '@lid' FROM n",
        "WITH RECURSIVE n(x) AS (SELECT 10 UNION ALL SELECT x + 1 FROM n WHERE x < 3009) "
            + "INSERT INTO ZWAPROFILEPUSHNAME SELECT x, 12, 1, '1555' || printf('%07d', x) || '@s.whatsapp.net', "
            + "'Synthetic Name ' || x FROM n",
        "WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 1 FROM n WHERE x < \(99 + rows)) "
            + "INSERT INTO ZWAMESSAGE SELECT x, 9, 2 + x % 5, x, NULL, 1, 10 + x % 600, CASE WHEN x % 3 = 0 THEN 10 + x % 2000 END, "
            + "NULL, CASE WHEN x % 4 = 0 THEN 100 + x END, CASE WHEN x % 2 = 0 THEN 100 + x END, "
            + "CASE WHEN x % 20 = 0 THEN x - 5 END, '3EB0' || hex(randomblob(10)), "
            + "CASE WHEN x % 4 <> 0 THEN substr(hex(randomblob(160)), 1, 5 + abs(random()) % 160) END, "
            + "'1555' || printf('%07d', x % 600) || '@s.whatsapp.net', '15550000001@s.whatsapp.net', "
            + "CASE WHEN x % 3 = 0 THEN 'Synthetic Name ' || x % 2000 END, 700000000.5 + x * 1300, 700000000.5 + x * 1300, "
            + "x % 4, 0, 256 + x % 3, 8 + x % 2, 0, x % 2, 0, NULL, CASE WHEN x % 4 = 0 THEN hex(randomblob(12)) END, "
            + "0, 0, 1, 0, 1, 1 FROM n",
        "WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 2 FROM n WHERE x < \(98 + rows)) "
            + "INSERT INTO ZWAMESSAGEINFO SELECT 100 + x, 10, 3, x, randomblob(120 + abs(random()) % 240) FROM n",
        "WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 4 FROM n WHERE x < \(96 + rows)) "
            + "INSERT INTO ZWAMEDIAITEM SELECT 100 + x, 8, 4, 20000 + abs(random()) % 4000000, 1, 0, 1.333, 0, 0, 0, NULL, NULL, NULL, "
            + "'https://mmg.whatsapp.net/v/t62.' || hex(randomblob(40)), NULL, NULL, NULL, randomblob(32), x, "
            + "'Media/1555' || printf('%07d', x % 600) || '@s.whatsapp.net/' || hex(randomblob(1)) || '/' || hex(randomblob(1)) || '/' || hex(randomblob(16)) || '.jpg', "
            + "'Media/1555' || printf('%07d', x % 600) || '@s.whatsapp.net/' || hex(randomblob(1)) || '/' || hex(randomblob(1)) || '/' || hex(randomblob(16)) || '.thumb', "
            + "'Media/1555' || printf('%07d', x % 600) || '@s.whatsapp.net/' || hex(randomblob(16)) || '.xmpp', 0, randomblob(400 + abs(random()) % 800) FROM n",
        "WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 8 FROM n WHERE x < \(92 + rows)) "
            + "INSERT INTO ZWAMESSAGEDATAITEM SELECT x, 14, 1, 0, x, 'https://example.com/' || hex(randomblob(20)), NULL, "
            + "'https://example.com/' || hex(randomblob(20)), substr(hex(randomblob(80)), 1, 120), 'Synthetic title ' || x, randomblob(200) FROM n",
        "COMMIT",
    ] }

    private func cpu(_ body: () throws -> Void) throws -> Int {
        func now() -> Int {
            var usage = rusage()
            getrusage(RUSAGE_SELF, &usage)
            let user = Int(usage.ru_utime.tv_sec) * 1000 + Int(usage.ru_utime.tv_usec) / 1000
            let system = Int(usage.ru_stime.tv_sec) * 1000 + Int(usage.ru_stime.tv_usec) / 1000
            return user + system
        }
        let start = now()
        try body()
        return now() - start
    }
}

private enum Fixtures {
    static func scratch(_ name: String) throws -> URL {
        try directory(FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)"))
    }

    static func directory(_ url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static let noMedia = "~/Lifestream Measure No Media"

    static func declaration(_ id: String) throws -> HomeLink.DeclaredStore {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Tests/Fixtures/stores/\(id).json")
        guard var block = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
              var store = block["store"] as? [String: Any], var engine = store["engine"] as? [String: Any],
              let stores = engine["stores"] as? [[String: Any]] else { throw CocoaError(.fileReadCorruptFile) }
        engine["stores"] = stores.map { store in store["file_root"] == nil ? store : store.merging(["file_root": noMedia]) { $1 } }
        store["engine"] = engine
        block["store"] = store
        return try JSONDecoder().decode(HomeLink.DeclaredStore.self, from: JSONSerialization.data(withJSONObject: block))
    }

    static func fixture(_ name: String) throws -> String {
        try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Tests/Fixtures/\(name).sql"), encoding: .utf8)
    }

    static func sqlite(_ file: URL, _ statements: [String]) throws {
        let handle = try SQLite.open(file, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        defer { sqlite3_close(handle) }
        for statement in statements { try SQLite.exec(statement, on: handle) }
    }
}

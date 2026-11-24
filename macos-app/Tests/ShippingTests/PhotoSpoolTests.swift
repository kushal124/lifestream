import CryptoKit
import DeviceFiles
import Foundation
import PhotoLibrary
import SQLite3
import XCTest
@testable import Shipping

class PhotoSpoolTests: XCTestCase {
    class var form: DeviceFiles.Form { .plain }

    static let source = "apple-photos:person-a@example.com:macbook-pro-0001"
    static let modified = "2026-09-22T06:00:00.000000000Z"
    static let observed = "2026-09-22T06:30:00.000000000Z"
    static let place = "51.501234"
    static let blobBytes = Data("synthetic photo bytes".utf8)
    static var blobHash: String { SHA256.hash(data: blobBytes).map { String(format: "%02x", $0) }.joined() }

    var root: URL!
    var files: DeviceFiles!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("photo-spool-tests")
        files = DeviceFiles(Self.form)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    var domain: PhotosDomain {
        PhotosDomain(sourceId: Self.source, root: root.appendingPathComponent("photos", isDirectory: true),
                     ledgers: Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: files))
    }

    static func asset(_ id: String, hash: String = String(repeating: "ab", count: 32)) -> PhotoEntry {
        PhotoEntry(kind: .asset, replayKey: "photos:\(id):\(modified):\(hash)", observedAt: observed,
                   payload: Data(#"{"local_identifier":"\#(id)","latitude":\#(place)}"#.utf8))
    }

    static func availability(_ id: String) -> PhotoEntry {
        PhotoEntry(kind: .availability, replayKey: "photos:\(id):\(modified):availability:\(String(repeating: "cd", count: 32)):\(observed)",
                   observedAt: observed,
                   payload: Data(#"{"local_identifier":"\#(id)","resources":[{"blob":{"hash":"sha256:\#(blobHash)"}}]}"#.utf8))
    }

    static func gone(_ entry: PhotoEntry) -> PhotoEntry {
        PhotoEntry(kind: .gone, replayKey: entry.replayKey + ":gone", observedAt: observed, payload: Data(#"{"of":"asset"}"#.utf8))
    }

    static var fixture: [PhotoEntry] {
        let first = asset("A1/L0/001")
        let other = asset("A10/L0/001")
        return [first, availability("A1/L0/001"), gone(first), other, asset("B2/L0/001"), availability("B2/L0/001")]
    }

    static func plain(_ entries: [PhotoEntry]) -> [String] {
        entries.map { "\($0.kind.rawValue) \($0.replayKey) \($0.observedAt) \(String(decoding: $0.payload, as: UTF8.self))" }
    }

    func export(_ bytes: Data = blobBytes) throws -> URL {
        let scratch = root.appendingPathComponent("scratch/mac/app/photos", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        let url = scratch.appendingPathComponent("photo-\(UUID().uuidString)")
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: bytes))
        return url
    }

    func todaysQuery(_ prefix: String, over entries: [PhotoEntry]) throws -> [String] {
        let database = root.appendingPathComponent("today.sqlite")
        try? FileManager.default.removeItem(at: database)
        let handle = try SQLite.open(database, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        defer { sqlite3_close(handle) }
        try SQLite.exec(Self.todaysSchema, on: handle)
        for entry in entries { try Self.insertToday(entry, on: handle) }
        guard let last = prefix.unicodeScalars.last, let next = UnicodeScalar(last.value + 1) else { return [] }
        let end = String(prefix.unicodeScalars.dropLast()) + String(next)
        var found: [String] = []
        try SQLite.rows("SELECT kind, replay_key, observed_at, payload FROM entries WHERE replay_key >= \(SQLiteDelta.literal(prefix)) "
                        + "AND replay_key < \(SQLiteDelta.literal(end)) ORDER BY sequence", on: handle) { cells in
            found.append(cells.map { cell in if case .text(let text) = cell { text } else { "" } }.joined(separator: " "))
        }
        return found
    }

    static let todaysSchema = "CREATE TABLE IF NOT EXISTS entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, "
        + "replay_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL)"

    static func insertToday(_ entry: PhotoEntry, on handle: OpaquePointer) throws {
        try SQLite.exec("INSERT INTO entries (replay_key, kind, observed_at, payload) VALUES ("
                        + [entry.replayKey, entry.kind.rawValue, entry.observedAt, String(decoding: entry.payload, as: UTF8.self)]
                            .map(SQLiteDelta.literal).joined(separator: ", ") + ")", on: handle)
    }

    func rows(_ database: URL) throws -> [[String]] {
        var rows: [[String]] = []
        try SQLite.rows("SELECT * FROM entries ORDER BY sequence", in: database) { cells in
            rows.append(cells.map { cell in if case .text(let text) = cell { text } else { "" } })
        }
        return rows
    }


    func testEachShapeOfPrefixAnswersTodaysEntriesWithTheirPlainKeys() async throws {
        let spool = domain.photos
        _ = try await spool.append(Self.fixture)
        let first = Self.asset("A1/L0/001")
        for prefix in ["photos:A1/L0/001:", "photos:A1/L0/001:\(Self.modified)", first.replayKey, "photos:B2/L0/001:"] {
            let answered = Self.plain(try await spool.written(prefix: prefix))
            XCTAssertEqual(answered, try todaysQuery(prefix, over: Self.fixture), prefix)
        }
        let asset = try await spool.written(prefix: "photos:A1/L0/001:")
        XCTAssertEqual(asset.map(\.kind), [.asset, .availability, .gone],
                       "the asset, its availability and its gone entry, never the asset whose id it begins")
        let whole = try await spool.written(prefix: first.replayKey)
        XCTAssertEqual(whole.map(\.replayKey), [first.replayKey, first.replayKey + ":gone"])
        let none = try await spool.written(prefix: "photos:NONE/L0/001:")
        XCTAssertEqual(none, [])
    }

    func testEntriesAfterAreTodaysAndAnEntryAppendedTwiceIsRefusedOnce() async throws {
        let spool = domain.photos
        let appended = try await spool.append(Self.fixture)
        XCTAssertEqual(appended, Self.fixture.count)
        let again = try await spool.append([Self.asset("A1/L0/001"), Self.asset("C3/L0/001")])
        XCTAssertEqual(again, 1, "the one already written is refused")
        let owed = try spool.entries(after: 1, limit: 3)
        XCTAssertEqual(owed.map(\.sequence), [2, 3, 4])
        XCTAssertEqual(owed.map { "\($0.kind) \($0.observedAt) \(String(decoding: $0.payload, as: UTF8.self))" },
                       Self.fixture[1...3].map { "\($0.kind.rawValue) \($0.observedAt) \(String(decoding: $0.payload, as: UTF8.self))" })
        XCTAssertEqual(owed.first?.blobs, [Self.blobHash])
        XCTAssertEqual(try spool.lastSequence(), try spool.entries(after: 0, limit: 100).last?.sequence)
    }

    func testAPlainFileOfTheReleasedSchemaIsReadAndWrittenAsReleased() async throws {
        guard !files.keyed else { return }
        let spool = domain.photos
        try FileManager.default.createDirectory(at: spool.root, withIntermediateDirectories: true)
        let handle = try SQLite.open(spool.database, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        try SQLite.exec(Self.todaysSchema, on: handle)
        for entry in Self.fixture { try Self.insertToday(entry, on: handle) }
        sqlite3_close(handle)
        let before = try rows(spool.database)

        let answered = try await spool.written(prefix: "photos:A1/L0/001:")
        XCTAssertEqual(Self.plain(answered), try todaysQuery("photos:A1/L0/001:", over: Self.fixture))
        XCTAssertEqual(try spool.lastSequence(), Self.fixture.count)
        XCTAssertEqual(try rows(spool.database), before, "a read writes nothing")
        let refused = try await spool.append([Self.asset("A1/L0/001")])
        XCTAssertEqual(refused, 0, "a released row still refuses its entry")
        let added = Self.asset("C3/L0/001")
        let appended = try await spool.append([added])
        XCTAssertEqual(appended, 1)
        XCTAssertEqual(try SQLite.columns(of: "entries", in: spool.database),
                       ["sequence", "replay_key", "kind", "observed_at", "payload"], "the released schema, no column added")
        XCTAssertEqual(try rows(spool.database).last.map { Array($0[1...]) },
                       [added.replayKey, added.kind.rawValue, added.observedAt, String(decoding: added.payload, as: UTF8.self)])
        XCTAssertEqual(try SQLite.integer("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'entries_asset'",
                                          in: spool.database), 0)
    }

    func testAReadTakesNoWriteLock() async throws {
        let spool = domain.photos
        _ = try await spool.append(Self.fixture)
        let writer = try SQLite.open(spool.database, flags: SQLITE_OPEN_READWRITE)
        defer { sqlite3_close(writer) }
        try SQLite.exec("BEGIN IMMEDIATE", on: writer)
        let written = try await spool.written(prefix: "photos:A1/L0/001:")
        XCTAssertEqual(written.count, 3, "read while another holds the write lock")
        XCTAssertEqual(try spool.entries(after: 0, limit: 100).count, Self.fixture.count)
        XCTAssertEqual(try spool.lastSequence(), Self.fixture.count)
        try SQLite.exec("ROLLBACK", on: writer)
    }

    func testANewFileIsCreatedWithItsFormsSchema() async throws {
        let spool = domain.photos
        _ = try await spool.append([Self.asset("A1/L0/001")])
        let columns: Set<String> = ["sequence", "replay_key", "kind", "observed_at", "payload"]
        XCTAssertEqual(try SQLite.columns(of: "entries", in: spool.database), files.keyed ? columns.union(["asset", "key"]) : columns)
        XCTAssertEqual(try SQLite.integer("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'entries_asset'",
                                          in: spool.database), files.keyed ? 1 : 0)
        XCTAssertEqual(try spool.entries(after: 0, limit: 100).count, 1)
    }

    func testAPhotosExportIsPlacedAtItsNamedBlobAndLeavesNothingInScratch() async throws {
        let spool = domain.photos
        let made = try export()
        let stored = try await spool.store(made)
        XCTAssertEqual(stored.hash, "sha256:" + Self.blobHash)
        XCTAssertEqual(stored.bytes, UInt64(Self.blobBytes.count))
        XCTAssertFalse(FileManager.default.fileExists(atPath: made.path))
        let again = try export()
        _ = try await spool.store(again)
        XCTAssertFalse(FileManager.default.fileExists(atPath: again.path), "a held blob's export is deleted")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: made.deletingLastPathComponent().path), [])

        let blob = try XCTUnwrap(spool.blob(Self.blobHash))
        XCTAssertEqual(blob.lastPathComponent, files.name(Self.blobHash))
        XCTAssertEqual(try files.read(blob, maximumBytes: 1 << 20), Self.blobBytes)
        XCTAssertEqual(spool.size(of: blob), Self.blobBytes.count)
        XCTAssertNil(spool.blob("not-a-hash"))
    }

    func testTheSweepKeepsOnlyTheBlobsAnOwedEntryNames() async throws {
        let spool = domain.photos
        _ = try await spool.append([Self.asset("A1/L0/001"), Self.availability("A1/L0/001")])
        _ = try await spool.store(try export())
        let stray = spool.blobs.appendingPathComponent(files.name(String(repeating: "ef", count: 32)))
        try files.writeNew(stray, Data("a stray".utf8), flush: .data)
        try spool.sweep(keepingAfter: 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: spool.blobs.path), [files.name(Self.blobHash)])
        try spool.sweep(keepingAfter: 2)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: spool.blobs.path), [])
    }

    func testThePassStateIsReplacedAndAnAbsentOneIsNone() throws {
        let spool = domain.photos
        XCTAssertNil(spool.readState())
        try spool.writeState(Data(#"{"later":[]}"#.utf8))
        XCTAssertEqual(spool.readState(), Data(#"{"later":[]}"#.utf8))
        try spool.writeState(Data(#"{"later":["A1/L0/001"]}"#.utf8))
        XCTAssertEqual(spool.readState(), Data(#"{"later":["A1/L0/001"]}"#.utf8))
    }

    func testAPlainSpoolKeepsTodaysValuesNamesAndFolder() async throws {
        guard !files.keyed else { return }
        let spool = domain.photos
        XCTAssertEqual(spool.root.lastPathComponent, ShippingState.fileName(forSource: Self.source))
        _ = try await spool.append(Self.fixture)
        let kept = try rows(spool.database)
        XCTAssertEqual(kept.map { Array($0[1...4]) },
                       Self.fixture.map { [$0.replayKey, $0.kind.rawValue, $0.observedAt, String(decoding: $0.payload, as: UTF8.self)] })
        XCTAssertEqual(kept.map(\.count), Self.fixture.map { _ in 5 }, "the released row, no column added")
        _ = try await spool.store(try export())
        XCTAssertEqual(try Data(contentsOf: spool.blobs.appendingPathComponent(Self.blobHash)), Self.blobBytes)
        try spool.writeState(Data("{}".utf8))
        XCTAssertEqual(try Data(contentsOf: spool.stateFile), Data("{}".utf8))
    }
}

final class KeyedPhotoSpoolTests: PhotoSpoolTests {
    override class var form: DeviceFiles.Form { .keyed(ShippingFixture.macKey) }

    func testAKeyedDomainSealsAnEncryptedBundleWhosePhotoIsThePlainExport() async throws {
        let domain = self.domain
        _ = try await domain.photos.append([Self.asset("A1/L0/001"), Self.availability("A1/L0/001")])
        _ = try await domain.photos.store(try export())
        let pending = root.appendingPathComponent("pending", isDirectory: true)
        try FileManager.default.createDirectory(at: pending, withIntermediateDirectories: true)
        let sealed = try domain.seal(SealRequest(fetchedAt: Date(timeIntervalSince1970: 1_790_000_000), workDirectory: pending, scratch: pending,
                                                 custody: SealCustody(pass: "pass-a", received: 0, imported: 0)))
        let bundle = try XCTUnwrap(sealed.first).file
        let onDisk = try XCTUnwrap(FileManager.default.contents(atPath: bundle.path))
        XCTAssertFalse(onDisk.starts(with: [0x50, 0x4b]), "the bundle on disk is no zip")
        XCTAssertNil(onDisk.range(of: Self.blobBytes), "nor holds the photo's bytes")
        let members = try StoredZipReader(bundle).members
        XCTAssertEqual(members.first { $0.name == "blobs/" + Self.blobHash }?.bytes, Self.blobBytes, "the bundle carries the plain export")
    }

    func testAKeyedSpoolOverAFileOfThePlainSchemaFailsAndNeverFallsBack() async throws {
        let spool = domain.photos
        try FileManager.default.createDirectory(at: spool.root, withIntermediateDirectories: true)
        let handle = try SQLite.open(spool.database, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        try SQLite.exec(Self.todaysSchema, on: handle)
        for entry in Self.fixture { try Self.insertToday(entry, on: handle) }
        sqlite3_close(handle)
        let before = try rows(spool.database)
        do {
            _ = try await spool.written(prefix: "photos:A1/L0/001:")
            XCTFail("a keyed read of a plain file answered")
        } catch {}
        do {
            _ = try await spool.append([Self.asset("C3/L0/001")])
            XCTFail("a keyed append to a plain file wrote")
        } catch {}
        XCTAssertEqual(try rows(spool.database), before, "the file is left as it was")
    }

    func testAKeyedSpoolKeepsNoTimePlaceKeyHashOrSourceInTheClear() async throws {
        let spool = domain.photos
        XCTAssertFalse(spool.root.lastPathComponent.contains("person-a"), "no source id in the folder's name")
        XCTAssertEqual(spool.root.lastPathComponent, files.name(Self.source))
        _ = try await spool.append(Self.fixture)
        _ = try await spool.store(try export())
        try spool.writeState(Data(#"{"later":["A1/L0/001"]}"#.utf8))

        let database = try XCTUnwrap(FileManager.default.contents(atPath: spool.database.path))
        for clear in ["2026-09-22", Self.place, "photos:", "A1/L0/001", Self.blobHash, String(repeating: "ab", count: 32)] {
            XCTAssertNil(database.range(of: Data(clear.utf8)), "entries.sqlite holds \(clear) in the clear")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: spool.blobs.path), [files.name(Self.blobHash)],
                       "no content hash as a blob's name")
        let blob = try XCTUnwrap(FileManager.default.contents(atPath: spool.blobs.appendingPathComponent(files.name(Self.blobHash)).path))
        XCTAssertNil(blob.range(of: Self.blobBytes), "the blob's bytes are encrypted")
        XCTAssertNotEqual(blob.count, Self.blobBytes.count)
        let state = try XCTUnwrap(FileManager.default.contents(atPath: spool.stateFile.path))
        XCTAssertNil(state.range(of: Data("A1/L0/001".utf8)), "pass.json is encrypted")
    }
}

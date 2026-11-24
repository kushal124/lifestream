import CryptoKit
import DeviceFiles
import Foundation
import PhoneBackupFixture
import SQLite3
import XCTest
import PhoneBackup

final class BackupPullTests: XCTestCase {
    private var root: URL!
    private var backups: URL { root.appendingPathComponent("Backup") }
    private var work: URL { root.appendingPathComponent("work") }
    private var out: URL { root.appendingPathComponent("carried/backups/a-backup") }
    private var kept: (url: URL, tree: [String: String])?

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("backup-pull-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let kept { XCTAssertEqual(try Self.tree(kept.url), kept.tree, "the backup folder was written") }
        try? FileManager.default.removeItem(at: root)
    }

    private func phone(_ media: [Int] = [2_000, 31, 70_001], password: String? = SyntheticBackup.password,
                       change: (inout [SyntheticBackup.File]) throws -> Void = { _ in }) throws -> (made: SyntheticBackup.Made, backup: OpenBackup) {
        var files = try SyntheticBackup.phone(whatsAppMedia: media, calls: password != nil)
        try change(&files)
        let made = try SyntheticBackup.write(in: backups, password: password, files: files)
        kept = (made.url, try Self.tree(made.url))
        return (made, try OpenBackup(try BackupFolder(at: made.url), password: password, work: work))
    }

    private static let roomy = BackupPull.Asks(held: { _ in [] }, room: { _ in })

    func testAPhoneComesOutAsThreeFolders() async throws {
        let (made, backup) = try phone()
        let asked = Box<[BackupPull.RoomAsk]>([])
        let result = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: .init(held: { _ in [] }, room: { asked.append($0) })).run()

        XCTAssertEqual(result.pulled.map(\.store), [.imessage, .whatsapp, .appleCalls])
        XCTAssertEqual(result.unreadable, [:])
        XCTAssertEqual(result.pulled.map(\.members), [["attachments.json", "backup.json", "messages.db"],
                                                      ["backup.json", "calls.sqlite", "chats.sqlite", "media.json"],
                                                      ["backup.json", "callhistory.sqlite"]])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path).sorted(), ["apple-calls", "blobs", "imessage", "whatsapp"], "no scratch left")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), ["phone-backup"], "the pull-out's scratch is gone")

        let chats = out.appendingPathComponent("whatsapp/chats.sqlite")
        XCTAssertEqual(try Self.column("SELECT ZSTANZAID FROM ZWAMESSAGE WHERE Z_PK = 2", chats), [SyntheticBackup.logOnlyStanza])
        XCTAssertEqual(try Self.column("PRAGMA journal_mode", chats), ["delete"])
        XCTAssertEqual(try Self.column("SELECT count(*) FROM message", out.appendingPathComponent("imessage/messages.db")), ["3"])
        XCTAssertEqual(try Self.column("SELECT count(*) FROM ZCALLRECORD", out.appendingPathComponent("apple-calls/callhistory.sqlite")), ["2"])
        XCTAssertEqual(try Self.column("SELECT count(*) FROM _SqliteDatabaseProperties WHERE key = '_ClientVersion'", out.appendingPathComponent("imessage/messages.db")), ["1"])
        XCTAssertEqual(try Self.column("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ZCALLRECORD', 'ZHANDLE', 'Z_2REMOTEPARTICIPANTHANDLES', 'ZEMERGENCYMEDIAITEM') ORDER BY name",
                                       out.appendingPathComponent("apple-calls/callhistory.sqlite")), ["ZCALLRECORD", "ZEMERGENCYMEDIAITEM", "ZHANDLE", "Z_2REMOTEPARTICIPANTHANDLES"])

        let attachments = try Self.index(out.appendingPathComponent("imessage/attachments.json"))
        XCTAssertEqual(attachments.map(\.path), ["Attachments/ab/01/00000000-0000-0000-0000-00000000A001/IMG_0001.HEIC"],
                       "two rows naming one file are one entry; the file not held and the one not named are left out")
        XCTAssertEqual(attachments.first?.sha256, Self.sha(SyntheticBackup.bytes(31, seed: 5)))
        XCTAssertEqual(attachments.first?.bytes, 31)
        let media = try Self.index(out.appendingPathComponent("whatsapp/media.json"))
        XCTAssertEqual(media.map(\.path), (0..<3).map(SyntheticBackup.whatsAppPointer))
        XCTAssertEqual(media.map(\.bytes), [2_000, 31, 70_001])

        let blobs = Set(attachments.map(\.sha256) + media.map(\.sha256))
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: result.blobs.path)), blobs)
        for blob in blobs { XCTAssertEqual(Self.sha(try Data(contentsOf: result.blobs.appendingPathComponent(blob))), blob) }
        XCTAssertEqual(result.pulled[1].blobs.map(\.sha256), media.map(\.sha256).sorted())
        XCTAssertEqual(result.pulled[2].blobs, [])

        var facts: [[String: Any]] = []
        for pulled in result.pulled {
            let data = try Data(contentsOf: pulled.folder.appendingPathComponent("backup.json"))
            let text = String(decoding: data, as: UTF8.self)
            XCTAssertFalse(text.contains(made.udid) || text.lowercased().contains(made.udid.lowercased()), "the UDID left the Mac")
            XCTAssertFalse(text.contains(made.serial), "the serial left the Mac")
            facts.append(try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any]))
        }
        XCTAssertEqual(facts.map { $0["store"] as? String }, ["imessage", "whatsapp", "apple-calls"])
        let folder = try BackupFolder(at: made.url)
        for fact in facts {
            XCTAssertEqual(Set(fact.keys), ["accounts", "device", "encrypted", "ios", "last_backup", "model", "model_name", "serial4", "store"])
            XCTAssertEqual(fact["accounts"] as? [String: [String]], ["apple": [SyntheticBackup.appleID], "whatsapp": [SyntheticBackup.ownJID]])
            XCTAssertEqual(fact["device"] as? String, folder.device)
            XCTAssertEqual(fact["serial4"] as? String, folder.serial4)
            XCTAssertEqual(fact["model"] as? String, "iPhone18,1")
            XCTAssertEqual(fact["model_name"] as? String, "iPhone 17 Pro")
            XCTAssertEqual(fact["ios"] as? String, "27.0")
            XCTAssertEqual(fact["last_backup"] as? String, "2026-08-28T11:20:55Z")
            XCTAssertEqual(fact["encrypted"] as? Bool, true)
        }

        let asks = asked.value
        XCTAssertEqual(asks.count, 2)
        guard case .stores(let storeBytes) = asks[0], case .media(let mediaBytes) = asks[1] else { return XCTFail("\(asks)") }
        XCTAssertGreaterThan(storeBytes, 0)
        XCTAssertGreaterThan(mediaBytes, 2_000 + 31 + 70_001)
    }

    func testAnIndexHashIsThePlaintexts() async throws {
        let lengths = Array(0...33)
        let (made, backup) = try phone(lengths)
        let result = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: Self.roomy).run()
        let media = try Self.index(result.pulled[1].folder.appendingPathComponent("media.json"))
        let byPath = Dictionary(uniqueKeysWithValues: media.map { ($0.path, $0) })
        for length in lengths {
            let content = SyntheticBackup.bytes(length, seed: UInt8(40 + length))
            let entry = try XCTUnwrap(byPath[SyntheticBackup.whatsAppPointer(length)])
            XCTAssertEqual(entry.sha256, Self.sha(content), "length \(length)")
            XCTAssertEqual(entry.bytes, Int64(length))
            let file = try XCTUnwrap(try backup.file(domain: BackupStore.whatsAppDomain, path: BackupStore.whatsAppMessage.prefix + SyntheticBackup.whatsAppPointer(length)))
            XCTAssertEqual(try backup.digest(file), BackupDigest(sha256: Self.sha(content), bytes: Int64(length)))
        }
        _ = made
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: OpenBackup.scratch(in: work).path), ["Manifest.db"], "digest writes nothing")
    }

    func testOnlyTheMediaTheHomeLacksComeOut() async throws {
        let (_, backup) = try phone(Array(1...10).map { $0 * 100 })
        let asked = Box<[[String]]>([])
        let result = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: .init(held: { hashes in
            asked.append(hashes)
            return Set(hashes.enumerated().filter { $0.offset % 2 == 0 }.map(\.element))
        }, room: { _ in })).run()
        let all = asked.value.flatMap { $0 }
        XCTAssertEqual(all.count, 11, "ten WhatsApp media and one attachment, each asked once")
        XCTAssertTrue(asked.value.allSatisfy { $0.count <= BackupPull.heldBatch })
        let lacking = Set(all.enumerated().filter { $0.offset % 2 == 1 }.map(\.element))
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: result.blobs.path)), lacking)
        XCTAssertEqual(Set(result.pulled.flatMap(\.blobs).map(\.sha256)), lacking)
        XCTAssertEqual(try Self.index(result.pulled[1].folder.appendingPathComponent("media.json")).count, 10)
    }

    func testNoMediumIsWrittenBeforeItsRoom() async throws {
        let (_, backup) = try phone()
        let destination = out
        struct NoRoom: Error {}
        let seen = Box<[String]>([])
        do {
            _ = try await BackupPull(backup, into: destination, scratch: work, files: DeviceFiles(.plain), asks: .init(held: { _ in [] }, room: { ask in
                guard case .media = ask else { return }
                let fm = FileManager.default
                seen.append(contentsOf: ["imessage/messages.db", "whatsapp/chats.sqlite", "apple-calls/callhistory.sqlite"]
                    .filter { fm.fileExists(atPath: destination.appendingPathComponent($0).path) })
                let blobs = destination.appendingPathComponent("blobs")
                if fm.fileExists(atPath: blobs.path), !(try fm.contentsOfDirectory(atPath: blobs.path)).isEmpty { seen.append("a blob") }
                throw NoRoom()
            })).run()
            XCTFail("the refusal stops the pull-out")
        } catch is NoRoom {}
        XCTAssertEqual(seen.value, ["imessage/messages.db", "whatsapp/chats.sqlite", "apple-calls/callhistory.sqlite"], "stores pulled, no medium")
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path), "a stopped pull-out leaves nothing")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), ["phone-backup"], "nor any scratch")
    }

    func testABackupRemadeMidReadStops() async throws {
        let (made, backup) = try phone()
        kept = nil
        let url = made.url
        do {
            _ = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: .init(held: { _ in [] }, room: { _ in }, progress: { progress in
                if progress.store == .imessage { try? SyntheticBackup.writeStatus(at: url, finished: false) }
            })).run()
            XCTFail("a remade backup is not read on")
        } catch let error as BackupError {
            XCTAssertEqual(error, .remade)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "its folder is removed")

        try SyntheticBackup.writeStatus(at: url, finished: true)
        try SyntheticBackup.writeInfo(at: url, udid: made.udid, serial: made.serial, lastBackup: made.lastBackup.addingTimeInterval(3_600))
        do {
            _ = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: Self.roomy).run()
            XCTFail("another lastBackup is another backup")
        } catch let error as BackupError {
            XCTAssertEqual(error, .remade)
        }
    }

    func testTheSameBackupGivesTheSameBytes() async throws {
        let (_, backup) = try phone()
        let first = try await BackupPull(backup, into: root.appendingPathComponent("first"), scratch: work, files: DeviceFiles(.plain), asks: Self.roomy).run()
        let second = try await BackupPull(backup, into: root.appendingPathComponent("second"), scratch: work, files: DeviceFiles(.plain), asks: Self.roomy).run()
        for (one, two) in zip(first.pulled, second.pulled) {
            XCTAssertEqual(try Self.tree(one.folder), try Self.tree(two.folder), one.store.rawValue)
        }
        XCTAssertEqual(try Self.tree(first.blobs), try Self.tree(second.blobs))
    }

    func testAStoreThatDoesNotReadIsLeftOut() async throws {
        let (_, backup) = try phone(password: nil) { files in
            let at = try XCTUnwrap(files.firstIndex { $0.path == BackupStore.messages.path })
            files[at] = SyntheticBackup.File(domain: BackupStore.messages.domain, path: BackupStore.messages.path, content: SyntheticBackup.bytes(9_000, seed: 3))
        }
        let result = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: Self.roomy).run()
        XCTAssertEqual(result.pulled.map(\.store), [.whatsapp], "no call history unencrypted; iMessage did not read")
        XCTAssertEqual(Array(result.unreadable.keys), [.imessage])
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.appendingPathComponent("imessage").path))
        let facts = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: result.pulled[0].folder.appendingPathComponent("backup.json"))) as? [String: Any])
        XCTAssertEqual(facts["accounts"] as? [String: [String]], ["apple": [], "whatsapp": [SyntheticBackup.ownJID]])
        XCTAssertEqual(facts["encrypted"] as? Bool, false)
    }

    func testAMediumThatDoesNotReadIsLeftOutOfItsIndex() async throws {
        let (made, backup) = try phone()
        let gone = try XCTUnwrap(try backup.file(domain: BackupStore.whatsAppDomain, path: BackupStore.whatsAppMessage.prefix + SyntheticBackup.whatsAppPointer(1)))
        try FileManager.default.removeItem(at: made.url.appendingPathComponent(String(gone.fileID.prefix(2))).appendingPathComponent(gone.fileID))
        kept = (made.url, try Self.tree(made.url))
        let result = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: Self.roomy).run()
        XCTAssertEqual(result.pulled.map(\.store), [.imessage, .whatsapp, .appleCalls])
        XCTAssertEqual(result.unreadable, [:])
        let media = try Self.index(out.appendingPathComponent("whatsapp/media.json"))
        XCTAssertEqual(media.map(\.path), [SyntheticBackup.whatsAppPointer(0), SyntheticBackup.whatsAppPointer(2)], "the medium that did not read is absent")
        XCTAssertEqual(result.pulled[1].blobs.map(\.sha256).sorted(), media.map(\.sha256).sorted())
    }

    func testProgressIsToldAStoreAndNotAMedium() async throws {
        let (_, backup) = try phone(Array(1...200).map { $0 * 10 })
        let told = Box<[BackupPull.Progress]>([])
        _ = try await BackupPull(backup, into: out, scratch: work, files: DeviceFiles(.plain), asks: .init(held: { _ in [] }, room: { _ in }, progress: { told.append($0) })).run()
        XCTAssertEqual(told.value.map(\.store).reduce(into: [BackupPull.Store]()) { if $0.last != $1 { $0.append($1) } },
                       [.imessage, .whatsapp, .appleCalls], "each store, Calls among them")
        let whatsapp = told.value.filter { $0.store == .whatsapp }
        XCTAssertEqual(whatsapp.last.map { [$0.hashed, $0.indexed] }, [200, 200], "the last medium is told")
        XCTAssertLessThan(whatsapp.count, 20, "not once a medium: \(whatsapp.count)")
    }

    func testAKeyedPullOutIsEncryptedInPlaceAndOpensToThePlainOnesBytes() async throws {
        let (_, backup) = try phone()
        let keyed = DeviceFiles(.keyed(SymmetricKey(data: Data(repeating: 0x5a, count: 32))))
        let plainOut = root.appendingPathComponent("plain"), keyedOut = root.appendingPathComponent("keyed")
        let plain = try await BackupPull(backup, into: plainOut, scratch: work, files: DeviceFiles(.plain), asks: Self.roomy).run()
        let sealed = try await BackupPull(backup, into: keyedOut, scratch: work, files: keyed, asks: Self.roomy).run()
        XCTAssertEqual(sealed.pulled.map(\.members), plain.pulled.map(\.members))
        XCTAssertEqual(sealed.pulled.map(\.blobs), plain.pulled.map(\.blobs))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), ["phone-backup"], "the pull-out's scratch is gone")

        let plainTree = try Self.tree(plainOut)
        var opened: [String: String] = [:]
        let walk = FileManager.default.enumerator(at: keyedOut, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? []
        for file in walk where (try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            let name = String(file.standardizedFileURL.path.dropFirst(keyedOut.standardizedFileURL.path.count))
            let disk = try Data(contentsOf: file)
            XCTAssertEqual(disk.first, 40, "\(name) is a whole encrypted file")
            XCTAssertNil(disk.range(of: Data("SQLite format 3".utf8)), "\(name) holds no plain database")
            XCTAssertNil(disk.range(of: Data("\"store\"".utf8)), "\(name) holds no plain JSON")
            opened[name] = Self.sha(try XCTUnwrap(try keyed.read(file, maximumBytes: Int.max)))
        }
        let named = Dictionary(uniqueKeysWithValues: plainTree.map { path, sha in
            path.hasPrefix("/blobs/") ? ("/blobs/" + keyed.name(String(path.dropFirst("/blobs/".count))), sha) : (path, sha)
        })
        XCTAssertEqual(opened, named, "each kept file opens to the plain pull-out's bytes, each medium at its keyed name")
        let plainBlobs = try FileManager.default.contentsOfDirectory(atPath: plain.blobs.path)
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: sealed.blobs.path)), Set(plainBlobs.map(keyed.name)))
        XCTAssertTrue(Set(plainBlobs).isDisjoint(with: try FileManager.default.contentsOfDirectory(atPath: sealed.blobs.path)), "no medium is named by its hash")
    }

    func testAKeyedPullOutThatStopsLeavesNeitherFolderNorScratch() async throws {
        let (_, backup) = try phone()
        let keyed = DeviceFiles(.keyed(SymmetricKey(data: Data(repeating: 0x5a, count: 32))))
        struct NoRoom: Error {}
        do {
            _ = try await BackupPull(backup, into: out, scratch: work, files: keyed, asks: .init(held: { _ in [] }, room: { ask in
                guard case .media = ask else { return }
                throw NoRoom()
            })).run()
            XCTFail("the refusal stops the pull-out")
        } catch is NoRoom {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), ["phone-backup"])
    }


    struct Entry: Decodable { let path: String; let sha256: String; let bytes: Int64 }

    private static func index(_ url: URL) throws -> [Entry] {
        struct Stated: Decodable { let sha256: String; let bytes: Int64 }
        struct Index: Decodable { let format: String; let entries: [String: Stated] }
        let index = try JSONDecoder().decode(Index.self, from: Data(contentsOf: url))
        XCTAssertEqual(index.format, "org.lifestreamprotocol.blob-index/1")
        return index.entries.keys.sorted().map { Entry(path: $0, sha256: index.entries[$0]!.sha256, bytes: index.entries[$0]!.bytes) }
    }

    private static func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func tree(_ url: URL) throws -> [String: String] {
        var tree: [String: String] = [:]
        let files = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? []
        for file in files where (try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            tree[String(file.standardizedFileURL.path.dropFirst(url.standardizedFileURL.path.count))] = sha(try Data(contentsOf: file))
        }
        return tree
    }

    private static func column(_ sql: String, _ url: URL) throws -> [String] {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY, nil), SQLITE_OK)
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw XCTSkip(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(statement) }
        var values: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW { values.append(sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? "") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path + "-wal"), "a log beside \(url.lastPathComponent)")
        return values
    }
}

final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Value
    init(_ value: Value) { held = value }
    var value: Value { lock.withLock { held } }
    func update(_ change: (inout Value) -> Void) { lock.withLock { change(&held) } }
}

extension Box {
    func append<Element>(_ element: Element) where Value == [Element] { update { $0.append(element) } }
    func append<Element>(contentsOf elements: [Element]) where Value == [Element] { update { $0.append(contentsOf: elements) } }
}

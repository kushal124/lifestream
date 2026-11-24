import CryptoKit
import DeviceFiles
import Foundation
import HomeLink
import PhoneBackup
import PhoneBackupFixture
import Recorder
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class BackupHostTests: XCTestCase {
    private var scratch: URL!
    private var root: URL { scratch.appendingPathComponent("Backup", isDirectory: true) }
    private var carried: URL { scratch.appendingPathComponent("carried", isDirectory: true) }
    private var ledger: ImportLedger { .in(carried, files: DeviceFiles(.plain)) }
    private var appScratch: URL { scratch.appendingPathComponent("scratch/mac/app", isDirectory: true) }

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("backup-host-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        try? FileManager.default.removeItem(at: scratch)
    }

    private final class Asked: @unchecked Sendable {
        let lock = NSLock()
        var saved: [String] = []
        var sheets: [Bool] = []
        var typing: [String] = []
    }

    private func password(_ asked: Asked, saved: String?, typed: [String]) -> BackupPassword {
        asked.typing = typed
        return BackupPassword(saved: { udid in
            asked.lock.withLock { asked.saved.append(udid) }
            return saved
        }, ask: { wrong in
            asked.sheets.append(wrong)
            return asked.typing.isEmpty ? nil : asked.typing.removeFirst()
        })
    }

    nonisolated private static func forever() async throws {
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        for await _ in stream {}
        continuation.finish()
        try Task.checkCancellation()
    }

    private func imports(files: DeviceFiles = DeviceFiles(.plain), free: Int64? = 1 << 40, most: Int64? = nil, told: ((([MacImport]) -> Void))? = nil,
                         held: @escaping @Sendable ([String]) async throws -> Set<String> = { _ in [] },
                         pause: @escaping @Sendable () async throws -> Void = { try await BackupHostTests.forever() }) -> Imports {
        let homeFree = HomeFree()
        homeFree.set(free: nil, most: most)
        return Imports(world: Imports.World(
            carried: carried, files: files, clock: { Date(timeIntervalSince1970: 1_790_000_000) }, ship: {}, report: { nil }, notify: { _, _ in },
            homeFree: homeFree, tell: told ?? { _ in }, looked: { _ in nil }, mark: {},
            backups: Imports.BackupWorld(root: root, scratch: appScratch, held: held, disk: Volume(scratch, every: 0, read: { _ in free }), pause: pause)))
    }

    private func phone(password: String? = SyntheticBackup.password) throws -> SyntheticBackup.Made {
        try SyntheticBackup.write(in: root, password: password, files: try SyntheticBackup.phone(calls: password != nil))
    }

    func testAReadPullsOutHandsOverInOneWriteAndKeepsNoPassword() async throws {
        let made = try phone()
        var told: [[MacImport]] = []
        let model = imports(told: { told.append($0) })
        await model.listBackups().value
        let row = try XCTUnwrap(model.backups?.rows.first)
        XCTAssertEqual(model.backups?.state, .listed)
        XCTAssertEqual([row.name, row.read.rawValue], ["Test iPhone", "unread"])
        XCTAssertTrue(row.encrypted && row.finished)
        XCTAssertFalse(row.id.isEmpty)

        let asked = Asked()
        try await model.readBackup(row.id, password: password(asked, saved: nil, typed: [SyntheticBackup.password]))
        await model.backupRead(row.id)

        XCTAssertEqual(asked.saved, [made.udid], "Finder's item asked once, by the backup's UDID")
        XCTAssertEqual(asked.sheets, [false], "denied or none: the sheet opens")
        let records = try ledger.read()
        XCTAssertEqual(records.files.map(\.name), ["imessage", "whatsapp", "apple-calls"])
        XCTAssertEqual(Set(records.files.map(\.kind)), [Imports.backupKind])
        XCTAssertEqual(Set(records.files.compactMap(\.backup)), [row.id])
        XCTAssertNotNil(records.backups?[row.id])
        for record in records.files {
            XCTAssertTrue(FileManager.default.fileExists(atPath: record.path + "/backup.json"))
            for blob in record.blobs ?? [] { XCTAssertTrue(FileManager.default.fileExists(atPath: blob.path)) }
            XCTAssertEqual(record.bundle, record.bytes + (record.blobs ?? []).reduce(0) { $0 + $1.bytes })
        }
        XCTAssertFalse((records.files.first { $0.name == "whatsapp" }?.blobs ?? []).isEmpty, "WhatsApp's media ride as blobs")
        let after = try XCTUnwrap(model.backups?.rows.first)
        XCTAssertEqual(after.read, .sending, "handed over, owed to the home: not Brought in yet")
        XCTAssertNotNil(after.inMs)
        XCTAssertEqual(after.left, [])
        XCTAssertEqual(told.last?.first?.kind, Imports.backupKind)
        XCTAssertEqual(told.last?.first?.files.map(\.name), ["iMessage", "WhatsApp", "Calls"], "the home is told each store by its words, never its folder")

        let password = Data(SyntheticBackup.password.utf8)
        let walk = FileManager.default.enumerator(at: carried, includingPropertiesForKeys: [.isRegularFileKey])
        var read = 0
        while let url = walk?.nextObject() as? URL {
            XCTAssertFalse(url.path.contains(SyntheticBackup.password))
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            XCTAssertNil(try Data(contentsOf: url).range(of: password), "the password is in \(url.lastPathComponent)")
            read += 1
        }
        XCTAssertGreaterThan(read, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: carried.appendingPathComponent("backups/open-\(row.id)").path),
                       "the open's scratch goes with the read")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: appScratch.path), [], "the open and the pull-out leave nothing in scratch")

        let again = await refusal { try await model.readBackup(row.id, password: self.password(asked, saved: nil, typed: [])) }
        XCTAssertEqual(again, "That backup is on its way to Lifestream.")
    }

    func testAKeyedMacNamesNeitherThePhoneNorAMediumUnderCarried() async throws {
        let made = try phone()
        let files = DeviceFiles(.keyed(SymmetricKey(data: Data(repeating: 0x5a, count: 32))))
        let model = imports(files: files)
        await model.listBackups().value
        let id = try XCTUnwrap(model.backups?.rows.first?.id)
        try await model.readBackup(id, password: password(Asked(), saved: SyntheticBackup.password, typed: []))
        await model.backupRead(id)

        let records = try ImportLedger.in(carried, files: files).read()
        XCTAssertEqual(records.files.map(\.name), ["imessage", "whatsapp", "apple-calls"])
        let hashes = records.files.flatMap { ($0.blobs ?? []).map(\.sha256) }
        XCTAssertFalse(hashes.isEmpty)
        for record in records.files {
            XCTAssertTrue(FileManager.default.fileExists(atPath: record.path + "/backup.json"))
            for blob in record.blobs ?? [] { XCTAssertTrue(FileManager.default.fileExists(atPath: blob.path)) }
        }
        let walk = FileManager.default.enumerator(at: carried, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        XCTAssertGreaterThan(walk.count, 3)
        for url in walk {
            let path = String(url.standardizedFileURL.path.dropFirst(carried.standardizedFileURL.path.count))
            for secret in [made.udid] + hashes { XCTAssertFalse(path.contains(secret), "\(path) names \(secret)") }
        }
    }

    func testAWrongSavedPasswordThenAWrongTypedOneAskAgainAndCancelReadsNothing() async throws {
        _ = try phone()
        let model = imports()
        await model.listBackups().value
        let id = try XCTUnwrap(model.backups?.rows.first?.id)
        let asked = Asked()
        try await model.readBackup(id, password: password(asked, saved: "not this one", typed: ["nor this one"]))
        await model.backupRead(id)
        XCTAssertEqual(asked.sheets, [false, true], "the saved one did not open it: the sheet; a wrong one typed: again, saying so")
        XCTAssertEqual(model.backups?.rows.first?.read, .unread, "Cancel reads nothing")
        XCTAssertEqual(try ledger.read().files, [])
        XCTAssertEqual((try? FileManager.default.contentsOfDirectory(atPath: carried.appendingPathComponent("backups").path)) ?? [], [],
                       "nothing of the open is left")
    }

    func testAnUnencryptedBackupAsksNoPassword() async throws {
        _ = try phone(password: nil)
        let model = imports()
        await model.listBackups().value
        let id = try XCTUnwrap(model.backups?.rows.first?.id)
        let asked = Asked()
        try await model.readBackup(id, password: password(asked, saved: nil, typed: []))
        await model.backupRead(id)
        XCTAssertEqual(asked.saved, [])
        XCTAssertEqual(asked.sheets, [])
        XCTAssertEqual(try ledger.read().files.map(\.name), ["imessage", "whatsapp"], "no call history in an unencrypted backup")
    }

    func testAReadWaitsForRoomAndAQuitLeavesNothingNorAsksAgain() async throws {
        _ = try phone()
        let model = imports(free: nil)
        await model.listBackups().value
        let id = try XCTUnwrap(model.backups?.rows.first?.id)
        let asked = Asked()
        try await model.readBackup(id, password: password(asked, saved: SyntheticBackup.password, typed: []))
        try await until("the read waits for room") { model.backups?.rows.first?.why == "room" }
        XCTAssertEqual(model.backups?.rows.first?.read, .reading)
        let needs = try XCTUnwrap(model.backups?.rows.first?.needBytes, "the free space it waits for is said")
        XCTAssertGreaterThan(needs, Room.keepBytes)
        XCTAssertEqual(asked.saved.count, 1)

        await model.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: carried.appendingPathComponent("backups/\(id)").path), "nothing of the read is left")
        XCTAssertEqual(try ledger.read().files, [])

        let left = carried.appendingPathComponent("backups/\(id)/whatsapp", isDirectory: true)
        try FileManager.default.createDirectory(at: left, withIntermediateDirectories: true)
        try Data("pulled".utf8).write(to: left.appendingPathComponent("chats.sqlite"))
        let relaunched = imports()
        relaunched.prune()
        await relaunched.listBackups().value
        XCTAssertFalse(FileManager.default.fileExists(atPath: left.path))
        XCTAssertEqual(relaunched.backups?.rows.first?.read, .unread)
        XCTAssertEqual(asked.saved.count, 1, "no keychain read after the quit")
        XCTAssertEqual(asked.sheets, [], "no sheet after the quit")
    }

    func testTheListSaysNoneAndNoAccess() async throws {
        let model = imports()
        await model.listBackups().value
        XCTAssertEqual(model.backups, BackupList(state: .none, rows: []))
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: root.path)
        let hidden = imports()
        await hidden.listBackups().value
        XCTAssertEqual(hidden.backups?.state, .noAccess, "a folder that cannot be listed is Full Disk Access withheld, never none")
    }

    func testTheActsAndTheStateKeepTheWindowsShape() throws {
        func act(_ body: [String: Any]) -> Result<HostAct, HostRefusal> { HostAct.read(["type": "act"].merging(body) { $1 }) }
        XCTAssertEqual(act(["act": "import", "do": "backup-read", "id": "backup-a", "label": "Read it"]), .success(.import(.backupRead(id: "backup-a"))))
        XCTAssertEqual(act(["act": "import", "do": "backup-settings"]), .success(.import(.backupSettings)))
        for odd: [String: Any] in [["act": "import", "do": "backup-read"], ["act": "import", "do": "backup-read", "id": ""],
                                   ["act": "import", "do": "backup-read", "id": "a", "password": "x"],
                                   ["act": "import", "do": "backup-choose"], ["act": "import", "do": "backup-settings", "kind": "iphone-backup"]] {
            XCTAssertNil(try? act(odd).get(), "a backup act misshapen was heard: \(odd)")
        }

        var state = HostState(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        let row = BackupList.Row(id: "backup-a", name: "Test iPhone", madeMs: 1_787_908_364_000, encrypted: true,
                                 finished: true, read: .reading, inMs: nil, doing: "WhatsApp", done: 41, of: 96, why: nil)
        state.backups = BackupList(state: .listed, rows: [row])
        let encoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        let backups = try XCTUnwrap(encoded["backups"] as? [String: Any])
        XCTAssertEqual(backups["state"] as? String, "listed")
        let shown = try XCTUnwrap((backups["rows"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(shown.keys), ["id", "name", "made_ms", "encrypted", "finished", "read", "in_ms", "doing", "done", "of", "why",
                                         "need_bytes", "left"])
        XCTAssertTrue(shown["in_ms"] is NSNull && shown["why"] is NSNull && shown["need_bytes"] is NSNull, "every member stated, null included")
        XCTAssertEqual(shown["read"] as? String, "reading")
        XCTAssertEqual((shown["left"] as? [Any])?.count, 0)
        let partly = BackupList.Row(id: "backup-a", name: "Test iPhone", madeMs: 1, encrypted: true, finished: true, read: .in,
                                    inMs: 2, doing: nil, done: nil, of: nil, why: nil,
                                    left: [.init(store: "iMessage", why: .lost), .init(store: "WhatsApp", why: .tooLarge)])
        let partlyShown = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(partly)) as? [String: Any])
        XCTAssertEqual(partlyShown["left"] as? [[String: String]], [["store": "iMessage", "why": "lost"], ["store": "WhatsApp", "why": "too-large"]])
        let bare = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            HostState(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)))) as? [String: Any])
        XCTAssertNil(bare["backups"], "a host that reads no backups states none")
    }

    func testTheRowIsTheLedgersWordAndSaysEachStoreLeftOutAcrossARelaunch() async throws {
        _ = try phone()
        let model = imports()
        await model.listBackups().value
        let id = try XCTUnwrap(model.backups?.rows.first?.id)
        let asked = Asked()
        try await model.readBackup(id, password: password(asked, saved: SyntheticBackup.password, typed: []))
        await model.backupRead(id)
        XCTAssertEqual(model.backups?.rows.first?.read, .sending)

        try ledger.change { contents in
            for index in contents.files.indices {
                if contents.files[index].name == "whatsapp" {
                    try? FileManager.default.removeItem(atPath: contents.files[index].path)
                    contents.files[index].state = .missing
                } else {
                    contents.files[index].state = .sent
                }
            }
        }
        let relaunched = imports()
        relaunched.prune()
        await relaunched.listBackups().value
        let row = try XCTUnwrap(relaunched.backups?.rows.first)
        XCTAssertEqual(row.read, .in, "nothing owed and some store sent: Brought in")
        XCTAssertEqual(row.left, [.init(store: "WhatsApp", why: .lost)], "the lost store names itself after the relaunch, by its words")
        XCTAssertEqual(try ledger.read().files.map(\.name), ["imessage", "apple-calls"], "lost: no file row to choose again")

        try await relaunched.readBackup(id, password: password(asked, saved: SyntheticBackup.password, typed: []))
        await relaunched.backupRead(id)
        XCTAssertEqual(relaunched.backups?.rows.first?.read, .sending)
        XCTAssertEqual(try ledger.read().backups?[id]?.stores["whatsapp"], .owed)
    }

    func testAStoreOverTheDoorsMostIsLeftOutBeforeAnyMediumIsWritten() async throws {
        _ = try phone()
        let model = imports(most: 1)
        await model.listBackups().value
        let id = try XCTUnwrap(model.backups?.rows.first?.id)
        try await model.readBackup(id, password: password(Asked(), saved: SyntheticBackup.password, typed: []))
        await model.backupRead(id)
        XCTAssertEqual(try ledger.read().files, [], "nothing handed over: no store fits the door")
        XCTAssertEqual(try ledger.read().backups?[id]?.stores, ["imessage": .tooLarge, "whatsapp": .tooLarge, "apple-calls": .tooLarge])
        XCTAssertFalse(FileManager.default.fileExists(atPath: carried.appendingPathComponent("backups/\(id)").path),
                       "no medium written, and nothing of the read left")
        let row = try XCTUnwrap(model.backups?.rows.first)
        XCTAssertEqual(row.read, .stopped)
        XCTAssertEqual(row.left.map(\.why), [.tooLarge, .tooLarge, .tooLarge])
    }

    func testAReadWaitsForTheHomeAndAsksAgain() async throws {
        _ = try phone()
        let asks = Tries(failing: 1)
        let gate = Gate()
        let model = imports(held: { _ in try asks.ask() }, pause: { await gate.wait() })
        await model.listBackups().value
        let id = try XCTUnwrap(model.backups?.rows.first?.id)
        try await model.readBackup(id, password: password(Asked(), saved: SyntheticBackup.password, typed: []))
        try await until("the read waits for the home") { model.backups?.rows.first?.why == "home" }
        XCTAssertEqual(model.backups?.rows.first?.read, .reading)
        await gate.open()
        await model.backupRead(id)
        XCTAssertEqual(asks.count, 2, "asked again once the wait ended")
        XCTAssertEqual(model.backups?.rows.first?.read, .sending)
        XCTAssertEqual(try ledger.read().files.map(\.name), ["imessage", "whatsapp", "apple-calls"])
    }

    private final class Tries: @unchecked Sendable {
        private let lock = NSLock()
        private var failing: Int
        private(set) var count = 0
        init(failing: Int) { self.failing = failing }
        func ask() throws -> Set<String> {
            try lock.withLock {
                count += 1
                if failing > 0 {
                    failing -= 1
                    throw URLError(.timedOut)
                }
                return []
            }
        }
    }

    private actor Gate {
        private var opened = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func wait() async {
            guard !opened else { return }
            await withCheckedContinuation { waiters.append($0) }
        }
        func open() {
            opened = true
            waiters.forEach { $0.resume() }
            waiters = []
        }
    }

    private func refusal(_ work: () async throws -> Void) async -> String? {
        do {
            try await work()
            return nil
        } catch {
            return (error as? HostRefusal)?.words ?? "not words: \(error)"
        }
    }
}

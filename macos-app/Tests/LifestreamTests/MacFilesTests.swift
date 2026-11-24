import DeviceFiles
import Foundation
import MachineEvents
import Passwords
import Security
import XCTest
@testable import Lifestream

final class MacFilesTests: XCTestCase {
    final class WatcherCalls: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [String] = []
        var made: [String] { lock.withLock { calls } }
        func add(_ call: String) { lock.withLock { calls.append(call) } }
    }

    private let modesBytes = Data(#"{"activity":[],"exclude":["com.example.private-notes"]}"#.utf8)
    private var root: URL!
    private var machine: URL!
    private var spool: URL!
    private var store: MemoryStore!
    private var watcher: WatcherCalls!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-files-\(UUID().uuidString)", isDirectory: true)
        machine = root.appendingPathComponent("machine", isDirectory: true)
        spool = root.appendingPathComponent("spool", isDirectory: true)
        try FileManager.default.createDirectory(at: machine, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: spool, withIntermediateDirectories: true)
        store = MemoryStore()
        watcher = WatcherCalls()
        suite = "mac-files-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        defaults.removePersistentDomain(forName: suite)
    }

    private func macFiles(_ reader: KeyReader, cut: MacFiles.Step? = nil) -> MacFiles {
        let watcher = watcher!
        var files = MacFiles(machine: machine, spool: spool, ship: machine.appendingPathComponent("ship", isDirectory: true),
                             key: HomeKey(store: store, trust: KeychainTrust(build: "build-7", defaults: defaults!), reader: reader),
                             plain: DeviceFiles(.plain),
                             watcher: MacFiles.Watcher(stop: { watcher.add("stop") }, start: { watcher.add("start") }))
        if let cut {
            files.step = { step in
                if step == cut { throw CocoaError(.userCancelled) }
            }
        }
        return files
    }

    private func put(_ path: String, in folder: URL, _ text: String = "x") throws {
        let url = folder.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    private func exists(_ path: String, in folder: URL) -> Bool {
        FileManager.default.fileExists(atPath: folder.appendingPathComponent(path).path)
    }

    private func onDisk(_ path: String, in folder: URL) -> Data? {
        try? Data(contentsOf: folder.appendingPathComponent(path))
    }

    private func isPlain(_ files: DeviceFiles) -> Bool {
        files.name("a name") == "a name"
    }

    private func keyed(_ opened: MacFiles.Opened, _ message: String) throws -> DeviceFiles {
        guard case .files(let files) = opened else {
            XCTFail("\(message): \(opened)")
            throw CocoaError(.featureUnsupported)
        }
        XCTAssertFalse(isPlain(files), message)
        return files
    }

    func testARecordingMacIsRefusedBeforeAnyKeyIsMadeOrTheWatcherStopped() throws {
        for (path, folder) in [("2026-11-18/observation.lsm", spool!), ("ship/ledger/messages/a/state.json", machine!),
                               ("ship/pending/bundle.zip", machine!)] {
            try put(path, in: folder)
            let files = DeviceFiles(.plain)
            XCTAssertThrowsError(try macFiles(.app).becomeKeyed(files), path) { error in
                XCTAssertEqual(error as? MacFiles.Refusal, .recording, path)
                XCTAssertTrue("\(error)".contains("Uninstall deletes what this Mac recorded and has not sent."), path)
            }
            XCTAssertTrue(isPlain(files), path)
            XCTAssertNil(store.data, "\(path): a key was made for a Mac that records for another home")
            XCTAssertEqual(watcher.made, [], path)
            XCTAssertFalse(exists(MacFiles.fileName, in: machine), path)
            try FileManager.default.removeItem(at: folder.appendingPathComponent(path).deletingLastPathComponent())
        }
    }

    func testBecomingKeyedEmptiesBothFoldersButThePlainListAndSaysTheFormAndTheKeysID() throws {
        let kept = [(".writer.lock", spool!), ("runtime.json", spool!), ("resources/watch-2026-11-18.jsonl", spool!)]
        let gone = [("resources/app-2026-11-18.jsonl", spool!), ("machine/current.jsonl", spool!), ("resources/power-cursor.json", spool!), ("ship/reach.json", machine!),
                    ("ship/photos/\(String(repeating: "a1", count: 32))/entries.sqlite", machine!), ("ship/settings.json", machine!), ("ship/schedule.json", machine!), ("ship/answer.json", machine!)]
        for (path, folder) in kept + gone { try put(path, in: folder) }
        try put("home-id", in: machine)
        let files = DeviceFiles(.plain)
        try macFiles(.app).becomeKeyed(files)

        for (path, folder) in kept { XCTAssertTrue(exists(path, in: folder), "\(path) of the plain list was deleted") }
        for (path, folder) in gone { XCTAssertFalse(exists(path, in: folder), "\(path) was written plain and stayed") }
        XCTAssertTrue(exists("machine", in: spool), "the switch deleted a folder a log held open writes in")
        XCTAssertTrue(exists("home-id", in: machine), "the machine directory outside ship/ was emptied")
        let id = try XCTUnwrap(store.data.map(VaultKeyID.of))
        XCTAssertEqual(store.prompted, [true, true], "the new key was not read back twice")
        XCTAssertEqual(onDisk(MacFiles.fileName, in: machine), Data(#"{"form":"keyed","key":"\#(id)"}"#.utf8))
        XCTAssertEqual(watcher.made, ["stop", "start"])
        XCTAssertFalse(isPlain(files), "the process's instance stayed plain")

        let written = spool.appendingPathComponent("runtime-check.json")
        try files.replace(written, with: Data("{}".utf8), commit: .durable)
        XCTAssertNotEqual(onDisk("runtime-check.json", in: spool), Data("{}".utf8), "a write after the switch was plain")
        XCTAssertThrowsError(try macFiles(.app).becomeKeyed(files), "a second switch")
    }

    func testALogHeldOpenAcrossTheSwitchWritesItsNextLineKeyedInItsFolder() throws {
        let files = DeviceFiles(.plain)
        let log = MachineEventSources(directory: spool, files: files)
        log.record(shipperRun: ["run": "run-00000001"])
        try macFiles(.app).becomeKeyed(files)
        log.record(shipperRun: ["run": "run-00000002"])
        log.rotate()
        let walk = FileManager.default.enumerator(at: spool, includingPropertiesForKeys: nil)
        var read: [Data] = []
        while let file = walk?.nextObject() as? URL {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            XCTAssertNil(try Data(contentsOf: file).range(of: Data("run-00000002".utf8)), "\(file.lastPathComponent) holds the line plain")
            if let opened = try? files.read(file, maximumBytes: 1 << 20) { read.append(opened) }
        }
        XCTAssertTrue(read.contains { $0.range(of: Data("run-00000002".utf8)) != nil }, "the held log lost its line after the switch")
    }

    func testTheModesAreCarriedThroughTheHandedKeyedInstanceAndTheCarry() throws {
        try put("app-modes.json", in: spool, String(decoding: modesBytes, as: UTF8.self))
        let files = DeviceFiles(.plain)
        try macFiles(.app).becomeKeyed(files)
        XCTAssertFalse(exists("app-modes.json.carry", in: spool))
        XCTAssertNotEqual(onDisk("app-modes.json", in: spool), modesBytes, "the modes stayed plain")
        XCTAssertEqual(try files.read(spool.appendingPathComponent("app-modes.json"), maximumBytes: 1 << 20), modesBytes)
        let reopened = try keyed(macFiles(.app).open(), "a keyed Mac did not open keyed")
        XCTAssertEqual(try reopened.read(spool.appendingPathComponent("app-modes.json"), maximumBytes: 1 << 20), modesBytes)

        let none = root.appendingPathComponent("none", isDirectory: true)
        try FileManager.default.createDirectory(at: none, withIntermediateDirectories: true)
        spool = none
        store = MemoryStore()
        try put("app-modes.json.carry", in: none, "a stray carry")
        try macFiles(.app).becomeKeyed(DeviceFiles(.plain))
        XCTAssertFalse(exists("app-modes.json", in: none), "a stray carry became the modes of a Mac that chose none")
        XCTAssertFalse(exists("app-modes.json.carry", in: none))
    }

    func testACutAtEachStepOfTheSwitchLeavesAMacThatOpensAndPairsAgain() throws {
        for cut in [MacFiles.Step.carry, .empty, .form] {
            tearDown()
            try setUpWithError()
            try put("app-modes.json", in: spool, String(decoding: modesBytes, as: UTF8.self))
            try put("ship/reach.json", in: machine)
            let files = DeviceFiles(.plain)
            XCTAssertThrowsError(try macFiles(.app, cut: cut).becomeKeyed(files), "\(cut)")
            XCTAssertTrue(isPlain(files), "\(cut): a cut switch left the instance keyed")
            XCTAssertEqual(watcher.made, ["stop", "start"], "\(cut): the watcher was left stopped")
            let item = try XCTUnwrap(store.data, "\(cut): the key made before the switch was lost")
            XCTAssertFalse(exists(MacFiles.fileName, in: machine), "\(cut)")
            XCTAssertEqual(onDisk("app-modes.json", in: spool), modesBytes, "\(cut): the plain modes were lost")
            guard case .files(let opened) = macFiles(.app).open(), isPlain(opened) else { return XCTFail("\(cut): a cut Mac did not open plain") }

            let again = DeviceFiles(.plain)
            try macFiles(.app).becomeKeyed(again)
            XCTAssertEqual(store.data, item, "\(cut): the unnamed item was not reused")
            XCTAssertEqual(onDisk(MacFiles.fileName, in: machine), Data(#"{"form":"keyed","key":"\#(VaultKeyID.of(item))"}"#.utf8))
            XCTAssertEqual(try again.read(spool.appendingPathComponent("app-modes.json"), maximumBytes: 1 << 20), modesBytes, "\(cut)")
            XCTAssertFalse(exists("ship/reach.json", in: machine), "\(cut)")
        }
    }

    func testAStartAfterACutBetweenTheFormAndTheRenameFinishesTheCarryBeforeTheModesAreRead() throws {
        try put("app-modes.json", in: spool, String(decoding: modesBytes, as: UTF8.self))
        let live = DeviceFiles(.plain)
        try macFiles(.app, cut: .rename).becomeKeyed(live)
        XCTAssertFalse(isPlain(live), "a rename that failed after the form was written left the live instance plain")
        XCTAssertEqual(watcher.made, ["stop", "start"])
        XCTAssertTrue(exists(MacFiles.fileName, in: machine))
        XCTAssertTrue(exists("app-modes.json.carry", in: spool))
        XCTAssertEqual(onDisk("app-modes.json", in: spool), modesBytes, "the plain modes went before the carry was in place")

        let files = try keyed(macFiles(.helper).open(), "a keyed Mac cut before the rename did not open keyed")
        XCTAssertFalse(exists("app-modes.json.carry", in: spool), "the start left the carry")
        XCTAssertEqual(try files.read(spool.appendingPathComponent("app-modes.json"), maximumBytes: 1 << 20), modesBytes,
                       "the modes the start read were not the carried ones")
    }

    func testAFailureAfterTheFormIsOnDiskLeavesTheLiveInstanceKeyedAndItsNextWriteKeyed() throws {
        let live = DeviceFiles(.plain)
        let log = MachineEventSources(directory: spool, files: live)
        try macFiles(.app, cut: .formed).becomeKeyed(live)
        XCTAssertTrue(exists(MacFiles.fileName, in: machine))
        XCTAssertFalse(isPlain(live), "a plain writer was left behind a keyed marker")
        log.record(shipperRun: ["run": "run-00000003"])
        log.rotate()
        let fresh = try keyed(macFiles(.helper).open(), "the Mac did not open keyed after the failure")
        let walk = FileManager.default.enumerator(at: spool, includingPropertiesForKeys: nil)
        var read = false
        while let file = walk?.nextObject() as? URL {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            XCTAssertNil(try Data(contentsOf: file).range(of: Data("run-00000003".utf8)), "\(file.lastPathComponent) holds the line plain")
            if let opened = try? fresh.read(file, maximumBytes: 1 << 20), opened.range(of: Data("run-00000003".utf8)) != nil { read = true }
        }
        XCTAssertTrue(read, "the line written after the failure does not open with the key the marker names")
    }

    func testAnObservationPublishedWhileTheKeychainAskedIsKeptAndThePairingRefused() throws {
        let spool = spool!
        let observation = spool.appendingPathComponent("2026-11-18/observation.lsm")
        let files = DeviceFiles(.plain)
        let switching = MacFiles(machine: machine, spool: spool, ship: machine.appendingPathComponent("ship", isDirectory: true),
                                 key: HomeKey(store: store, trust: KeychainTrust(build: "build-7", defaults: defaults!), reader: .app),
                                 plain: DeviceFiles(.plain),
                                 watcher: MacFiles.Watcher(stop: {
                                     try FileManager.default.createDirectory(at: observation.deletingLastPathComponent(), withIntermediateDirectories: true)
                                     try Data("a frame".utf8).write(to: observation)
                                 }, start: {}))
        XCTAssertThrowsError(try switching.becomeKeyed(files)) { error in
            XCTAssertEqual(error as? MacFiles.Refusal, .recording)
        }
        XCTAssertEqual(try Data(contentsOf: observation), Data("a frame".utf8), "the switch deleted an observation published meanwhile")
        XCTAssertTrue(isPlain(files))
        XCTAssertFalse(exists(MacFiles.fileName, in: machine))
    }

    func testAFolderThatCannotBeListedStopsTheSwitchBeforeTheForm() throws {
        let locked = spool.appendingPathComponent("resources/powerlog", isDirectory: true)
        try put("resources/powerlog/rows.jsonl", in: spool, #"{"bundle":"com.example.app"}"#)
        XCTAssertEqual(chmod(locked.path, 0), 0)
        defer { chmod(locked.path, 0o700) }
        let files = DeviceFiles(.plain)
        XCTAssertThrowsError(try macFiles(.app).becomeKeyed(files), "a folder that could not be listed was read as empty") { error in
            XCTAssertEqual(error as? MacFiles.Refusal, .unlisted("powerlog"), "the person was handed a raw error")
        }
        XCTAssertTrue(isPlain(files))
        XCTAssertFalse(exists(MacFiles.fileName, in: machine), "the form was published over a folder that was never swept")
        XCTAssertEqual(watcher.made, ["stop", "start"])
        chmod(locked.path, 0o700)
        XCTAssertTrue(exists("resources/powerlog/rows.jsonl", in: spool))
    }

    func testAKeyedMacWithItsKeyRefusedWritesNothingAndOnlyTheAppsOpenStartsAgain() throws {
        try macFiles(.app).becomeKeyed(DeviceFiles(.plain))
        try put("ship/credentials.json", in: machine)
        try put("runtime.json", in: spool)
        let made = try XCTUnwrap(store.data)

        store.refusal = .keychain(errSecAuthFailed)
        for reader in [KeyReader.helper, .app] {
            guard case .refused = macFiles(reader).open() else { return XCTFail("\(reader): a refused key opened or was said gone") }
        }
        store.refusal = nil
        XCTAssertNotNil(try macFiles(.app).key.read(), "Allow did not read the key again")

        store.data = nil
        guard case .refused = macFiles(.helper).open() else { return XCTFail("a helper decided the key is gone") }
        XCTAssertTrue(exists("ship/credentials.json", in: machine), "a helper deleted files")
        guard case .startedAgain(let restarted) = macFiles(.app).open() else { return XCTFail("the app did not start again on a gone key") }
        XCTAssertFalse(isPlain(restarted))
        XCTAssertNotEqual(store.data.map(VaultKeyID.of), VaultKeyID.of(made))

        try put("ship/credentials.json", in: machine)
        try put("resources/app-2026-11-18.jsonl", in: spool)
        store.data = Data(repeating: 9, count: 32)
        guard case .refused = macFiles(.helper).open() else { return XCTFail("a helper decided an item of another id is gone") }
        XCTAssertTrue(exists("ship/credentials.json", in: machine), "a helper deleted files")
        guard case .startedAgain(let again) = macFiles(.app).open() else { return XCTFail("an item of another id did not start the Mac again") }
        XCTAssertFalse(isPlain(again))
        let id = try XCTUnwrap(store.data.map(VaultKeyID.of))
        XCTAssertNotEqual(id, VaultKeyID.of(made))
        XCTAssertNotEqual(id, VaultKeyID.of(Data(repeating: 9, count: 32)), "the item of another id was kept")
        XCTAssertEqual(onDisk(MacFiles.fileName, in: machine), Data(#"{"form":"keyed","key":"\#(id)"}"#.utf8))
        XCTAssertFalse(exists("ship/credentials.json", in: machine), "a file the lost key encrypted stayed")
        XCTAssertFalse(exists("resources/app-2026-11-18.jsonl", in: spool), "the app's lines the lost key encrypted stayed")
        XCTAssertTrue(exists("runtime.json", in: spool), "a plain file holding no record was deleted")
        _ = try keyed(macFiles(.helper).open(), "the Mac started again did not open keyed")
    }

    func testAPlainMacOpensPlainAndReadsNoKey() {
        guard case .files(let files) = macFiles(.app).open(), isPlain(files) else { return XCTFail("a plain Mac did not open plain") }
        XCTAssertEqual(store.prompted, [], "a plain Mac read the Keychain")
    }
}

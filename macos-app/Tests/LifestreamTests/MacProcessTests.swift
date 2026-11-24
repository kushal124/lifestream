import CryptoKit
import DeviceFiles
import Foundation
import MachineEvents
import Passwords
import Security
import Shipping
import XCTest
@testable import Lifestream

final class MacProcessTests: XCTestCase {
    private var root: URL!
    private var machine: URL!
    private var spool: URL!
    private var store: MemoryStore!
    private var suite: String!
    private var defaults: UserDefaults!
    private var watcher: MacFilesTests.WatcherCalls!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-process-\(UUID().uuidString)", isDirectory: true)
        machine = root.appendingPathComponent("machine", isDirectory: true)
        spool = root.appendingPathComponent("spool", isDirectory: true)
        try FileManager.default.createDirectory(at: machine, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: spool, withIntermediateDirectories: true)
        store = MemoryStore()
        suite = "mac-process-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        watcher = MacFilesTests.WatcherCalls()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        defaults.removePersistentDomain(forName: suite)
    }

    private func process(_ name: SealWork.Process) -> MacProcess {
        let watcher = watcher!
        return MacProcess.opened(name, spool: spool, machine: machine, ship: machine.appendingPathComponent("ship", isDirectory: true),
                                 keys: HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, files: store),
                                 watcher: MacFiles.Watcher(stop: { watcher.add("stop") }, start: { watcher.add("start") }))
    }

    private func put(_ path: String) throws {
        let url = machine.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: url)
    }

    private func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: machine.appendingPathComponent(path).path)
    }

    private func keyedForm() throws {
        let key = Data(repeating: 7, count: 32)
        store.data = key
        try Data(#"{"form":"keyed","key":"\#(VaultKeyID.of(key))"}"#.utf8).write(to: machine.appendingPathComponent(MacFiles.fileName))
    }

    func testEachProcessEmptiesItsOwnScratchAtItsStartAndKeepsItsRecordersAudioForItsRecovery() throws {
        for path in ["scratch/mac/app/stale.sqlite", "scratch/mac/app/photos/export.heic", "scratch/mac/app/audio/torn.m4a",
                     "scratch/mac/cli/history-copy", "scratch/mac/cli/audio/open.m4a", "scratch/mac/watch/.work/powerlog"] {
            try put(path)
        }
        let app = process(.app)
        XCTAssertEqual(app.scratch, machine.appendingPathComponent("scratch/mac/app", isDirectory: true))
        XCTAssertFalse(exists("scratch/mac/app/stale.sqlite"))
        XCTAssertFalse(exists("scratch/mac/app/photos"), "the photo pass's exports outlived the start")
        XCTAssertTrue(exists("scratch/mac/app/audio/torn.m4a"), "a torn recording was swept before the recorder recovered it")
        XCTAssertTrue(exists("scratch/mac/cli/history-copy"), "the app emptied another process's scratch")
        _ = process(.cli)
        XCTAssertFalse(exists("scratch/mac/cli/history-copy"))
        XCTAssertTrue(exists("scratch/mac/cli/audio/open.m4a"), "a command's start swept a foreground recorder's audio")
        _ = process(.cli)
        XCTAssertTrue(exists("scratch/mac/cli/audio/open.m4a"), "a second command's start swept it")
        XCTAssertTrue(exists("scratch/mac/watch/.work/powerlog"))
        _ = process(.watch)
        XCTAssertFalse(exists("scratch/mac/watch/.work"))
        let mode = try FileManager.default.attributesOfItem(atPath: app.scratch.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o700)
        XCTAssertEqual(try app.scratch.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testAPlainMacOpensOnePlainInstanceThatWrites() throws {
        let opened = process(.app)
        XCTAssertEqual(opened.opened, .open)
        XCTAssertNil(opened.refusal())
        XCTAssertEqual(try XCTUnwrap(opened.files).name("a name"), "a name")
        XCTAssertFalse(exists(MacFiles.fileName), "opening a plain Mac said a form")
        XCTAssertTrue(store.prompted.isEmpty, "a plain Mac read the Keychain")
    }

    func testARefusedProcessHoldsNoInstanceAndSetUpCountsItPairedUntilAllowHandsItTheKeyedOne() throws {
        try keyedForm()
        for name in [SealWork.Process.app, .watch, .cli] {
            let opened = process(name)
            guard case .refused = opened.opened else { return XCTFail("\(name) opened a keyed Mac whose build is not trusted") }
            XCTAssertNil(opened.files, "\(name) held an instance that reads keyed files as plain")
            XCTAssertEqual(opened.refusal(), name == .app ? "Lifestream can't open what this Mac records. Click Allow."
                                                          : "Open Lifestream and click Allow.")
        }
        XCTAssertTrue(SetupWorld.paired(nil, folderHome: "home-a"), "a refused Mac that is keyed was shown set up")
        let app = process(.app)
        store.refusal = .keychain(errSecAuthFailed)
        XCTAssertEqual(app.allow(), .refused(MacProcess.deniedWords))
        XCTAssertNil(app.files)
        XCTAssertEqual(watcher.made, [])
        store.refusal = nil
        XCTAssertEqual(app.allow(), .open)
        XCTAssertNotEqual(try XCTUnwrap(app.files).name("a name"), "a name", "Allow handed a plain instance")
        XCTAssertEqual(watcher.made, ["start"], "the watcher was not started again after Allow")
    }

    func testAGoneItemStartsTheAppAgainAndOnlyRefusesAHelper() throws {
        try keyedForm()
        try put("ship/answer.json")
        _ = try HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, files: store).macFiles.read()
        store.data = nil
        let watch = process(.watch)
        guard case .refused = watch.opened else { return XCTFail("the watcher decided the item was gone") }
        XCTAssertTrue(exists("ship/answer.json"), "a helper deleted what the Mac recorded")
        let app = process(.app)
        XCTAssertEqual(app.opened, .startedAgain)
        XCTAssertFalse(exists("ship/answer.json"))
        XCTAssertNotEqual(try XCTUnwrap(app.files).name("a name"), "a name")
        XCTAssertNotNil(store.data, "no new key was made")
    }

    func testAnItemGoneOnABuildNotTrustedStartsTheAppAgainAtAllowAndARefusedHelperStaysRefused() throws {
        try keyedForm()
        try put("ship/answer.json")
        for item in [nil, Data(repeating: 9, count: 32)] {
            store.data = item
            defaults.removeObject(forKey: "vault.machineKeyReadBy.mac-files")
            let helper = process(.cli)
            guard case .refused = helper.opened else { return XCTFail("a helper on an untrusted build opened") }
            XCTAssertEqual(helper.allow(), .refused(MacFiles.goneWords))
            XCTAssertTrue(exists("ship/answer.json"), "a helper's Allow deleted what the Mac recorded")
        }
        store.data = nil
        defaults.removeObject(forKey: "vault.machineKeyReadBy.mac-files")
        let app = process(.app)
        guard case .refused = app.opened else { return XCTFail("an untrusted build read the Keychain at launch") }
        XCTAssertEqual(app.allow(), .startedAgain, "Allow on an item gone never took the gone road")
        XCTAssertFalse(exists("ship/answer.json"))
        let made = try XCTUnwrap(store.data, "no new key was made")
        XCTAssertNotEqual(try XCTUnwrap(app.files).name("a name"), "a name")
        XCTAssertEqual(try macFilesID(), VaultKeyID.of(made))
        XCTAssertEqual(process(.app).opened, .open, "the next launch did not open the new key")
    }

    func testAKeychainThatOnlyRanOutOfTimeKeepsTheTrustForTheNextLaunch() throws {
        try keyedForm()
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, files: store)
        _ = try keys.macFiles.read()
        store.hold = DispatchSemaphore(value: 0)
        defer { store.hold?.signal() }
        guard case .refused = keys.macFiles.found(within: 0.2) else { return XCTFail("a read that never answered opened") }
        XCTAssertTrue(keys.macFiles.trusted, "a read that only ran out of time cleared the trust")
    }

    func testOnlyTheAppsOwnRefusalClearsTheTrustAndAReadMacOSCouldNotAskKeepsIt() throws {
        try keyedForm()
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, files: store)
        _ = try keys.macFiles.read()
        store.refusal = .keychain(errSecInteractionNotAllowed)
        for name in [SealWork.Process.watch, .cli, .app] {
            guard case .refused = process(name).opened else { return XCTFail("\(name): a read macOS could not ask for opened") }
            XCTAssertTrue(keys.macFiles.trusted, "\(name): a read where macOS could not ask the person cleared the trust")
        }
        store.refusal = .keychain(errSecAuthFailed)
        for name in [SealWork.Process.watch, .cli] {
            let helper = process(name)
            guard case .refused = helper.opened else { return XCTFail("\(name): a refused helper opened") }
            XCTAssertEqual(helper.allow(), .refused(MacProcess.deniedWords))
            XCTAssertEqual(defaults.string(forKey: "vault.machineKeyReadBy.mac-files"), "build-7", "\(name): a helper's refusal changed the trust record")
        }
        guard case .refused = process(.app).opened else { return XCTFail("the app's refused read opened") }
        XCTAssertFalse(keys.macFiles.trusted, "the app's own refusal left this build trusted")
    }

    func testAllowHandsTheKeyedInstanceThatOpensTheKeyedSettingsAndLogs() throws {
        try keyedForm()
        let key = try XCTUnwrap(store.data)
        let ship = machine.appendingPathComponent("ship", isDirectory: true)
        try FileManager.default.createDirectory(at: ship, withIntermediateDirectories: true)
        let file = ship.appendingPathComponent(MacSettings.fileName)
        XCTAssertTrue(try MacSettings(file: file, files: DeviceFiles(.keyed(SymmetricKey(data: key)))).set("screen", "ocr", to: .string("always")))
        let app = process(.app)
        XCTAssertNil(app.files)
        XCTAssertEqual(app.allow(), .open)
        let files = try XCTUnwrap(app.files)
        XCTAssertEqual(MacSettings(file: file, files: files).value("screen", "ocr"), .string("always"), "settings answered launch's defaults")
        let log = MachineEventSources(directory: spool, files: files)
        log.record(shipperRun: ["run": "run-00000001"])
        log.rotate()
        let walk = FileManager.default.enumerator(at: spool, includingPropertiesForKeys: nil)
        var lines = 0
        while let url = walk?.nextObject() as? URL {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            XCTAssertNil(try Data(contentsOf: url).range(of: Data("run-00000001".utf8)), "the machine log wrote its line plain")
            if let opened = try? files.read(url, maximumBytes: 1 << 20), opened.range(of: Data("run-00000001".utf8)) != nil { lines += 1 }
        }
        XCTAssertGreaterThan(lines, 0, "the keyed line does not read back")
    }

    func testBecomingKeyedSwitchesTheProcesssOwnInstance() throws {
        let app = process(.app)
        let files = try XCTUnwrap(app.files)
        try app.becomeKeyed()
        XCTAssertNotEqual(files.name("a name"), "a name")
        XCTAssertTrue(exists(MacFiles.fileName))
        XCTAssertEqual(app.plain.name("a name"), "a name", "the fixed plain instance switched")
        XCTAssertEqual(watcher.made, ["stop", "start"])
    }

    func testAllowStartsAgainOnlyOnTwoCleanMissesAndKeepsTheFilesOnAMissThenTheKeyAKeyThatFlickersOrAMalformedItem() throws {
        try keyedForm()
        try put("ship/answer.json")
        let key = try XCTUnwrap(store.data)
        let scripted = ScriptedStore(holding: key)
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, files: scripted)
        let opened = { MacProcess.opened(.app, spool: self.spool, machine: self.machine,
                                         ship: self.machine.appendingPathComponent("ship", isDirectory: true), keys: keys,
                                         watcher: MacFiles.Watcher(stop: {}, start: {})) }
        let app = opened()
        guard case .refused = app.opened else { return XCTFail("an untrusted build read the Keychain at launch") }
        scripted.reads = [.success(nil), .success(key), .success(key)]
        XCTAssertEqual(app.allow(), .open, "one miss before the key was read as gone")
        XCTAssertTrue(exists("ship/answer.json"), "one miss deleted what the Mac recorded")
        XCTAssertNotEqual(try XCTUnwrap(app.files).name("a name"), "a name")

        defaults.removeObject(forKey: "vault.machineKeyReadBy.mac-files")
        let flickering = opened()
        scripted.reads = [.success(key), .success(nil), .success(key), .success(nil)]
        XCTAssertEqual(flickering.allow(), .open, "a read that found the key was counted as a miss")
        XCTAssertTrue(exists("ship/answer.json"), "a key that was read deleted what the Mac recorded")
        XCTAssertEqual(scripted.data, key, "a key that was read was replaced")

        defaults.removeObject(forKey: "vault.machineKeyReadBy.mac-files")
        let malformed = opened()
        scripted.reads = [.failure(.notAKey)]
        XCTAssertEqual(malformed.allow(), .refused(MacFiles.formWords), "a malformed item was answered with advice Allow cannot follow")
        XCTAssertNil(malformed.files)
        XCTAssertTrue(exists("ship/answer.json"), "a malformed item deleted what the Mac recorded")
        XCTAssertEqual(scripted.data, key, "a malformed answer made a new key")
    }

    func testAllowFinishesACarryTheLaunchCouldNotBeforeTheModesAreRead() throws {
        try keyedForm()
        let key = try XCTUnwrap(store.data)
        let chosen = Data(#"{"activity":[],"exclude":["com.example.private-notes"]}"#.utf8)
        let modes = spool.appendingPathComponent("app-modes.json")
        try DeviceFiles(.keyed(SymmetricKey(data: key))).replace(spool.appendingPathComponent("app-modes.json.carry"), with: chosen,
                                                                  commit: .durable)
        try FileManager.default.createDirectory(at: modes.appendingPathComponent("held"), withIntermediateDirectories: true)
        _ = try HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, files: store).macFiles.read()
        let app = process(.app)
        guard case .refused = app.opened else { return XCTFail("a launch whose carry could not be put in place opened") }
        try FileManager.default.removeItem(at: modes)
        XCTAssertEqual(app.allow(), .open)
        XCTAssertFalse(FileManager.default.fileExists(atPath: spool.appendingPathComponent("app-modes.json.carry").path),
                       "Allow handed out files before the carry was put in place")
        XCTAssertEqual(try XCTUnwrap(app.files).read(modes, maximumBytes: 1 << 20), chosen)
    }

    private func macFilesID() throws -> String? {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: machine.appendingPathComponent(MacFiles.fileName))) as? [String: Any]
        return object?["key"] as? String
    }
}

final class ScriptedStore: KeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var item: Data?
    private var script: [Result<Data?, KeyStoreError>] = []

    init(holding data: Data) {
        item = data
    }

    var data: Data? { lock.withLock { item } }
    var reads: [Result<Data?, KeyStoreError>] {
        get { lock.withLock { script } }
        set { lock.withLock { script = newValue } }
    }

    func read(prompting: Bool) throws -> Data? {
        let next: Result<Data?, KeyStoreError>? = lock.withLock { script.isEmpty ? nil : script.removeFirst() }
        guard let next else { return lock.withLock { item } }
        return try next.get()
    }

    func held() throws -> Bool { lock.withLock { item != nil } }
    func keyID() throws -> String? { lock.withLock { item.map(VaultKeyID.of) } }
    func mark(keyID: String) throws {}
    func add(_ data: Data) throws { lock.withLock { item = data } }
    func delete() throws { lock.withLock { item = nil } }
}

import AppKit
import Combine
import Foundation
import Passwords
import Recorder
import XCTest
@testable import Lifestream

@MainActor final class KeyedFirstRunTests: XCTestCase {
    private var scratch: URL!
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("keyed-first-run-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        suite = "KeyedFirstRunTests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: scratch)
    }

    private var folder: URL { scratch.appendingPathComponent("Lifestream") }

    private func looked(_ form: MachineLook.Form, id: String? = nil) -> MachineLook.Folder {
        MachineLook.Folder(path: folder.path, refused: nil, free_bytes: 1.2e12, door: "http://127.0.0.1:4680", form: form, id: id)
    }

    private func host(_ home: FirstRunTests.FakeHome, _ form: MachineLook.Form, id: String? = nil) -> (SetupHost, SetupStart) {
        let start = SetupStart(pair: { _, _ in
            home.paired()
            return .paired
        })
        let world = SetupWorld(placed: true, release: false, outdated: false, folder: nil,
                               agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, .notRegistered) }), paired: false)
        let setup = SetupHost(world: world, start: start, release: nil, steps: home.steps, name: "Desk Mac",
                              look: MachineLook(folder: looked(form, id: id)), defaults: defaults, quit: { XCTFail("Set up quit the app") })
        return (setup, start)
    }

    private func page(_ setup: SetupHost) -> (MacHost, NSPasteboard) {
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                           lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                           socket: { nil }, readGrants: { [:] }, readFolder: { nil }, unit: { nil }, ask: .untouched, setup: setup)
        let board = NSPasteboard(name: NSPasteboard.Name("keyed-first-run-\(UUID().uuidString)"))
        setup.key.board = board
        setup.key.later = { _, _ in }
        return (host, board)
    }

    private func setUp(_ home: FirstRunTests.FakeHome, _ form: MachineLook.Form, id: String? = nil) async throws -> SetupStart {
        let (setup, start) = host(home, form, id: id)
        await setup.setUp()
        try await until("the first run stops") { start.phase != .running }
        return start
    }

    private func refused(_ host: MacHost, _ act: HostAct) async -> String? {
        do {
            _ = try await host.reply(act)
            return nil
        } catch {
            return (error as? HostRefusal)?.words ?? "\(error)"
        }
    }

    private let today = ["install", "command", "agents", "login item", "answer?", "answer?", "answer?", "code", "name Desk Mac"]

    func testTheFolderDecidesTheRoadAndThePageIsOfferedNoChoice() throws {
        let kept = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"
        XCTAssertEqual(FolderHome.of(looked(.empty)), .new)
        XCTAssertEqual(FolderHome.of(looked(.plain)), .plain)
        XCTAssertEqual(FolderHome.of(looked(.keyed, id: kept)), .encrypted(id: kept))
        let home = FirstRunTests.FakeHome(SetupHost.standardFolder)
        for (form, word) in [(MachineLook.Form.empty, "new"), (.plain, "plain"), (.keyed, "encrypted")] {
            let machine = String(decoding: try JSONEncoder().encode(host(home, form, id: kept).0.machine), as: UTF8.self)
            XCTAssertTrue(machine.contains(#""home":"\#(word)""#), machine)
            XCTAssertFalse(machine.contains("encryption"), "the page was offered a choice: \(machine)")
        }
        XCTAssertEqual(HostAct.read(["type": "act", "act": "setup"]), .success(.setUp))
        for pick: Any in [true, false, "no"] {
            guard case .failure = HostAct.read(["type": "act", "act": "setup", "encrypt": pick]) else {
                return XCTFail("a pick of \(pick) was read")
            }
        }
        for act in ["show", "copy", "save", "saved", "back"] {
            XCTAssertEqual(HostAct.read(["type": "act", "act": "setup-key", "do": act]), .success(.setupKey(SetupKey.Act(rawValue: act)!)))
        }
        guard case .failure = HostAct.read(["type": "act", "act": "setup-key", "do": "print"]) else { return XCTFail("an unknown key act was read") }
    }

    func testANewFolderShowsItsKeyOnThePageAndIsMadeOnlyOnceTheKeyIsSaved() async throws {
        let home = FirstRunTests.FakeHome(SetupHost.standardFolder)
        let (setup, start) = host(home, .empty)
        let (host, board) = page(setup)
        defer { board.releaseGlobally() }
        let beforeSetUp = await refused(host, .setupKey(.show))

        XCTAssertEqual(beforeSetUp, SetupKey.noKey)

        _ = try await host.reply(.setUp)
        try await until("the page shows the key") { host.state.setup?.state == "key" }
        XCTAssertEqual(home.asked, ["keys draft"], "a Keychain item was made before the key was saved")
        XCTAssertNil(home.draft)
        XCTAssertEqual(host.state.setup?.key, SetupKey.Shown(number: 1, madeMs: 1_763_337_600_000, used: nil, said: nil))
        let state = String(decoding: try JSONEncoder().encode(host.state), as: UTF8.self)
        let plain = FirstRunTests.FakeHome.recovery.filter { !$0.isWhitespace }
        for form in [FirstRunTests.FakeHome.recovery, plain, String(plain.prefix(12)), String(plain.suffix(12))] {
            XCTAssertFalse(state.contains(form), "the page's state holds the recovery key")
        }
        let page = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(state.utf8)) as? [String: Any])
        let shownKey = try XCTUnwrap((page["setup"] as? [String: Any])?["key"] as? NSDictionary, state)
        XCTAssertEqual(shownKey, ["made_ms": 1_763_337_600_000, "number": 1, "said": NSNull(), "used": NSNull()] as NSDictionary, state)
        let shown = try await host.reply(.setupKey(.show))
        XCTAssertEqual(shown["key"] as? String, FirstRunTests.FakeHome.recovery)

        let early = await refused(host, .setupKey(.saved))


        XCTAssertEqual(early, RecoveryKey.toGoOn, "the key was taken as saved before Copy or Save as file")
        XCTAssertFalse(home.asked.contains { $0.hasPrefix("adopt") })
        _ = try await host.reply(.setupKey(.copy))
        XCTAssertEqual(board.string(forType: .string), FirstRunTests.FakeHome.recovery)
        XCTAssertEqual(host.state.setup?.key, SetupKey.Shown(number: 1, madeMs: 1_763_337_600_000, used: .copied, said: RecoveryKey.copied))
        _ = try await host.reply(.setupKey(.saved))
        try await until("the first run stops") { start.phase != .running }
        XCTAssertEqual(start.phase, .done)
        XCTAssertNil(host.state.setup?.key)
        let afterSaving = await refused(host, .setupKey(.show))

        XCTAssertEqual(afterSaving, SetupKey.noKey, "the key outlived its saving")
        XCTAssertEqual(home.asked, ["keys draft", "make key", "adopt --keyed <folder>"] + today)
        XCTAssertNil(defaults.string(forKey: SetupHost.keyFolder), "the key screen outlived its saving")
        let handed = try XCTUnwrap(home.handed.first)
        XCTAssertEqual(handed.last, 10, "the hand-off is one line")
        let line = try XCTUnwrap(JSONSerialization.jsonObject(with: handed) as? [String: String])
        XCTAssertEqual(Set(line.keys), ["home_id", "slot_key", "recovery"])
        XCTAssertEqual(line["slot_key"], FirstRunTests.FakeHome.slotKey.map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(line["recovery"], FirstRunTests.FakeHome.recovery)
        let id = try XCTUnwrap(line["home_id"])
        XCTAssertNotNil(UUID(uuidString: id))
        XCTAssertEqual(id, id.lowercased(), "the home's id and its Keychain account in two cases")
        XCTAssertNil(home.draft, "the drafted home outlived its adopt")
    }

    func testBackMakesNothingASaveInsideTheFolderIsRefusedAndTheNextPressStartsFromANewKey() async throws {
        let home = FirstRunTests.FakeHome(SetupHost.standardFolder)
        let (setup, start) = host(home, .empty)
        let (host, board) = page(setup)
        defer { board.releaseGlobally() }
        _ = try await host.reply(.setUp)
        try await until("the page shows the key") { host.state.setup?.state == "key" }
        _ = try await host.reply(.setupKey(.back))
        try await until("the first run stops") { start.phase != .running }
        XCTAssertEqual(start.phase, .idle)
        XCTAssertEqual(host.state.setup?.state, "idle")
        XCTAssertEqual(home.asked, ["keys draft"], "Back made a Keychain item or a home")
        XCTAssertEqual(home.handed, [])
        XCTAssertNil(defaults.string(forKey: SetupHost.keyFolder), "Back left the key screen to come back to")

        _ = try await host.reply(.setUp)
        try await until("the page shows a new key") { host.state.setup?.state == "key" }
        let inside = SetupHost.standardFolder.appendingPathComponent("key.txt")
        setup.key.choose = { _, _ in inside }
        _ = try await host.reply(.setupKey(.save))
        XCTAssertEqual(host.state.setup?.key?.used, nil, "a key saved inside the new home's folder counted as saved")
        XCTAssertEqual(host.state.setup?.key?.said, RecoveryKeyFile.inside)
        let name = RecoveryKeyFile.name(KeyName(number: 1, madeMs: 1_763_337_600_000))
        let outside = scratch.appendingPathComponent(name)
        var named: String?
        setup.key.choose = { offered, _ in
            named = offered
            return outside
        }
        _ = try await host.reply(.setupKey(.save))
        XCTAssertEqual(named, name)
        XCTAssertEqual(host.state.setup?.key?.used, .saved)
        XCTAssertEqual(host.state.setup?.key?.said, "Saved to \(name).")
        XCTAssertTrue(try String(contentsOf: outside, encoding: .utf8).contains(RecoveryKeyFile.grouped(FirstRunTests.FakeHome.recovery)))
        _ = try await host.reply(.setupKey(.saved))
        try await until("the first run stops") { start.phase != .running }
        XCTAssertEqual(start.phase, .done)
        XCTAssertEqual(home.asked, ["keys draft", "keys draft", "make key", "adopt --keyed <folder>"] + today)
    }

    func testAKeyTheKeychainWillNotKeepStartsNoHome() async throws {
        let home = FirstRunTests.FakeHome(SetupHost.standardFolder)
        home.keychainRefuses = true
        let (setup, start) = host(home, .empty)
        let (host, board) = page(setup)
        defer { board.releaseGlobally() }
        _ = try await host.reply(.setUp)
        try await until("the page shows the key") { host.state.setup?.state == "key" }
        _ = try await host.reply(.setupKey(.copy))
        _ = try await host.reply(.setupKey(.saved))
        try await until("the first run stops") { start.phase != .running }
        XCTAssertEqual(start.phase, .refused("Lifestream couldn't keep its key in your Mac's Keychain: the Keychain refused (-25293). Nothing was made, so the recovery key you saved opens nothing."))
        XCTAssertEqual(home.asked, ["keys draft", "make key"])
        XCTAssertEqual(home.handed, [])
    }

    func testQuittingOnTheKeyScreenOpensOnANewKeyForTheSameFolderAndNoKeychainItemOutlivesIt() async throws {
        let home = FirstRunTests.FakeHome(SetupHost.standardFolder)
        let (setup, _) = host(home, .empty)
        let (quitting, board) = page(setup)
        defer { board.releaseGlobally() }
        _ = try await quitting.reply(.setUp)
        try await until("the page shows the key") { quitting.state.setup?.state == "key" }
        XCTAssertEqual(defaults.string(forKey: SetupHost.keyFolder), SetupHost.standardFolder.path)

        let (reopened, start) = host(home, .empty)
        let (host, again) = page(reopened)
        defer { again.releaseGlobally() }
        try await until("the reopened app shows a key again, with no press") { host.state.setup?.state == "key" }
        XCTAssertEqual(host.state.machine?.folder, "~/Lifestream")
        XCTAssertEqual(home.asked, ["keys draft", "keys draft"], "a Keychain item was made before any key was saved")
        _ = try await host.reply(.setupKey(.copy))
        _ = try await host.reply(.setupKey(.saved))
        try await until("the first run stops") { start.phase != .running }
        XCTAssertEqual(start.phase, .done)
        XCTAssertNil(defaults.string(forKey: SetupHost.keyFolder))
        _ = try await quitting.reply(.setupKey(.back))
    }

    func testAReopenedAppForgetsAKeyScreenWhoseFolderNoLongerWaitsForANewLifestream() async throws {
        defaults.set(SetupHost.standardFolder.path, forKey: SetupHost.keyFolder)
        let home = FirstRunTests.FakeHome(SetupHost.standardFolder)
        let (setup, start) = host(home, .plain)
        try await until("the kept key screen is forgotten") { defaults.string(forKey: SetupHost.keyFolder) == nil }
        XCTAssertEqual(start.phase, .idle)
        XCTAssertNil(setup.key.shown)
        XCTAssertEqual(home.asked, [])
    }

    func testAFolderThatHoldsALifestreamIsAdoptedAsItIsWithNoNewKey() async throws {
        let kept = FirstRunTests.FakeHome(SetupHost.standardFolder)
        let keyed = try await setUp(kept, .keyed, id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b")
        XCTAssertEqual(keyed.phase, .done)
        XCTAssertEqual(kept.asked, ["trust 6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", "adopt <folder>"] + today)
        let plain = FirstRunTests.FakeHome(SetupHost.standardFolder)
        let older = try await setUp(plain, .plain)
        XCTAssertEqual(older.phase, .done)
        XCTAssertEqual(plain.asked, ["adopt <folder>"] + today, "a folder holding a Lifestream was given a new key")
    }

    func testALockedStartHandsOverToTheLockedPageAndTheFirstRunGoesOnOnceItOpens() async throws {
        let home = FirstRunTests.FakeHome(folder)
        home.locked = 100
        var steps = home.steps
        steps.answerWithin = 0.25
        let handed = Collected<String>()
        steps.locked = { handed.append("the locked page") }
        let start = SetupStart(pair: { _, _ in
            home.paired()
            return .paired
        })
        let phases = Collected<SetupStart.Phase>()
        let watch = start.$phase.sink { phases.append($0) }
        defer { watch.cancel() }
        await start.run(steps, folder: folder, door: "http://127.0.0.1:4680", name: "Desk Mac")
        XCTAssertEqual(start.phase, .done, "a locked start was said as a home that did not answer")
        XCTAssertEqual(handed.values, ["the locked page"], "the locked page was not handed the start, or was handed it again at each answer")
        XCTAssertTrue(phases.values.contains(.locked))
        XCTAssertEqual(home.asked.filter { $0 == "answer?" }.count, 103, "the locked answers counted against the first run's wait")
        XCTAssertEqual(Array(home.asked.suffix(2)), ["code", "name Desk Mac"])
    }

    func testADoorThatAnswersLockedIsReadAsLockedNotAsServing() async {
        let locked = Data(#"{"code":"LOCKED","message":"Lifestream is locked: unlock it on your Mac."}"#.utf8)
        XCTAssertEqual(DoorAnswer(status: 503, body: locked, retryAfter: "5"), .locked,
                       "first run read the door's LOCKED as a door that serves, and went on to pairing")
        XCTAssertNil(DoorAnswer.locked.need)
        let unreached = await DoorAnswer.asked(nil, within: 1)
        XCTAssertEqual(unreached, .silent)
    }

    func testTheHomesLockedAnswerIsReadFromItsSocket() async throws {
        let words = "Lifestream is locked: unlock it on your Mac."
        let locked = try ScriptedHome { _ in ["error": words, "refusal": ["status": 503, "code": "LOCKED", "words": words, "extra": ["why": "no key"]]] }
        defer { locked.stop() }
        let open = try ScriptedHome { _ in ["result": ["unit": "macbook-pro-0001"]] }
        defer { open.stop() }
        let refusing = try ScriptedHome { _ in ["error": "the home refused settings"] }
        defer { refusing.stop() }
        let answers = await Task.detached {
            [locked, open, refusing].map { StartSteps.homeAnswers(HomeSocket(path: $0.path, folder: $0.folder)) } + [StartSteps.homeAnswers(nil)]
        }.value
        XCTAssertEqual(answers, [.locked, nil, .silent, .silent])
    }

    func testAFolderCheckThatEndsAfterAnotherFolderWasChosenIsDropped() async throws {
        let release = scratch.appendingPathComponent("release", isDirectory: true)
        try FileManager.default.createDirectory(at: release, withIntermediateDirectories: true)
        let gate = release.appendingPathComponent("gate")
        XCTAssertEqual(mkfifo(gate.path, 0o600), 0)
        let node = release.appendingPathComponent("node")
        try Data(#"""
            #!/bin/sh
            shift
            here="$(dirname "$0")"
            case "$2" in
              */plain-a) echo "$2" >> "$here/held"; read line < "$here/gate"; form=plain ;;
              *) form=empty ;;
            esac
            printf '{"folder":{"path":"%s","refused":null,"free_bytes":1.2e12,"door":"http://127.0.0.1:4680","form":"%s"}}\n' "$2" "$form"
            """#.utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let a = scratch.appendingPathComponent("plain-a", isDirectory: true)
        let b = scratch.appendingPathComponent("empty-b", isDirectory: true)
        let world = SetupWorld(placed: false, release: false, outdated: false, folder: a,
                               agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, .notRegistered) }), paired: false)
        let setup = SetupHost(world: world, start: SetupStart(pair: { _, _ in .paired }), release: BundledRelease(folder: release), steps: nil,
                              name: "Desk Mac", quit: { XCTFail("Set up quit the app") })
        let slow = Task { await setup.lookAgain() }
        let held = release.appendingPathComponent("held")
        try await until("the first folder's check is under way") { FileManager.default.fileExists(atPath: held.path) }
        setup.choose(b)
        try await until("the second folder's check is in") { setup.look?.folder?.path == b.path }
        await Task.detached { try? "go\n".write(to: gate, atomically: false, encoding: .utf8) }.value
        await slow.value
        XCTAssertEqual(setup.look?.folder?.path, b.path, "the first folder's late check replaced the chosen folder's")
        XCTAssertEqual(setup.look?.folder?.form, .empty)
    }

    func testTheKeyedVerbsCarryTheirKeysThroughPipesAndNoFileHoldsThem() async throws {
        let release = scratch.appendingPathComponent("release", isDirectory: true)
        let machine = scratch.appendingPathComponent("machine", isDirectory: true)
        try FileManager.default.createDirectory(at: release, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: machine, withIntermediateDirectories: true)
        let node = release.appendingPathComponent("node")
        try Data(#"""
            #!/bin/sh
            shift
            here="$(dirname "$0")"
            for fd in 0 1 2; do if [ -p /dev/fd/$fd ]; then echo "$1 $fd pipe" >> "$here/ends"; else echo "$1 $fd file" >> "$here/ends"; fi; done
            case "$1" in
              keys) cat > /dev/null; echo '{"recovery":"MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA","slot":"r-1","number":1,"made_ms":1763337600000}' ;;
              adopt) read line; printf '{"args":"%s","line":%d}\n' "$*" "${#line}" ;;
            esac
            """#.utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let keychain = KeychainItems()
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, item: { keychain.item($0) })
        let steps = KeyedSteps.live(BundledRelease(folder: release), keys: keys)
        let target = folder
        let temporary = FileManager.default.temporaryDirectory
        let before = Set((try? FileManager.default.contentsOfDirectory(atPath: temporary.path)) ?? [])

        let (drafted, home, slot) = try await Task.detached {
            let made = try steps.make(target)
            let drafted = try steps.draft()
            try steps.adopt("/Volumes/T7/Lifestream", try drafted.handoff(home: made.home, slotKey: made.key))
            steps.adopted(made.home, target)
            return (drafted, made.home, made.key)
        }.value
        XCTAssertEqual(drafted.number, 1)
        XCTAssertEqual(keychain.item("machine:\(home)").data, slot)
        XCTAssertTrue(keys.keyed(home).trusted, "the new home's key was not trusted before adopt")
        XCTAssertFalse("\(drafted)".contains("MZXW"), "a draft says its key when described")
        XCTAssertNil(defaults.string(forKey: "vault.draftedHome"), "the drafted home outlived its adopt")

        let hex = slot.map { String(format: "%02x", $0) }.joined()
        let after = Set((try? FileManager.default.contentsOfDirectory(atPath: temporary.path)) ?? []).subtracting(before)
        for name in after {
            let url = temporary.appendingPathComponent(name)
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            XCTAssertFalse(text.contains(hex) || text.contains("MZXW 6YTB"), "\(name) holds a key")
        }
        let ends = try String(contentsOf: release.appendingPathComponent("ends"), encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(ends, ["keys 0 pipe", "keys 1 pipe", "keys 2 pipe", "adopt 0 pipe", "adopt 1 pipe", "adopt 2 pipe"],
                       "a keyed verb's input or output went through a file")
    }

    func testAKeyedRunsAnswerIsReadAndItsArgumentsHoldNoKey() async throws {
        let release = scratch.appendingPathComponent("release", isDirectory: true)
        try FileManager.default.createDirectory(at: release, withIntermediateDirectories: true)
        let node = release.appendingPathComponent("node")
        try Data(#"""
            #!/bin/sh
            shift
            read line
            printf '{"args":"%s","line":%d}\n' "$*" "${#line}"
            """#.utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let handed = Data(#"{"home_id":"6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b","slot_key":"00","recovery":"MZXW"}"#.utf8) + Data([10])
        let answer = try await Task.detached { try BundledRelease(folder: release).home(["adopt", "/Volumes/T7/Lifestream", "--keyed"], handing: handed) }.value
        let read = try XCTUnwrap(JSONSerialization.jsonObject(with: answer) as? [String: Any])
        XCTAssertEqual(read["args"] as? String, "adopt /Volumes/T7/Lifestream --keyed")
        XCTAssertEqual(read["line"] as? Int, handed.count - 1, "the home did not read the whole line on its standard input")
    }
}

final class KeychainItems: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: MemoryStore] = [:]

    func item(_ account: String) -> MemoryStore {
        lock.withLock {
            if let held = items[account] { return held }
            let made = MemoryStore()
            items[account] = made
            return made
        }
    }

    var accounts: [String] { lock.withLock { items.filter { $0.value.data != nil }.map(\.key).sorted() } }
}

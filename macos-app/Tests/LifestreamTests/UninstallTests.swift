import Foundation
import Passwords
import XCTest
@testable import Lifestream

final class UninstallTests: XCTestCase {
    final class Recorded: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [String] = []
        private var handed: [Data?] = []
        let fail: Set<String>
        let drop: [String]?
        let key: Uninstall.KeyStep
        let home: String?
        var homeKey = HomeKey(store: MemoryStore(), trust: KeychainTrust(build: ""), reader: .app)

        init(fail: Set<String> = [], drop: [String]? = nil, key: Uninstall.KeyStep = .saved, home: String? = nil) {
            self.fail = fail
            self.drop = drop
            self.key = key
            self.home = home
        }

        var made: [String] { lock.withLock { calls } }
        var slots: [Data?] { lock.withLock { handed } }

        func call(_ name: String) throws {
            lock.withLock { calls.append(name) }
            if fail.contains(name) { throw ReleaseError(words: "\(name) refused") }
        }

        var steps: Uninstall.Steps {
            Uninstall.Steps(
                key: {
                    try? self.call("window")
                    return self.key
                },
                thisHome: { [homeKey] in homeKey },
                quiet: { try? self.call("quiet") },
                removeAgents: { try self.call("agents") },
                apply: { erase, slot in
                    self.lock.withLock { self.handed.append(slot) }
                    try self.call(erase ? "apply --erase" : "apply")
                    let home = self.home ?? (erase ? "erased" : "kept")
                    return Uninstall.Applied(home: home, folder: "/Users/person-a/Lifestream", revoked: home == "kept" ? 4 : home == "away" ? nil : 0)
                },
                deleteKeychain: { try self.call("keychain \($0.name)") },
                remove: { try self.call("remove \($0.path)") },
                dropNames: { _ in self.drop })
        }
    }

    let user = URL(fileURLWithPath: "/Users/person-a", isDirectory: true)
    let drop = URL(fileURLWithPath: "/Users/person-a/Lifestream Drop", isDirectory: true)

    private func run(_ recorded: Recorded, erase: Bool = false, plan: Uninstall.Plan? = UninstallTests.plan(.confirmed)) async -> Uninstall.Outcome? {
        await Uninstall.run(plan, erase: erase, drop: drop, user: user, steps: recorded.steps, said: { _ in })
    }

    private static func plan(_ recovery: Uninstall.Recovery?, here: Bool = true) -> Uninstall.Plan {
        Uninstall.Plan(folder: "/Users/person-a/Lifestream", here: here, refused: nil, recovery: recovery)
    }

    func testEveryStepRunsInTheOneOrderThatLeavesNoJobOnFilesGone() async {
        let recorded = Recorded(drop: [".DS_Store"])
        let outcome = await run(recorded, erase: true)
        XCTAssertEqual(recorded.made, [
            "quiet", "agents", "apply --erase",
            "keychain org.lifestreamprotocol.vault / machine", "keychain org.lifestreamprotocol.passwords / key",
            "keychain org.lifestreamprotocol.homelink / pass",
            "remove /Users/person-a/Library/Application Support/Lifestream Screen", "remove /Users/person-a/Library/Logs/lifestream",
            "remove /Users/person-a/Library/Application Support/lifestream/ship",
            "remove /Users/person-a/Library/Application Support/Lifestream/scratch/mac",
            "remove /Users/person-a/Library/Application Support/Lifestream/mac-files.json",
            "keychain org.lifestreamprotocol.mac / files",
            "remove /Users/person-a/Lifestream Drop",
        ])
        XCTAssertEqual(outcome, Uninstall.Outcome(stopped: nil, applied: Uninstall.Applied(home: "erased", folder: "/Users/person-a/Lifestream", revoked: 0),
                                                  vault: .kept))
    }

    func testAJobThatWillNotStopOrARefusedReleaseHalfRemovesNothingMore() async {
        let agents = Recorded(fail: ["agents"])
        let stoppedAtAgents = await run(agents)
        XCTAssertEqual(agents.made, ["quiet", "agents"])
        XCTAssertEqual(stoppedAtAgents?.stopped, "macOS did not stop Lifestream's background jobs: agents refused")

        let apply = Recorded(fail: ["apply --erase"])
        let stoppedAtApply = await run(apply, erase: true)
        XCTAssertEqual(apply.made, ["quiet", "agents", "apply --erase"])
        XCTAssertEqual(stoppedAtApply?.stopped, "apply --erase refused")
        XCTAssertNil(stoppedAtApply?.applied)
    }

    func testAFailureAfterTheReleasesHalfIsSaidAndTheRestStillRun() async throws {
        let recorded = Recorded(fail: ["keychain org.lifestreamprotocol.vault / machine", "remove /Users/person-a/Library/Logs/lifestream"])
        let ran = await run(recorded, erase: true)
        let outcome = try XCTUnwrap(ran)
        XCTAssertEqual(recorded.made.count, 12, "every step after the release's half ran: \(recorded.made)")
        XCTAssertNil(outcome.stopped)
        XCTAssertEqual(outcome.failures.count, 2)
        XCTAssertTrue(outcome.failures[0].hasPrefix("The Keychain item org.lifestreamprotocol.vault / machine"))
    }

    func testAClaudeCodeSignOutTheReleaseCouldNotMakeIsSaidAndTheRestStillRun() async throws {
        let failed = #"{"folder":null,"home":"none","revoked":0,"public":{"state":"off"},"removed":[],"claude_failed":"it did not end in time"}"#
        let signedOut = #"{"folder":null,"home":"none","revoked":0,"public":{"state":"off"},"removed":[],"claude_failed":null}"#
        var outcomes: [Uninstall.Outcome?] = []
        for answer in [failed, signedOut] {
            let recorded = Recorded()
            var steps = recorded.steps
            let applied = try JSONDecoder().decode(Uninstall.Applied.self, from: Data(answer.utf8))
            steps.apply = { _, _ in applied }
            outcomes.append(await Uninstall.run(nil, erase: true, drop: drop, user: user, steps: steps, said: { _ in }))
            XCTAssertEqual(recorded.made.count, 11, "every step after the release's half ran: \(recorded.made)")
        }
        XCTAssertEqual(outcomes[0]?.failures, ["Claude Code could not be signed out, so its sign-in may stay in the Keychain: it did not end in time"])
        XCTAssertEqual(outcomes[1]?.failures, [])
    }

    func testBothFormsRemoveTheMacsScratchAndFormFileAndThenItsKeyOnceTheFoldersAreGone() async {
        let form = "remove /Users/person-a/Library/Application Support/Lifestream/mac-files.json"
        let item = "keychain org.lifestreamprotocol.mac / files"
        for erase in [false, true] {
            let recorded = Recorded()
            _ = await run(recorded, erase: erase)
            let made = recorded.made
            guard let ship = made.firstIndex(of: "remove /Users/person-a/Library/Application Support/lifestream/ship"),
                  let scratch = made.firstIndex(of: "remove /Users/person-a/Library/Application Support/Lifestream/scratch/mac"),
                  let file = made.firstIndex(of: form), let key = made.firstIndex(of: item) else {
                return XCTFail("erase \(erase): the Mac's form file or its key was left: \(made)")
            }
            XCTAssertLessThan(ship, file, "erase \(erase): mac-files.json went before the folders it describes")
            XCTAssertLessThan(scratch, file, "erase \(erase): mac-files.json went before the scratch it describes")
            XCTAssertLessThan(file, key, "erase \(erase): the key went before mac-files.json")
        }
        let failing = Recorded(fail: [item])
        let outcome = await run(failing)
        XCTAssertEqual(outcome?.failures.count, 1)
        XCTAssertTrue(outcome?.failures.first?.hasPrefix("The Keychain item org.lifestreamprotocol.mac / files") == true)
    }

    func testTheDropFolderGoesOnlyEmptyAndIsLeftAloneWhenItIsNotThere() async {
        let holding = Recorded(drop: [".DS_Store", "export.zip"])
        let kept = await run(holding)
        XCTAssertFalse(holding.made.contains("remove /Users/person-a/Lifestream Drop"))
        XCTAssertEqual(kept?.dropKept, drop)

        let none = Recorded(drop: nil)
        let absent = await run(none)
        XCTAssertFalse(none.made.contains { $0.hasSuffix("Lifestream Drop") })
        XCTAssertNil(absent?.dropKept)
    }

    func testTheLiveRemovalTakesAPathAlreadyGoneAsDone() throws {
        let gone = FileManager.default.temporaryDirectory.appendingPathComponent("uninstall-gone-\(UUID().uuidString)")
        XCTAssertNoThrow(try Uninstall.live(key: { .saved }, quiet: {}).remove(gone))
    }

    func testTheCleanerRemovesEveryPathItsCommandsAndItselfOnceTheAppHasEnded() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("uninstall-cleaner-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("Lifestream.app/Contents/MacOS", isDirectory: true)
        let quoted = root.appendingPathComponent("the person's \"caches\"", isDirectory: true)
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: quoted, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: quoted.appendingPathComponent("file"))
        let marker = root.appendingPathComponent("ran")
        let ended = Process()
        ended.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try ended.run()
        ended.waitUntilExit()
        let script = Cleaner.script(pid: ended.processIdentifier, paths: [root.appendingPathComponent("Lifestream.app"), quoted],
                                    commands: [["/usr/bin/touch", marker.path]])
        let file = root.appendingPathComponent("cleaner.sh")
        try Data(script.utf8).write(to: file)
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = [file.path]
        try shell.run()
        shell.waitUntilExit()
        XCTAssertEqual(shell.terminationStatus, 0)
        XCTAssertEqual([root.appendingPathComponent("Lifestream.app"), quoted, file].map { FileManager.default.fileExists(atPath: $0.path) },
                       [false, false, false])
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "the commands ran")
    }

    func testTheCleanerForThisAppForgetsItsPreferencesPrivacyRowsAndRemovesTheApp() {
        let script = Cleaner.forThisApp(user: user, bundle: Bundle(for: Self.self))
        let id = Bundle(for: Self.self).bundleIdentifier ?? "org.lifestreamprotocol.screen-capture"
        for line in ["'/usr/bin/defaults' 'delete' '\(id)'", "'/usr/bin/tccutil' 'reset' 'All' '\(id)'",
                     "/bin/rm -rf '/Users/person-a/Library/Application Support/Lifestream Screen'",
                     "/bin/rm -rf '/Users/person-a/Library/Preferences/\(id).plist'",
                     "/bin/rm -rf '/Users/person-a/Library/WebKit/\(id)'",
                     "/bin/rm -rf '\(Bundle(for: Self.self).bundleURL.path)'"] {
            XCTAssertTrue(script.contains(line), "the cleaner runs \(line)")
        }
        XCTAssertLessThan(script.range(of: "defaults")!.lowerBound, script.range(of: "Preferences")!.lowerBound)
    }

    func testTheWordsSayWhatThePersonLosesAndWhatStays() {
        let question = UninstallWords.question(Self.plan(.confirmed))
        for words in ["Your iPhone, the Chrome extension and any agents lose their access", "has not sent yet is lost",
                      "What Lifestream kept stays in /Users/person-a/Lifestream"] {
            XCTAssertTrue(question.contains(words), words)
        }
        XCTAssertFalse(UninstallWords.question(nil).contains("What Lifestream kept stays"))
        var keyed = Self.plan(.confirmed)
        keyed.keyed = true
        var keyedHere = keyed
        keyedHere.keyHere = true
        for (name, plan, access) in [("not encrypted, its drive here", Self.plan(.confirmed), UninstallWords.loseAccess),
                                     ("encrypted, this Mac's key held", keyedHere, UninstallWords.loseAccess),
                                     ("encrypted, no key of this Mac's", keyed, UninstallWords.keepAccess),
                                     ("its drive not connected", Self.plan(.confirmed, here: false), UninstallWords.keepAccess)] {
            let said = UninstallWords.question(plan)
            XCTAssertTrue(said.contains(access), "\(name): \(said)")
            XCTAssertFalse(said.contains(access == UninstallWords.loseAccess ? UninstallWords.keepAccess : UninstallWords.loseAccess), "\(name): \(said)")
        }
        for plan in [nil, Uninstall.Plan(folder: nil, here: false, refused: nil)] {
            let said = UninstallWords.question(plan)
            XCTAssertFalse(said.contains(UninstallWords.loseAccess) || said.contains(UninstallWords.keepAccess), "no home said its devices' access: \(said)")
        }
        XCTAssertFalse(UninstallWords.question(Self.plan(.confirmed)).contains("passwords"), "the question says passwords, not Lifestream's vault")
        XCTAssertTrue(UninstallWords.erase(folder: "/Volumes/T7/home").contains("/Volumes/T7/home is deleted"))
        XCTAssertTrue(UninstallWords.erase(folder: "/Volumes/T7/home").contains("can't be undone"))

        var outcome = Uninstall.Outcome(applied: Uninstall.Applied(home: "kept", folder: "/Users/person-a/Lifestream", revoked: 4))
        outcome.dropKept = drop
        outcome.failures = ["The Keychain item org.lifestreamprotocol.homelink / pass: the Keychain refused (-25244)"]
        let done = UninstallWords.done(outcome)
        for words in ["What Lifestream kept stays in /Users/person-a/Lifestream", "can no longer reach it", "Lifestream Drop still holds files",
                      "could not be removed", "Chrome extension and the iPhone app"] {
            XCTAssertTrue(done.contains(words), words)
        }
        XCTAssertTrue(UninstallWords.done(Uninstall.Outcome(applied: Uninstall.Applied(home: "erased", folder: "/x", revoked: 0))).hasPrefix("Everything Lifestream kept is erased."))
        XCTAssertTrue(UninstallWords.done(Uninstall.Outcome(applied: Uninstall.Applied(home: "away", folder: "/Volumes/T7/home", revoked: nil))).contains("wasn't connected"))
        XCTAssertTrue(UninstallWords.done(Uninstall.Outcome(stopped: "why")).contains("What Lifestream kept was not changed"))
    }

    func testAKeptKeyedHomeKeepsItsKeyAndOpensWithOneAllowWhenSetUpAgain() async throws {
        let machine = FileManager.default.temporaryDirectory.appendingPathComponent("uninstall-keyed-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: machine) }
        let suite = "UninstallTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let keychain = KeychainItems()
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, item: { keychain.item($0) })
        let folder = machine.appendingPathComponent("Lifestream", isDirectory: true)
        let made = try keys.newHome(in: folder)
        let other = try keys.keyed("0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d").make()
        try FileManager.default.createDirectory(at: machine.appendingPathComponent("vaults"), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: machine.appendingPathComponent("vaults/\(made.home).json"))
        try Data("\(made.home)\n".utf8).write(to: machine.appendingPathComponent("home-id"))

        let kept = Recorded()
        kept.homeKey = keys.thisHome()
        XCTAssertTrue(kept.homeKey.keyed)
        _ = await run(kept)
        XCTAssertFalse(kept.made.contains { $0.contains(made.home) })
        XCTAssertEqual(keychain.item("machine:\(made.home)").data, made.key, "Uninstall that kept the home deleted its key")

        UserDefaults().removePersistentDomain(forName: suite)
        try FileManager.default.removeItem(at: machine.appendingPathComponent("vaults"))
        let item = keychain.item("machine:\(made.home)")
        let before = item.prompted.count
        XCTAssertFalse(keys.keyed(made.home).trusted, "the app's preferences outlived Uninstall")
        let steps = KeyedSteps.live(BundledRelease(folder: machine), keys: keys)
        steps.trust(made.home)
        XCTAssertEqual(Array(item.prompted.dropFirst(before)), [true, true], "setting up again on the kept folder asked more than one Allow")
        XCTAssertEqual(keys.thisHome().launchRead(within: VaultHandOff.wait), .key(made.key),
                       "the launcher did not open the kept home with its own key and no recovery key")
        XCTAssertEqual(item.prompted.last, false)

        let erased = Recorded()
        erased.homeKey = keys.thisHome()
        _ = await run(erased, erase: true)
        XCTAssertNil(keychain.item("machine:\(made.home)").data, "Erase left the erased home's key")
        XCTAssertEqual(keychain.item("machine:0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d").data, other, "Erase deleted another home's key")
        XCTAssertEqual(erased.made.filter { $0.hasPrefix("keychain") }, ["keychain org.lifestreamprotocol.homelink / pass",
                                                                       "keychain org.lifestreamprotocol.mac / files"],
                       "erasing a keyed home deleted the plain homes' machine item or the old passwords key")
    }

    private struct Row {
        let name: String
        let plan: Uninstall.Plan?
        var erase = false
        var key = Uninstall.KeyStep.saved
        var home: String? = nil
        let window: Bool
        let deleted: [String]
        let question: String?
        let done: [String]
        let notDone: [String]
    }

    func testEveryStateOfTheFolderTheVaultAndTheHomeRunsDeletesAndSaysItsOwn() async throws {
        let vaultKeys = ["keychain org.lifestreamprotocol.vault / machine", "keychain org.lifestreamprotocol.passwords / key"]
        let pass = ["keychain org.lifestreamprotocol.homelink / pass"]
        let saved = "This Mac keeps the key to its vault, so if you set Lifestream up here again it opens what Lifestream kept without your recovery key. On another Mac, your recovery key opens it."
        let unsaved = "Lifestream asks you to save your recovery key first: on another Mac, or if this Mac's Keychain is lost, it is the only way into Lifestream's vault."
        let erased = "Everything Lifestream kept is erased. Its keys are deleted from this Mac's Keychain."
        let rows = [
            Row(name: "erased, a key never saved", plan: Self.plan(.unconfirmed), erase: true, window: false, deleted: vaultKeys + pass,
                question: unsaved, done: [erased], notDone: [UninstallWords.keptKey, UninstallWords.unsavedKey]),
            Row(name: "erased, no vault", plan: Self.plan(nil), erase: true, window: false, deleted: vaultKeys + pass,
                question: nil, done: [erased], notDone: [UninstallWords.keptKey]),
            Row(name: "kept, no vault yet or one that does not read", plan: Self.plan(nil), window: false, deleted: pass,
                question: nil, done: ["can no longer reach it."], notDone: [UninstallWords.keptKey, UninstallWords.unsavedKey]),
            Row(name: "kept, saved", plan: Self.plan(.confirmed), window: false, deleted: pass,
                question: saved, done: [UninstallWords.keptKey], notDone: [UninstallWords.unsavedKey]),
            Row(name: "kept, never saved, the window saved it (open, or after Allow)", plan: Self.plan(.unconfirmed), window: true, deleted: pass,
                question: unsaved, done: [UninstallWords.keptKey], notDone: [UninstallWords.unsavedKey]),
            Row(name: "kept, never saved, lost or no home", plan: Self.plan(.unconfirmed), key: .unsaved, window: true, deleted: pass,
                question: unsaved, done: [UninstallWords.unsavedKey], notDone: [UninstallWords.keptKey]),
            Row(name: "not connected", plan: Self.plan(nil, here: false), home: "away", window: false, deleted: pass,
                question: nil, done: ["wasn't connected, so what Lifestream kept stays as it was. \(UninstallWords.keepAccess) " + UninstallWords.keptKey],
                notDone: [UninstallWords.unsavedKey, UninstallWords.reached]),
            Row(name: "no plan: the window reads the vault from the home", plan: nil, window: true, deleted: pass,
                question: nil, done: [], notDone: [UninstallWords.unsavedKey]),
        ]
        for row in rows {
            let recorded = Recorded(drop: [".DS_Store"], key: row.key, home: row.home)
            let ran = await run(recorded, erase: row.erase, plan: row.plan)
            let outcome = try XCTUnwrap(ran, row.name)
            XCTAssertEqual(recorded.made.first == "window", row.window, "\(row.name): the window")
            XCTAssertEqual(recorded.made.filter { $0.hasPrefix("keychain") }, row.deleted + ["keychain org.lifestreamprotocol.mac / files"],
                           "\(row.name): the Keychain")
            if row.window { XCTAssertEqual(recorded.made.dropFirst().first, "quiet", "\(row.name): the key came after the first step") }
            let question = UninstallWords.question(row.plan)
            if let words = row.question {
                XCTAssertTrue(question.hasSuffix("What Lifestream kept stays in /Users/person-a/Lifestream unless you erase it. " + words), "\(row.name): \(question)")
            } else if row.plan != nil {
                XCTAssertTrue(question.hasSuffix("What Lifestream kept stays in /Users/person-a/Lifestream unless you erase it."), "\(row.name): \(question)")
            }
            let done = UninstallWords.done(outcome)
            for words in row.done { XCTAssertTrue(done.contains(words), "\(row.name): \(words) in \(done)") }
            for words in row.notDone { XCTAssertFalse(done.contains(words), "\(row.name): \(words) in \(done)") }
            XCTAssertFalse(done.contains("passwords"), "\(row.name): \(done)")
        }
    }

    func testAKeptKeyedHomeHandsThisMacsSlotKeyOnInputAndTheLastWindowSaysWhatWasRevoked() async throws {
        let slot = Data(repeating: 0xab, count: 32)
        let store = MemoryStore()
        store.data = slot
        let keyed = HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true)
        let kept = Recorded()
        kept.homeKey = keyed
        let ran = await run(kept)
        let outcome = try XCTUnwrap(ran)
        XCTAssertEqual(kept.slots, [slot], "Uninstall of a kept keyed home did not hand this Mac's slot key")
        XCTAssertTrue(outcome.keyed)
        let erased = Recorded()
        erased.homeKey = keyed
        _ = await run(erased, erase: true)
        XCTAssertNil(store.data, "an erase left this Mac's key to the home in the Keychain")
        let plain = Recorded()
        _ = await run(plain)
        XCTAssertEqual(erased.slots + plain.slots, [nil, nil], "a key was handed where nothing needs it: an erase, or a plain home")

        let arguments = Uninstall.applyArguments(erase: false, slot: true)
        XCTAssertEqual(arguments, ["uninstall", "--apply", "--key-on-input", "--json"])
        XCTAssertEqual(Uninstall.applyArguments(erase: false, slot: false), ["uninstall", "--apply"], "a plain home's Uninstall changed")
        let input = String(decoding: Uninstall.keyOnInput(slot), as: UTF8.self)
        XCTAssertEqual(input, String(repeating: "ab", count: 32) + "\n")
        XCTAssertFalse(arguments.contains { $0.contains("abab") }, "the slot key went into the arguments")

        var revoked = Uninstall.Outcome(applied: Uninstall.Applied(home: "kept", folder: "/Users/person-a/Lifestream", revoked: 3), vault: .kept, keyed: true)
        let said = UninstallWords.done(revoked)
        XCTAssertTrue(said.hasPrefix("What Lifestream kept stays in /Users/person-a/Lifestream, encrypted. \(UninstallWords.reached) \(UninstallWords.keptHomeKey)"), said)
        revoked.applied = Uninstall.Applied(home: "kept", folder: "/Users/person-a/Lifestream", revoked: nil)
        let unreached = UninstallWords.done(revoked)
        XCTAssertTrue(unreached.contains("Your devices keep their access until you remove them in Devices."), unreached)
        XCTAssertFalse(unreached.contains(UninstallWords.reached), "a home whose passes were not reached said its devices can no longer reach it")
        revoked.applied = Uninstall.Applied(home: "kept", folder: "/Users/person-a/Lifestream", revoked: 0)
        let none = UninstallWords.done(revoked)
        XCTAssertTrue(none.contains("No device or agent had access to it."), none)
        XCTAssertFalse(none.contains(UninstallWords.keepAccess), "a home that held no pass said its devices keep their access")
        XCTAssertFalse(none.contains(UninstallWords.reached), "a home that revoked nothing said its devices can no longer reach it")
        let answered = { (revoked: String) in
            try JSONDecoder().decode(Uninstall.Applied.self, from: Data(#"{"folder":"/x","home":"kept","revoked":\#(revoked),"public":{"state":"off"},"removed":[]}"#.utf8))
        }
        XCTAssertNil(try answered("null").revoked, "a home that reached no pass was read as one that held none")
        XCTAssertEqual(try answered("0").revoked, 0)
    }

    func testUninstallsWordsSayEncryptedOnAKeyedHome() {
        var plan = Self.plan(.confirmed)
        plan.keyed = true
        XCTAssertTrue(UninstallWords.question(plan).hasSuffix(
            "What Lifestream kept stays in /Users/person-a/Lifestream, encrypted, unless you erase it. This Mac keeps the key that opens it, "
                + "so if you set Lifestream up here again it opens what Lifestream kept without your recovery key. On another Mac, your recovery key opens it."),
            UninstallWords.question(plan))
        plan.recovery = .unconfirmed
        XCTAssertTrue(UninstallWords.question(plan).hasSuffix("it is the only way into what Lifestream kept."), UninstallWords.question(plan))
        let away = UninstallWords.done(Uninstall.Outcome(applied: Uninstall.Applied(home: "away", folder: "/Volumes/T7/home", revoked: 0), keyed: true))
        XCTAssertTrue(away.contains(UninstallWords.keptHomeKey), away)
        XCTAssertFalse(UninstallWords.question(Self.plan(.confirmed)).contains("encrypted"), "a plain home's Uninstall said encrypted")
    }

    func testClosingTheWindowOrCancelUninstallRunsNothingAndDeletesNothing() async {
        let recorded = Recorded(key: .cancelled)
        let outcome = await run(recorded, plan: Self.plan(.unconfirmed))
        XCTAssertNil(outcome)
        XCTAssertEqual(recorded.made, ["window"])
    }
}

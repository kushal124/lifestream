import AppKit
import Foundation
import Passwords
import SwiftUI
import XCTest
@testable import Lifestream

@MainActor final class RecoveryKeyTests: XCTestCase {
    private let key = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"
    private let second = "ABCD 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"
    nonisolated private static let day17 = Int64(1_794_916_800_000)
    nonisolated private static let day3 = Int64(1_793_707_200_000)
    private var home: ScriptedHome!
    private var keeper: VaultKeeper!
    private let state = HomeState()
    private let machine = MemoryStore()
    private var board: NSPasteboard!
    private var held: [NeedsModel] = []
    private let suite = "RecoveryKeyTests-\(UUID().uuidString)"
    private var defaults: UserDefaults!

    private let drop = FileManager.default.temporaryDirectory.appendingPathComponent("recovery-key-\(UUID().uuidString)", isDirectory: true)

    override func setUp() async throws {
        let state = state
        home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "vault": return ["result": state.vault]
            case "vault-init", "vault-recovery":
                state.making?()
                let kept = (state.vault["slots"] as? [[String: Any]] ?? []).filter { $0["confirmed_ms"] != nil }
                state.number += 1
                let slot: [String: Any] = ["id": "r-\(state.number)", "kind": "recovery", "made_ms": state.madeMs]
                state.waiting = slot
                state.vault = ["key_id": "3fa2c91b", "locked": false, "recovery": "unconfirmed", "slots": kept + [slot]]
                return ["result": ["recovery_slot": "r-\(state.number)", "made_ms": state.madeMs, "recovery": state.made]]
            case "vault-new":
                if let opens = state.opens, request["slot_key"] as? String == opens {
                    state.vault = ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed", "slots": state.vault["slots"] ?? []]
                    return ["result": ["opened": "3fa2c91b"]]
                }
                if let refused = state.refusal { return ["error": refused] }
                if state.answer == .lost { return [:] }
                state.number += 1
                let slot: [String: Any] = ["id": "r-\(state.number)", "kind": "recovery", "made_ms": state.madeMs]
                state.waiting = slot
                state.vault = ["key_id": "0a1b2c3d", "locked": false, "recovery": "unconfirmed", "slots": [slot]]
                switch state.answer {
                case .actedThenLost: return [:]
                case .unnamed: return ["result": ["key_id": "0a1b2c3d", "slot": "m-0a1b2c3d", "recovery": state.made]]
                case .said, .lost:
                    return ["result": ["key_id": "0a1b2c3d", "slot": "m-0a1b2c3d", "recovery": state.made,
                                       "recovery_slot": "r-\(state.number)", "made_ms": state.madeMs]]
                }
            case "unlock":
                guard let opens = state.opens, request["slot_key"] as? String == opens else { return SocketMachine.wrongKey }
                state.vault = ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed", "slots": state.vault["slots"] ?? []]
                return ["result": ["key_id": "3fa2c91b"]]
            case "vault-discard":
                if let refused = state.refusal { return ["error": refused] }
                let slots = state.vault["slots"] as? [[String: Any]] ?? []
                let kept = slots.filter { $0["confirmed_ms"] != nil }
                let dropped = slots.filter { $0["confirmed_ms"] == nil }.compactMap { ($0["id"] as? String).flatMap { Int($0.dropFirst(2)) } }
                var vault = state.vault
                vault["slots"] = kept
                vault["recovery"] = kept.isEmpty ? "none" : "confirmed"
                state.vault = vault
                state.waiting = nil
                return ["result": ["dropped": dropped]]
            case "vault-check":
                let typed = request["recovery"] as? String
                if typed == "MZXW" { return ["error": "that is not a recovery key: it has 4 letters and digits, not 52"] }
                return ["result": ["opens": typed == state.made, "slot": "r-2", "number": 2, "made_ms": state.madeMs]]
            case "vault-confirm":
                state.confirming?()
                if state.answer == .lost { return [:] }
                guard request["recovery"] as? String == state.made else { return ["error": "that recovery key does not open this vault: nothing was changed"] }
                var slot = state.waiting ?? [:]
                slot["confirmed_ms"] = state.madeMs + 1
                state.vault = ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed", "slots": [slot]]
                return state.answer == .actedThenLost ? [:] : ["result": ["confirmed": slot["id"] ?? ""]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        state.made = key
        state.madeMs = Self.day17
        let socket = HomeSocket(path: home.path, folder: home.folder, patience: 0.5)
        keeper = VaultKeeper(machine: machine, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        board = NSPasteboard(name: NSPasteboard.Name("recovery-\(UUID().uuidString)"))
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        try FileManager.default.createDirectory(at: drop, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        home.stop()
        board.releaseGlobally()
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: drop)
    }

    private var verbs: [String] { home.requests.compactMap { $0["verb"] as? String } }

    private func made(_ keeper: VaultKeeper? = nil, folder: URL? = nil, file: URL? = nil) -> (needs: NeedsModel, recovery: RecoveryKey) {
        let recovery = RecoveryKey(keeper: keeper ?? self.keeper, defaults: defaults)
        let needs = NeedsModel(keeper: keeper ?? self.keeper, recovery: recovery)
        held.append(needs)
        recovery.board = board
        recovery.later = { _, _ in }
        recovery.folder = { folder }
        recovery.choose = { _ in file }
        return (needs, recovery)
    }

    private func saved(_ number: Int, made: Int64 = day17) -> [String: Any] {
        ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed",
         "slots": [["id": "r-\(number)", "kind": "recovery", "made_ms": made, "confirmed_ms": made + 1]]]
    }

    func testIveSavedItIsOffUntilSaveOrCopyInThisWindowForThisKey() async throws {
        let file = drop.appendingPathComponent("chosen.txt")
        let (_, recovery) = made(file: file)
        await recovery.open(.asked)
        XCTAssertEqual(recovery.face, .shown)
        XCTAssertEqual(recovery.shown, .init(key: key, name: KeyName(number: 1, madeMs: Self.day17)))
        XCTAssertNil(recovery.used, "I've saved it is on before Save or Copy")
        XCTAssertEqual(verbs, ["vault", "vault", "vault-init", "vault"])
        let early = await recovery.confirm()
        XCTAssertFalse(early)
        XCTAssertEqual(verbs.filter { $0 == "vault-confirm" }, [], "a key neither saved nor copied was confirmed")

        recovery.copy()
        XCTAssertEqual(recovery.used, .copied)
        XCTAssertEqual(board.string(forType: .string), key)
        XCTAssertEqual(recovery.said, "Copied. Paste it into your password manager within 90 seconds.")
        XCTAssertNotNil(board.data(forType: SecretCopy.concealed), "the key went to the clipboard unconcealed")

        await recovery.save()
        XCTAssertEqual(recovery.said, "Saved to chosen.txt.")
        XCTAssertTrue(try String(contentsOf: file, encoding: .utf8).contains(key))

        let kept = await recovery.confirm()
        XCTAssertTrue(kept)
        XCTAssertEqual(home.requests.last { $0["verb"] as? String == "vault-confirm" }?["recovery"] as? String, key, "the key confirmed is not the one shown")
        XCTAssertEqual(recovery.face, .saved(KeyName(number: 1, madeMs: Self.day17), replaced: nil))
        XCTAssertNil(recovery.shown)
        XCTAssertNil(recovery.used)

        state.made = second
        state.madeMs = Self.day17 + 60_000
        await recovery.make()
        XCTAssertEqual(recovery.shown?.key, second)
        XCTAssertNil(recovery.used, "I've saved it stayed on for a new key")
        XCTAssertNil(recovery.said)
        await recovery.save()
        XCTAssertEqual(recovery.used, .saved)
        let renewed = await recovery.confirm()
        XCTAssertTrue(renewed)
        XCTAssertEqual(recovery.face, .saved(KeyName(number: 2, madeMs: Self.day17 + 60_000), replaced: KeyName(number: 1, madeMs: Self.day17)),
                       "the key it replaced is not said")
    }

    func testASaveThePanelCancelledLeavesItOff() async throws {
        let (_, recovery) = made(file: nil)
        await recovery.open(.asked)
        await recovery.save()
        XCTAssertNil(recovery.used)
        XCTAssertNil(recovery.said)
    }

    func testASaveInsideTheHomesFolderOrThroughALinkIntoItIsRefusedAndWritesNothing() async throws {
        let folder = drop.appendingPathComponent("Lifestream", isDirectory: true)
        let outside = drop.appendingPathComponent("Documents", isDirectory: true)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("blobs"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let link = outside.appendingPathComponent("home")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: folder)

        for file in [folder.appendingPathComponent("key.txt"), folder.appendingPathComponent("blobs/key.txt"),
                     link.appendingPathComponent("key.txt")] {
            let (_, recovery) = made(folder: folder, file: file)
            await recovery.open(.asked)
            await recovery.save()
            XCTAssertEqual(recovery.said, "Save it outside Lifestream's folder: a copy of the folder would carry its own key.", file.path)
            XCTAssertNil(recovery.used, "a refused save turned I've saved it on")
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "a refused save wrote \(file.path)")
            recovery.forget()
        }
        let fine = outside.appendingPathComponent("key.txt")
        let (_, recovery) = made(folder: folder, file: fine)
        await recovery.open(.asked)
        await recovery.save()
        XCTAssertEqual(recovery.used, .saved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fine.path))

        let failing = made(folder: folder, file: drop.appendingPathComponent("missing/key.txt")).recovery
        await failing.open(.asked)
        await failing.save()
        XCTAssertNil(failing.used, "a save the disk refused turned I've saved it on")
        let said = try XCTUnwrap(failing.said)
        XCTAssertTrue(said.hasPrefix("Lifestream couldn't save the file: ") && said.hasSuffix(". Choose another place, or copy the key."), said)
    }

    func testAKeyNamedByItsDayIsTheVaultsKeyOfThatNumberAndDay() throws {
        let made = RecoveryMade(key: key, number: 2, madeMs: Self.day17 + 3_660_000)
        let slot = try XCTUnwrap(VaultState(answer: ["key_id": "3fa2c91b", "keyed": true, "locked": false, "recovery": "confirmed",
                                                     "slots": [["id": "r-2", "kind": "recovery", "made_ms": Self.day17 + 3_600_000,
                                                                "confirmed_ms": Self.day17 + 3_720_000]]]))
        XCTAssertTrue(RecoveryKey.confirmed(KeyName(made), in: slot), "a confirm whose answer was lost did not find its key in the vault")
        XCTAssertNotEqual(KeyName(made), KeyName(number: 1, madeMs: Self.day17))
        XCTAssertNotEqual(KeyName(made), KeyName(number: 2, madeMs: Self.day17 + 86_400_000))
    }

    func testTheFileIsNamedByItsKeyAndCarriesItsNumberAndDay() throws {
        let name = KeyName(number: 2, madeMs: Self.day17)
        XCTAssertEqual(name.title, "Recovery key 2")
        XCTAssertEqual(name.inLine, "recovery key 2, made on 17 November 2026")
        XCTAssertEqual(RecoveryKeyFile.name(name), "Lifestream recovery key 2 (17 Nov 2026).txt")
        XCTAssertEqual(RecoveryKeyView.lines(key), "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB\nOIMZ XW6Y TBOI MZXW 6YTB OIAA")
        XCTAssertEqual(RecoveryKeyFile.text(key: key.replacingOccurrences(of: " ", with: ""), name: name, keyed: false), """
        Lifestream recovery key 2
        Made on 17 November 2026

        \(key)

        It opens your Lifestream passwords on another Mac, or on this Mac if its Keychain loses Lifestream's key.
        A copy of Lifestream's folder from before a newer key opens only with the key of its time: keep this file with any such copy.
        Keep it away from this Mac: in your password manager, or printed.

        """)
        try FileManager.default.createDirectory(at: Shots.e2e, withIntermediateDirectories: true)
        try Data(RecoveryKeyFile.text(key: key, name: name, keyed: false).utf8).write(to: Shots.e2e.appendingPathComponent(RecoveryKeyFile.name(name)))
        let keyed = RecoveryKeyFile.text(key: key, name: name, keyed: true)
        XCTAssertTrue(keyed.contains("It opens Lifestream and everything it keeps on another Mac, or on this Mac if its Keychain loses Lifestream's key."), keyed)
        XCTAssertFalse(keyed.contains("passwords"), "a keyed home's saved file said it opens passwords")
    }

    func testTheSavedKeyFaceSaysWhyALostKeyMattersOnAnEncryptedLifestream() {
        XCTAssertEqual(RecoveryKeyView.savedKeyWords(keyed: false),
                       "Make a new key if this one is lost. Your old key keeps working until you save the new one.")
        XCTAssertEqual(RecoveryKeyView.savedKeyWords(keyed: true),
                       "This Mac's key and this one are the only two ways into Lifestream: make a new key if this one is lost. Your old key keeps working until you save the new one.")
    }

    func testTheSavePanelOpensInDocumentsNeverTheLastFolderUsed() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let panel = RecoveryKeyFile.panel(RecoveryKeyFile.name(KeyName(number: 1, madeMs: Self.day17)))
        panel.directoryURL = drop
        XCTAssertEqual(RecoveryKeyFile.panel("again.txt").directoryURL?.standardizedFileURL.path, documents.standardizedFileURL.path,
                       "the panel opened where the last one was pointed, not in Documents")
        XCTAssertEqual(panel.nameFieldStringValue, "Lifestream recovery key 1 (17 Nov 2026).txt")
    }

    func testEachVaultStateOpensItsFace() async throws {
        let (_, none) = made()
        state.vault = ["key_id": NSNull(), "locked": false, "recovery": "none"]
        await none.open(.asked)
        XCTAssertEqual(none.face, .shown, "no vault did not make one at once")

        state.vault = saved(1, made: Self.day3)
        state.number = 1
        let (_, savedKey) = made()
        let before = verbs.count
        await savedKey.open(.asked)
        XCTAssertEqual(savedKey.face, .savedKey(KeyName(number: 1, madeMs: Self.day3)))
        XCTAssertEqual(Array(verbs.dropFirst(before)), ["vault"], "a saved key's face made a key before Make a new key")
        await savedKey.make()
        XCTAssertEqual(savedKey.face, .shown)
        XCTAssertEqual(savedKey.shown?.name, KeyName(number: 2, madeMs: Self.day17))
        XCTAssertEqual(Array(verbs.dropFirst(before)), ["vault", "vault", "vault-recovery", "vault"])
        savedKey.forget()

        let (_, unsaved) = made()
        await unsaved.open(.asked)
        XCTAssertEqual(unsaved.face, .shown, "a key not saved did not make a new one at once")
        XCTAssertEqual(unsaved.shown?.name.number, 3)

        machine.data = Data(repeating: 7, count: 32)
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "confirmed"]
        let (_, allow) = made()
        await allow.open(.asked)
        XCTAssertEqual(allow.face, .allow)

        machine.data = nil
        let (_, lost) = made()
        await lost.open(.asked)
        XCTAssertEqual(lost.face, .lost)

        state.vault = saved(1)
        let (_, asked) = made()
        await asked.open(.lost)
        XCTAssertEqual(asked.face, .lost, "the Unlock sheet's door did not open on Lost")

        let alone = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let (_, noHome) = made(alone)
        await noHome.open(.asked)
        XCTAssertEqual(noHome.face, .noHome)
    }

    func testAllowOpensTheVaultAndGoesOnToTheKey() async throws {
        let held = Data(repeating: 9, count: 32)
        machine.data = held
        state.opens = held.base64EncodedString()
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "unconfirmed"]
        let (_, recovery) = made()
        await recovery.open(.asked)
        XCTAssertEqual(recovery.face, .allow)
        await recovery.allow()
        XCTAssertEqual(verbs.filter { $0 != "vault" }, ["unlock"])
        XCTAssertEqual(recovery.face, .savedKey(nil), "Allow did not go on to the vault's face")
    }

    func testAKeyAskedOfAHomeThatStoppedAnsweringShowsNoHome() async throws {
        let socket = HomeSocket(path: home.path, folder: home.folder, patience: 0.5)
        let (_, recovery) = made(VaultKeeper(machine: machine, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket }))
        state.vault = saved(1)
        state.number = 1
        await recovery.open(.asked)
        home.stop()
        await recovery.make()
        XCTAssertEqual(recovery.face, .noHome)
        XCTAssertEqual(recovery.refusal, HostRefusal(.notSent))
        XCTAssertNil(recovery.shown)
    }

    func testAConfirmTheHomeRefusesSaysItsWordsAndKeepsTheKey() async throws {
        let (_, recovery) = made()
        await recovery.open(.asked)
        recovery.copy()
        state.made = second
        let kept = await recovery.confirm()
        XCTAssertFalse(kept)
        XCTAssertEqual(recovery.refusal, HostRefusal("that recovery key does not open this vault: nothing was changed"))
        XCTAssertEqual(recovery.shown?.key, key)
        XCTAssertEqual(recovery.face, .shown)
    }

    func testClosingAfterSaveOrCopyAsksAndGoBackKeepsTheKey() async throws {
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        var asked = 0
        var answer = RecoveryKeyWindow.Closing.goBack
        window.ask = { _ in
            asked += 1
            return answer
        }
        window.open(.asked)
        let shown = try XCTUnwrap(window.window)
        try await until("the key shown") { recovery.face == .shown }
        XCTAssertTrue(window.windowShouldClose(shown), "a key neither saved nor copied asked before closing")
        XCTAssertEqual(asked, 0)

        recovery.copy()
        XCTAssertFalse(window.windowShouldClose(shown))
        try await until("asked once") { asked == 1 }
        XCTAssertEqual(recovery.shown?.key, key, "Go back forgot the key")

        answer = .discard
        XCTAssertFalse(window.windowShouldClose(shown))
        try await until("the window closed") { window.window == nil }
        XCTAssertNil(recovery.shown, "Discard kept the key")
        XCTAssertEqual(asked, 2)
        XCTAssertEqual(verbs.filter { $0 == "vault-confirm" }, [])
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }, ["vault-discard"], "Discard this key left the key's slot at the home")
    }

    func testDiscardThisKeyDropsItsSlotAtTheHomeAndClosesOnlyAfterTheAnswer() async throws {
        let (needs, recovery) = made()
        state.vault = saved(1)
        state.number = 1
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        window.ask = { _ in .discard }
        window.open(.asked)
        let shown = try XCTUnwrap(window.window)
        try await until("the saved key's face") { if case .savedKey = recovery.face { true } else { false } }
        _ = await recovery.make()
        XCTAssertEqual(recovery.face, .shown)
        recovery.copy()

        state.refusal = "the home could not drop the slot"
        XCTAssertFalse(window.windowShouldClose(shown))
        try await until("the refusal said") { recovery.refusal != nil }
        XCTAssertNotNil(window.window, "the window closed though the key still opens the home")
        XCTAssertEqual(recovery.shown?.key, key, "a discard the home refused forgot the key")
        XCTAssertEqual(recovery.refusal?.words, "the home could not drop the slot")
        XCTAssertEqual(((state.vault["slots"] as? [[String: Any]]) ?? []).count, 2)

        state.refusal = nil
        XCTAssertFalse(window.windowShouldClose(shown))
        try await until("the window closed") { window.window == nil }
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }.count, 2)
        XCTAssertEqual((state.vault["slots"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["r-1"], "the new key's slot still opens the home")
        XCTAssertEqual(needs.list, [], "a discarded key left the saved key said not saved")
    }

    func testADiscardNoHomeHearsClosesTheWindowAndIsSentOnTheFirstReadThatReachesIt() async throws {
        let reach = Reach()
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: machine, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { reach.on ? socket : nil })
        let (needs, recovery) = made(keeper)
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        window.ask = { _ in .discard }
        var told: [String] = []
        window.tell = { _, words in told.append(words) }
        window.open(.asked)
        let shown = try XCTUnwrap(window.window)
        try await until("the key shown") { recovery.face == .shown }
        recovery.copy()

        reach.on = false
        XCTAssertFalse(window.windowShouldClose(shown))
        try await until("the window closed") { window.window == nil }
        XCTAssertEqual(told, ["This key still opens your passwords until Lifestream answers again. This Mac discards it then."],
                       "the window closed without saying the key still opens")
        XCTAssertNil(recovery.shown)
        XCTAssertTrue(recovery.owesDiscard, "a discard no home heard was not kept as owed")
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }, [])

        let (again, relaunched) = made(keeper)
        XCTAssertTrue(relaunched.owesDiscard, "the discard owed did not outlive a quit")
        await again.read()
        XCTAssertTrue(relaunched.owesDiscard, "a read that reached no home cleared the discard owed")

        reach.on = true
        await again.read()
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }, ["vault-discard"], "the first read that reached the home did not send the discard owed")
        XCTAssertFalse(relaunched.owesDiscard, "the home's answer left the discard owed")
        XCTAssertEqual(state.vault["recovery"] as? String, "none", "the key discarded still opens the home")
        await again.read()
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }.count, 1, "a discard the home answered was sent again")
    }

    func testALogOutsDiscardWaitsOnNoSocketAndTheOwedDiscardWaitsWhileAKeyIsShown() async throws {
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        window.ask = { _ in .discard }
        var told: [String] = []
        window.tell = { _, words in told.append(words) }
        window.open(.asked)
        try await until("the key shown") { recovery.face == .shown }
        recovery.copy()

        let quits = await window.beforeQuit(.system)
        XCTAssertTrue(quits, "a log out's Discard held the quit")
        XCTAssertNil(window.window)
        XCTAssertEqual(told, [], "a log out was held by a sentence")
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }, [], "a log out asked the home's socket")
        XCTAssertTrue(recovery.owesDiscard)

        _ = await recovery.make()
        XCTAssertEqual(recovery.face, .shown)
        await needs.read()
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }, [], "the discard owed was sent while a key was shown")
        recovery.copy()
        let kept = await recovery.confirm()
        XCTAssertTrue(kept)
        XCTAssertEqual(verbs.filter { $0 == "vault-discard" }, ["vault-discard"], "the discard owed was not sent once no key was shown")
        XCTAssertFalse(recovery.owesDiscard)
        XCTAssertEqual(state.vault["recovery"] as? String, "confirmed", "the discard owed dropped the key saved after it")
    }

    func testACloseWhileIveSavedItIsAnsweringIsRefusedAndAQuitWaitsForTheAnswer() async throws {
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        var asked = 0
        window.ask = { _ in
            asked += 1
            return .discard
        }
        window.open(.asked)
        let shown = try XCTUnwrap(window.window)
        try await until("the key shown") { recovery.face == .shown }
        recovery.copy()
        let seen = Seen()
        state.confirming = {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    seen.closes.append(window.window.map(window.windowShouldClose) ?? true)
                    Task { seen.quit = await window.beforeQuit(.user) }
                }
            }
        }
        let kept = await recovery.confirm()
        XCTAssertTrue(kept)
        XCTAssertEqual(seen.closes, [false], "a close while the home was taking the key was not refused")
        try await until("the quit answered") { seen.quit != nil }
        XCTAssertEqual(seen.quit, true, "a quit after the key was confirmed was held")
        XCTAssertEqual(asked, 0, "Discard this key was asked over a key the home took")
        XCTAssertEqual(recovery.face, .saved(KeyName(number: 1, madeMs: Self.day17), replaced: nil))
        XCTAssertNotNil(window.window)
        XCTAssertTrue(window.windowShouldClose(shown), "a saved key's window asked before closing")
    }

    func testAConfirmWhoseAnswerWasLostReadsTheVault() async throws {
        let (_, recovery) = made()
        await recovery.open(.asked)
        recovery.copy()
        state.answer = .lost
        let unheard = await recovery.confirm()
        XCTAssertFalse(unheard)
        XCTAssertNotNil(recovery.refusal, "a confirm the home did not answer said nothing")
        XCTAssertEqual(recovery.shown?.key, key)
        XCTAssertEqual(recovery.face, .shown)

        state.answer = .actedThenLost
        let landed = await recovery.confirm()
        XCTAssertTrue(landed, "a key the home confirmed read as refused")
        XCTAssertNil(recovery.refusal)
        XCTAssertNil(recovery.shown)
        XCTAssertEqual(recovery.face, .saved(KeyName(number: 1, madeMs: Self.day17), replaced: nil))

        let other = try XCTUnwrap(VaultState(answer: saved(1, made: Self.day3)))
        XCTAssertFalse(RecoveryKey.confirmed(KeyName(number: 1, madeMs: Self.day17), in: other),
                       "another key of the same number read as this key confirmed")
    }

    func testACloseAndAQuitAskedTogetherShareOneQuestion() async throws {
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        var asked = 0
        var release: CheckedContinuation<Void, Never>?
        window.ask = { _ in
            asked += 1
            await withCheckedContinuation { release = $0 }
            return .discard
        }
        window.open(.asked)
        let shown = try XCTUnwrap(window.window)
        try await until("the key shown") { recovery.face == .shown }
        recovery.copy()
        XCTAssertFalse(window.windowShouldClose(shown))
        let quit = Task { await window.beforeQuit(.user) }
        try await until("the close's question asked") { release != nil }
        release?.resume()
        let quits = await quit.value
        XCTAssertEqual(asked, 1, "a quit during the close's question asked a second one")
        XCTAssertTrue(quits, "the quit did not take the close's Discard")
        XCTAssertNil(window.window)
    }

    func testAQuitAfterSaveOrCopyAsksAsClosingDoesAndGoBackKeepsTheApp() async throws {
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        var asked = 0
        var answer = RecoveryKeyWindow.Closing.goBack
        window.ask = { _ in
            asked += 1
            return answer
        }
        window.open(.asked)
        try await until("the key shown") { recovery.face == .shown }
        XCTAssertFalse(window.asksBeforeQuitting(.user))
        let unused = await window.beforeQuit(.user)
        XCTAssertTrue(unused, "a key neither saved nor copied held the quit")
        XCTAssertEqual(asked, 0)

        recovery.copy()
        let relaunch = QuitSource.classify(shuttingDown: false, quitReason: nil, updating: true)
        XCTAssertTrue(window.asksBeforeQuitting(.user))
        XCTAssertTrue(window.asksBeforeQuitting(relaunch), "an update's relaunch did not ask")
        XCTAssertFalse(window.asksBeforeQuitting(.controlShutdown))
        let stayed = await window.beforeQuit(relaunch)
        XCTAssertFalse(stayed, "Go back did not cancel the quit")
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(recovery.shown?.key, key, "Go back forgot the key")
        XCTAssertNotNil(window.window)

        answer = .discard
        let quit = await window.beforeQuit(.user)
        XCTAssertTrue(quit)
        XCTAssertEqual(asked, 2)
        XCTAssertNil(recovery.shown)
        XCTAssertNil(window.window, "Discard left the window open")
        XCTAssertEqual(verbs.filter { $0 == "vault-confirm" }, [])
    }

    func testClosingTheWindowForgetsAKeyNeitherSavedNorCopied() async throws {
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        window.open(.asked)
        try await until("the key shown") { recovery.face == .shown }
        window.window?.close()
        XCTAssertNil(recovery.shown)
        XCTAssertNil(window.window)
        await needs.read()
        XCTAssertEqual(needs.list, [.saveRecoveryKey(keyed: false)], "a key closed unsaved left no need")
        state.made = second
        window.open(.asked)
        try await until("a new key shown") { recovery.shown?.key == second }
        XCTAssertEqual(recovery.shown?.name.number, 2, "the key closed was shown again")
    }

    func testAKeyWhoseMakingTheWindowClosedIsNeverShown() async {
        let (_, recovery) = made()
        state.making = { DispatchQueue.main.async { MainActor.assumeIsolated { recovery.forget() } } }
        let shown = await recovery.make()
        XCTAssertFalse(shown)
        XCTAssertNil(recovery.shown, "a key made after the window closed was shown")
        XCTAssertFalse(recovery.working)
        state.making = nil
        state.made = second
        let again = await recovery.make()
        XCTAssertTrue(again)
        XCTAssertEqual(recovery.shown?.key, second)
    }

    func testTheLostFaceStartsANewVaultAndNamesTheOtherMacs() async throws {
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let paired = VaultKeeper(machine: machine, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket }, unit: { "macbook-pro-0001" })
        let (_, recovery) = made(paired)
        recovery.names = { $0.map { $0 == "macbook-air-bb17" ? "Second MacBook" : $0 } }
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "confirmed", "slots": [
            ["id": "m-1", "kind": "machine", "unit": "macbook-air-bb17", "store": "keychain-login", "made_ms": 1],
            ["id": "m-2", "kind": "machine", "unit": "macbook-pro-0001", "store": "keychain-login", "made_ms": 1],
            ["id": "m-3", "kind": "machine", "unit": "mac-mini-cc01", "store": "keychain-login", "made_ms": 1],
            ["id": "r-1", "kind": "recovery", "made_ms": 1, "confirmed_ms": 2]]]
        await recovery.open(.asked)
        XCTAssertEqual(recovery.face, .lost)
        XCTAssertEqual(recovery.elsewhere, ["Second MacBook", "mac-mini-cc01"], "another Mac is not named as Devices names it, else by its unit")

        let words = "this vault is not one this Mac may start again: nothing was deleted"
        state.refusal = words
        await recovery.startNewVault()
        XCTAssertEqual(recovery.refusal, HostRefusal(words))
        XCTAssertEqual(recovery.face, .lost)
        XCTAssertNil(machine.data, "a new vault the home refused left a key that opens nothing")

        state.refusal = nil
        state.made = second
        await recovery.startNewVault()
        XCTAssertEqual(recovery.face, .shown)
        XCTAssertEqual(recovery.shown, .init(key: second, name: KeyName(number: 1, madeMs: Self.day17)))
        XCTAssertNotNil(machine.data)

        recovery.copy()
        let kept = await recovery.confirm()
        XCTAssertTrue(kept)
        XCTAssertEqual(recovery.face, .saved(KeyName(number: 1, madeMs: Self.day17), replaced: nil),
                       "a new vault's key said the old vault's key of its own number no longer opens your passwords")
    }

    func testCheckYourRecoveryKeySaysWhetherItOpensTheHomeAndChangesNothing() async throws {
        var vault = saved(2)
        vault["keyed"] = true
        state.vault = vault
        let (_, recovery) = made()
        await recovery.open(.asked)
        XCTAssertEqual(recovery.face, .savedKey(KeyName(number: 2, madeMs: Self.day17)))
        recovery.checking()
        XCTAssertEqual(recovery.face, .check)
        let name = KeyName(number: 2, madeMs: Self.day17)

        await recovery.check(key)
        XCTAssertEqual(recovery.checked.map(recovery.checkedLine), "Recovery key 2, made on \(name.day), opens Lifestream.")
        XCTAssertNil(recovery.refusal)

        await recovery.check(second)
        XCTAssertEqual(recovery.checked.map(recovery.checkedLine), "This key doesn't open Lifestream. Your saved key is recovery key 2, made on \(name.day).")

        await recovery.check("MZXW")
        XCTAssertNil(recovery.checked)
        XCTAssertEqual(recovery.refusal?.words, "that is not a recovery key: it has 4 letters and digits, not 52")

        await recovery.check(" ")
        XCTAssertEqual(recovery.refusal?.words, "Type the recovery key first.")
        XCTAssertEqual(home.requests.filter { $0["verb"] as? String == "vault-check" }.compactMap { $0["recovery"] as? String }, [key, second, "MZXW"])
        XCTAssertEqual(Set(verbs), ["vault", "vault-check"], "checking a key asked the home to change something")
        XCTAssertNil(machine.data, "checking a key touched the Keychain")

        home.stop()
        await recovery.check(key)
        XCTAssertNil(recovery.checked)
        XCTAssertNotNil(recovery.refusal, "a home that did not answer said nothing")
    }

    func testALockedKeyedHomesLostFaceOffersNoNewVault() async throws {
        state.vault = ["key_id": "3fa2c91b", "keyed": true, "locked": true, "recovery": "confirmed", "slots": [
            ["id": "m-1", "kind": "machine", "unit": "macbook-air-bb17", "store": "keychain-login", "made_ms": 1],
            ["id": "r-1", "kind": "recovery", "made_ms": 1, "confirmed_ms": 2]]]
        let (needs, recovery) = made()
        await recovery.open(.asked)
        XCTAssertEqual(needs.list, [.homeLocked(allow: false)])
        XCTAssertEqual(recovery.face, .lost)
        XCTAssertTrue(recovery.keyed)
        await recovery.startNewVault()
        XCTAssertFalse(verbs.contains("vault-new"), "a keyed home was offered a new vault")
        XCTAssertNil(machine.data)
        try await Shots.draw("recovery-key-lost-keyed", size: CGSize(width: RecoveryKeyView.width, height: 260)) {
            RecoveryKeyView(recovery: recovery, needs: needs, close: {}, learnMore: {}).cockpitPlatform(.mac)
        }
    }

    func testAKeyThisMacHoldsThatOpensTheVaultStartsNoNewOne() async throws {
        let (_, recovery) = made()
        let held = Data(repeating: 9, count: 32)
        machine.data = held
        state.opens = held.base64EncodedString()
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "confirmed"]
        await recovery.open(.lost)
        await recovery.startNewVault()
        XCTAssertNil(recovery.shown)
        XCTAssertNil(recovery.refusal)
        XCTAssertEqual(verbs.filter { $0 != "vault" }, ["vault-new"])
        XCTAssertEqual(machine.data, held)
        XCTAssertEqual(recovery.face, .savedKey(nil), "a vault the held key opened did not show as saved")
    }

    func testANewVaultWhoseAnswerIsLostSaysSo() async throws {
        let (needs, recovery) = made()
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "confirmed"]
        await recovery.open(.asked)
        XCTAssertEqual(recovery.face, .lost)
        state.answer = .lost
        await recovery.startNewVault()
        let first = try XCTUnwrap(machine.data, "a key the home may have wrapped its new vault's slot in was deleted")
        XCTAssertEqual(recovery.refusal, HostRefusal(RecoveryKey.unheard))
        XCTAssertEqual(needs.list, [.unlock])

        state.answer = .actedThenLost
        await recovery.startNewVault()
        XCTAssertEqual(machine.data, first)
        XCTAssertEqual(recovery.refusal, HostRefusal(RecoveryKey.unheard))
        XCTAssertEqual(needs.list, [.saveRecoveryKey(keyed: false)])
    }

    func testANewVaultTheHomeStartedButNamedNoKeyForSaysTheHomeMayHaveActed() async throws {
        let (needs, recovery) = made()
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "confirmed"]
        await recovery.open(.asked)
        state.answer = .unnamed
        await recovery.startNewVault()
        XCTAssertEqual(recovery.refusal, HostRefusal(RecoveryKey.unheard), "a new vault the home started read as one to try again")
        XCTAssertNil(recovery.shown)
        XCTAssertNotNil(machine.data, "a key the home wrapped its new vault's slot in was deleted")
        XCTAssertEqual(needs.list, [.saveRecoveryKey(keyed: false)])
    }

    func testUninstallWaitsOnTheWindowUntilTheKeyIsSaved() async throws {
        state.vault = ["key_id": "3fa2c91b", "locked": false, "recovery": "unconfirmed"]
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        let step = Task { await window.beforeUninstall() }
        try await until("the key shown") { recovery.face == .shown }
        XCTAssertTrue(recovery.leaving, "the window did not say Uninstall waits on it")
        recovery.copy()
        await recovery.confirm()
        let saved = await step.value
        XCTAssertEqual(saved, .saved)
        XCTAssertNil(window.window, "the window stayed open once the key was saved")
        XCTAssertFalse(recovery.leaving)
    }

    func testClosingTheWindowOrCancelUninstallEndsUninstall() async throws {
        state.vault = ["key_id": "3fa2c91b", "locked": false, "recovery": "unconfirmed"]
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        let step = Task { await window.beforeUninstall() }
        try await until("the key shown") { recovery.face == .shown }
        window.window?.close()
        let closed = await step.value
        XCTAssertEqual(closed, .cancelled)
        XCTAssertFalse(recovery.leaving)
        XCTAssertEqual(verbs.filter { $0 == "vault-confirm" }, [])
    }

    func testUninstallAfterAllowGoesOnOnceTheVaultReadsSaved() async throws {
        let held = Data(repeating: 9, count: 32)
        machine.data = held
        state.opens = held.base64EncodedString()
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "unconfirmed"]
        let (needs, recovery) = made()
        let window = RecoveryKeyWindow(needs: needs)
        window.onScreen = false
        let step = Task { await window.beforeUninstall() }
        try await until("the Allow face") { recovery.face == .allow }
        XCTAssertTrue(recovery.leaving)
        await recovery.allow()
        let saved = await step.value
        XCTAssertEqual(saved, .saved)
        XCTAssertNil(window.window)
    }

    func testUninstallOpensNoWindowWhenNoKeyCanBeMadeOrNoneIsOwed() async throws {
        func step(_ keeper: VaultKeeper? = nil) async -> (Uninstall.KeyStep, RecoveryKeyWindow) {
            let (needs, _) = made(keeper)
            let window = RecoveryKeyWindow(needs: needs)
            window.onScreen = false
            return (await window.beforeUninstall(), window)
        }
        state.vault = ["key_id": "3fa2c91b", "locked": true, "recovery": "unconfirmed"]
        let (lost, lostWindow) = await step()
        XCTAssertEqual(lost, .unsaved, "a vault no key of this Mac opens held Uninstall")
        XCTAssertNil(lostWindow.window)

        let alone = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let (noHome, noHomeWindow) = await step(alone)
        XCTAssertEqual(noHome, .unsaved, "a home that does not answer held Uninstall")
        XCTAssertNil(noHomeWindow.window)

        state.vault = saved(1)
        let (elsewhere, elsewhereWindow) = await step()
        XCTAssertEqual(elsewhere, .saved, "a key saved on another door held Uninstall")
        XCTAssertNil(elsewhereWindow.window)

        state.vault = ["key_id": NSNull(), "locked": false, "recovery": "none"]
        let (none, noneWindow) = await step()
        XCTAssertEqual(none, .saved)
        XCTAssertNil(noneWindow.window)
        XCTAssertEqual(Set(verbs), ["vault"], "Uninstall made a key or a vault the home did not owe")
    }

    func testTheWindowsFacesAreDrawn() async throws {
        let (needs, recovery) = made()
        let size = CGSize(width: RecoveryKeyView.width, height: 340)
        func draw(_ name: String, height: CGFloat = 340) async throws {
            try await Shots.draw("recovery-key-\(name)", size: CGSize(width: size.width, height: height)) {
                RecoveryKeyView(recovery: recovery, needs: needs, close: {}, learnMore: {}).cockpitPlatform(.mac)
            }
        }
        await recovery.open(.asked)
        try await draw("shown")
        recovery.leaving = true
        try await draw("uninstall", height: 440)
        recovery.leaving = false
        recovery.copy()
        try await draw("copied")
        await recovery.confirm()
        try await draw("saved")
        recovery.forget()
        await recovery.open(.asked)
        try await draw("saved-key")
        recovery.forget()
        await recovery.open(.lost)
        try await draw("lost")
        recovery.forget()
        home.stop()
        await recovery.open(.asked)
        try await draw("no-home")
    }
}

private final class Reach: @unchecked Sendable {
    private let lock = NSLock()
    private var _on = true
    var on: Bool {
        get { lock.withLock { _on } }
        set { lock.withLock { _on = newValue } }
    }
}

@MainActor private final class Seen {
    var closes: [Bool] = []
    var quit: Bool?
}

private final class HomeState: @unchecked Sendable {
    private let lock = NSLock()
    private var _vault: [String: Any] = ["key_id": NSNull(), "locked": true, "recovery": "none"]
    private var _made = ""
    private var _madeMs: Int64 = 0
    private var _number = 0
    private var _waiting: [String: Any]?
    private var _making: (@Sendable () -> Void)?
    private var _confirming: (@Sendable () -> Void)?
    enum Answer { case said, actedThenLost, lost, unnamed }

    private var _refusal: String?
    private var _answer = Answer.said
    private var _opens: String?
    var answer: Answer {
        get { lock.withLock { _answer } }
        set { lock.withLock { _answer = newValue } }
    }
    var opens: String? {
        get { lock.withLock { _opens } }
        set { lock.withLock { _opens = newValue } }
    }
    var refusal: String? {
        get { lock.withLock { _refusal } }
        set { lock.withLock { _refusal = newValue } }
    }
    var making: (@Sendable () -> Void)? {
        get { lock.withLock { _making } }
        set { lock.withLock { _making = newValue } }
    }
    var confirming: (@Sendable () -> Void)? {
        get { lock.withLock { _confirming } }
        set { lock.withLock { _confirming = newValue } }
    }
    var vault: [String: Any] {
        get { lock.withLock { _vault } }
        set { lock.withLock { _vault = newValue } }
    }
    var made: String {
        get { lock.withLock { _made } }
        set { lock.withLock { _made = newValue } }
    }
    var madeMs: Int64 {
        get { lock.withLock { _madeMs } }
        set { lock.withLock { _madeMs = newValue } }
    }
    var number: Int {
        get { lock.withLock { _number } }
        set { lock.withLock { _number = newValue } }
    }
    var waiting: [String: Any]? {
        get { lock.withLock { _waiting } }
        set { lock.withLock { _waiting = newValue } }
    }
}

import Foundation
import Passwords
import XCTest

final class VaultKeeperTests: XCTestCase {
    private var home: FakeSocketHome!
    private var machine: MemoryKeyStore!
    private var old: MemoryKeyStore!
    private var keeper: VaultKeeper!
    private var trust: KeychainTrust!
    private var suite: String!
    private let slotKey = Data((0..<32).map { UInt8($0) })
    private let oldKey = Data((0..<32).map { UInt8(255 - $0) })
    private let recovery = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"

    override func setUpWithError() throws {
        home = try FakeSocketHome()
        machine = MemoryKeyStore()
        old = MemoryKeyStore()
        suite = "VaultKeeperTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("build-2", forKey: KeychainTrust.name)
        trust = KeychainTrust(build: "build-2", defaults: defaults)
        let socket = home.socket
        keeper = VaultKeeper(machine: machine, old: old, trust: trust, socket: { socket })
    }

    override func tearDown() {
        home.stop()
        UserDefaults().removePersistentDomain(forName: suite)
    }

    private func state(keyID: String? = "3fa2c91b", locked: Bool = false, by: String? = "start",
                       migrate: String? = nil, recovery: String = "confirmed") -> VaultState {
        VaultState(answer: Self.answer(keyID: keyID, locked: locked, by: by, migrate: migrate, recovery: recovery))!
    }

    static func answer(keyID: String? = "3fa2c91b", locked: Bool = false, by: String? = "start",
                       migrate: String? = nil, recovery: String = "confirmed") -> [String: Any] {
        ["key_id": (keyID as Any?) ?? NSNull(), "locked": locked, "recovery": recovery,
         "migrate": (migrate.map { ["key_id": $0] } as Any?) ?? NSNull(),
         "opened": (keyID == nil ? nil : by.map { ["by": $0, "slot": "m-0a1b2c3d", "at_ms": 1] } as Any?) ?? NSNull(),
         "slots": [], "plain": [], "requests": [], "unreadable": "a field this app does not read"]
    }

    private func homeWith(_ vault: [String: Any]) {
        home.answer = { [recovery] request in
            request["verb"] as? String == "vault"
                ? ["result": vault]
                : ["result": ["key_id": "0a1b2c3d", "slot": "m-0a1b2c3d", "recovery": recovery, "recovery_slot": "r-1", "made_ms": 1_794_916_800_000]]
        }
    }

    func testTheHomesStateIsRead() async throws {
        home.answer = { _ in ["result": Self.answer(locked: true, by: nil, recovery: "unconfirmed")] }
        let read = await keeper.read()
        XCTAssertEqual(read, .state(state(locked: true, by: nil, recovery: "unconfirmed")))
        XCTAssertEqual(home.requests.first?["verb"] as? String, "vault")
        home.answer = { _ in ["result": ["held": NSNull()]] }
        guard case .failed = await keeper.read() else { return XCTFail("an answer that is not a vault's was read as one") }
    }

    func testAKeyTheHomeRefusesIsSaidWithoutTheKeyAndTheOldItemStays() async throws {
        machine.data = slotKey
        old.data = oldKey
        home.answer = { _ in ["error": "The Mac app offered a key that is not this vault's: nothing was changed"] }
        guard let words = await refusal(keeper.allow) else { return XCTFail("a refused key was taken as held") }
        XCTAssertEqual(words.reason, "The Mac app offered a key that is not this vault's: nothing was changed")
        XCTAssertEqual(words.words, words.reason, "the home's refusal is not the words shown")
        XCTAssertFalse(words.reason.contains(slotKey.base64EncodedString()))
        XCTAssertEqual(old.prompted, [], "the old item was read outside the act that hands it over")
        XCTAssertEqual(old.deletes, 0)
        XCTAssertEqual(old.data, oldKey)
        machine.refusal = .keychain(errSecInteractionNotAllowed)
        guard let why = await refusal(keeper.allow) else { return XCTFail("a refused Keychain read was taken as a key") }
        XCTAssertTrue(why.reason.contains("Keychain"))
        XCTAssertNil(why.words, "this Mac's Keychain refusing was shown as it is")
        XCTAssertEqual(home.verbs, ["unlock"])
    }

    func testTheOldItemIsDeletedInTheActThatHandedItOverAndNeverReadAgain() async throws {
        old.data = oldKey
        let id = VaultKeyID.of(oldKey)
        home.answer = { request in
            request["verb"] as? String == "vault" ? ["result": Self.answer(keyID: nil, locked: true, by: nil, migrate: id, recovery: "none")]
                : ["error": "the folder cannot be written: nothing was made"]
        }
        do {
            _ = try await keeper.makeRecoveryKey()
            XCTFail("a refused vault-init was taken")
        } catch is VaultRefusal {}
        XCTAssertEqual(old.deletes, 0)
        XCTAssertEqual(old.data, oldKey)
        homeWith(Self.answer(keyID: nil, locked: true, by: nil, migrate: id, recovery: "none"))
        _ = try await keeper.makeRecoveryKey()
        XCTAssertEqual(old.deletes, 1)
        XCTAssertNil(old.data)
        let reads = old.prompted.count
        homeWith(Self.answer(keyID: id, recovery: "confirmed"))
        _ = await keeper.read()
        XCTAssertEqual(old.prompted.count, reads)
    }

    func testAFreshVaultNeverReadsTheOldItem() async throws {
        old.data = oldKey
        homeWith(Self.answer(keyID: nil, locked: true, by: nil, migrate: nil, recovery: "none"))
        _ = try await keeper.makeRecoveryKey()
        XCTAssertEqual(old.prompted, [])
        XCTAssertEqual(old.deletes, 0)
        XCTAssertEqual(old.data, oldKey)
    }

    func testTheMachineKeyIsReadTwiceBeforeThisBuildIsTrusted() async throws {
        let suite = "VaultKeeperTests-trust-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let socket = home.socket
        let untrusted = VaultKeeper(machine: machine, old: old, trust: KeychainTrust(build: "build-3", defaults: defaults), socket: { socket })
        machine.data = slotKey
        home.answer = { _ in ["result": ["key_id": "3fa2c91b", "slot": "m-0a1b2c3d"]] }
        try await untrusted.recover(recovery)
        XCTAssertEqual(machine.prompted, [true, true])
        XCTAssertEqual(defaults.string(forKey: KeychainTrust.name), "build-3")
    }

    func testMigrationHandsTheOldKeyOnlyWhenItsIdIsTheOneTheItemsNameAndAKeychainThatFailsStopsIt() async throws {
        let id = VaultKeyID.of(oldKey)
        old.data = oldKey
        homeWith(Self.answer(keyID: nil, locked: true, by: nil, migrate: id, recovery: "none"))
        let shown = try await keeper.makeRecoveryKey()
        XCTAssertEqual(shown, RecoveryMade(key: recovery, number: 1, madeMs: 1_794_916_800_000))
        let made = try XCTUnwrap(machine.data)
        XCTAssertEqual(made.count, 32)
        XCTAssertNotEqual(made, oldKey)
        XCTAssertEqual(home.requests.last?["key"] as? String, oldKey.base64EncodedString())
        XCTAssertEqual(home.requests.last?["slot_key"] as? String, made.base64EncodedString())
        XCTAssertEqual(home.requests.last?["store"] as? String, "keychain-login")
        XCTAssertEqual(old.deletes, 1)
        old.data = oldKey
        homeWith(Self.answer(keyID: nil, locked: true, by: nil, migrate: "00000000", recovery: "none"))
        _ = try await keeper.makeRecoveryKey()
        XCTAssertEqual(home.verbs.last, "vault-init")
        XCTAssertNil(home.requests.last?["key"])
        homeWith(Self.answer(keyID: nil, locked: true, by: nil, migrate: nil, recovery: "none"))
        _ = try await keeper.makeRecoveryKey()
        XCTAssertNil(home.requests.last?["key"])
        old.data = nil
        homeWith(Self.answer(keyID: nil, locked: true, by: nil, migrate: id, recovery: "none"))
        _ = try await keeper.makeRecoveryKey()
        XCTAssertEqual(home.verbs.last, "vault-init")
        XCTAssertNil(home.requests.last?["key"])
        old.data = oldKey
        old.refusal = .keychain(-25308)
        let inits = home.verbs.filter { $0 == "vault-init" }.count
        homeWith(Self.answer(keyID: nil, locked: true, by: nil, migrate: id, recovery: "none"))
        do {
            _ = try await keeper.makeRecoveryKey()
            XCTFail("a vault was made while the Keychain did not answer for the old key")
        } catch let refusal as VaultRefusal {
            XCTAssertFalse(refusal.reason.contains(oldKey.base64EncodedString()))
            XCTAssertNil(refusal.words, "this Mac's Keychain failing was shown as it is")
        }
        XCTAssertEqual(home.verbs.filter { $0 == "vault-init" }.count, inits)
    }

    func testAVaultThatExistsGetsANewRecoveryKeyAndNeverASecondVault() async throws {
        homeWith(Self.answer(recovery: "unconfirmed"))
        let made = try await keeper.makeRecoveryKey()
        XCTAssertEqual(made, RecoveryMade(key: recovery, number: 1, madeMs: 1_794_916_800_000), "the key made is not named by its slot and day")
        XCTAssertEqual(home.verbs, ["vault", "vault-recovery"])
        XCTAssertNil(machine.data, "a machine slot was made for a vault that has one")
        for unnamed: [String: Any] in [["recovery": recovery, "made_ms": 1], ["recovery": recovery, "recovery_slot": "m-1", "made_ms": 1],
                                       ["recovery": recovery, "recovery_slot": "r-1"]] {
            home.answer = { request in request["verb"] as? String == "vault" ? ["result": Self.answer(recovery: "unconfirmed")] : ["result": unnamed] }
            let refused = await refusal { _ = try await keeper.makeRecoveryKey() }
            XCTAssertEqual(refused?.reason, "the home answered no recovery key", "a key with no slot or day was taken: \(unnamed)")
            XCTAssertEqual(refused?.homeMayHaveActed, true, "an answer the home sent after acting read as one it never acted on")
        }
        home.answer = { request in
            request["verb"] as? String == "vault" ? ["result": Self.answer(locked: true, by: nil)] : ["error": "the vault is locked: unlock it first"]
        }
        do {
            _ = try await keeper.makeRecoveryKey()
            XCTFail("a new key was taken from a locked vault")
        } catch let refusal as VaultRefusal {
            XCTAssertEqual(refusal.reason, "the vault is locked: unlock it first")
            XCTAssertEqual(refusal.words, "the vault is locked: unlock it first", "the home's refusal is not the words shown")
        }
    }

    func testAReadWaitingOnMacOSsDialogHoldsUpNoOtherAct() async throws {
        home.answer = { request in ["result": ["sealed": request["secret"] ?? NSNull(), "key": "0a1b2c3d"]] }
        machine.data = slotKey
        machine.hold = DispatchSemaphore(value: 0)
        let keeper = keeper!
        let allow = Task { try? await keeper.allow() }
        while machine.prompted.isEmpty { await Task.yield() }
        try await keeper.save(secret: "x.password", value: "fake-password-1")
        let read = await keeper.read()
        XCTAssertNotEqual(read, .noHome)
        XCTAssertEqual(home.verbs.first, "seal", "an act waited behind the dialog")
        machine.hold?.signal()
        machine.hold?.signal()
        _ = await allow.value
    }

    func testRecoverySendsTheKeyAsTypedWithThisMacsSlotAndATypoIsTheHomesToRefuse() async throws {
        home.answer = { _ in ["result": ["key_id": "3fa2c91b", "slot": "m-0a1b2c3d"]] }
        let typed = recovery.lowercased().replacingOccurrences(of: " ", with: "-")
        try await keeper.recover(typed)
        let made = try XCTUnwrap(machine.data)
        XCTAssertEqual(home.verbs, ["recover"])
        XCTAssertEqual(home.requests[0]["recovery"] as? String, typed)
        XCTAssertEqual(home.requests[0]["slot_key"] as? String, made.base64EncodedString())
        XCTAssertEqual(home.requests[0]["store"] as? String, "keychain-login")
        try await keeper.recover(recovery)
        XCTAssertEqual(machine.data, made)
        XCTAssertEqual(home.requests[1]["slot_key"] as? String, made.base64EncodedString())
        let words = "that is not a recovery key: 52 letters and digits, in groups of four"
        home.answer = { _ in ["error": words] }
        do {
            try await keeper.recover("ABCD EFGH")
            XCTFail("a refused recovery key was taken")
        } catch let refusal as VaultRefusal {
            XCTAssertEqual(refusal.reason, words)
            XCTAssertFalse(refusal.reason.contains(made.base64EncodedString()))
        }
        XCTAssertEqual(machine.data, made)
        XCTAssertEqual(machine.deletes, 0)
        machine.data = nil
        home.answer = { _ in [:] }
        let unheard = await refusal { try await keeper.recover(recovery) }
        XCTAssertEqual(unheard?.socket, .broken)
        XCTAssertNotNil(machine.data, "a key the home may have wrapped a slot in was deleted")
        XCTAssertEqual(machine.deletes, 0)
        machine.data = nil
        home.answer = { _ in ["error": words] }
        for stopped in [false, true] {
            if stopped { home.stop() }
            do {
                try await keeper.recover(recovery)
                XCTFail("a recovery the home did not take was taken")
            } catch is VaultRefusal {}
            XCTAssertNil(machine.data, "a recovery the home did not take left a key no slot opens")
        }
        XCTAssertEqual(machine.deletes, 2)
    }

    func testANewVaultIsMadeWithAFreshSlotAndItsKeyIsDeletedOnlyWhenTheHomeCertainlyDidNotAct() async throws {
        let paired = VaultKeeper(machine: machine, old: old, trust: trust, socket: { [home] in home!.socket }, unit: { "macbook-pro-0001" })
        home.answer = { [recovery] _ in ["result": ["key_id": "0a1b2c3d", "slot": "m-0a1b2c3d", "recovery": recovery, "recovery_slot": "r-1", "made_ms": 1_794_916_800_000]] }
        let shown = try await paired.startNewVault()
        XCTAssertEqual(shown, .made(RecoveryMade(key: recovery, number: 1, madeMs: 1_794_916_800_000)))
        let made = try XCTUnwrap(machine.data)
        XCTAssertEqual(made.count, 32)
        XCTAssertEqual(home.verbs, ["vault-new"])
        XCTAssertEqual(home.requests[0]["slot_key"] as? String, made.base64EncodedString())
        XCTAssertEqual(home.requests[0]["store"] as? String, "keychain-login")
        XCTAssertEqual(home.requests[0]["unit"] as? String, "macbook-pro-0001")
        XCTAssertEqual(old.prompted, [], "a new vault read today's old key")

        machine.data = nil
        let words = "your vault is open: nothing was deleted"
        home.answer = { _ in ["error": words] }
        let refused = await refusal { _ = try await paired.startNewVault() }
        XCTAssertEqual(refused?.words, words, "the home's refusal was not said in its words")
        XCTAssertFalse(refused?.reason.contains(made.base64EncodedString()) ?? true)
        XCTAssertNil(machine.data, "a new vault the home refused left a key no slot opens")
        XCTAssertEqual(machine.deletes, 1)

        home.answer = { _ in [:] }
        let unheard = await refusal { _ = try await paired.startNewVault() }
        XCTAssertEqual(unheard?.socket, .broken)
        XCTAssertEqual(unheard?.homeMayHaveActed, true)
        let kept = try XCTUnwrap(machine.data, "a key the home may have wrapped its new vault's slot in was deleted")
        XCTAssertEqual(home.requests.last?["slot_key"] as? String, kept.base64EncodedString())
        XCTAssertEqual(machine.deletes, 1)

        machine.data = nil
        home.stop()
        let silent = await refusal { _ = try await paired.startNewVault() }
        XCTAssertEqual(silent?.socket, .noHome)
        XCTAssertEqual(silent?.homeMayHaveActed, false)
        XCTAssertNil(machine.data, "a new vault the home never heard left a key no slot opens")
    }

    func testAKeyThisMacHoldsGoesInTheOneAskAndTheHomeDecidesWhetherItOpensTheOldVault() async throws {
        machine.data = slotKey
        home.answer = { _ in ["result": ["opened": "3fa2c91b"]] }
        let opened = try await keeper.startNewVault()
        XCTAssertEqual(opened, .opened, "a key that opens the vault started a new one")
        XCTAssertEqual(home.verbs, ["vault-new"])
        XCTAssertEqual(home.requests[0]["slot_key"] as? String, slotKey.base64EncodedString())
        XCTAssertEqual(machine.data, slotKey)
        XCTAssertEqual(machine.deletes, 0)

        for vaultNew: [String: Any] in [["error": "your vault is open: nothing was deleted"], [:]] {
            home.answer = { _ in vaultNew }
            let refused = await refusal { _ = try await keeper.startNewVault() }
            XCTAssertNotNil(refused)
            XCTAssertEqual(machine.data, slotKey, "a key held before the new vault was deleted: it may open another home")
        }

        home.answer = { [recovery] _ in ["result": ["key_id": "0a1b2c3d", "slot": "m-0a1b2c3d", "recovery": recovery, "recovery_slot": "r-2", "made_ms": 1_794_916_800_000]] }
        let made = try await keeper.startNewVault()
        XCTAssertEqual(made, .made(RecoveryMade(key: recovery, number: 2, madeMs: 1_794_916_800_000)))
        XCTAssertEqual(home.verbs, ["vault-new", "vault-new", "vault-new", "vault-new"], "the Mac asked the home more than once to decide one new vault")
        XCTAssertEqual(home.requests.last?["slot_key"] as? String, slotKey.base64EncodedString(), "the key held was not the new vault's slot")
        XCTAssertEqual(machine.data, slotKey)
        XCTAssertEqual(machine.deletes, 0)

        home.answer = { _ in ["error": "Your home is starting.", "refusal": ["status": 503, "code": "NOT_NOW", "words": "Your home is starting.", "extra": ["wait": "starting"]]] }
        let waiting = await refusal { _ = try await keeper.startNewVault() }
        XCTAssertEqual(waiting?.socket?.reach, true)
        XCTAssertEqual(machine.data, slotKey)
    }

    func testOnlyTheHomesWrongKeyCodeSaysTheKeyOpensNothing() async throws {
        machine.data = slotKey
        home.answer = { _ in SocketMachine.wrongKey }
        let wrong = await refusal { try await keeper.allow() }
        XCTAssertEqual(wrong?.wrongKey, true)
        XCTAssertEqual(wrong?.words, "the Mac app offered a key that is not this vault's: nothing was changed")
        home.answer = { _ in ["error": "config/vault.json does not read as JSON"] }
        let unread = await refusal { try await keeper.allow() }
        XCTAssertEqual(unread?.wrongKey, false, "a vault that did not read for a moment was taken for a key that opens nothing")
    }

    func testTheVaultsMachineSlotsOnOtherMacsAreNamed() throws {
        var answer = Self.answer(locked: true)
        answer["slots"] = [["id": "m-1", "kind": "machine", "unit": "macbook-air-bb17", "store": "keychain-login", "made_ms": 1],
                           ["id": "m-2", "kind": "machine", "unit": "macbook-pro-0001", "store": "keychain-login", "made_ms": 1],
                           ["id": "m-3", "kind": "machine", "store": "keychain-login", "made_ms": 1],
                           ["id": "m-4", "kind": "machine", "unit": "macbook-air-bb17", "store": "keychain-data-protection", "made_ms": 1],
                           ["id": "r-1", "kind": "recovery", "made_ms": 1, "confirmed_ms": 2]]
        let state = try XCTUnwrap(VaultState(answer: answer))
        XCTAssertEqual(state.slots.count, 5)
        XCTAssertEqual(state.slots.map(\.id), ["m-1", "m-2", "m-3", "m-4", "r-1"])
        XCTAssertEqual(state.slots.map(\.recovery), [nil, nil, nil, nil, 1])
        XCTAssertEqual(state.slots.last?.madeMs, 1)
        XCTAssertEqual(state.slots.last?.confirmedMs, 2)
        XCTAssertEqual(state.slots.first?.confirmedMs, nil)
        XCTAssertEqual(state.saved?.id, "r-1")

        var two = answer
        two["slots"] = [["id": "r-2", "kind": "recovery", "made_ms": 10, "confirmed_ms": 11],
                        ["id": "r-3", "kind": "recovery", "made_ms": 20],
                        ["id": "m-1", "kind": "machine", "unit": "macbook-air-bb17", "made_ms": 1]]
        let both = try XCTUnwrap(VaultState(answer: two))
        XCTAssertEqual(both.recoveries.map(\.id), ["r-3", "r-2"], "the recovery slots are not newest first")
        XCTAssertEqual(both.saved?.id, "r-2", "the saved key is not the newest confirmed")
        XCTAssertEqual(state.machines(besides: "macbook-pro-0001"), ["macbook-air-bb17"])
        XCTAssertEqual(state.machines(besides: nil), ["macbook-air-bb17", "macbook-pro-0001"])
        let paired = VaultKeeper(machine: machine, old: old, trust: trust, socket: { nil }, unit: { "macbook-pro-0001" })
        XCTAssertEqual(paired.elsewhere(state), ["macbook-air-bb17"])
        XCTAssertEqual(self.state().slots, [])
    }

    func testTheSlotNamesThisMacsUnitOncePairedAndNoneBefore() async throws {
        let paired = VaultKeeper(machine: machine, old: old, trust: trust, socket: { [home] in home!.socket }, unit: { "macbook-pro-0001" })
        homeWith(Self.answer(keyID: nil, by: nil, recovery: "none"))
        _ = try await paired.makeRecoveryKey()
        XCTAssertEqual(home.requests.last?["verb"] as? String, "vault-init")
        XCTAssertEqual(home.requests.last?["unit"] as? String, "macbook-pro-0001")
        home.answer = { _ in ["result": ["key_id": "3fa2c91b", "slot": "m-0a1b2c3d"]] }
        try await paired.recover(recovery)
        XCTAssertEqual(home.requests.last?["unit"] as? String, "macbook-pro-0001")
        try await keeper.recover(recovery)
        XCTAssertNil(home.requests.last?["unit"])
    }

    func testConfirmSendsTheKeyAsTypedAndARefusalIsSaidWithoutIt() async throws {
        home.answer = { _ in ["result": ["confirmed": "r-1"]] }
        try await keeper.confirm(recovery.lowercased())
        XCTAssertEqual(home.verbs, ["vault-confirm"])
        XCTAssertEqual(home.requests[0]["recovery"] as? String, recovery.lowercased())
        home.answer = { _ in ["error": "that recovery key does not open this vault: nothing was changed"] }
        do {
            try await keeper.confirm(recovery)
            XCTFail("a refused confirmation was taken")
        } catch let refusal as VaultRefusal {
            XCTAssertFalse(refusal.reason.contains(recovery))
        }
        homeWith(Self.answer())
        let made = try await keeper.makeRecoveryKey()
        XCTAssertEqual(made.key, recovery)
        XCTAssertEqual(home.verbs.last, "vault-recovery")
    }

    func testATypedValueIsSentToBeSealedAndARefusalIsSaid() async throws {
        home.answer = { request in ["result": ["sealed": request["secret"] ?? NSNull(), "key": "0a1b2c3d"]] }
        try await keeper.save(secret: "x.password", value: "fake-password-1")
        XCTAssertEqual(home.requests.last?["verb"] as? String, "seal")
        XCTAssertEqual(home.requests.last?["secret"] as? String, "x.password")
        XCTAssertEqual(home.requests.last?["value"] as? String, "fake-password-1")
        let refusal = "passwords are locked on this machine: x.password was not sealed"
        home.answer = { _ in ["error": refusal] }
        do {
            try await keeper.save(secret: "x.password", value: "fake-password-2")
            XCTFail("a refused value was taken as kept")
        } catch let error as VaultRefusal {
            XCTAssertEqual(error.reason, refusal)
            XCTAssertFalse(error.reason.contains("fake-password-2"))
        }
    }

    func testNoHomeIsNoHomeAndTellsFailed() async throws {
        let failures = Failures()
        let socket = home.socket(failed: { failures.add() })
        keeper = VaultKeeper(machine: machine, old: old, trust: trust, socket: { socket })
        home.stop()
        machine.data = slotKey
        let read = await keeper.read()
        XCTAssertEqual(read, .noHome)
        XCTAssertEqual(failures.count, 1)
        let unlock = await refusal(keeper.allow)
        XCTAssertNil(unlock?.words, "a home that did not answer was said in words of its own")
        XCTAssertEqual(unlock?.socket, .noHome)
        XCTAssertEqual(failures.count, 2)
        let unpointed: VaultRead = await VaultKeeper(machine: machine, old: old, trust: trust, socket: { nil }).read()
        XCTAssertEqual(unpointed, .noHome)
    }

    func testThisMacFindsTheSocketByTheHomesIDInTheMachinesRun() throws {
        let machine = FileManager.default.temporaryDirectory.appendingPathComponent("machine-\(UUID().uuidString)", isDirectory: true)
        let folder = machine.appendingPathComponent("Lifestream", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: machine) }
        let pointer = machine.appendingPathComponent("home")
        XCTAssertNil(HomeSocket.thisMac(pointer: pointer), "no pointer")
        XCTAssertNil(HomeSocket.folder(pointer: pointer), "no pointer")
        try "Lifestream\n".write(to: pointer, atomically: true, encoding: .utf8)
        XCTAssertNil(HomeSocket.thisMac(pointer: pointer), "a pointer that names no absolute folder")
        XCTAssertNil(HomeSocket.folder(pointer: pointer), "a pointer that names no absolute folder")
        try (folder.path + "\n").write(to: pointer, atomically: true, encoding: .utf8)
        XCTAssertNil(HomeSocket.thisMac(pointer: pointer), "a folder with no HOME.json")
        XCTAssertEqual(HomeSocket.folder(pointer: pointer), folder, "the pointer's folder needs no HOME.json")
        try Data("not json".utf8).write(to: folder.appendingPathComponent("HOME.json"))
        XCTAssertNil(HomeSocket.thisMac(pointer: pointer), "a HOME.json that does not read")
        try Data(#"{"version":1}"#.utf8).write(to: folder.appendingPathComponent("HOME.json"))
        XCTAssertNil(HomeSocket.thisMac(pointer: pointer), "a HOME.json with no id")
        try Data(#"{"id":"home-0001","version":1}"#.utf8).write(to: folder.appendingPathComponent("HOME.json"))
        let socket = try XCTUnwrap(HomeSocket.thisMac(pointer: pointer))
        XCTAssertEqual(socket.path, machine.appendingPathComponent("run/195695e8.sock").path)
        XCTAssertEqual(socket.folder, folder)
        XCTAssertEqual(socket, HomeSocket(path: machine.appendingPathComponent("run/195695e8.sock").path, folder: folder))
        XCTAssertFalse(socket.path.hasPrefix(folder.path), "the socket is in the folder")
    }

    func testARefusalIsReadWholeAndOnlyANotNowIsReachs() async throws {
        let failures = Failures()
        let socket = home.socket(failed: { failures.add() })
        let ask = { (answer: [String: Any]) async -> HomeSocketError? in
            self.home.answer = { _ in answer }
            return await Task.detached {
                do {
                    _ = try socket.ask(["verb": "vault"])
                    return nil
                } catch {
                    return error as? HomeSocketError
                }
            }.value
        }
        func refusal(_ status: Int, _ code: String, _ words: String, retryAfter: Int? = nil, extra: [String: Any] = [:]) -> [String: Any] {
            var refusal: [String: Any] = ["status": status, "code": code, "words": words, "extra": extra]
            if let retryAfter { refusal["retryAfter"] = retryAfter }
            return ["error": words, "refusal": refusal]
        }
        let none = Data("{}".utf8)

        let starting = "Your home is starting: it answers in a moment."
        let started = Data(#"{"wait":"starting"}"#.utf8)
        let notNow = await ask(refusal(503, "NOT_NOW", starting, extra: ["wait": "starting"]))
        XCTAssertEqual(notNow, .refused(SocketRefusal(status: 503, code: "NOT_NOW", words: starting, extra: started)))
        XCTAssertEqual(notNow?.reach, true)
        XCTAssertEqual(failures.count, 1, "the home's own not-now told no probe")
        let own = await ask(refusal(503, "NOT_NOW", "Your people are being prepared.", extra: ["wait": "busy"]))
        XCTAssertEqual(own?.reach, false)
        XCTAssertEqual(failures.count, 1, "a request's own wait told a probe")

        let busy = await ask(refusal(503, "INDEX_BUSY", "Your home is building its index.", retryAfter: 5))
        XCTAssertEqual(busy, .refused(SocketRefusal(status: 503, code: "INDEX_BUSY", words: "Your home is building its index.",
                                                    retryAfter: 5, extra: none)))
        let unknown = await ask(refusal(503, "OUTCOME_UNKNOWN", "Lifestream did not answer in time: it may have done it."))
        XCTAssertEqual(unknown, .refused(SocketRefusal(status: 503, code: "OUTCOME_UNKNOWN",
                                                       words: "Lifestream did not answer in time: it may have done it.", extra: none)))
        let failed = await ask(refusal(500, "HOME_FAILED", "it failed", extra: ["step": "seal", "at": 2]))
        XCTAssertEqual(failed, .refused(SocketRefusal(status: 500, code: "HOME_FAILED", words: "it failed",
                                                      extra: Data(#"{"at":2,"step":"seal"}"#.utf8))))
        let plain = await ask(["error": "faces: something failed"])
        XCTAssertEqual(plain, .refused("faces: something failed"))
        let answered = await ask(["result": Self.answer()])
        XCTAssertNil(answered)
        for refused in [busy, unknown, failed, plain] { XCTAssertEqual(refused?.reach, false) }
        XCTAssertEqual(failures.count, 1, "a refusal of the request, or an answer, told a probe")

        let keeper = VaultKeeper(machine: machine, old: old, trust: trust, socket: { socket })
        home.answer = { _ in refusal(503, "NOT_NOW", starting, extra: ["wait": "starting"]) }
        let held = await self.refusal { try await keeper.save(secret: "x.password", value: "fake-password-1") }
        XCTAssertNil(held?.words)
        XCTAssertEqual(held?.socket?.reach, true)
        home.answer = { _ in refusal(503, "INDEX_BUSY", "Your home is building its index.", retryAfter: 5) }
        let waits = await self.refusal { try await keeper.save(secret: "x.password", value: "fake-password-1") }
        XCTAssertEqual(waits?.words, "Your home is building its index.")
    }

    private func refusal(_ step: () async throws -> Void) async -> VaultRefusal? {
        do {
            try await step()
            return nil
        } catch {
            return error as? VaultRefusal
        }
    }
}

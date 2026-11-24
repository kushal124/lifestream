import Foundation
import Passwords
import Security
import XCTest

final class MemoryKeychain: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: MemoryKeyStore] = [:]

    func item(_ account: String) -> MemoryKeyStore {
        lock.withLock {
            if let held = items[account] { return held }
            let made = MemoryKeyStore()
            items[account] = made
            return made
        }
    }

    var accounts: [String] { lock.withLock { items.filter { $0.value.data != nil }.map(\.key).sorted() } }
}

final class HomeKeysTests: XCTestCase {
    private let home = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"
    private let other = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
    private let recovery = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"
    private var machine: URL!
    private var suite = ""
    private var defaults: UserDefaults!
    private var keychain: MemoryKeychain!
    private var keys: HomeKeys!

    override func setUpWithError() throws {
        machine = FileManager.default.temporaryDirectory.appendingPathComponent("home-keys-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: machine, withIntermediateDirectories: true)
        suite = "HomeKeysTests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        keychain = MemoryKeychain()
        let keychain = keychain!
        keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, item: { keychain.item($0) })
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: machine)
    }

    private func write(_ text: String, _ path: String, in root: URL? = nil) throws {
        let url = (root ?? machine).appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    private func pointAt(_ folder: URL) throws {
        try write(folder.path + "\n", "home")
    }

    func testThePlainItemIsTodaysAndItsTrustTodaysRecord() throws {
        XCTAssertEqual(keys.plain.name, "org.lifestreamprotocol.vault / machine")
        XCTAssertEqual(KeychainItem.vaultMachine.name, keys.plain.name)
        XCTAssertFalse(keys.plain.keyed)
        keychain.item("machine").data = Data(repeating: 7, count: 32)
        XCTAssertNotNil(try keys.plain.read())
        XCTAssertEqual(defaults.string(forKey: KeychainTrust.name), "build-7", "a plain home's trust moved from today's record")
        XCTAssertEqual(defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(KeychainTrust.name) }, [KeychainTrust.name])
    }

    func testTheLaunchersItemIsThisHomesOnlyWhenTheHomeIsKeyed() throws {
        XCTAssertEqual(keys.thisHome().name, keys.plain.name, "no home id")
        try write("\(home)\n", "home-id")
        XCTAssertEqual(keys.thisHome().name, keys.plain.name, "a plain home's passwords are read from today's item")
        try write("{}", "vaults/\(home).json")
        XCTAssertEqual(keys.thisHome().name, "org.lifestreamprotocol.vault / machine:\(home)")
        XCTAssertTrue(keys.thisHome().keyed)

        try FileManager.default.removeItem(at: machine.appendingPathComponent("vaults"))
        let folder = machine.appendingPathComponent("Lifestream", isDirectory: true)
        try pointAt(folder)
        try write(#"{"version":1,"key_id":"3fa2c91b","slots":[]}"#, "config/vault.json", in: folder)
        XCTAssertFalse(keys.thisHome().keyed, "a vault of passwords alone made the home keyed")
        try write(#"{"version":2,"counter":1,"key_id":"3fa2c91b","slots":[],"keys":[]}"#, "config/vault.json", in: folder)
        XCTAssertTrue(keys.thisHome().keyed, "a kept keyed folder set up again, its copy gone with the machine directory")

        try FileManager.default.removeItem(at: folder)
        XCTAssertFalse(keys.thisHome().keyed)
        keychain.item("machine:\(home)").data = Data(repeating: 3, count: 32)
        XCTAssertTrue(keys.thisHome().keyed, "the folder away and no copy, but this Mac holds the home's own key")
    }

    func testTrustingOneHomesKeyTrustsNoOther() throws {
        keychain.item("machine:\(home)").data = Data(repeating: 1, count: 32)
        keychain.item("machine:\(other)").data = Data(repeating: 2, count: 32)
        keychain.item("machine").data = Data(repeating: 3, count: 32)
        XCTAssertNotNil(try keys.keyed(home).read())
        XCTAssertTrue(keys.keyed(home).trusted)
        XCTAssertFalse(keys.keyed(other).trusted)
        XCTAssertFalse(keys.plain.trusted)
        XCTAssertNil(defaults.string(forKey: KeychainTrust.name))
        guard case .refused = keys.keyed(other).launchRead(within: 5) else { return XCTFail("a home whose key was never read here was handed it") }
        XCTAssertEqual(keychain.item("machine:\(other)").prompted, [], "the launcher read an item this build is not trusted with")
        XCTAssertEqual(keys.keyed(home).launchRead(within: 5), .key(Data(repeating: 1, count: 32)))
        keychain.item("machine:\(other)").refusal = .keychain(errSecAuthFailed)
        _ = try? keys.keyed(other).read()
        XCTAssertTrue(keys.keyed(home).trusted, "a refused read of another home's item cleared this home's trust")
    }

    func testWhetherThisMacKeptItsSlotReadsOnlyTheItemsKeyIDAndNeverChangesTheTrust() throws {
        let key = keys.keyed(home)
        let made = try key.make()
        let store = keychain.item("machine:\(home)")
        let vault = try XCTUnwrap(VaultState(answer: ["keyed": true, "locked": false, "recovery": "confirmed",
                                                       "slots": [["id": "m-\(VaultKeyID.of(made))", "kind": "machine"]]]))
        XCTAssertEqual(store.mark, VaultKeyID.of(made), "a new item was made without its key's id")
        let reads = store.prompted.count
        XCTAssertEqual(key.kept(in: vault), .kept)
        store.refusal = .keychain(errSecAuthFailed)
        XCTAssertEqual(key.kept(in: vault), .kept, "a Keychain that refuses the key's value decided whether the slot is kept")
        store.attributesRefusal = .keychain(errSecInteractionNotAllowed)
        XCTAssertEqual(key.kept(in: vault), .unread, "a locked Keychain was said as a slot not kept")
        XCTAssertEqual(store.prompted.count, reads, "the check read the key's value")
        XCTAssertTrue(key.trusted, "the check cleared this build's trust")
        store.refusal = nil
        store.attributesRefusal = nil

        store.mark = "00000000"
        XCTAssertEqual(key.kept(in: vault), .notKept, "an item naming another key was said as kept")
        XCTAssertEqual(try key.renew(), made)
        XCTAssertEqual(store.mark, VaultKeyID.of(made), "keeping the key left the item naming another")
        XCTAssertEqual(key.kept(in: vault), .kept)

        store.mark = nil
        XCTAssertEqual(key.kept(in: vault), .notKept, "an item with no key id was said as kept")
        XCTAssertEqual(try key.read(), made)
        XCTAssertNil(store.mark, "a read wrote the item")
        XCTAssertEqual(try key.renew(), made)
        XCTAssertEqual(key.kept(in: vault), .kept, "keeping the key left the item with no key id")

        try key.delete()
        XCTAssertEqual(key.kept(in: vault), .notKept)
        XCTAssertTrue(key.trusted)
    }

    func testANewHomesKeyIsMadeThenReadBackTwiceBeforeItIsTrusted() throws {
        let key = try keys.keyed(home).make()
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(keychain.item("machine:\(home)").data, key)
        XCTAssertEqual(keychain.item("machine:\(home)").prompted, [true, true])
        XCTAssertTrue(keys.keyed(home).trusted)
        XCTAssertEqual(keychain.accounts, ["machine:\(home)"], "a new home's key was put in another item")

        keychain.item("machine:\(other)").refusal = .keychain(errSecAuthFailed)
        XCTAssertThrowsError(try keys.keyed(other).make())
        XCTAssertFalse(keys.keyed(other).trusted)
        XCTAssertThrowsError(try keys.keyed(home).make(), "a second item for one home")
    }

    func testTheMacFilesKeyIsItsOwnItemMadeReadBackTwiceAndTrustedUnderItsOwnRecord() throws {
        let files = MemoryKeyStore()
        let keychain = keychain!
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, item: { keychain.item($0) }, files: files)
        XCTAssertEqual(keys.macFiles.name, "org.lifestreamprotocol.mac / files")
        XCTAssertEqual(KeychainItem.macFiles.name, keys.macFiles.name)
        XCTAssertFalse(keys.macFiles.keyed, "the Mac's files key was taken for a keyed home's")

        let key = try keys.macFiles.make()
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(files.data, key)
        XCTAssertEqual(files.mark, VaultKeyID.of(key))
        XCTAssertEqual(files.prompted, [true, true], "the new item was not read back twice")
        XCTAssertTrue(keys.macFiles.trusted)
        XCTAssertEqual(defaults.string(forKey: "vault.machineKeyReadBy.mac-files"), "build-7")
        XCTAssertEqual(keychain.accounts, [], "the Mac's files key went into the vault's items")
        XCTAssertFalse(keys.plain.trusted, "trusting the Mac's files key trusted the home's item")
        XCTAssertEqual(keys.macFiles.found(within: 5), .key(key))
    }

    func testTheMacFilesKeyIsGoneOnlyOnACleanNotFoundSeenTwiceAndRefusedOnAnyOtherAnswer() throws {
        let files = MemoryKeyStore()
        let keychain = keychain!
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, item: { keychain.item($0) }, files: files)
        guard case .refused = keys.macFiles.found(within: 5) else { return XCTFail("a build never trusted with the item was told it is gone") }
        XCTAssertEqual(files.prompted, [], "an untrusted build read the item at launch")

        _ = try keys.macFiles.make()
        files.data = nil
        let reads = files.prompted.count
        XCTAssertEqual(keys.macFiles.found(within: 5), .gone)
        XCTAssertEqual(files.prompted.dropFirst(reads), [false, false], "gone was decided on fewer than two clean reads, or one that could prompt")
        XCTAssertTrue(keys.macFiles.trusted, "no item cleared this build's trust")

        files.data = Data(repeating: 4, count: 32)
        files.refusal = .keychain(errSecInteractionNotAllowed)
        guard case .refused = keys.macFiles.found(within: 5) else { return XCTFail("a Keychain that would ask was said as gone") }
        XCTAssertTrue(keys.macFiles.trusted, "a read where macOS could not ask the person cleared the trust")

        files.refusal = .keychain(errSecAuthFailed)
        let helper = keys.reading(as: .helper)
        guard case .refused = helper.macFiles.found(within: 5) else { return XCTFail("a helper's refused read was said as gone") }
        XCTAssertThrowsError(try helper.macFiles.read())
        XCTAssertTrue(keys.macFiles.trusted, "a helper's refused read cleared the app's trust")
        guard case .refused = keys.macFiles.found(within: 5) else { return XCTFail("the app's refused read was said as gone") }
        XCTAssertFalse(keys.macFiles.trusted, "the app's refused read left this build trusted")

        files.refusal = nil
        _ = try keys.macFiles.read()
        files.refusal = .notAKey
        guard case .refused = keys.macFiles.found(within: 5) else { return XCTFail("an item that holds no key was said as gone") }
        files.refusal = .keychain(errSecAuthFailed)
        guard case .refused = keys.macFiles.found(within: 5) else { return XCTFail("a Keychain refusal was said as gone") }
    }

    func testAQuitDraftsKeyGoesAtTheNextNewHomeOnlyWhenNoVaultNamesIt() throws {
        let folder = machine.appendingPathComponent("Lifestream", isDirectory: true)
        let first = try keys.newHome(in: folder)
        XCTAssertEqual(first.home, first.home.lowercased())
        XCTAssertEqual(keychain.item("machine:\(first.home)").data, first.key)
        let second = try keys.newHome(in: folder)
        XCTAssertNil(keychain.item("machine:\(first.home)").data, "a draft no vault names kept its key")
        XCTAssertNotEqual(second.home, first.home)

        try write(#"{"version":2,"counter":1,"key_id":"3fa2c91b","slots":[{"id":"m-0a1b2c3d","kind":"machine","account":"machine:\#(second.home)"}],"keys":[]}"#,
                  "config/vault.json", in: folder)
        let third = try keys.newHome(in: folder)
        XCTAssertEqual(keychain.item("machine:\(second.home)").data, second.key, "the key of a vault the folder holds was deleted")

        try write("{}", "vaults/\(third.home).json")
        let fourth = try keys.newHome(in: folder)
        XCTAssertEqual(keychain.item("machine:\(third.home)").data, third.key, "the key of a vault this Mac keeps a copy of was deleted")
        keys.adopted(fourth.home, in: folder)
        _ = try keys.newHome(in: folder)
        XCTAssertEqual(keychain.item("machine:\(fourth.home)").data, fourth.key, "an adopted home's key was taken for a draft")
        XCTAssertEqual(keychain.accounts.count, 4)
    }

    func testAHalfMadeVaultsKeyGoesOnceTheVaultThatReplacedItIsWritten() throws {
        let folder = machine.appendingPathComponent("Lifestream", isDirectory: true)
        let vault = { (home: String) in
            #"{"version":2,"counter":1,"key_id":"3fa2c91b","slots":[{"id":"m-0a1b2c3d","kind":"machine","account":"machine:\#(home)"}],"keys":[]}"#
        }
        let half = try keys.newHome(in: folder)
        try write(vault(half.home), "config/vault.json", in: folder)
        try write("{}", "vaults/\(half.home).json")
        let made = try keys.newHome(in: folder)
        XCTAssertEqual(keychain.item("machine:\(half.home)").data, half.key, "a key the folder's vault names went before a vault replaced it")

        let elsewhere = machine.appendingPathComponent("Other", isDirectory: true)
        keys.adopted(made.home, in: elsewhere)
        XCTAssertEqual(keychain.item("machine:\(half.home)").data, half.key, "a home adopted in another folder took this folder's half-made key")

        try write(vault(made.home), "config/vault.json", in: folder)
        keys.adopted(made.home, in: folder)
        XCTAssertNil(keychain.item("machine:\(half.home)").data, "the item of a half-made vault adopt replaced stayed for good")
        XCTAssertEqual(keychain.item("machine:\(made.home)").data, made.key)
        XCTAssertEqual(keychain.accounts, ["machine:\(made.home)"])
    }

    func testANewRecoveryKeyOnAKeyedHomeIsDraftedHereAndTheHomeAnswersItsSlotAndDayNeverAKey() async throws {
        let fake = try FakeSocketHome()
        defer { fake.stop() }
        let drafted = "NBSW Y3DP EB3W 64TM MQQH I2LO NZXW 6IDT OVRG E3LF ON2C A2LF NZSA"
        fake.answer = { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": "3fa2c91b", "keyed": true, "locked": false, "recovery": "confirmed"]]
            case "vault-recovery":
                guard request["recovery"] as? String == drafted else { return ["error": "a keyed home makes no recovery key"] }
                return ["result": ["slot": 2, "day": "2026-11-18"]]
            default: return ["error": "no answer is set"]
            }
        }
        let drafts = Failures()
        let socket = fake.socket
        let keeper = VaultKeeper(key: keys.keyed(home), old: MemoryKeyStore(), socket: { socket }, draft: {
            drafts.add()
            return drafted
        })
        let made = try await keeper.makeRecoveryKey()
        XCTAssertEqual(made.key, drafted, "the window would show a key the home did not take")
        XCTAssertEqual(made.number, 2)
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        XCTAssertEqual(day.string(from: Date(timeIntervalSince1970: TimeInterval(made.madeMs) / 1000)), "2026-11-18")
        XCTAssertEqual(fake.verbs, ["vault", "vault-recovery"])
        XCTAssertEqual(drafts.count, 1)
        XCTAssertEqual(keychain.item("machine:\(home)").prompted, [], "a new recovery key read the Keychain")

        fake.answer = { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": "3fa2c91b", "keyed": true, "locked": false, "recovery": "confirmed"]]
            default: return ["result": ["recovery": drafted, "recovery_slot": "r-3", "made_ms": 1_763_337_600_000]]
            }
        }
        do {
            _ = try await keeper.makeRecoveryKey()
            XCTFail("a keyed home's answer with no slot and day was taken")
        } catch let refusal as VaultRefusal {
            XCTAssertTrue(refusal.homeMayHaveActed)
            XCTAssertFalse(refusal.reason.contains("NBSW"))
        }

        fake.answer = { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
            case "vault-recovery": return ["result": ["recovery": drafted, "recovery_slot": "r-3", "made_ms": 1_763_337_600_000]]
            default: return ["error": "no answer is set"]
            }
        }
        _ = try await keeper.makeRecoveryKey()
        XCTAssertNil(fake.requests.last?["recovery"], "a plain home's new recovery key carried one drafted by the app")
        XCTAssertEqual(drafts.count, 2, "a plain home's road drafted a key")
    }

    private func keyedHome(_ fake: FakeSocketHome, refusing: Set<String> = []) {
        fake.answer = { [recovery] request in
            let verb = request["verb"] as? String ?? ""
            if refusing.contains(verb) { return ["error": "this home refused \(verb)"] }
            switch verb {
            case "recover": return ["result": ["key_id": "3fa2c91b", "slot": "r-1"]]
            case "vault-slot": return ["result": ["slot": "m-0a1b2c3d", "removed": []]]
            case "vault-check":
                return ["result": ["opens": request["recovery"] as? String == recovery, "slot": "r-1", "number": 1,
                                   "made_ms": 1_763_337_600_000, "confirmed_ms": NSNull()]]
            default: return ["error": "no answer is set"]
            }
        }
    }

    func testAKeyedRecoverReachesTheHomeBeforeTheKeychainThenAddsThisMacsSlot() async throws {
        let fake = try FakeSocketHome()
        defer { fake.stop() }
        keyedHome(fake)
        let order = Order()
        let item = DeniedItem(Data(repeating: 9, count: 32), order: order)
        let keys = HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, item: { _ in item })
        fake.answer = { [answer = fake.answer] request in
            order.add(request["verb"] as? String ?? "")
            return answer(request)
        }
        let socket = fake.socket
        let keeper = VaultKeeper(key: keys.keyed(home), old: MemoryKeyStore(), socket: { socket }, unit: { "macbook-pro-0001" })
        try await keeper.recover(recovery)
        XCTAssertEqual(order.all, ["recover"], "recover waited on the Keychain")
        let kept = await keeper.keep()
        XCTAssertEqual(kept, .kept)
        XCTAssertEqual(order.all, ["recover", "keychain read", "keychain delete", "keychain add", "keychain read", "keychain read", "vault-slot"])
        XCTAssertNil(fake.requests[0]["slot_key"], "recover carried a key from the Keychain")
        let slot = try XCTUnwrap(fake.requests[1]["slot_key"] as? String)
        XCTAssertEqual(Data(base64Encoded: slot), item.kept)
        XCTAssertNotEqual(item.kept, Data(repeating: 9, count: 32), "an item that would not read was kept")
        XCTAssertEqual(fake.requests[1]["store"] as? String, "keychain-login")
        XCTAssertEqual(fake.requests[1]["unit"] as? String, "macbook-pro-0001")
        XCTAssertTrue(keys.keyed(home).trusted)
    }

    func testAKeyedRecoverWithAKeychainThatRefusesStillOpensTheHome() async throws {
        let fake = try FakeSocketHome()
        defer { fake.stop() }
        keyedHome(fake)
        keychain.item("machine:\(home)").refusal = .keychain(errSecAuthFailed)
        let socket = fake.socket
        let keeper = VaultKeeper(key: keys.keyed(home), old: MemoryKeyStore(), socket: { socket })
        try await keeper.recover(recovery)
        guard case .notKept(let why) = await keeper.keep() else { return XCTFail("a Keychain that refused was said kept") }
        XCTAssertEqual(fake.verbs, ["recover"])
        XCTAssertFalse(why.contains(recovery))
        XCTAssertEqual(why, "Your Mac's Keychain said: \(KeyStoreError.keychain(errSecAuthFailed).reason)")
        XCTAssertFalse(why.contains("\(errSecAuthFailed)"), "the Keychain's reason was its status code")
    }

    func testKeepingTheKeySendsItsSlotOnlyOnceTheOpenedHomeAnswersItsSocketWithinItsLimit() async throws {
        let fake = try FakeSocketHome()
        defer { fake.stop() }
        let starting = Failures()
        fake.answer = { request in
            guard request["verb"] as? String == "vault-slot" else { return ["error": "no answer is set"] }
            starting.add()
            switch starting.count {
            case 1, 2:
                let words = "Lifestream is locked: unlock it on your Mac."
                return ["error": words, "refusal": ["status": 503, "code": "LOCKED", "words": words, "extra": ["why": "opening"]]]
            case 3:
                let words = "Your home is starting: it answers in a moment."
                return ["error": words, "refusal": ["status": 503, "code": "NOT_NOW", "words": words, "extra": ["wait": "starting"]]]
            default: return ["result": ["slot": "m-0a1b2c3d", "removed": []]]
            }
        }
        let socket = fake.socket
        keychain.item("machine:\(home)").data = Data(repeating: 9, count: 32)
        let keeper = VaultKeeper(key: keys.keyed(home), old: MemoryKeyStore(), socket: { socket })
        let kept = await keeper.keep()
        XCTAssertEqual(kept, .kept, "the slot was given up while the home was still opening")
        XCTAssertEqual(fake.verbs, ["vault-slot", "vault-slot", "vault-slot", "vault-slot"])
        XCTAssertEqual(Set(fake.requests.compactMap { $0["slot_key"] as? String }), [Data(repeating: 9, count: 32).base64EncodedString()],
                       "a slot key was made again between the home's answers")
    }

    func testKeepingTheKeyStopsAtItsLimitOnAHoldOrASilentSocketAndSaysItDidNotOpen() async throws {
        let fake = try FakeSocketHome()
        let hold = "Lifestream is checking its files: it opens when the check ends"
        fake.answer = { request in
            guard request["verb"] as? String == "vault-slot" else { return ["error": "no answer is set"] }
            return ["error": hold, "refusal": ["status": 503, "code": "NOT_NOW", "words": hold, "extra": ["wait": "hold"]]]
        }
        let socket = fake.socket
        keychain.item("machine:\(home)").data = Data(repeating: 9, count: 32)
        let keeper = VaultKeeper(key: keys.keyed(home), old: MemoryKeyStore(), socket: { socket })
        let held = await keeper.keep(within: 0.5)
        XCTAssertEqual(held, .notOpened, "a hold that outlasted the limit was waited on")
        XCTAssertGreaterThan(fake.verbs.count, 1, "the slot was not asked again while the home held")
        XCTAssertEqual(VaultKeeper.keepWithin, 300)
        fake.stop()
        let silent = await keeper.keep(within: 0.5)
        XCTAssertEqual(silent, .notOpened, "a home that never listened was waited on past the limit")
    }

    func testAKeyedRecoverTheHomeRefusesTouchesNoKey() async throws {
        let fake = try FakeSocketHome()
        defer { fake.stop() }
        keyedHome(fake, refusing: ["recover"])
        let item = keychain.item("machine:\(home)")
        item.data = Data(repeating: 9, count: 32)
        let socket = fake.socket
        let keeper = VaultKeeper(key: keys.keyed(home), old: MemoryKeyStore(), socket: { socket })
        do {
            try await keeper.recover("MZXW 6YTB")
            XCTFail("a refused recovery key opened the home")
        } catch {}
        XCTAssertEqual(fake.verbs, ["recover"])
        XCTAssertEqual(item.data, Data(repeating: 9, count: 32))
        XCTAssertEqual(item.deletes, 0)
        XCTAssertEqual(item.prompted, [])
    }

    func testCheckingTheRecoveryKeyAsksTheHomeAndNamesTheKey() async throws {
        let fake = try FakeSocketHome()
        defer { fake.stop() }
        keyedHome(fake)
        let socket = fake.socket
        let keeper = VaultKeeper(key: keys.keyed(home), old: MemoryKeyStore(), socket: { socket })
        let opens = try await keeper.check(recovery)
        XCTAssertEqual(opens.opens, true)
        XCTAssertEqual(opens.number, 1)
        XCTAssertEqual(opens.madeMs, 1_763_337_600_000)
        let refused = try await keeper.check("MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAB")
        XCTAssertFalse(refused.opens)
        XCTAssertEqual(fake.verbs, ["vault-check", "vault-check"])
        XCTAssertEqual(keychain.item("machine:\(home)").prompted, [], "a check read the Keychain")
    }

    func testTheVaultSaysWhetherTheHomeIsKeyed() {
        var answer = VaultKeeperTests.answer(locked: true, by: nil)
        XCTAssertEqual(VaultState(answer: answer)?.keyed, false)
        answer["keyed"] = true
        XCTAssertEqual(VaultState(answer: answer)?.keyed, true)
    }
}

final class Order: @unchecked Sendable {
    private let lock = NSLock()
    private var steps: [String] = []
    var all: [String] { lock.withLock { steps } }
    func add(_ step: String) { lock.withLock { steps.append(step) } }
}

final class DeniedItem: KeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private let order: Order
    private var data: Data?
    private var denied = true

    init(_ data: Data, order: Order) {
        self.data = data
        self.order = order
    }

    var kept: Data? { lock.withLock { data } }

    func read(prompting: Bool) throws -> Data? {
        order.add("keychain read")
        return try lock.withLock {
            if denied { throw KeyStoreError.keychain(errSecAuthFailed) }
            return data
        }
    }

    func held() throws -> Bool { lock.withLock { data != nil } }

    func keyID() throws -> String? { lock.withLock { data.map(VaultKeyID.of) } }

    func mark(keyID: String) throws {}

    func add(_ added: Data) throws {
        order.add("keychain add")
        try lock.withLock {
            guard data == nil else { throw KeyStoreError.keychain(errSecDuplicateItem) }
            data = added
        }
    }

    func delete() throws {
        order.add("keychain delete")
        lock.withLock {
            data = nil
            denied = false
        }
    }
}

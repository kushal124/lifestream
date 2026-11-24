import Foundation
import Passwords
import XCTest

final class KeychainTrustTests: XCTestCase {
    private var home: FakeSocketHome!
    private var machine: MemoryKeyStore!
    private var defaults: UserDefaults!
    private var suite: String!
    private let slotKey = Data((0..<32).map { UInt8($0) })

    override func setUpWithError() throws {
        home = try FakeSocketHome()
        machine = MemoryKeyStore()
        suite = "KeychainTrustTests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        home.answer = { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": NSNull(), "locked": false, "recovery": "none"]]
            case "unlock": return ["result": ["key_id": "3fa2c91b"]]
            default: return ["result": ["key_id": "0a1b2c3d", "slot": "m-0a1b2c3d", "recovery": "MZXW", "recovery_slot": "r-1", "made_ms": 1]]
            }
        }
    }

    override func tearDown() {
        home.stop()
        UserDefaults().removePersistentDomain(forName: suite)
    }

    private func keeper(build: String = "build-2") -> VaultKeeper {
        let socket = home.socket
        return VaultKeeper(machine: machine, old: MemoryKeyStore(),
                           trust: KeychainTrust(build: build, defaults: defaults), socket: { socket }, unit: { "macbook-pro-0001" })
    }

    private var record: String? { defaults.string(forKey: KeychainTrust.name) }

    func testDecidingWhatThePersonMustDoReadsNoValue() async {
        machine.data = slotKey
        let held = await keeper().holdsKey()
        XCTAssertTrue(held)
        machine.data = nil
        let none = await keeper().holdsKey()
        XCTAssertFalse(none)
        XCTAssertEqual(machine.prompted, [], "deciding read the key")
    }

    func testAllowReadsTwiceRecordsTheBuildAndUnlocksTheHome() async throws {
        defaults.set("build-1", forKey: KeychainTrust.name)
        machine.data = slotKey
        try await keeper().allow()
        XCTAssertEqual(machine.prompted, [true, true])
        XCTAssertEqual(record, "build-2")
        XCTAssertTrue(KeychainTrust(build: "build-2", defaults: defaults).allowed, "the launcher, the same build, does not read it")
        XCTAssertEqual(home.verbs, ["unlock"])
        XCTAssertEqual(home.requests[0]["slot_key"] as? String, slotKey.base64EncodedString())
        XCTAssertFalse(KeychainTrust(build: "build-3", defaults: defaults).allowed)
        defaults.set("team:4HH63Q6JYM", forKey: KeychainTrust.name)
        XCTAssertTrue(KeychainTrust(build: "team:4HH63Q6JYM", defaults: defaults).allowed)
        XCTAssertFalse(KeychainTrust(build: "team:ZZZZZZZZZZ", defaults: defaults).allowed)
        XCTAssertFalse(KeychainTrust(build: "build-3", defaults: defaults).allowed)
        KeychainTrust(build: "team:4HH63Q6JYM", defaults: defaults).clear()
        XCTAssertFalse(KeychainTrust(build: "team:4HH63Q6JYM", defaults: defaults).allowed, "a failed read stops every launcher read until Allow")
    }

    func testAReadThatDoesNotComeBackClearsTheRecordAndIsSaidWithoutTheKey() async {
        defaults.set("build-2", forKey: KeychainTrust.name)
        machine.data = slotKey
        machine.refusal = .keychain(errSecAuthFailed)
        let why = await refusal { try await self.keeper().allow() }
        XCTAssertTrue(why?.reason.contains("Keychain") == true, "a denial was taken as allowed")
        XCTAssertNil(why?.words, "this Mac's denial was shown as it is")
        let words = why?.reason ?? ""
        XCTAssertFalse(words.contains(slotKey.base64EncodedString()))
        XCTAssertEqual(machine.prompted, [true], "a denial was read again")
        XCTAssertNil(record, "a denial left the build trusted")
        XCTAssertEqual(home.verbs, [], "an unlock was sent with no key")
        defaults.set("build-2", forKey: KeychainTrust.name)
        machine.refusal = nil
        machine.data = nil
        let none = await refusal { try await self.keeper().allow() }
        XCTAssertTrue(none?.reason.contains("recovery key") == true)
        XCTAssertEqual(record, "build-2", "an item gone cleared the trust, so the launcher's next log blames the build")
        XCTAssertEqual(home.verbs, [])
    }

    func testAKeyThisBuildMakesOrReadsInTheRecoveryKeyStepTrustsIt() async throws {
        _ = try await keeper().makeRecoveryKey()
        XCTAssertEqual(record, "build-2")
        try await keeper(build: "build-3").recover("MZXW")
        XCTAssertEqual(record, "build-3")
    }

    func testABuildWithNoVersionIsNotTrackedAndWritesNothing() async throws {
        defaults.set("build-1", forKey: KeychainTrust.name)
        machine.data = slotKey
        let untracked = KeychainTrust(build: "", defaults: defaults)
        XCTAssertTrue(untracked.allowed)
        try await keeper(build: "").allow()
        XCTAssertEqual(record, "build-1")
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

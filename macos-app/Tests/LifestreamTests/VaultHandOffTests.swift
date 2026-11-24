import Darwin
import Foundation
import Passwords
import XCTest
@testable import Lifestream

final class VaultHandOffTests: XCTestCase {
    private let key = Data((0..<32).map { UInt8($0 &+ 100) })

    override func tearDown() {
        unsetenv(VaultHandOff.variable)
    }

    private func descriptor() -> Int32 {
        open("/dev/null", O_RDONLY)
    }

    private func readToEnd(_ fd: Int32) -> Data {
        var bytes = Data()
        var chunk = [UInt8](repeating: 0, count: 64)
        while true {
            let size = read(fd, &chunk, chunk.count)
            if size <= 0 { break }
            bytes.append(contentsOf: chunk[..<size])
        }
        return bytes
    }

    func testTheHomeIsHandedTheKeyOnItsDescriptorThenEndOfFile() {
        let fd = descriptor()
        defer { close(fd) }
        XCTAssertNil(VaultHandOff.prepare(.key(key), descriptor: fd))
        XCTAssertEqual(String(cString: getenv(VaultHandOff.variable)), "\(fd)")
        XCTAssertEqual(fcntl(fd, F_GETFD) & FD_CLOEXEC, 0)
        XCTAssertEqual(readToEnd(fd), key)
    }

    func testEveryFailureStartsTheHomeWithNoDescriptorAndNoVariable() {
        let failures: [KeyRead] = [.none, .unreadable("the Keychain item is not 32 bytes"), .refused("the Keychain would ask the person (-25308)"),
                                   .unanswered("the Keychain did not answer within 5 s"), .key(Data(repeating: 1, count: 16))]
        for failure in failures {
            setenv(VaultHandOff.variable, "3", 1)
            let fd = descriptor()
            let why = VaultHandOff.prepare(failure, descriptor: fd)
            XCTAssertNotNil(why, "\(failure)")
            XCTAssertNil(getenv(VaultHandOff.variable), "\(failure)")
            XCTAssertEqual(fcntl(fd, F_GETFD), -1, "the descriptor stayed open after \(failure)")
            XCTAssertFalse(why!.contains(key.base64EncodedString()))
        }
    }

    func testARefusedOrInteractiveReadIsNotRetriedAndNeverAsksThePerson() {
        let store = MemoryStore()
        store.refusal = .keychain(errSecInteractionNotAllowed)
        guard case .unanswered(let why) = store.readForLaunch(within: 5) else { return XCTFail("an interactive read was not said to be unanswered") }
        XCTAssertTrue(why.contains("-25308"))
        XCTAssertEqual(store.prompted, [false])
        let empty = MemoryStore()
        XCTAssertEqual(empty.readForLaunch(within: 5), .none)
        let held = MemoryStore()
        held.data = key
        XCTAssertEqual(held.readForLaunch(within: 5), .key(key))
        XCTAssertEqual(held.prompted, [false])
    }

    func testTheLauncherReadsOnlyForATrustedBuildAndOnlyTheAppsRefusedReadEndsTheTrust() throws {
        let suite = "VaultHandOffTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let trust = KeychainTrust(build: "build-2", defaults: defaults)
        let store = MemoryStore()
        store.data = key
        guard case .refused(let why) = HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: VaultHandOff.wait) else { return XCTFail("a build not trusted was handed the key") }
        XCTAssertEqual(store.prompted, [], "the launcher read the item for a build not trusted")
        XCTAssertTrue(why.contains("Allow"))
        defaults.set("build-2", forKey: KeychainTrust.name)
        XCTAssertEqual(HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: VaultHandOff.wait), .key(key))
        XCTAssertEqual(store.prompted, [false])
        XCTAssertTrue(trust.allowed)
        store.data = nil
        XCTAssertEqual(HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: VaultHandOff.wait), .none)
        XCTAssertTrue(trust.allowed, "an item gone ended this build's trust, so the next launch blames the build")
        let gone = try XCTUnwrap(VaultHandOff.prepare(HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: VaultHandOff.wait), descriptor: descriptor()))
        XCTAssertTrue(gone.contains("holds no vault key"), gone)
        XCTAssertFalse(gone.contains("has not opened"), "the launcher blamed the build for an item that is gone: \(gone)")
        store.data = key
        store.refusal = .notAKey
        let unreadable = HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: VaultHandOff.wait)
        XCTAssertEqual(unreadable, .unreadable(KeyStoreError.notAKey.description))
        XCTAssertTrue(trust.allowed, "an item that holds no key ended this build's trust")
        let said = try XCTUnwrap(VaultHandOff.prepare(unreadable, descriptor: descriptor()))
        XCTAssertTrue(said.contains("holds no key it can use"), said)
        store.refusal = .keychain(errSecInteractionNotAllowed)
        guard case .unanswered = HomeKey(store: store, trust: trust, reader: .app).launchRead(within: VaultHandOff.wait) else {
            return XCTFail("a read where macOS could not ask the person was not said to be unanswered")
        }
        XCTAssertTrue(trust.allowed, "a read where macOS could not ask the person cleared the trust")
        store.refusal = .keychain(errSecAuthFailed)
        guard case .refused = HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: VaultHandOff.wait) else {
            return XCTFail("the Keychain's refusal was not said as refused")
        }
        XCTAssertEqual(defaults.string(forKey: KeychainTrust.name), "build-2", "the launcher's refused read changed the trust record")
        XCTAssertTrue(trust.allowed, "the launcher's refused read cleared the app's trust")
        XCTAssertNotEqual(HomeKey(store: store, trust: trust, reader: .app).launchRead(within: VaultHandOff.wait), .key(key))
        XCTAssertNil(defaults.string(forKey: KeychainTrust.name), "a Keychain that refused the app left this build trusted")
        XCTAssertFalse(trust.allowed)
        let reads = store.prompted.count
        _ = HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: VaultHandOff.wait)
        XCTAssertEqual(store.prompted.count, reads)
        defaults.set("build-2", forKey: KeychainTrust.name)
        store.refusal = nil
        store.data = key
        store.hold = DispatchSemaphore(value: 0)
        defer { store.hold?.signal() }
        guard case .unanswered = HomeKey(store: store, trust: trust, reader: .helper).launchRead(within: 0.2) else {
            return XCTFail("a read that ran out of time was not said to be unanswered")
        }
        XCTAssertTrue(trust.allowed, "a read that only ran out of time cleared the trust")
    }

    func testAKeychainThatDoesNotAnswerIsNotWaitedOn() {
        let store = MemoryStore()
        store.hold = DispatchSemaphore(value: 0)
        defer { store.hold?.signal() }
        guard case .unanswered(let why) = store.readForLaunch(within: 0.2) else { return XCTFail("a Keychain that did not answer was waited on") }
        XCTAssertTrue(why.contains("did not answer"))
    }
}

final class MemoryStore: KeyStore, @unchecked Sendable {
    var data: Data? { didSet { mark = data.map(VaultKeyID.of) } }
    var mark: String?
    var refusal: KeyStoreError?
    var attributesRefusal: KeyStoreError?
    var hold: DispatchSemaphore?
    private let lock = NSLock()
    private var _prompted: [Bool] = []
    var prompted: [Bool] { lock.withLock { _prompted } }

    func read(prompting: Bool) throws -> Data? {
        lock.withLock { _prompted.append(prompting) }
        hold?.wait()
        if let refusal { throw refusal }
        return data
    }

    func held() throws -> Bool { data != nil }
    func keyID() throws -> String? {
        if let attributesRefusal { throw attributesRefusal }
        return data == nil ? nil : mark
    }
    func mark(keyID: String) throws {
        if let attributesRefusal { throw attributesRefusal }
        mark = keyID
    }
    func add(_ data: Data) throws { self.data = data }
    func delete() throws { data = nil }
}

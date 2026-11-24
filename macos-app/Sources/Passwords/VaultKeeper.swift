import Foundation

public struct VaultState: Equatable, Sendable, CustomStringConvertible {
    public enum Recovery: String, Sendable {
        case none, unconfirmed, confirmed
    }

    public struct Slot: Equatable, Sendable {
        public let id: String
        public let kind: String
        public let unit: String?
        public let madeMs: Int64?
        public let confirmedMs: Int64?

        public var recovery: Int? { kind == "recovery" ? RecoveryMade.number(id) : nil }
    }

    public let keyID: String?
    public let keyed: Bool
    public let locked: Bool
    public let migrateKeyID: String?
    public let recovery: Recovery
    public let slots: [Slot]
    public let why: String?

    public init?(answer: Any) {
        guard let object = answer as? [String: Any], let locked = object["locked"] as? Bool,
              let recovery = (object["recovery"] as? String).flatMap(Recovery.init(rawValue:)) else { return nil }
        keyID = object["key_id"] as? String
        keyed = object["keyed"] as? Bool ?? false
        self.locked = locked
        migrateKeyID = (object["migrate"] as? [String: Any])?["key_id"] as? String
        self.recovery = recovery
        why = locked ? object["why"] as? String : nil
        slots = (object["slots"] as? [[String: Any]] ?? []).compactMap { slot in
            guard let id = slot["id"] as? String, let kind = slot["kind"] as? String else { return nil }
            return Slot(id: id, kind: kind, unit: slot["unit"] as? String, madeMs: (slot["made_ms"] as? NSNumber)?.int64Value,
                        confirmedMs: (slot["confirmed_ms"] as? NSNumber)?.int64Value)
        }
    }

    public var recoveries: [Slot] {
        slots.filter { $0.recovery != nil }.sorted { ($0.madeMs ?? 0, $0.recovery ?? 0) > ($1.madeMs ?? 0, $1.recovery ?? 0) }
    }

    public var saved: Slot? {
        recoveries.filter { $0.confirmedMs != nil }.max { ($0.confirmedMs ?? 0, $0.recovery ?? 0) < ($1.confirmedMs ?? 0, $1.recovery ?? 0) }
    }

    public func opens(with slotKey: Data) -> Bool {
        opens(keyID: VaultKeyID.of(slotKey))
    }

    public func opens(keyID: String) -> Bool {
        slots.contains { $0.kind == "machine" && $0.id == "m-\(keyID)" }
    }

    public func machines(besides unit: String?) -> [String] {
        slots.compactMap { $0.kind == "machine" ? $0.unit : nil }.filter { $0 != unit }
            .reduce(into: []) { units, each in if !units.contains(each) { units.append(each) } }
    }

    public var description: String {
        "vault \(keyID ?? "none") \(locked ? "locked" : "open") recovery \(recovery.rawValue) migrate \(migrateKeyID ?? "none")"
    }
}

public struct RecoveryMade: Equatable, Sendable {
    public let key: String
    public let number: Int
    public let madeMs: Int64

    public init(key: String, number: Int, madeMs: Int64) {
        self.key = key
        self.number = number
        self.madeMs = madeMs
    }

    init(answer: Any) throws {
        guard let object = answer as? [String: Any], let key = object["recovery"] as? String,
              let number = (object["recovery_slot"] as? String).flatMap(Self.number),
              let made = (object["made_ms"] as? NSNumber)?.int64Value else {
            throw VaultRefusal(reason: "the home answered no recovery key", acted: true)
        }
        self.init(key: key, number: number, madeMs: made)
    }

    init(drafted key: String, answer: Any) throws {
        guard let object = answer as? [String: Any], let number = (object["slot"] as? NSNumber)?.intValue, number > 0,
              let made = (object["day"] as? String).flatMap(Self.noon) else {
            throw VaultRefusal(reason: "the home answered no slot for the recovery key", acted: true)
        }
        self.init(key: key, number: number, madeMs: made)
    }

    static func noon(_ day: String) -> Int64? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd HH"
        return formatter.date(from: "\(day) 12").map { Int64($0.timeIntervalSince1970 * 1000) }
    }

    static func number(_ slot: String) -> Int? {
        guard slot.hasPrefix("r-"), let number = Int(slot.dropFirst(2)), number > 0 else { return nil }
        return number
    }
}

public enum NewVault: Equatable, Sendable {
    case opened
    case made(RecoveryMade)
}

public enum KeyKept: Equatable, Sendable {
    case kept
    case notKept(String)
    case notOpened
}

public struct RecoveryCheck: Equatable, Sendable {
    public let opens: Bool
    public let number: Int
    public let madeMs: Int64

    init(answer: Any) throws {
        guard let object = answer as? [String: Any], let opens = object["opens"] as? Bool,
              let number = (object["number"] as? NSNumber)?.intValue, let made = (object["made_ms"] as? NSNumber)?.int64Value else {
            throw VaultRefusal(reason: "the home answered no check of the recovery key")
        }
        self.opens = opens
        self.number = number
        madeMs = made
    }
}

public enum VaultRead: Equatable, Sendable {
    case noHome
    case state(VaultState)
    case failed(String)
}

public struct VaultRefusal: Error, Equatable, CustomStringConvertible {
    public let reason: String
    public let words: String?
    public let socket: HomeSocketError?
    public let acted: Bool
    public var description: String { reason }

    public init(reason: String, words: String? = nil, socket: HomeSocketError? = nil, acted: Bool = false) {
        self.reason = reason
        self.words = words
        self.socket = socket
        self.acted = acted
    }

    init(_ failure: HomeSocketError) {
        self.init(reason: "\(failure)", words: failure.reach ? nil : "\(failure)", socket: failure)
    }

    public var wrongKey: Bool {
        guard case .refused(let refusal) = socket else { return false }
        return refusal.code == VaultKeeper.wrongKeyCode
    }

    public var homeMayHaveActed: Bool { acted || socket.map { !VaultKeeper.unheard($0) } ?? false }
}

public final class VaultKeeper: Sendable {
    public static let store = "keychain-login"
    public static let keyHeld = "This Mac's Keychain holds a key for your passwords. Press Allow to open them."
    public static let opening: TimeInterval = 0.25

    public typealias Draft = @Sendable () throws -> String

    private let key: @Sendable () -> HomeKey
    private let old: KeyStore
    private let socket: @Sendable () -> HomeSocket?
    private let unit: @Sendable () -> String?
    private let draft: Draft

    public init(keys: HomeKeys = HomeKeys(reader: .app), old: KeyStore = KeychainItem.oldPasswords, socket: (@Sendable () -> HomeSocket?)? = nil,
                failed: @escaping @Sendable () -> Void = {}, unit: @escaping @Sendable () -> String? = { nil }, draft: @escaping Draft = VaultKeeper.noDraft) {
        key = { keys.thisHome() }
        self.old = old
        self.socket = socket ?? { HomeSocket.thisMac(failed: failed) }
        self.unit = unit
        self.draft = draft
    }

    public init(machine: KeyStore, old: KeyStore, trust: KeychainTrust, socket: (@Sendable () -> HomeSocket?)? = nil,
                failed: @escaping @Sendable () -> Void = {}, unit: @escaping @Sendable () -> String? = { nil }, draft: @escaping Draft = VaultKeeper.noDraft) {
        key = { HomeKey(store: machine, trust: trust, reader: .app) }
        self.old = old
        self.socket = socket ?? { HomeSocket.thisMac(failed: failed) }
        self.unit = unit
        self.draft = draft
    }

    public init(key: HomeKey, old: KeyStore, socket: (@Sendable () -> HomeSocket?)? = nil, unit: @escaping @Sendable () -> String? = { nil },
                draft: @escaping Draft = VaultKeeper.noDraft) {
        self.key = { key }
        self.old = old
        self.socket = socket ?? { HomeSocket.thisMac() }
        self.unit = unit
        self.draft = draft
    }

    public static let noDraft: Draft = { throw VaultRefusal(reason: "this copy of the app carries no release to draft a recovery key") }

    public func read() async -> VaultRead {
        await run { [socket] in
            guard let home = socket() else { return .noHome }
            do {
                guard let state = VaultState(answer: try home.ask(["verb": "vault"])) else { return .failed("the home answered no vault") }
                return .state(state)
            } catch HomeSocketError.noHome {
                return .noHome
            } catch let failure as HomeSocketError {
                return .failed("\(failure)")
            } catch {
                return .failed("\(error)")
            }
        }
    }

    public func elsewhere(_ state: VaultState) -> [String] {
        state.machines(besides: unit())
    }

    public func holdsKey() async -> Bool {
        await run { [key] in (try? key().held()) ?? true }
    }

    public func kept(in state: VaultState) async -> SlotKept {
        await run { [key] in key().kept(in: state) }
    }

    public func keyTrusted() async -> Bool {
        await run { [key] in key().trusted }
    }

    public func allow() async throws {
        try await exchange { [key] home in
            let mine = key()
            guard let held = try mine.read() else {
                let words = mine.keyed ? "This Mac's Keychain holds no key for Lifestream: unlock it with your recovery key."
                                       : "This Mac's Keychain holds no key for your passwords: unlock them with your recovery key."
                throw VaultRefusal(reason: words, words: words)
            }
            _ = try home.ask(["verb": "unlock", "slot_key": held.base64EncodedString()])
        }
    }

    public func makeRecoveryKey() async throws -> RecoveryMade {
        try await exchange { [old, draft] home in
            guard let state = VaultState(answer: try home.ask(["verb": "vault"], waiting: home.patience)) else { throw VaultRefusal(reason: "the home answered no vault") }
            if state.keyed {
                let drafted = try draft()
                return try RecoveryMade(drafted: drafted, answer: try home.ask(["verb": "vault-recovery", "recovery": drafted]))
            }
            guard state.keyID == nil else { return try RecoveryMade(answer: try home.ask(["verb": "vault-recovery"])) }
            var request: [String: Any] = ["verb": "vault-init", "store": Self.store]
            if let id = state.migrateKeyID {
                let key: Data?
                do {
                    key = try old.read(prompting: true)
                } catch {
                    throw VaultRefusal(reason: "the Keychain did not answer for this Mac's old passwords key (\(error)): nothing was made; try again")
                }
                if let key, VaultKeyID.of(key) == id { request["key"] = key.base64EncodedString() }
            }
            request["slot_key"] = try self.key().readOrMake().key.base64EncodedString()
            if let unit = self.unit() { request["unit"] = unit }
            let made = try RecoveryMade(answer: try home.ask(request))
            if request["key"] != nil { try? old.delete() }
            return made
        }
    }

    public func startNewVault() async throws -> NewVault {
        try await exchange { [key] home in
            let mine = key()
            let slot = try mine.readOrMake()
            var request: [String: Any] = ["verb": "vault-new", "store": Self.store, "slot_key": slot.key.base64EncodedString()]
            if let unit = self.unit() { request["unit"] = unit }
            do {
                let answer = try home.ask(request)
                if (answer as? [String: Any])?["opened"] is String { return .opened }
                return .made(try RecoveryMade(answer: answer))
            } catch {
                if slot.made, Self.unheard(error) { try? mine.delete() }
                throw error
            }
        }
    }

    public func discard() async throws {
        try await exchange { home in _ = try home.ask(["verb": "vault-discard"]) }
    }

    public func confirm(_ shown: String) async throws {
        try await exchange { home in _ = try home.ask(["verb": "vault-confirm", "recovery": shown], waiting: home.patience) }
    }

    public func recover(_ typed: String) async throws {
        try await exchange { [key] home in
            let mine = key()
            guard mine.keyed else {
                let slot = try mine.readOrMake()
                var request: [String: Any] = ["verb": "recover", "recovery": typed, "store": Self.store,
                                              "slot_key": slot.key.base64EncodedString()]
                if let unit = self.unit() { request["unit"] = unit }
                do {
                    _ = try home.ask(request, waiting: home.patience)
                } catch {
                    if slot.made, Self.unheard(error) { try? mine.delete() }
                    throw error
                }
                return
            }
            _ = try home.ask(["verb": "recover", "recovery": typed], waiting: home.patience)
        }
    }

    public static let keepWithin: TimeInterval = 300

    public func keep(within limit: TimeInterval = keepWithin) async -> KeyKept {
        await run { [key, socket, unit] in
            let slot: Data
            do {
                slot = try key().renew()
            } catch {
                return .notKept("Your Mac's Keychain said: \((error as? KeyStoreError)?.reason ?? "\(error)")")
            }
            guard let home = socket() else { return .notKept(Self.notTaken(HomeSocketError.noHome)) }
            var request: [String: Any] = ["verb": "vault-slot", "store": Self.store, "slot_key": slot.base64EncodedString()]
            if let unit = unit() { request["unit"] = unit }
            do {
                _ = try Self.once(open: home, request, until: Date().addingTimeInterval(limit))
            } catch is NotOpened {
                return .notOpened
            } catch {
                return .notKept(Self.notTaken(error))
            }
            return .kept
        }
    }

    private static func notTaken(_ error: Error) -> String {
        "Lifestream didn't take this Mac's new key: \(error)."
    }

    public func check(_ typed: String) async throws -> RecoveryCheck {
        try await exchange { home in try RecoveryCheck(answer: try home.ask(["verb": "vault-check", "recovery": typed], waiting: home.patience)) }
    }

    public func save(secret: String, value: String?) async throws {
        try await exchange { home in
            _ = try home.ask(["verb": "seal", "secret": secret, "value": value.map { $0 as Any } ?? NSNull()], waiting: home.patience)
        }
    }

    static let wrongKeyCode = "VAULT_KEY"
    static let lockedCode = "LOCKED"

    struct NotOpened: Error {}

    private static func once(open home: HomeSocket, _ request: [String: Any], until end: Date) throws -> Any {
        while true {
            do {
                return try home.ask(request, waiting: max(0, end.timeIntervalSinceNow))
            } catch HomeSocketError.refused(let refusal) where refusal.code == lockedCode || refusal.notNow {
                guard end.timeIntervalSinceNow > opening else { throw NotOpened() }
                Thread.sleep(forTimeInterval: opening)
            } catch HomeSocketError.noHome {
                throw NotOpened()
            }
        }
    }

    static func unheard(_ error: Error) -> Bool {
        switch error as? HomeSocketError {
        case .noHome, .refused: true
        case .broken, .timeout, nil: false
        }
    }

    private func exchange<T: Sendable>(_ body: @escaping @Sendable (HomeSocket) throws -> T) async throws -> T {
        let outcome: Result<T, VaultRefusal> = await run { [socket] in
            guard let home = socket() else {
                return .failure(VaultRefusal(reason: "this Mac points at no Lifestream folder", socket: .noHome))
            }
            do {
                return .success(try body(home))
            } catch let refusal as VaultRefusal {
                return .failure(refusal)
            } catch let failure as HomeSocketError {
                return .failure(VaultRefusal(failure))
            } catch {
                return .failure(VaultRefusal(reason: "\(error)"))
            }
        }
        return try outcome.get()
    }

    private func run<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await HomeSocket.blocking(work)
    }
}

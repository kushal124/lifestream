import Foundation
import Security

public enum SlotKept: Equatable, Sendable {
    case kept
    case notKept
    case untrusted
    case unread
}

public enum KeyReader: Sendable {
    case app
    case helper
}

public enum KeyFound: Equatable, Sendable {
    case key(Data)
    case gone
    case malformed
    case refused(String)
}

public struct HomeKey: Sendable {
    public let keyed: Bool
    public let name: String
    public let reader: KeyReader
    let store: KeyStore
    let trust: KeychainTrust
    private let untrusted: String

    public init(store: KeyStore, trust: KeychainTrust, reader: KeyReader, keyed: Bool = false, name: String = "a key of this Mac's",
                untrusted: String? = nil) {
        self.store = store
        self.trust = trust
        self.reader = reader
        self.keyed = keyed
        self.name = name
        self.untrusted = untrusted ?? (keyed ? "this build of the app has not opened Lifestream yet: Allow in the app unlocks it"
                                             : "this build of the app has not opened your passwords yet: Allow in the app's Connectors unlocks Lifestream")
    }

    public var trusted: Bool { trust.allowed }

    public func launchRead(within seconds: TimeInterval) -> KeyRead {
        guard trust.allowed else { return .refused(untrusted) }
        let read = store.readForLaunch(within: seconds)
        if case .refused = read { refused() }
        return read
    }

    public func found(within seconds: TimeInterval) -> KeyFound {
        for _ in 0..<2 {
            switch launchRead(within: seconds) {
            case .key(let key): return .key(key)
            case .none: continue
            case .unreadable(let why), .refused(let why), .unanswered(let why): return .refused(why)
            }
        }
        return .gone
    }

    public func prompted() -> KeyFound {
        for _ in 0..<2 {
            do {
                guard let key = try readOnce() else { continue }
                trust.record()
                return .key(key)
            } catch KeyStoreError.notAKey {
                return .malformed
            } catch {
                return .refused((error as? KeyStoreError)?.reason ?? "\(error)")
            }
        }
        return .gone
    }

    public func kept(in state: VaultState) -> SlotKept {
        guard trust.allowed else { return .untrusted }
        let id: String?
        do {
            id = try store.keyID()
        } catch {
            return .unread
        }
        guard let id else { return .notKept }
        return state.opens(keyID: id) ? .kept : .notKept
    }

    public func held() throws -> Bool {
        try store.held()
    }

    public func read() throws -> Data? {
        guard let key = try readOnce(), try readOnce() != nil else { return nil }
        trust.record()
        return key
    }

    public func make() throws -> Data {
        try store.add(try Self.random())
        guard let key = try read() else { throw KeyStoreError.unread }
        return key
    }

    public func readOrMake() throws -> (key: Data, made: Bool) {
        if let key = try read() { return (key, false) }
        var made = true
        do {
            try store.add(try Self.random())
        } catch KeyStoreError.keychain(errSecDuplicateItem) {
            made = false
        }
        guard let key = try read() else { throw KeyStoreError.notAKey }
        return (key, made)
    }

    public func renew() throws -> Data {
        if let key = try? read() {
            try mark(key)
            return key
        }
        try store.delete()
        return try make()
    }

    public func delete() throws {
        try store.delete()
    }

    private func mark(_ key: Data) throws {
        let id = VaultKeyID.of(key)
        guard try store.keyID() != id else { return }
        try store.mark(keyID: id)
    }

    private func readOnce() throws -> Data? {
        do {
            return try store.read(prompting: true)
        } catch {
            if (error as? KeyStoreError)?.refusesThisBuild ?? true { refused() }
            throw error
        }
    }

    private func refused() {
        guard reader == .app else { return }
        trust.clear()
    }

    private static func random() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: KeychainItem.length)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw KeyStoreError.random }
        return Data(bytes)
    }
}

public struct HomeKeys: @unchecked Sendable {
    public static let service = "org.lifestreamprotocol.vault"
    static let plainAccount = "machine"
    static let macFilesRecord = "\(KeychainTrust.name).mac-files"

    public let machine: URL
    public let reader: KeyReader
    private let build: String
    private let defaults: UserDefaults
    private let item: @Sendable (_ account: String) -> KeyStore
    private let files: KeyStore

    public init(reader: KeyReader, machine: URL = HomeSocket.pointer.deletingLastPathComponent(), build: String = KeychainTrust.thisBuild,
                defaults: UserDefaults = .standard,
                item: @escaping @Sendable (_ account: String) -> KeyStore = { KeychainItem(service: HomeKeys.service, account: $0) },
                files: KeyStore = KeychainItem.macFiles) {
        self.machine = machine
        self.reader = reader
        self.build = build
        self.defaults = defaults
        self.item = item
        self.files = files
    }

    public var plain: HomeKey { key(Self.plainAccount, keyed: false) }

    public var macFiles: HomeKey {
        HomeKey(store: files, trust: KeychainTrust(build: build, defaults: defaults, record: Self.macFilesRecord), reader: reader,
                name: KeychainItem.macFiles.name,
                untrusted: "this build of the app has not opened what this Mac records yet: Allow in the app opens it")
    }

    public func reading(as reader: KeyReader) -> HomeKeys {
        HomeKeys(reader: reader, machine: machine, build: build, defaults: defaults, item: item, files: files)
    }

    public func keyed(_ home: String) -> HomeKey { key("\(Self.plainAccount):\(home)", keyed: true) }

    public func thisHome() -> HomeKey {
        guard let home = pointedHome else { return plain }
        let keyed = keyed(home)
        if FileManager.default.fileExists(atPath: copy(of: home).path) || pointedFolderKeyed || (try? keyed.held()) == true { return keyed }
        return plain
    }

    private var pointedFolderKeyed: Bool {
        guard let folder = HomeSocket.folder(pointer: machine.appendingPathComponent("home")) else { return false }
        return Self.vault(in: folder)?["keys"] != nil
    }

    private static func vault(in folder: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("config/vault.json")) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    public func newHome(in folder: URL) throws -> (home: String, key: Data) {
        if let earlier = defaults.string(forKey: Self.drafted) {
            if folderNames(earlier, folder) {
                defaults.set([earlier, folder.standardizedFileURL.path], forKey: Self.replacing)
            } else if !named(earlier, folder: folder) {
                try? keyed(earlier).delete()
            }
        }
        let home = UUID().uuidString.lowercased()
        defaults.set(home, forKey: Self.drafted)
        return (home, try keyed(home).make())
    }

    public func adopted(_ home: String, in folder: URL) {
        if let replaced = defaults.stringArray(forKey: Self.replacing), replaced.count == 2, replaced[1] == folder.standardizedFileURL.path,
           replaced[0] != home, !folderNames(replaced[0], folder) {
            try? keyed(replaced[0]).delete()
            defaults.removeObject(forKey: Self.replacing)
        }
        guard defaults.string(forKey: Self.drafted) == home else { return }
        defaults.removeObject(forKey: Self.drafted)
    }

    static let drafted = "vault.draftedHome"
    static let replacing = "vault.replacedDraft"

    var pointedHome: String? {
        guard let text = try? String(contentsOf: machine.appendingPathComponent("home-id"), encoding: .utf8) else { return nil }
        let home = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return home.isEmpty ? nil : home
    }

    private func named(_ home: String, folder: URL) -> Bool {
        FileManager.default.fileExists(atPath: copy(of: home).path) || folderNames(home, folder)
    }

    private func folderNames(_ home: String, _ folder: URL) -> Bool {
        guard let vault = Self.vault(in: folder) else { return false }
        let account = "\(Self.plainAccount):\(home)"
        return (vault["slots"] as? [[String: Any]] ?? []).contains { $0["account"] as? String == account }
    }

    private func copy(of home: String) -> URL {
        machine.appendingPathComponent("vaults/\(home).json")
    }

    private func key(_ account: String, keyed: Bool) -> HomeKey {
        let record = keyed ? "\(KeychainTrust.name).\(account)" : KeychainTrust.name
        return HomeKey(store: item(account), trust: KeychainTrust(build: build, defaults: defaults, record: record), reader: reader,
                       keyed: keyed, name: "\(Self.service) / \(account)")
    }
}

import CryptoKit
import Foundation
import LocalAuthentication
import Security

public protocol KeyStore: Sendable {
    func read(prompting: Bool) throws -> Data?
    func held() throws -> Bool
    func keyID() throws -> String?
    func mark(keyID: String) throws
    func add(_ data: Data) throws
    func delete() throws
}

public enum KeyStoreError: Error, Equatable, CustomStringConvertible {
    case keychain(OSStatus)
    case random
    case notAKey
    case unread

    public var description: String {
        switch self {
        case .keychain(let status) where status == errSecInteractionNotAllowed:
            return "the Keychain would ask the person (\(status))"
        case .keychain(let status): return "the Keychain refused (\(status))"
        case .random: return "no random bytes could be made for a key"
        case .notAKey: return "the Keychain item is not \(KeychainItem.length) bytes"
        case .unread: return "the Keychain did not give back the key it was handed"
        }
    }

    public var refusesThisBuild: Bool {
        if case .keychain = self { !unanswered } else { false }
    }

    public var unanswered: Bool {
        self == .keychain(errSecInteractionNotAllowed)
    }

    public var reason: String {
        guard case .keychain(let status) = self, let said = SecCopyErrorMessageString(status, nil) as String?, !said.isEmpty else { return description }
        return said
    }
}

public struct KeychainItem: KeyStore {
    public static let length = 32
    public static let vaultMachine = KeychainItem(service: "org.lifestreamprotocol.vault", account: "machine")
    public static let oldPasswords = KeychainItem(service: "org.lifestreamprotocol.passwords", account: "key")
    public static let macFiles = KeychainItem(service: "org.lifestreamprotocol.mac", account: "files")

    let service: String
    let account: String

    public init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    public var name: String { "\(service) / \(account)" }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func read(prompting: Bool) throws -> Data? {
        dispatchPrecondition(condition: .notOnQueue(.main))
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        if !prompting {
            let context = LAContext()
            context.interactionNotAllowed = true
            request[kSecUseAuthenticationContext as String] = context
        }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeyStoreError.keychain(status) }
        guard data.count == Self.length else { throw KeyStoreError.notAKey }
        return data
    }

    public func held() throws -> Bool {
        dispatchPrecondition(condition: .notOnQueue(.main))
        var request = query
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else { throw KeyStoreError.keychain(status) }
        return true
    }

    public func keyID() throws -> String? {
        dispatchPrecondition(condition: .notOnQueue(.main))
        var request = query
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        let context = LAContext()
        context.interactionNotAllowed = true
        request[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let attributes = result as? [String: Any] else { throw KeyStoreError.keychain(status) }
        return (attributes[kSecAttrGeneric as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
    }

    public func mark(keyID: String) throws {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let status = SecItemUpdate(query as CFDictionary, [kSecAttrGeneric as String: Data(keyID.utf8)] as CFDictionary)
        guard status == errSecSuccess else { throw KeyStoreError.keychain(status) }
    }

    public func add(_ data: Data) throws {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let fields: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrGeneric as String: Data(VaultKeyID.of(data).utf8),
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemAdd(query.merging(fields) { _, new in new } as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeyStoreError.keychain(status) }
    }

    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeyStoreError.keychain(status) }
    }
}

public enum KeyRead: Equatable, Sendable {
    case key(Data)
    case none
    case unreadable(String)
    case refused(String)
    case unanswered(String)
}

extension KeyStore {
    public func readForLaunch(within seconds: TimeInterval) -> KeyRead {
        let box = ReadBox()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            let read: KeyRead
            do {
                read = try self.read(prompting: false).map(KeyRead.key) ?? .none
            } catch let error as KeyStoreError where error.unanswered {
                read = .unanswered("\(error)")
            } catch let error as KeyStoreError where !error.refusesThisBuild {
                read = .unreadable("\(error)")
            } catch {
                read = .refused("\(error)")
            }
            box.set(read)
            done.signal()
        }
        guard done.wait(timeout: .now() + seconds) == .success, let read = box.value else {
            return .unanswered("the Keychain did not answer within \(Int(seconds.rounded())) s")
        }
        return read
    }
}

private final class ReadBox: @unchecked Sendable {
    private let lock = NSLock()
    private var read: KeyRead?
    var value: KeyRead? { lock.withLock { read } }
    func set(_ value: KeyRead) { lock.withLock { read = value } }
}

public enum VaultKeyID {
    public static func of(_ key: Data) -> String {
        SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined().prefix(8).description
    }
}

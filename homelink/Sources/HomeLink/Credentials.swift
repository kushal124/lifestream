import DeviceFiles
import Foundation
import Security

public protocol Credentials: Sendable {
    func read() throws -> Data?
    func write(_ data: Data) throws
    func delete() throws
}

public struct KeychainCredentials: Credentials {
    public static let defaultService = "org.lifestreamprotocol.homelink"

    let service: String
    let account: String

    public init(service: String = KeychainCredentials.defaultService, account: String = "pass") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw LinkFailure.credentials }
        return data
    }

    public func write(_ data: Data) throws {
        let fields: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(fields) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw LinkFailure.credentials }
    }

    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw LinkFailure.credentials }
    }
}

public struct FileCredentials: Credentials {
    static let most = 1 << 20

    let url: URL
    let files: DeviceFiles

    public init(url: URL, files: DeviceFiles? = nil) {
        self.url = url
        self.files = files ?? DeviceFiles(.plain)
    }

    public func read() throws -> Data? {
        do { return try files.read(url, maximumBytes: Self.most) } catch { throw LinkFailure.credentials }
    }

    public func write(_ data: Data) throws {
        do { try files.replace(url, with: data, commit: .pass) } catch { throw LinkFailure.credentials }
    }

    public func delete() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do { try FileManager.default.removeItem(at: url) } catch { throw LinkFailure.credentials }
    }
}

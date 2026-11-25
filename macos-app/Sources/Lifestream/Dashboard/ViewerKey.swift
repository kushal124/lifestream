import Foundation
import Security

/// The key the dashboard asks of every /api/ request on 127.0.0.1, so that another program or account on this Mac can't
/// read Lifestream through it. It is a file beside the dashboard's door token, readable by its owner alone; the dashboard
/// makes it if it starts first, and the app makes it if it comes first.
enum ViewerKey {
    static let file = "viewer-key"
    static let cookie = "lifestream_viewer"
    static let header = "X-Lifestream-Viewer-Key"

    static func location(machine: URL = MachineDirectory.url) -> URL {
        machine.appendingPathComponent("dashboard").appendingPathComponent(file)
    }

    static func held(at location: URL = location()) -> String? {
        if let key = read(location) { return key }
        let folder = location.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: folder.path) else { return nil }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let key = bytes.map { String(format: "%02x", $0) }.joined()
        let draft = folder.appendingPathComponent(".\(file)-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: draft.path, contents: Data("\(key)\n".utf8),
                                             attributes: [.posixPermissions: 0o600]) else { return nil }
        defer { unlink(draft.path) }
        _ = link(draft.path, location.path)
        return read(location)
    }

    static func cookies(_ key: String) -> [HTTPCookie] {
        ["127.0.0.1", "localhost"].compactMap { host in
            HTTPCookie(properties: [
                .domain: host, .path: "/", .name: cookie, .value: key,
                .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict,
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            ])
        }
    }

    private static func read(_ location: URL) -> String? {
        guard let text = try? String(contentsOf: location, encoding: .utf8) else { return nil }
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.count == 64 && key.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) ? key : nil
    }
}

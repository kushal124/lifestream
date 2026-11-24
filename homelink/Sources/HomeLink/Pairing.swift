import CryptoKit
import Foundation
import Network


public struct PairingLink: Sendable, Equatable {
    public let code: String
    public let addresses: [URL]
    public let fingerprint: String
    public let account: String?

    public init?(_ text: String) {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "lifestream", parts.host?.lowercased() == "pair" else { return nil }
        let value = { (name: String) in parts.queryItems?.first { $0.name == name }?.value }
        guard let code = value("code"), HomeLink.isCode(code),
              let host = value("host"), Self.isHost(host),
              let port = value("port").flatMap(Int.init), (1...65_535).contains(port),
              let fingerprint = value("fp"), HomeLink.isFingerprint(fingerprint),
              let wifi = URL(string: "https://\(host):\(port)") else { return nil }
        let others = (parts.queryItems ?? []).filter { $0.name == "at" }.compactMap { $0.value.flatMap(Self.address) }
        var addresses: [URL] = []
        for address in [wifi] + others where !addresses.contains(address) { addresses.append(address) }
        self.code = code
        self.addresses = addresses
        self.fingerprint = fingerprint
        account = value("account").flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
    }

    private static func address(_ text: String) -> URL? {
        guard let parts = URLComponents(string: text), parts.scheme?.lowercased() == "https",
              let host = parts.host, isHost(host), let port = parts.port, (1...65_535).contains(port),
              parts.path.isEmpty || parts.path == "/", parts.query == nil, parts.user == nil else { return nil }
        return URL(string: "https://\(host):\(port)")
    }

    private static func isHost(_ host: String) -> Bool {
        !host.isEmpty && host.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == ".") }
    }
}

public struct FoundHome: Sendable, Equatable {
    public let address: URL
    public let fingerprint: String

    public init(address: URL, fingerprint: String) {
        self.address = address
        self.fingerprint = fingerprint
    }

    public func match(code: String) -> String {
        HomeLink.match(fingerprint: fingerprint, code: code)
    }
}

public protocol HomeFinder: Sendable {
    func find(within: TimeInterval) async -> [URL]
}

public struct BonjourFinder: HomeFinder {
    public static let type = "_lifestream._tcp"

    public init() {}

    public func find(within: TimeInterval) async -> [URL] {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.type, domain: nil), using: .tcp)
        let found = Found()
        browser.browseResultsChangedHandler = { results, _ in
            found.set(results.compactMap { result -> URL? in
                guard case .bonjour(let record) = result.metadata, let host = record["host"],
                      let port = record["port"].flatMap(Int.init) else { return nil }
                return URL(string: "https://\(host):\(port)")
            })
        }
        browser.start(queue: DispatchQueue(label: "org.lifestreamprotocol.homelink.finder"))
        try? await Task.sleep(nanoseconds: UInt64(within * 1_000_000_000))
        browser.cancel()
        return found.urls
    }

    private final class Found: @unchecked Sendable {
        private let lock = NSLock()
        private var held: [URL] = []
        var urls: [URL] { lock.withLock { held } }
        func set(_ urls: [URL]) { lock.withLock { held = Array(Set(urls)).sorted { $0.absoluteString < $1.absoluteString } } }
    }
}

extension HomeLink {
    static func isCode(_ text: String) -> Bool {
        text.utf8.count == 8 && text.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    static func isFingerprint(_ text: String) -> Bool {
        text.count == 52 && text.allSatisfy { base32Alphabet.contains($0) }
    }

    static func match(fingerprint: String, code: String) -> String {
        guard let digest = base32Decoded(fingerprint) else { return "" }
        return String(base32(Data(SHA256.hash(data: digest + Data(code.utf8)))).prefix(4))
    }

    static let base32Alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    public static func base32(_ data: Data) -> String {
        var out = "", value = 0, bits = 0
        for byte in data {
            value = (value << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                out.append(base32Alphabet[(value >> (bits - 5)) & 31])
                bits -= 5
            }
            value &= (1 << bits) - 1
        }
        if bits > 0 { out.append(base32Alphabet[(value << (5 - bits)) & 31]) }
        return out
    }

    static func base32Decoded(_ text: String) -> Data? {
        var out = Data(), value = 0, bits = 0
        for character in text {
            guard let index = base32Alphabet.firstIndex(of: character) else { return nil }
            value = (value << 5) | index
            bits += 5
            if bits >= 8 {
                out.append(UInt8((value >> (bits - 8)) & 0xff))
                bits -= 8
            }
            value &= (1 << bits) - 1
        }
        return out
    }
}

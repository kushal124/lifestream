import CryptoKit
import Darwin
import Foundation

public struct HomeSocket: Sendable, Equatable {
    public static let pointer = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Lifestream/home")

    public let path: String
    public let folder: URL
    public let patience: TimeInterval
    public let failed: @Sendable () -> Void

    public init(path: String, folder: URL, patience: TimeInterval = HomeSocket.restarting, failed: @escaping @Sendable () -> Void = {}) {
        self.path = path
        self.folder = folder
        self.patience = patience
        self.failed = failed
    }

    public static func == (a: HomeSocket, b: HomeSocket) -> Bool {
        a.path == b.path && a.folder == b.folder && a.patience == b.patience
    }

    public static func folder(pointer: URL = HomeSocket.pointer) -> URL? {
        guard let text = try? String(contentsOf: pointer, encoding: .utf8) else { return nil }
        let named = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return named.hasPrefix("/") ? URL(fileURLWithPath: named, isDirectory: true) : nil
    }

    public static func thisMac(pointer: URL = HomeSocket.pointer, failed: @escaping @Sendable () -> Void = {}) -> HomeSocket? {
        guard let folder = folder(pointer: pointer), let id = homeID(folder) else { return nil }
        let path = pointer.deletingLastPathComponent().appendingPathComponent("run/\(name(id)).sock").path
        return HomeSocket(path: path, folder: folder, failed: failed)
    }

    static func name(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    private static func homeID(_ folder: URL) -> String? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("HOME.json")),
              let id = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["id"] as? String,
              !id.isEmpty else { return nil }
        return id
    }

    public func listens() -> Bool {
        guard let fd = try? connection() else { return false }
        Darwin.close(fd)
        return true
    }

    public static let silence: TimeInterval = 60

    public static let restarting: TimeInterval = 60

    public static func blocking<Value: Sendable>(_ work: @escaping @Sendable () -> Value) async -> Value {
        await withCheckedContinuation { going in
            DispatchQueue.global(qos: .userInitiated).async { going.resume(returning: work()) }
        }
    }

    public func ask(_ request: [String: Any], waiting: TimeInterval = 0) throws -> Any {
        dispatchPrecondition(condition: .notOnQueue(.main))
        do {
            return try exchange(request, waiting: waiting)
        } catch let failure as HomeSocketError where failure.reach {
            failed()
            throw failure
        }
    }

    private func exchange(_ request: [String: Any], waiting: TimeInterval) throws -> Any {
        var named = request
        named["folder"] = folder.path
        var line = try JSONSerialization.data(withJSONObject: named)
        line.append(10)
        let fd = try connected(until: Date().addingTimeInterval(waiting))
        defer { Darwin.close(fd) }
        try line.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let sent = Darwin.send(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset, 0)
                if sent < 0 && errno == EINTR { continue }
                guard sent > 0 else { throw errno == EAGAIN ? HomeSocketError.timeout : HomeSocketError.broken }
                offset += sent
            }
        }
        var buffered = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let size = Darwin.recv(fd, &chunk, chunk.count, 0)
            if size < 0 && errno == EINTR { continue }
            if size < 0 { throw errno == EAGAIN ? HomeSocketError.timeout : HomeSocketError.broken }
            guard size > 0 else { throw HomeSocketError.broken }
            buffered.append(contentsOf: chunk[..<size])
            while let newline = buffered.firstIndex(of: 10) {
                let answer = buffered[buffered.startIndex..<newline]
                buffered = Data(buffered[buffered.index(after: newline)...])
                guard let object = (try? JSONSerialization.jsonObject(with: Data(answer))) as? [String: Any] else {
                    throw HomeSocketError.broken
                }
                if let error = object["error"] as? String { throw HomeSocketError.of(error, refusal: object["refusal"] as? [String: Any]) }
                if let result = object["result"] { return result }
            }
        }
    }

    private func connected(until deadline: Date) throws -> Int32 {
        while true {
            do {
                return try connection()
            } catch HomeSocketError.noHome where Date() < deadline {
                Thread.sleep(forTimeInterval: 0.25)
            }
        }
    }

    private func connection() throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HomeSocketError.noHome }
        var on: Int32 = 1
        var time = timeval(tv_sec: Int(Self.silence), tv_usec: 0)
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &time, socklen_t(MemoryLayout<timeval>.size)) == 0 else {
            Darwin.close(fd)
            throw HomeSocketError.broken
        }
        do {
            try connect(fd)
        } catch {
            Darwin.close(fd)
            throw error
        }
        return fd
    }

    private func connect(_ fd: Int32) throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw HomeSocketError.noHome }
        withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes) }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw HomeSocketError.noHome }
    }
}

public enum HomeSocketError: Error, Equatable, CustomStringConvertible {
    case noHome
    case refused(SocketRefusal)
    case broken
    case timeout

    public var reach: Bool {
        switch self {
        case .noHome, .broken, .timeout: true
        case .refused(let refusal): refusal.notNow && (refusal.wait == "starting" || refusal.wait == "needs")
        }
    }

    public var description: String {
        switch self {
        case .noHome: "no home answers this Mac's socket"
        case .refused(let refusal): refusal.words
        case .broken: "the home's socket broke before its answer"
        case .timeout: "the home's socket carried nothing for a minute"
        }
    }

    public static func of(_ error: String, refusal: [String: Any]?) -> HomeSocketError {
        .refused(refusal.flatMap(SocketRefusal.init(line:)) ?? SocketRefusal(words: error))
    }
}

public struct SocketRefusal: Sendable, Equatable, ExpressibleByStringLiteral {
    public let status: Int?
    public let code: String?
    public let words: String
    public let retryAfter: Int?
    public let extra: Data?

    public init(status: Int? = nil, code: String? = nil, words: String, retryAfter: Int? = nil, extra: Data? = nil) {
        self.status = status
        self.code = code
        self.words = words
        self.retryAfter = retryAfter
        self.extra = extra
    }

    public init(stringLiteral words: String) {
        self.init(words: words)
    }

    init?(line refusal: [String: Any]) {
        guard let words = refusal["words"] as? String, !words.isEmpty else { return nil }
        let extra = (refusal["extra"] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
        self.init(status: refusal["status"] as? Int, code: refusal["code"] as? String, words: words,
                  retryAfter: refusal["retryAfter"] as? Int, extra: extra)
    }

    public var notNow: Bool { status == 503 && code == "NOT_NOW" }

    public var wait: String? {
        extra.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["wait"] as? String
    }
}

import Darwin
import Foundation
import Passwords

final class FakeSocketHome: @unchecked Sendable {
    let path: String
    let pointer: URL
    let folder: URL
    private let root: String
    private let fd: Int32
    private let lock = NSLock()
    private var _requests: [[String: Any]] = []
    private var _answer: ([String: Any]) -> [String: Any] = { _ in ["error": "no answer is set"] }
    private var stopped = false

    var requests: [[String: Any]] { lock.withLock { _requests } }
    var verbs: [String] { requests.map { $0["verb"] as? String ?? "" } }
    var answer: ([String: Any]) -> [String: Any] {
        get { lock.withLock { _answer } }
        set { lock.withLock { _answer = newValue } }
    }

    var socket: HomeSocket { HomeSocket(path: path, folder: folder, patience: 0.5) }

    func socket(failed: @escaping @Sendable () -> Void) -> HomeSocket { HomeSocket(path: path, folder: folder, patience: 0.5, failed: failed) }

    init() throws {
        root = "/tmp/lsp-\(UUID().uuidString.prefix(8))"
        (pointer, folder, path) = try SocketMachine.make(root)
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        let bound = Self.withAddress(path) { Darwin.bind(fd, $0, $1) }
        guard bound == 0, Darwin.listen(fd, 8) == 0 else { throw POSIXError(.EADDRINUSE) }
        Thread.detachNewThread { [self] in serve() }
    }

    func stop() {
        let first = lock.withLock { () -> Bool in
            defer { stopped = true }
            return !stopped
        }
        guard first else { return }
        let wake = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        _ = Self.withAddress(path) { Darwin.connect(wake, $0, $1) }
        Darwin.close(wake)
        try? FileManager.default.removeItem(atPath: root)
    }

    private static func withAddress(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> Int32) -> Int32 {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
    }

    private func serve() {
        defer { Darwin.close(fd) }
        while !lock.withLock({ stopped }) {
            let client = Darwin.accept(fd, nil, nil)
            guard client >= 0 else { return }
            if lock.withLock({ stopped }) {
                Darwin.close(client)
                return
            }
            var line = Data()
            var byte: UInt8 = 0
            while Darwin.recv(client, &byte, 1, 0) == 1, byte != 10 { line.append(byte) }
            var request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] ?? [:]
            let refused = SocketMachine.otherFolder(request, folder)
            request["folder"] = nil
            let answer = lock.withLock { () -> [String: Any] in
                _requests.append(request)
                return refused ?? _answer(request)
            }
            for object in [["out": "a line as the verb goes"], answer] {
                var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
                data.append(10)
                _ = data.withUnsafeBytes { Darwin.send(client, $0.baseAddress, $0.count, 0) }
            }
            Darwin.close(client)
        }
    }
}

enum SocketMachine {
    static let wrongKey: [String: Any] = {
        let words = "the Mac app offered a key that is not this vault's: nothing was changed"
        return ["error": words, "refusal": ["status": 403, "code": "VAULT_KEY", "words": words, "extra": [String: Any]()]]
    }()

    static func otherFolder(_ request: [String: Any], _ folder: URL) -> [String: Any]? {
        guard request["folder"] as? String != folder.path else { return nil }
        let words = "a request names the folder of the home it asks (folder)"
        return ["error": words, "refusal": ["status": 400, "code": "BAD_CALL", "words": words, "extra": [String: Any]()]]
    }

    static func make(_ root: String) throws -> (pointer: URL, folder: URL, path: String) {
        let machine = URL(fileURLWithPath: root, isDirectory: true)
        let folder = machine.appendingPathComponent("folder", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONSerialization.data(withJSONObject: ["id": "home-\(UUID().uuidString.prefix(8).lowercased())"])
            .write(to: folder.appendingPathComponent("HOME.json"))
        let pointer = machine.appendingPathComponent("home")
        try Data((folder.path + "\n").utf8).write(to: pointer)
        guard let socket = HomeSocket.thisMac(pointer: pointer) else { throw POSIXError(.ENOENT) }
        try FileManager.default.createDirectory(atPath: (socket.path as NSString).deletingLastPathComponent,
                                                withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return (pointer, socket.folder, socket.path)
    }
}

final class MemoryKeyStore: KeyStore, @unchecked Sendable {
    private let lock = NSLock()
    var hold: DispatchSemaphore?
    private var _data: Data?
    private var _mark: String?
    private var _refusal: KeyStoreError?
    private var _attributesRefusal: KeyStoreError?
    private var _deletes = 0
    private var _prompted: [Bool] = []

    init(_ data: Data? = nil) {
        _data = data
        _mark = data.map(VaultKeyID.of)
    }

    var data: Data? {
        get { lock.withLock { _data } }
        set { lock.withLock { _data = newValue; _mark = newValue.map(VaultKeyID.of) } }
    }
    var mark: String? {
        get { lock.withLock { _mark } }
        set { lock.withLock { _mark = newValue } }
    }
    var attributesRefusal: KeyStoreError? {
        get { lock.withLock { _attributesRefusal } }
        set { lock.withLock { _attributesRefusal = newValue } }
    }
    var refusal: KeyStoreError? {
        get { lock.withLock { _refusal } }
        set { lock.withLock { _refusal = newValue } }
    }
    var deletes: Int { lock.withLock { _deletes } }
    var prompted: [Bool] { lock.withLock { _prompted } }

    func read(prompting: Bool) throws -> Data? {
        lock.withLock { _prompted.append(prompting) }
        hold?.wait()
        return try lock.withLock {
            if let refusal = _refusal { throw refusal }
            return _data
        }
    }

    func held() throws -> Bool {
        lock.withLock { _data != nil }
    }

    func keyID() throws -> String? {
        try lock.withLock {
            if let refusal = _attributesRefusal { throw refusal }
            return _data == nil ? nil : _mark
        }
    }

    func mark(keyID: String) throws {
        try lock.withLock {
            if let refusal = _attributesRefusal { throw refusal }
            guard _data != nil else { throw KeyStoreError.keychain(errSecItemNotFound) }
            _mark = keyID
        }
    }

    func add(_ data: Data) throws {
        try lock.withLock {
            if let refusal = _refusal { throw refusal }
            guard _data == nil else { throw KeyStoreError.keychain(errSecDuplicateItem) }
            _data = data
            _mark = VaultKeyID.of(data)
        }
    }

    func delete() throws {
        lock.withLock {
            _deletes += 1
            _data = nil
            _mark = nil
        }
    }
}

final class Failures: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func add() { lock.withLock { value += 1 } }
}

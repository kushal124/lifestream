import Foundation
import CryptoKit
import Darwin

enum LogLayout {
    static let mark: UInt8 = 0x80
    static let saltBytes = 32
    static let headerBytes = 1 + saltBytes
    static let lengthBytes = 4
    static let nonceBytes = 12
    static let tagBytes = 16
    static let overhead = lengthBytes + nonceBytes + tagBytes
    static let maximumRecord = 16 * 1024 * 1024
    static let info = Data("lifestream-mac:1:log".utf8)

    static func key(_ macKey: SymmetricKey, salt: Data) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: macKey, salt: salt, info: info, outputByteCount: 32)
    }

    static func header(salt: Data = WholeFile.random(saltBytes)) -> Data {
        var header = Data([mark])
        header.append(salt)
        return header
    }

    static func record(_ plain: Data, index: UInt64, key: SymmetricKey, nonce: Data = WholeFile.random(nonceBytes)) -> Data {
        let box = try! AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: nonce), authenticating: associatedData(index))
        var out = Data()
        var length = UInt32(nonceBytes + box.ciphertext.count + tagBytes).bigEndian
        withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
        out.append(nonce)
        out.append(box.ciphertext)
        out.append(box.tag)
        return out
    }

    static func whole(_ plain: Data, macKey: SymmetricKey?) -> Data {
        guard let macKey else { return plain }
        var whole = header()
        let key = key(macKey, salt: whole.subdata(in: 1..<headerBytes))
        var index: UInt64 = 0
        var at = plain.startIndex
        repeat {
            let next = min(at + maximumRecord, plain.endIndex)
            whole.append(record(Data(plain[at..<next]), index: index, key: key))
            index += 1
            at = next
        } while at < plain.endIndex
        return whole
    }

    static func checked(_ declared: UInt32, record: Int, name: String) throws -> Int {
        let count = Int(declared)
        guard count >= nonceBytes + tagBytes else {
            throw DeviceFileError.unreadable(name: name, why: "record \(record) is shorter than its nonce and tag")
        }
        guard count <= maximumRecord + nonceBytes + tagBytes else {
            throw DeviceFileError.unreadable(name: name, why: "record \(record) declares more bytes than a record may hold")
        }
        return count
    }

    static func unseal(_ body: Data, index: UInt64, key: SymmetricKey, name: String) throws -> Data {
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: body.subdata(in: 0..<nonceBytes)),
                ciphertext: body.subdata(in: nonceBytes..<(body.count - tagBytes)),
                tag: body.subdata(in: (body.count - tagBytes)..<body.count)
            )
            return try AES.GCM.open(box, using: key, authenticating: associatedData(index))
        } catch {
            throw DeviceFileError.unreadable(name: name, why: "record \(index) fails its tag")
        }
    }

    static func associatedData(_ index: UInt64) -> Data {
        var big = index.bigEndian
        return withUnsafeBytes(of: &big) { Data($0) }
    }

    struct Walk {
        var salt = Data()
        var records: UInt64 = 0
        var plainBytes = 0
        var end = 0
        var torn = false
    }

    static func walk(_ length: (Int) throws -> UInt32?, salt: Data, size: Int, name: String) throws -> Walk {
        var walk = Walk(salt: salt, end: headerBytes)
        var at = headerBytes
        while at < size {
            guard at + lengthBytes <= size, let declared = try length(at) else {
                walk.torn = true
                break
            }
            let count = try checked(declared, record: Int(walk.records), name: name)
            guard at + lengthBytes + count <= size else {
                walk.torn = true
                break
            }
            walk.records += 1
            walk.plainBytes += count - nonceBytes - tagBytes
            at += lengthBytes + count
            walk.end = at
        }
        return walk
    }

    static func walk(_ fd: Int32, size: Int, naming url: URL) throws -> Walk {
        let name = url.lastPathComponent
        guard let first = try Durable.firstByte(fd, naming: url) else { return Walk(salt: Data(), end: 0) }
        guard first == mark else {
            throw DeviceFileError.unreadable(name: name, why: "its header is not a log's")
        }
        guard size >= headerBytes else { return Walk(salt: Data(), end: 0, torn: true) }
        let header = try Durable.read(fd, count: headerBytes, from: 0, naming: url)
        return try walk({ at in
            try Durable.read(fd, count: lengthBytes, from: at, naming: url).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        }, salt: header.subdata(in: 1..<headerBytes), size: size, name: name)
    }

    final class Opening: Unsealing {
        private let macKey: SymmetricKey
        private let name: String
        private var key: SymmetricKey?
        private var held = Data()
        private var index: UInt64 = 0

        init(macKey: SymmetricKey, name: String) {
            self.macKey = macKey
            self.name = name
        }

        func update(_ disk: Data) throws -> Data {
            held.append(disk)
            if key == nil {
                guard held.count >= headerBytes else { return Data() }
                guard held.first == mark else {
                    throw DeviceFileError.unreadable(name: name, why: "its header is not a log's")
                }
                key = LogLayout.key(macKey, salt: held.subdata(in: 1..<headerBytes))
                held = held.subdata(in: headerBytes..<held.count)
            }
            guard let key else { return Data() }
            var plain = Data()
            var at = 0
            while held.count - at >= lengthBytes {
                let declared = held.subdata(in: at..<(at + lengthBytes)).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
                let count = try checked(declared, record: Int(index), name: name)
                guard held.count - at - lengthBytes >= count else { break }
                let start = at + lengthBytes
                plain.append(try unseal(held.subdata(in: start..<(start + count)), index: index, key: key, name: name))
                index += 1
                at = start + count
            }
            if at > 0 { held = held.subdata(in: at..<held.count) }
            return plain
        }

        func finish() throws -> Data {
            held = Data()
            return Data()
        }
    }
}

public final class Log {
    public static let maximumRecord = LogLayout.maximumRecord

    private let files: DeviceFiles
    let url: URL
    private var descriptor: Int32 = -1
    private var key: SymmetricKey?
    private var macKey: SymmetricKey?
    private var index: UInt64 = 0
    private(set) var end: off_t = 0
    private(set) var damaged = false

    init(files: DeviceFiles, url: URL, keys: DeviceFiles.Keys?) throws {
        self.files = files
        self.url = url
        try open(keys)
    }

    deinit { close() }

    public func append(_ record: Data, flush: DeviceFiles.Flush?) throws {
        try files.shared { keys in
            guard record.count <= LogLayout.maximumRecord else {
                throw DeviceFileError.invalidSizeOrType(name: url.lastPathComponent, maximumBytes: LogLayout.maximumRecord)
            }
            try follow(keys)
            try repairHeld()
            let bytes = sealed(record)
            if let partial = Durable.writeAll(bytes, to: descriptor) {
                if partial.written > 0 {
                    do { try cut() } catch { damaged = true }
                }
                throw partial.error
            }
            end += off_t(bytes.count)
            if macKey != nil { index += 1 }
            if let flush {
                do {
                    try Durable.issue(flush, on: descriptor, naming: url)
                } catch DeviceFileError.io(_, let code) {
                    throw DeviceFileError.notFlushed(name: url.lastPathComponent, code: code)
                }
            }
        }
    }

    public func repair() throws {
        try files.shared { keys in
            try follow(keys)
            try repairHeld()
        }
    }

    public func cut(keepingPlainBytes kept: Int) throws {
        try files.shared { keys in
            try follow(keys)
            try repairHeld()
            if macKey != nil {
                guard try LogLayout.walk(descriptor, size: Int(end), naming: url).plainBytes <= kept else {
                    throw DeviceFileError.unreadable(name: url.lastPathComponent,
                                                     why: "a keyed log ends at a record's end, never inside one")
                }
                return
            }
            guard off_t(kept) < end else { return }
            do {
                end = off_t(kept)
                try cut()
            } catch {
                close()
                throw error
            }
        }
    }

    public func flush(_ flush: DeviceFiles.Flush) throws {
        try files.shared { keys in
            try follow(keys)
            try Durable.issue(flush, on: descriptor, naming: url)
        }
    }

    public func truncate() throws {
        try files.shared { keys in
            try follow(keys)
            do {
                if let code = DeviceFiles.failStep?(url, .truncate) {
                    throw Durable.failure("truncate \(url.lastPathComponent)", code: code)
                }
                guard ftruncate(descriptor, 0) == 0 else {
                    throw Durable.failure("truncate \(url.lastPathComponent)")
                }
                end = 0
                damaged = false
                if let macKey { try startKeyed(macKey) }
            } catch {
                close()
                throw error
            }
        }
    }

    public func close() {
        if descriptor >= 0 { Darwin.close(descriptor) }
        descriptor = -1
        key = nil
    }

    private func sealed(_ record: Data) -> Data {
        guard macKey != nil else { return record }
        guard let key else { preconditionFailure("a keyed log appends only under its log key") }
        return LogLayout.record(record, index: index, key: key)
    }

    private func follow(_ keys: DeviceFiles.Keys?) throws {
        guard (keys != nil) != (macKey != nil) || descriptor < 0 else { return }
        close()
        try open(keys)
    }

    private func open(_ keys: DeviceFiles.Keys?) throws {
        key = nil
        macKey = keys?.files
        index = 0
        damaged = false
        let flags = (keys == nil ? O_WRONLY : O_RDWR) | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC
        descriptor = Darwin.open(url.path, flags, 0o600)
        guard descriptor >= 0 else {
            throw Durable.failure("open \(url.lastPathComponent)")
        }
        var info = stat()
        guard fstat(descriptor, &info) == 0 else {
            let failure = Durable.failure("inspect \(url.lastPathComponent)")
            close()
            throw failure
        }
        end = info.st_size
        guard let macKey else { return }
        do {
            let walk = try LogLayout.walk(descriptor, size: Int(info.st_size), naming: url)
            guard walk.end > 0 else {
                if info.st_size > 0 {
                    guard ftruncate(descriptor, 0) == 0 else { throw Durable.failure("cut \(url.lastPathComponent)") }
                    end = 0
                }
                try startKeyed(macKey)
                return
            }
            key = LogLayout.key(macKey, salt: walk.salt)
            index = walk.records
            end = off_t(walk.end)
            damaged = walk.torn
        } catch {
            close()
            throw error
        }
    }

    private func startKeyed(_ macKey: SymmetricKey) throws {
        let header = LogLayout.header()
        try Durable.write(header, to: descriptor)
        key = LogLayout.key(macKey, salt: header.subdata(in: 1..<LogLayout.headerBytes))
        index = 0
        end = off_t(header.count)
    }

    private func repairHeld() throws {
        guard damaged else { return }
        try cut()
        damaged = false
    }

    private func cut() throws {
        if let code = DeviceFiles.failStep?(url, .cut) {
            throw Durable.failure("cut \(url.lastPathComponent)", code: code)
        }
        guard ftruncate(descriptor, end) == 0 else {
            throw Durable.failure("cut \(url.lastPathComponent)")
        }
        try Durable.issue(.barrier, on: descriptor, naming: url)
    }
}

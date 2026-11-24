import Darwin
import DeviceFiles
import Evidence
import Foundation

struct HashCache {
    static let format = "org.lifestreamprotocol.hash-cache/2"
    static let formatBefore = "org.lifestreamprotocol.hash-cache/1"

    struct Entry: Equatable {
        let bytes: Int
        let modifiedAt: Int
        let sha256: String
    }

    struct Failing: Equatable {
        let since: Int
        let last: Int
        let why: String
    }

    static let patience: TimeInterval = 3600

    private let file: URL
    private let files: DeviceFiles
    private var entries: [String: Entry]
    private var failures: [String: Failing]
    private var measured: [String] = []
    private var lines: Int
    private var appendable: Bool

    init(file: URL, files: DeviceFiles) {
        self.file = file
        self.files = files
        let read = Self.read(file, files: files)
        entries = read.entries
        failures = read.failures
        lines = read.lines
        appendable = read.appendable
    }

    var count: Int { entries.count }

    mutating func measure(locator: String, file url: URL, opener: FileOpener = .own) throws -> (sha256: String, bytes: Int)? {
        guard let opened = try opener.open(url), opened.isRegularFile else { return nil }
        let stamp = opened.stamp
        if let held = entries[locator], held.bytes == stamp.bytes, held.modifiedAt == stamp.modifiedAt {
            return (held.sha256, held.bytes)
        }
        let measured = try FileChunks.measure(opened)
        entries[locator] = Entry(bytes: measured.bytes, modifiedAt: stamp.modifiedAt, sha256: measured.sha256)
        self.measured.append(locator)
        return measured
    }

    mutating func measureNamed(locator: String, file url: URL, opener: FileOpener, at: Date) throws -> (sha256: String, bytes: Int)? {
        do { return try measure(locator: locator, file: url, opener: opener) } catch let refused as StoreFiles.Unsafe {
            throw refused
        } catch {
            failed(locator: locator, why: ShipperRunRow.reason(error), at: at)
            return nil
        }
    }

    mutating func shipped(_ locators: some Sequence<String>) {
        for locator in locators where failures[locator] != nil {
            failures[locator] = nil
            if entries[locator] != nil { measured.append(locator) }
        }
    }

    mutating func failed(locator: String, why: String, at: Date) {
        let now = Int((at.timeIntervalSince1970 * 1000).rounded(.down))
        entries[locator] = nil
        failures[locator] = Failing(since: failures[locator]?.since ?? now, last: now, why: why)
        measured.append(locator)
        ShippingState.log.notice("a file a store names was left out of its seal: \(why, privacy: .public) (\(locator, privacy: .private))")
    }

    func failing(at now: Date) -> [(locator: String, why: String)] {
        let now = Int((now.timeIntervalSince1970 * 1000).rounded(.down)), patience = Int(Self.patience * 1000)
        return failures.filter { $0.value.last - $0.value.since >= patience && now - $0.value.last <= patience }
            .sorted { JSONText.javaScriptOrder($0.key, $1.key) }.map { ($0.key, $0.value.why) }
    }

    mutating func save() throws {
        guard !measured.isEmpty else { return }
        let held = Set(entries.keys).union(failures.keys).count
        let appended = measured.reduce(into: Data()) { $0 += line($1) }
        if appendable && lines + measured.count <= max(2 * held, 64) && appended.count <= Log.maximumRecord {
            let log = try files.log(file)
            defer { log.close() }
            try log.append(appended, flush: .barrier)
            lines += measured.count
        } else {
            let data = Set(entries.keys).union(failures.keys).sorted(by: JSONText.javaScriptOrder).reduce(into: Self.header) {
                $0 += line($1)
            }
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try files.replaceLog(file, with: data)
            lines = held
            appendable = true
        }
        measured = []
    }

    private static let header = JSONText.object([("format", .string(format))]).data + Data("\n".utf8)

    private func line(_ locator: String) -> Data {
        if let failing = failures[locator] {
            return JSONText.object([("locator", .string(locator)), ("failing_since_ms", .int(failing.since)),
                                    ("failed_at_ms", .int(failing.last)), ("why", .string(failing.why))]).data + Data("\n".utf8)
        }
        let entry = entries[locator]!
        return JSONText.object([("locator", .string(locator)), ("bytes", .int(entry.bytes)),
                                ("mtime_ns", .int(entry.modifiedAt)), ("sha256", .string(entry.sha256))]).data + Data("\n".utf8)
    }

    private static func entry(_ value: Any?) -> Entry? {
        guard let row = value as? [String: Any],
              let bytes = row["bytes"] as? Int, bytes >= 0,
              let modifiedAt = row["mtime_ns"] as? Int,
              let sha256 = row["sha256"] as? String, ShippingState.isHexSHA256(sha256) else { return nil }
        return Entry(bytes: bytes, modifiedAt: modifiedAt, sha256: sha256)
    }

    private static func failing(_ value: Any?) -> Failing? {
        guard let row = value as? [String: Any], let since = row["failing_since_ms"] as? Int,
              let last = row["failed_at_ms"] as? Int, last >= since, let why = row["why"] as? String else { return nil }
        return Failing(since: since, last: last, why: why)
    }

    private static func read(_ file: URL, files: DeviceFiles) -> (entries: [String: Entry], failures: [String: Failing], lines: Int, appendable: Bool) {
        guard let data = try? files.read(file, maximumBytes: ShippingState.mostKept) else { return ([:], [:], 0, false) }
        let first = data.firstIndex(of: 0x0A) ?? data.endIndex
        guard let head = try? JSONSerialization.jsonObject(with: data[..<first]) as? [String: Any] else {
            return ([:], [:], 0, false)
        }
        guard head["format"] as? String == format else { return (before(head), [:], 0, false) }
        guard first < data.endIndex else { return ([:], [:], 0, false) }
        let lines = data[(first + 1)...].split(separator: 0x0A)
        var array = Data("[".utf8)
        for (index, line) in lines.enumerated() {
            if index > 0 { array.append(0x2C) }
            array.append(contentsOf: line)
        }
        array.append(0x5D)
        let rows = (try? JSONSerialization.jsonObject(with: array) as? [Any])
            ?? lines.compactMap { try? JSONSerialization.jsonObject(with: $0) }
        var held: [String: Entry] = [:]
        var failures: [String: Failing] = [:]
        for row in rows {
            guard let locator = (row as? [String: Any])?["locator"] as? String else { continue }
            if let entry = entry(row) {
                held[locator] = entry
                failures[locator] = nil
            } else if let failing = failing(row) {
                failures[locator] = failing
                held[locator] = nil
            }
        }
        return (held, failures, lines.count, data.last == 0x0A)
    }

    private static func before(_ object: [String: Any]) -> [String: Entry] {
        guard object["format"] as? String == formatBefore, let stated = object["entries"] as? [String: Any] else { return [:] }
        return stated.compactMapValues(entry)
    }
}

enum FileFacts {
    private static let statPath: @convention(c) (UnsafePointer<CChar>?, UnsafeMutablePointer<stat>?) -> Int32 = stat
    private static let lstatPath: @convention(c) (UnsafePointer<CChar>?, UnsafeMutablePointer<stat>?) -> Int32 = lstat

    struct Stamp: Equatable {
        let bytes: Int
        let modifiedAt: Int
    }

    static func of(_ path: String) -> stat? {
        var status = stat()
        guard statPath(path, &status) == 0 else { return nil }
        return status
    }

    static func isRegularFile(_ path: String) -> Bool {
        guard let status = of(path) else { return false }
        return status.st_mode & S_IFMT == S_IFREG
    }

    static func regularFileSize(_ path: String) -> Int? {
        guard let status = of(path), status.st_mode & S_IFMT == S_IFREG else { return nil }
        return Int(status.st_size)
    }

    static func stamp(_ path: String) -> Stamp? {
        of(path).map(stamp(of:))
    }

    static func stamp(of status: stat) -> Stamp {
        Stamp(bytes: Int(status.st_size), modifiedAt: nanoseconds(status.st_mtimespec))
    }

    static func entry(_ path: String) -> stat? {
        var status = stat()
        guard lstatPath(path, &status) == 0 else { return nil }
        return status
    }

    static func isDirectory(_ path: String) -> Bool {
        guard let status = entry(path) else { return false }
        return status.st_mode & S_IFMT == S_IFDIR
    }

    private static func nanoseconds(_ time: timespec) -> Int {
        Int(time.tv_sec) * 1_000_000_000 + Int(time.tv_nsec)
    }
}

import Darwin
import DeviceFiles
import Evidence
import Foundation
import SQLite3
import zlib

public struct PowerLogCopy {
    public static let tables: [(table: String, file: String)] = [
        ("PLCoalitionAgent_EventInterval_CoalitionInterval", "coalitions"),
        ("PLBatteryAgent_EventBackward_Battery", "battery"),
    ]
    public static let currentName = "CurrentPowerlog.PLSQL"
    public static let cursorName = "cursor.json"

    public let source: URL
    public let destination: URL
    public let work: URL
    private let files: DeviceFiles
    private let pruner: DayFiles.Pruner

    public init(source: URL, destination: URL, files: DeviceFiles, scratch: URL) {
        self.source = source
        self.destination = destination
        work = scratch.appendingPathComponent(".work", isDirectory: true)
        self.files = files
        pruner = DayFiles.Pruner(in: destination, prefixes: Self.tables.map { $0.file + "-" })
    }

    public struct Pass: Equatable {
        public var rows: [String: Int] = [:]
        public var archivesRead: [String] = []
    }

    @discardableResult
    public func run(now: Date = Date()) throws -> Pass {
        pruner.prune(at: now)
        try? FileManager.default.removeItem(at: work)
        OwnerOnly.folder(destination)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: Int(OwnerOnly.folderMode)])
        defer { try? FileManager.default.removeItem(at: work) }
        var cursor = loadCursor()
        var pass = Pass()

        let archives = source.appendingPathComponent("Archives", isDirectory: true)
        let present = ((try? FileManager.default.contentsOfDirectory(atPath: archives.path)) ?? [])
            .filter { $0.hasSuffix(".PLSQL.gz") }.sorted()
        cursor.archives = cursor.archives.filter(present.contains)
        for name in present where !cursor.archives.contains(name) {
            let inflated = work.appendingPathComponent("archive.PLSQL")
            try? FileManager.default.removeItem(at: inflated)
            try Self.gunzip(archives.appendingPathComponent(name), to: inflated)
            try copyRows(from: inflated, immutable: true, cursor: &cursor, pass: &pass)
            try? FileManager.default.removeItem(at: inflated)
            cursor.archives.append(name)
            pass.archivesRead.append(name)
            try saveCursor(cursor)
        }

        let current = source.appendingPathComponent(Self.currentName)
        if FileManager.default.fileExists(atPath: current.path) {
            let clone = work.appendingPathComponent(Self.currentName)
            let wal = URL(fileURLWithPath: current.path + "-wal")
            if FileManager.default.fileExists(atPath: wal.path) {
                try Self.clone(wal, to: URL(fileURLWithPath: clone.path + "-wal"))
            }
            try Self.clone(current, to: clone)
            try copyRows(from: clone, immutable: false, cursor: &cursor, pass: &pass)
        }
        try saveCursor(cursor)
        return pass
    }


    struct Cursor: Codable {
        struct Mark: Codable {
            var id: Int64
            var timestamp: Double
        }

        var archives: [String] = []
        var tables: [String: Mark] = [:]
    }

    private var cursorURL: URL { destination.appendingPathComponent(Self.cursorName) }

    private func loadCursor() -> Cursor {
        guard let data = try? files.read(cursorURL, maximumBytes: 1 << 20),
              let cursor = try? JSONDecoder().decode(Cursor.self, from: data) else { return Cursor() }
        return cursor
    }

    private func saveCursor(_ cursor: Cursor) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try files.replace(cursorURL, with: encoder.encode(cursor), commit: .atomic)
        chmod(cursorURL.path, OwnerOnly.fileMode)
    }


    private func copyRows(from database: URL, immutable: Bool, cursor: inout Cursor, pass: inout Pass) throws {
        let reader = try PowerLogDatabase(database, immutable: immutable)
        for (table, file) in Self.tables where reader.has(table) {
            let mark = cursor.tables[table] ?? Cursor.Mark(id: 0, timestamp: 0)
            var next = mark
            var days: [String: Data] = [:]
            var copied = 0
            func flush(_ day: String) throws {
                guard let lines = days.removeValue(forKey: day) else { return }
                try append(lines, to: destination.appendingPathComponent("\(file)-\(day).jsonl"))
            }
            try reader.rows(of: table, after: mark.id, orAfter: mark.timestamp) { id, timestamp, row in
                next.id = max(next.id, id)
                next.timestamp = max(next.timestamp, timestamp)
                let day = String(UTCInstant.rfc3339(Date(timeIntervalSince1970: timestamp)).prefix(10))
                days[day, default: Data()].append(row)
                days[day]!.append(0x0A)
                copied += 1
                if days[day]!.count >= 1 << 20 { try flush(day) }
            }
            for day in Array(days.keys) { try flush(day) }
            cursor.tables[table] = next
            if copied > 0 { pass.rows[file, default: 0] += copied }
        }
    }

    private func append(_ data: Data, to url: URL) throws {
        do {
            let log = try files.log(url)
            defer { log.close() }
            try log.append(data, flush: nil)
            chmod(url.path, OwnerOnly.fileMode)
        } catch {
            throw PowerLogError.write
        }
    }


    private static func clone(_ source: URL, to destination: URL) throws {
        guard copyfile(source.path, destination.path, nil, copyfile_flags_t(COPYFILE_CLONE)) == 0 else {
            throw PowerLogError.copy
        }
    }

    private static func gunzip(_ source: URL, to destination: URL) throws {
        guard let input = gzopen(source.path, "rb") else { throw PowerLogError.copy }
        defer { gzclose(input) }
        let output = open(destination.path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
        guard output >= 0 else { throw PowerLogError.copy }
        defer { close(output) }
        var buffer = [UInt8](repeating: 0, count: 1 << 20)
        while true {
            let count = gzread(input, &buffer, UInt32(buffer.count))
            guard count >= 0 else { throw PowerLogError.copy }
            if count == 0 { return }
            guard write(output, buffer, Int(count)) == Int(count) else { throw PowerLogError.copy }
        }
    }
}

enum PowerLogError: Error {
    case copy
    case write
    case read(String)
}

private final class PowerLogDatabase {
    private var handle: OpaquePointer?

    init(_ url: URL, immutable: Bool) throws {
        let path = immutable ? "file:\(url.path)?immutable=1" : url.path
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK else {
            let message = handle.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "open"
            sqlite3_close(handle)
            throw PowerLogError.read(message)
        }
    }

    deinit { sqlite3_close(handle) }

    func has(_ table: String) -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                                 -1, &statement, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, table, -1, transient)
        return sqlite3_step(statement) == SQLITE_ROW
    }

    func rows(of table: String, after id: Int64, orAfter timestamp: Double,
              _ body: (Int64, Double, Data) throws -> Void) throws {
        var statement: OpaquePointer?
        let sql = "SELECT * FROM \"\(table)\" WHERE ID > ?1 OR timestamp > ?2 ORDER BY ID"
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            throw PowerLogError.read(String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, id)
        sqlite3_bind_double(statement, 2, timestamp)
        let width = sqlite3_column_count(statement)
        let names = (0..<width).map { column -> String in
            let name = String(cString: sqlite3_column_name(statement, column))
            return name == "BundleId" ? "bundle_id" : name
        }
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { return }
            guard code == SQLITE_ROW else { throw PowerLogError.read(String(cString: sqlite3_errmsg(handle))) }
            try autoreleasepool { try row(statement, width: width, names: names, body) }
        }
    }

    private func row(_ statement: OpaquePointer?, width: Int32, names: [String],
                     _ body: (Int64, Double, Data) throws -> Void) throws {
        var object: [String: Any] = [:]
        var rowID: Int64 = 0
        var rowTime: Double = 0
        for column in 0..<width {
            let name = names[Int(column)]
            switch sqlite3_column_type(statement, column) {
            case SQLITE_INTEGER:
                let value = sqlite3_column_int64(statement, column)
                if name == "ID" { rowID = value }
                object[name] = value
            case SQLITE_FLOAT:
                let value = sqlite3_column_double(statement, column)
                guard value.isFinite else { continue }
                if name == "timestamp" || name == "timestampEnd" {
                    if name == "timestamp" { rowTime = value }
                    object[name] = UTCInstant.rfc3339(Date(timeIntervalSince1970: value))
                } else {
                    object[name] = value
                }
            case SQLITE_TEXT:
                object[name] = String(cString: sqlite3_column_text(statement, column))
            case SQLITE_BLOB:
                let count = Int(sqlite3_column_bytes(statement, column))
                if let bytes = sqlite3_column_blob(statement, column) {
                    object[name] = Data(bytes: bytes, count: count).base64EncodedString()
                }
            default:
                continue
            }
        }
        let line = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        try body(rowID, rowTime, line)
    }

    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
}

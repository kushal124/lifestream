import Foundation
import SQLite3

enum SQLite {
    enum Cell: Equatable {
        case null
        case text(String)
        case other
    }

    static func columns(of table: String, in database: URL) throws -> Set<String> {
        var declared: Set<String> = []
        let quoted = table.replacingOccurrences(of: "\"", with: "\"\"")
        try rows("PRAGMA table_info(\"\(quoted)\")", in: database) { cells in
            if cells.count > 1, case .text(let name) = cells[1] { declared.insert(name) }
        }
        return declared
    }

    static func integer(_ sql: String, in database: URL) throws -> Int? {
        try reading(database) { try integer(sql, on: $0) }
    }

    static func text(_ sql: String, in database: URL) throws -> String? {
        var first: String??
        try query(sql, in: database) { row in if first == nil { first = .some(row.first ?? nil) } }
        return first ?? nil
    }

    static func query(_ sql: String, in database: URL, _ row: ([String?]) throws -> Void) throws {
        try rows(sql, in: database) { cells in
            try row(cells.map { cell in
                if case .text(let value) = cell { return value }
                return nil
            })
        }
    }

    static func rows(_ sql: String, in database: URL, _ row: ([Cell]) throws -> Void) throws {
        try reading(database) { try rows(sql, on: $0, row) }
    }


    static func open(_ url: URL, flags: Int32 = SQLITE_OPEN_READONLY) throws -> OpaquePointer {
        var handle: OpaquePointer?
        let code = sqlite3_open_v2(url.path, &handle, flags, nil)
        guard code == SQLITE_OK, let handle else {
            let mode = flags == SQLITE_OPEN_READONLY ? "read-only" : "read-write"
            let why = handle.map { message($0) } ?? "cannot open \(mode) (code \(code))"
            if let handle { sqlite3_close(handle) }
            throw SQLiteError.sqlite("open \(url.lastPathComponent)", why)
        }
        return handle
    }

    static func source(_ database: URL) throws -> OpaquePointer {
        var opened: OpaquePointer?
        guard sqlite3_open_v2(":memory:", &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, nil) == SQLITE_OK,
              let handle = opened else {
            sqlite3_close(opened)
            throw SQLiteError.sqlite("open a scratch database", "no memory")
        }
        do {
            try exec("ATTACH \(SQLiteDelta.literal(database.absoluteString + "?mode=ro")) AS source", on: handle)
        } catch {
            sqlite3_close(handle)
            throw error
        }
        return handle
    }

    private static func reading<T>(_ database: URL, _ body: (OpaquePointer) throws -> T) throws -> T {
        let handle = try open(database)
        defer { sqlite3_close(handle) }
        return try body(handle)
    }

    static func message(_ handle: OpaquePointer) -> String {
        guard let text = sqlite3_errmsg(handle) else { return "no message" }
        let words = String(cString: text)
        let primary = sqlite3_extended_errcode(handle) & 0xff
        let system = sqlite3_system_errno(handle)
        guard primary == SQLITE_CANTOPEN || primary == SQLITE_IOERR, system != 0 else { return words }
        return "\(words) (\(String(cString: strerror(system))))"
    }

    static func exec(_ sql: String, on handle: OpaquePointer) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(handle, sql, nil, nil, &error) == SQLITE_OK else {
            let why = error.map { String(cString: $0) } ?? message(handle)
            sqlite3_free(error)
            throw SQLiteError.sqlite(sql, why)
        }
        sqlite3_free(error)
    }

    static func integer(_ sql: String, on handle: OpaquePointer) throws -> Int? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteError.sqlite("prepare \(sql)", message(handle))
        }
        defer { sqlite3_finalize(statement) }
        let code = sqlite3_step(statement)
        if code == SQLITE_DONE { return nil }
        guard code == SQLITE_ROW else { throw SQLiteError.sqlite("read \(sql)", message(handle)) }
        switch sqlite3_column_type(statement, 0) {
        case SQLITE_NULL: return nil
        case SQLITE_INTEGER:
            guard let value = Int(exactly: sqlite3_column_int64(statement, 0)) else {
                throw SQLiteError.rowId(sql)
            }
            return value
        default: throw SQLiteError.rowId(sql)
        }
    }

    static func rows(_ sql: String, on handle: OpaquePointer, _ row: ([Cell]) throws -> Void) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteError.sqlite("prepare \(sql)", message(handle))
        }
        defer { sqlite3_finalize(statement) }
        let width = Int(sqlite3_column_count(statement))
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { break }
            guard code == SQLITE_ROW else {
                throw SQLiteError.sqlite("read \(sql)", message(handle))
            }
            var cells: [Cell] = []
            cells.reserveCapacity(width)
            for index in 0..<width {
                let column = Int32(index)
                if sqlite3_column_type(statement, column) == SQLITE_NULL {
                    cells.append(.null)
                } else if sqlite3_column_type(statement, column) == SQLITE_TEXT,
                          let text = sqlite3_column_text(statement, column) {
                    cells.append(.text(String(cString: text)))
                } else {
                    cells.append(.other)
                }
            }
            try row(cells)
        }
    }

    static func passesQuickCheck(_ handle: OpaquePointer) throws -> Bool {
        var answers: [Cell] = []
        try rows("PRAGMA quick_check", on: handle) { answers.append($0.first ?? .null) }
        return answers == [.text("ok")]
    }
}

enum SQLiteError: PathFreeError, Equatable {
    case missing(String)
    case denied(String, String)
    case sqlite(String, String)
    case integrity(String)
    case rowId(String)

    var description: String {
        switch self {
        case .missing(let name): return "no such database \(name)"
        case .denied(let name, let why): return "\(name) cannot be read: \(why)"
        case .sqlite(let operation, let why): return "sqlite could not \(operation): \(why)"
        case .integrity(let name): return "the copy \(name) failed quick_check"
        case .rowId(let sql): return "\(sql) does not state an integer row id this machine holds"
        }
    }
}

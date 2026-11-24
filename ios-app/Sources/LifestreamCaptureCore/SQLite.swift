import Foundation
import SQLite3

public struct SQLiteError: Error, CustomStringConvertible, Equatable {
    public let code: Int32
    public let message: String
    public var description: String { "SQLite \(code): \(message)" }
}

public enum SQLiteValue: Sendable {
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)
    case null
}

public final class SQLiteDatabase {
    private let handle: OpaquePointer
    private var statements: [String: OpaquePointer] = [:]

    public init(url: URL, create: Bool = false) throws {
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX
            | SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION
        if create { flags |= SQLITE_OPEN_CREATE }
        var opened: OpaquePointer?
        let code = sqlite3_open_v2(url.path, &opened, flags, nil)
        guard let opened else { throw SQLiteError(code: code, message: "cannot open \(url.lastPathComponent)") }
        handle = opened
        guard code == SQLITE_OK else {
            let error = SQLiteError(code: code, message: String(cString: sqlite3_errmsg(opened)))
            sqlite3_close_v2(opened)
            throw error
        }
        sqlite3_busy_timeout(handle, 10_000)
        try execute("""
            PRAGMA page_size = 16384;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA journal_size_limit = 67108864;
            """)
    }

    deinit {
        for statement in statements.values { sqlite3_finalize(statement) }
        sqlite3_close_v2(handle)
    }

    public func execute(_ sql: String) throws {
        try check(sqlite3_exec(handle, sql, nil, nil, nil))
    }

    public private(set) var transactions = 0

    public func write<T>(cause: String = "other", _ body: () throws -> T) throws -> T {
        transactions += 1
        EnergyLedger.shared.count("store_transactions")
        EnergyLedger.shared.count("store_transactions_\(cause)")
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    public func read<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN")
        defer { try? execute("COMMIT") }
        return try body()
    }

    @discardableResult
    public func run(_ sql: String, _ values: SQLiteValue...) throws -> Int {
        try run(sql, values)
    }

    @discardableResult
    public func run(_ sql: String, _ values: [SQLiteValue]) throws -> Int {
        try query(sql, values) { _ in }
        return Int(sqlite3_changes(handle))
    }

    public func query(_ sql: String, _ values: SQLiteValue..., row: (SQLiteRow) throws -> Void) throws {
        try query(sql, values, row: row)
    }

    public func query(_ sql: String, _ values: [SQLiteValue], row: (SQLiteRow) throws -> Void) throws {
        let statement = try prepared(sql)
        defer {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
        }
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            switch value {
            case .integer(let value): try check(sqlite3_bind_int64(statement, index, value))
            case .real(let value): try check(sqlite3_bind_double(statement, index, value))
            case .text(let value): try check(sqlite3_bind_text(statement, index, value, -1, transient))
            case .blob(let value):
                try check(value.withUnsafeBytes {
                    sqlite3_bind_blob64(statement, index, $0.baseAddress ?? UnsafeRawPointer(bitPattern: 1),
                        sqlite3_uint64($0.count), transient)
                })
            case .null: try check(sqlite3_bind_null(statement, index))
            }
        }
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { return }
            guard code == SQLITE_ROW else { throw error(code) }
            try row(SQLiteRow(statement: statement))
        }
    }

    public func integer(_ sql: String, _ values: SQLiteValue...) throws -> Int64? {
        var result: Int64?
        try query(sql, values) { row in if result == nil, !row.isNull(0) { result = row.integer(0) } }
        return result
    }

    private func prepared(_ sql: String) throws -> OpaquePointer {
        if let statement = statements[sql] { return statement }
        var statement: OpaquePointer?
        try check(sqlite3_prepare_v3(handle, sql, -1, UInt32(SQLITE_PREPARE_PERSISTENT), &statement, nil))
        guard let statement else { throw SQLiteError(code: SQLITE_MISUSE, message: "empty statement") }
        statements[sql] = statement
        return statement
    }

    private func check(_ code: Int32) throws {
        guard code == SQLITE_OK else { throw error(code) }
    }

    private func error(_ code: Int32) -> SQLiteError {
        SQLiteError(code: code, message: String(cString: sqlite3_errmsg(handle)))
    }

    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
}

public struct SQLiteRow {
    fileprivate let statement: OpaquePointer

    public func isNull(_ column: Int32) -> Bool { sqlite3_column_type(statement, column) == SQLITE_NULL }
    public func integer(_ column: Int32) -> Int64 { sqlite3_column_int64(statement, column) }
    public func real(_ column: Int32) -> Double { sqlite3_column_double(statement, column) }

    public func text(_ column: Int32) -> String? {
        sqlite3_column_text(statement, column).map { String(cString: $0) }
    }

    public func blob(_ column: Int32) -> Data {
        guard let bytes = sqlite3_column_blob(statement, column) else { return Data() }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, column)))
    }
}

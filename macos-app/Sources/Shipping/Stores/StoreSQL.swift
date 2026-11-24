import Foundation
import HomeLink
import SQLite3

enum StoreSQL {
    static let functions: Set<String> = [
        "abs", "avg", "char", "coalesce", "count", "date", "datetime", "format", "glob", "group_concat", "hex", "ifnull", "iif",
        "instr", "json_extract", "json_type", "json_valid", "julianday", "length", "like", "likelihood", "likely", "lower",
        "ltrim", "max", "min", "nullif", "octet_length", "printf", "quote", "replace", "round", "rtrim", "sign", "strftime",
        "string_agg", "substr", "substring", "sum", "time", "total", "trim", "typeof", "unicode", "unixepoch", "unlikely", "upper",
    ]
    static let temporary: Set<String> = ["touched", "selected", "fresh"]

    struct Fragment: Equatable {
        let at: String
        let sql: String
        let statement: String
    }

    static func fragments(of store: HomeLink.MacStore.SqliteStore, declared: Set<String>) -> [Fragment] {
        var found: [Fragment] = []
        for (index, table) in store.tables.enumerated() where declared.contains(table.name) {
            let at = "tables[\(index)]"
            let name = SQLiteDelta.quoted(table.name)
            if case .main(let time, _) = table.role { found.append(Fragment(at: "\(at).role.main.time", sql: time, statement: "SELECT (\(time)) FROM \(name)")) }
            if let keep = applying(table.keep, declared).first {
                found.append(Fragment(at: "\(at).keep", sql: keep, statement: "SELECT 1 FROM \(name) WHERE (\(keep))"))
            }
            if let chosen = table.chosen { found.append(Fragment(at: "\(at).chosen", sql: chosen, statement: "SELECT 1 FROM \(name) WHERE (\(chosen))")) }
            for (file, sql) in (table.files ?? []).enumerated() {
                found.append(Fragment(at: "\(at).files[\(file)]", sql: sql, statement: "SELECT (\(sql)) FROM \(name)"))
            }
            for (pair, touched) in (table.touchedBy ?? []).enumerated() where declared.contains(touched[0]) && applies(touched, declared) {
                found.append(Fragment(at: "\(at).touched_by[\(pair)]", sql: touched[1], statement: "SELECT k FROM (\(touched[1]))"))
            }
        }
        if let attachments = store.attachments {
            for (index, select) in applyingEvery(attachments.select, declared).enumerated() {
                found.append(Fragment(at: "attachments.select[\(index)]", sql: select, statement: "SELECT * FROM (\(select))"))
            }
        }
        return found
    }

    static func applying(_ selects: HomeLink.MacStore.SqliteStore.Selects?, _ declared: Set<String>) -> [String] {
        switch selects {
        case nil: return []
        case .one(let sql)?: return [sql]
        case .first(let alternatives)?: return alternatives.filter { $0.when.map(declared.contains) ?? true }.map(\.sql)
        }
    }

    static func applies(_ touched: [String], _ declared: Set<String>) -> Bool {
        touched.count == 2 || (touched.count == 3 && declared.contains(touched[2]))
    }

    static func applyingEvery(_ selects: HomeLink.MacStore.SqliteStore.Selects, _ declared: Set<String>) -> [String] {
        applying(selects, declared)
    }

    static func declared(on handle: OpaquePointer, schema: String = "source") throws -> Set<String> {
        var tables: [String] = []
        try SQLite.rows("SELECT name FROM \(SQLiteDelta.quoted(schema)).sqlite_master WHERE type = 'table'", on: handle) { cells in
            if case .text(let name) = cells.first { tables.append(name) }
        }
        var declared = Set(tables)
        for table in tables where !table.lowercased().hasPrefix("sqlite_") {
            try SQLite.rows("SELECT name FROM pragma_table_info(\(SQLiteDelta.literal(table)), \(SQLiteDelta.literal(schema)))", on: handle) { cells in
                if case .text(let column) = cells.first { declared.insert("\(table).\(column)") }
            }
        }
        return declared
    }

    static func check(_ store: HomeLink.MacStore.SqliteStore, against database: URL) throws {
        try scratch(database) { handle, declared, guardian in
            for fragment in fragments(of: store, declared: declared) {
                if let fault = lexicalFault(fragment.sql) { throw StoreFiles.Unsafe(reason: "\(fragment.at): \(fault)") }
                try compile(fragment.statement, at: fragment.at, on: handle, guardian)
            }
        }
    }

    static func compile(_ statement: String, against database: URL) throws {
        try scratch(database) { handle, _, guardian in try compile(statement, at: "the statement", on: handle, guardian) }
    }

    private static func scratch(_ database: URL, _ body: (OpaquePointer, Set<String>, Authorizer) throws -> Void) throws {
        var opened: OpaquePointer?
        guard sqlite3_open_v2(":memory:", &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, nil) == SQLITE_OK,
              let handle = opened else {
            sqlite3_close(opened)
            throw SQLiteError.sqlite("open a scratch database", "no memory")
        }
        defer { sqlite3_close(handle) }
        try SQLite.exec("ATTACH \(SQLiteDelta.literal(database.absoluteString + "?mode=ro")) AS source", on: handle)
        let declared = try declared(on: handle)
        let own = Set(declared.filter { !$0.contains(".") }.map { $0.lowercased() })
        for table in temporary.sorted() {
            try SQLite.exec("CREATE TEMP TABLE \(table) (t_name TEXT, t_key INTEGER, t_fp INTEGER)", on: handle)
        }
        let guardian = Authorizer(own: own)
        let context = Unmanaged.passRetained(guardian)
        defer {
            sqlite3_set_authorizer(handle, nil, nil)
            context.release()
        }
        sqlite3_set_authorizer(handle, { context, action, first, second, database, _ in
            let guardian = Unmanaged<Authorizer>.fromOpaque(context!).takeUnretainedValue()
            return guardian.decide(action, first.map { String(cString: $0) }, second.map { String(cString: $0) },
                                   database.map { String(cString: $0) })
        }, context.toOpaque())
        try body(handle, declared, guardian)
    }

    private static func compile(_ statement: String, at: String, on handle: OpaquePointer, _ guardian: Authorizer) throws {
        guardian.refused = nil
        let (code, rest) = statement.withCString { text -> (Int32, String) in
            var prepared: OpaquePointer?
            var tail: UnsafePointer<CChar>?
            let code = sqlite3_prepare_v2(handle, text, -1, &prepared, &tail)
            sqlite3_finalize(prepared)
            return (code, tail.map { String(cString: $0) } ?? "")
        }
        if let refused = guardian.refused { throw StoreFiles.Unsafe(reason: "\(at): \(refused) is refused") }
        if code == SQLITE_AUTH { throw StoreFiles.Unsafe(reason: "\(at): the statement is refused") }
        guard code == SQLITE_OK else { throw SQLiteError.sqlite("compile \(at)", SQLite.message(handle)) }
        if !rest.allSatisfy(\.isWhitespace) { throw StoreFiles.Unsafe(reason: "\(at): a second statement is refused") }
    }

    private final class Authorizer {
        let own: Set<String>
        var refused: String?

        init(own: Set<String>) { self.own = own }

        func decide(_ action: Int32, _ first: String?, _ second: String?, _ database: String?) -> Int32 {
            switch action {
            case SQLITE_SELECT, SQLITE_RECURSIVE:
                return SQLITE_OK
            case SQLITE_READ:
                let table = (first ?? "").lowercased()
                switch database {
                case "source"? where own.contains(table) && !table.hasPrefix("sqlite_"): return SQLITE_OK
                case "temp"? where StoreSQL.temporary.contains(table): return SQLITE_OK
                case nil: return SQLITE_OK
                default: return deny("a read of \(first ?? "a table") the store does not hold")
                }
            case SQLITE_FUNCTION:
                let name = (second ?? "").lowercased()
                return StoreSQL.functions.contains(name) ? SQLITE_OK : deny("the function \(second ?? "")")
            case SQLITE_ATTACH, SQLITE_DETACH: return deny("an attach")
            case SQLITE_PRAGMA: return deny("a pragma")
            case SQLITE_INSERT, SQLITE_UPDATE, SQLITE_DELETE: return deny("a write")
            case SQLITE_CREATE_VTABLE, SQLITE_DROP_VTABLE: return deny("a virtual table")
            case SQLITE_TRANSACTION, SQLITE_SAVEPOINT: return deny("a transaction")
            default: return deny("a schema change")
            }
        }

        private func deny(_ what: String) -> Int32 {
            if refused == nil { refused = what }
            return SQLITE_DENY
        }
    }

    static func lexicalFault(_ sql: String) -> String? {
        let characters = Array(sql.unicodeScalars)
        var depth = 0
        var index = 0
        while index < characters.count {
            let character = characters[index]
            switch character {
            case "'", "\"", "`", "[":
                let close: Unicode.Scalar = character == "[" ? "]" : character
                index += 1
                while index < characters.count {
                    if characters[index] == close {
                        if close != "]", index + 1 < characters.count, characters[index + 1] == close { index += 2; continue }
                        break
                    }
                    index += 1
                }
                if index >= characters.count { return "a quote does not close" }
            case ";": return "a second statement is refused"
            case "-" where index + 1 < characters.count && characters[index + 1] == "-": return "a comment is refused"
            case "/" where index + 1 < characters.count && characters[index + 1] == "*": return "a comment is refused"
            case "(": depth += 1
            case ")":
                depth -= 1
                if depth < 0 { return "a parenthesis closes what it did not open" }
            case "\0": return "holds a NUL"
            default: break
            }
            index += 1
        }
        return depth == 0 ? nil : "a parenthesis does not close"
    }
}

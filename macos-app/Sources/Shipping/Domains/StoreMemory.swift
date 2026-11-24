import Darwin
import DeviceFiles
import Foundation
import SQLite3

struct StoreMemory {
    let file: URL
    let files: DeviceFiles

    init(file: URL, files: DeviceFiles) {
        self.file = file
        self.files = files
    }

    func named(_ value: String) -> String {
        files.name(value)
    }

    static let schema = [
        "CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value) WITHOUT ROWID",
        "CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, key INTEGER NOT NULL, fingerprint INTEGER NOT NULL, "
            + "seal INTEGER NOT NULL, files TEXT, PRIMARY KEY (tbl, key)) WITHOUT ROWID",
        "CREATE INDEX IF NOT EXISTS rows_seal ON rows (seal)",
        "CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, seal INTEGER NOT NULL) WITHOUT ROWID",
        "CREATE INDEX IF NOT EXISTS blobs_seal ON blobs (seal)",
    ]

    struct Begun: Equatable {
        let identity: String?
        let stamp: String?
        let owed: Int
        let months: Months?
        let countedAt: Int?

        func countDue(at now: Date) -> Bool {
            countedAt.map { now.timeIntervalSince1970 - TimeInterval($0) >= Months.recount } ?? true
        }
    }

    func begin(received: Int) throws -> Begun {
        try writing { handle in
            try SQLite.exec("DELETE FROM rows WHERE seal > \(received)", on: handle)
            var forgot = sqlite3_changes(handle) > 0
            try SQLite.exec("DELETE FROM blobs WHERE seal > \(received)", on: handle)
            forgot = forgot || sqlite3_changes(handle) > 0
            if forgot { try set("stamp", nil, on: handle) }
            let months = try text("months", on: handle).flatMap { try Months(spelled: files.values().decrypt($0)) }
            return Begun(identity: try text("identity", on: handle), stamp: forgot ? nil : try text("stamp", on: handle),
                         owed: try SQLite.integer("SELECT value FROM meta WHERE name = 'owed'", on: handle) ?? 0,
                         months: months, countedAt: months == nil ? nil : try SQLite.integer("SELECT value FROM meta WHERE name = 'counted_at'", on: handle))
        }
    }

    @discardableResult
    func adopt(identity: String, declared: String? = nil) throws -> Bool {
        try writing { handle in
            let held = try text("declared", on: handle)
            let declared = declared.map(named), identity = named(identity)
            let otherDeclaration = held != nil && held != declared
            guard try text("identity", on: handle) != identity || otherDeclaration else {
                if held != declared { try set("declared", declared, on: handle) }
                return false
            }
            try SQLite.exec("DELETE FROM rows", on: handle)
            try set("identity", identity, on: handle)
            try set("declared", declared, on: handle)
            try set("stamp", nil, on: handle)
            try set("owed", nil, on: handle)
            try set("months", nil, on: handle)
            try set("counted_at", nil, on: handle)
            return true
        }
    }

    func counted(_ months: Months, at now: Date) throws {
        try writing { handle in
            try set("months", files.values().encrypt(months.spelled), on: handle)
            try SQLite.exec("INSERT OR REPLACE INTO meta (name, value) VALUES ('counted_at', \(Int(now.timeIntervalSince1970.rounded(.down))))",
                            on: handle)
        }
    }

    func settle(stamp: String, owed: Int) throws {
        try writing { handle in
            try set("stamp", named(stamp), on: handle)
            try SQLite.exec("INSERT OR REPLACE INTO meta (name, value) VALUES ('owed', \(owed))", on: handle)
        }
    }

    func refused(page seal: Int, reason: String) throws -> Bool {
        try writing { handle in
            try SQLite.exec("DELETE FROM rows WHERE seal >= \(seal)", on: handle)
            try SQLite.exec("DELETE FROM blobs WHERE seal >= \(seal)", on: handle)
            let reason = named(reason)
            guard try text("page_refused", on: handle) != reason else { return false }
            try set("page_refused", reason, on: handle)
            return true
        }
    }

    func unsent(_ hashes: some Sequence<String>) throws -> [String] {
        let unique = Set(hashes).sorted()
        guard !unique.isEmpty else { return [] }
        guard FileManager.default.fileExists(atPath: file.path) else { return unique }
        let handle = try SQLite.open(file, flags: SQLITE_OPEN_READONLY)
        defer { sqlite3_close(handle) }
        guard try SQLite.integer("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blobs'", on: handle) != nil else {
            return unique
        }
        return try unique.filter { hash in
            try SQLite.integer("SELECT 1 FROM blobs WHERE hash = \(SQLiteDelta.literal(named(hash)))", on: handle) == nil
        }
    }

    func record(blobs: [String], seal: Int) throws {
        guard !blobs.isEmpty else { return }
        try writing { handle in
            for hash in blobs {
                try SQLite.exec("INSERT OR REPLACE INTO blobs (hash, seal) VALUES (\(SQLiteDelta.literal(named(hash))), \(seal))", on: handle)
            }
        }
    }

    func record(files index: BlobIndex, from database: URL, schema: (Set<String>) -> StoreSchema, seal: Int) throws {
        try writing { handle in
            try SQLite.exec("ATTACH \(SQLiteDelta.literal(database.path)) AS source", on: handle)
            let declared = try StoreSQL.declared(on: handle)
            let sizes = JSONText.object(index.entries.map { ($0.key, .int($0.value.bytes)) }).data
            let json = SQLiteDelta.literal(String(decoding: sizes, as: UTF8.self))
            try SQLite.exec("CREATE TEMP TABLE carried_files (locator TEXT PRIMARY KEY, bytes INTEGER) WITHOUT ROWID", on: handle)
            try SQLite.exec("INSERT INTO carried_files SELECT key, value FROM json_each(\(json))", on: handle)
            for table in schema(declared).tables where !table.files.isEmpty && declared.contains(table.name) {
                let files = table.files.map { "(SELECT bytes FROM temp.carried_files WHERE locator = (\($0)))" }.joined(separator: ", ")
                try SQLite.exec("UPDATE rows SET seal = \(seal), files = (SELECT json_array(\(files)) FROM source.\(SQLiteDelta.quoted(table.name)) "
                                + "WHERE \(SQLiteDelta.quoted(table.key ?? "rowid")) = rows.key) "
                                + "WHERE tbl = \(SQLiteDelta.literal(table.name)) AND (seal = \(seal) OR key IN "
                                + "(SELECT \(SQLiteDelta.quoted(table.key ?? "rowid")) FROM source.\(SQLiteDelta.quoted(table.name))))", on: handle)
            }
        }
    }

    private func writing<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let handle = try SQLite.open(file, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        defer { sqlite3_close(handle) }
        try SQLite.exec("PRAGMA temp_store=MEMORY", on: handle)
        try SQLite.exec("BEGIN IMMEDIATE", on: handle)
        do {
            for statement in Self.schema { try SQLite.exec(statement, on: handle) }
            if try SQLite.integer("SELECT 1 FROM pragma_table_info('rows') WHERE name = 'files'", on: handle) == nil {
                try SQLite.exec("ALTER TABLE rows ADD COLUMN files TEXT", on: handle)
            }
            let value = try body(handle)
            try SQLite.exec("COMMIT", on: handle)
            return value
        } catch {
            if sqlite3_get_autocommit(handle) == 0 { try? SQLite.exec("ROLLBACK", on: handle) }
            throw error
        }
    }

    private func text(_ name: String, on handle: OpaquePointer) throws -> String? {
        var found: String?
        try SQLite.rows("SELECT value FROM meta WHERE name = \(SQLiteDelta.literal(name))", on: handle) { cells in
            if case .text(let value) = cells.first { found = value }
        }
        return found
    }

    private func set(_ name: String, _ value: String?, on handle: OpaquePointer) throws {
        guard let value else {
            return try SQLite.exec("DELETE FROM meta WHERE name = \(SQLiteDelta.literal(name))", on: handle)
        }
        try SQLite.exec("INSERT OR REPLACE INTO meta (name, value) VALUES (\(SQLiteDelta.literal(name)), \(SQLiteDelta.literal(value)))", on: handle)
    }
}

enum FileStamp {
    static func of(_ database: URL) -> String {
        ([database.path] + SQLiteHeldCopy.sidecars.map { database.path + $0 }).map { path in
            var facts = stat()
            guard stat(path, &facts) == 0 else { return "-" }
            let modified = Int64(facts.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(facts.st_mtimespec.tv_nsec)
            return "\(facts.st_dev):\(facts.st_ino):\(facts.st_size):\(modified)"
        }.joined(separator: " ")
    }
}

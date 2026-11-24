import Darwin
import Foundation

enum DatabaseIdentity {
    enum Kind {
        case file, coreData, calendar
    }

    static func of(_ kind: Kind, database: URL, readable: URL) throws -> String {
        switch kind {
        case .file: return try file(database)
        case .coreData: return try stated(readable, sql: "SELECT Z_UUID FROM Z_METADATA LIMIT 1", prefix: "z")
        case .calendar:
            return try stated(readable, sql: "SELECT value FROM _SqliteDatabaseProperties WHERE key = '_UniqueIdentifier'", prefix: "calendar")
        }
    }

    static func file(_ url: URL) throws -> String {
        var status = stat()
        guard stat(url.path, &status) == 0 else { throw DatabaseIdentityError.unreadable(url.lastPathComponent) }
        let born = Int64(status.st_birthtimespec.tv_sec) * 1_000_000_000 + Int64(status.st_birthtimespec.tv_nsec)
        return "file:\(status.st_dev):\(status.st_ino):\(born)"
    }

    private static func stated(_ url: URL, sql: String, prefix: String) throws -> String {
        do {
            guard let id = try SQLite.text(sql, in: url), !id.isEmpty else {
                throw DatabaseIdentityError.none(url.lastPathComponent)
            }
            return "\(prefix):\(id)"
        } catch {
            throw DatabaseIdentityError.none(url.lastPathComponent)
        }
    }

}

enum DatabaseIdentityError: PathFreeError, Equatable {
    case unreadable(String)
    case none(String)

    var description: String {
        switch self {
        case .unreadable(let name): return "the store \(name) cannot be read for its identity"
        case .none(let name): return "the store \(name) states no identity of its own"
        }
    }
}

import CryptoKit
import Foundation
import HomeLink

enum SqliteEngine {
    typealias Declared = HomeLink.MacStore.SqliteStore

    static func domain(sourceId: String, store: HomeLink.MacStore, stores: [Declared], folder: String?, files: StoreFiles,
                       ledgers: Ledgers, hashCache: URL, wake: (@Sendable () -> Void)?,
                       report: @escaping @Sendable (String) -> Void = Differences.log) -> DifferencesDomain {
        DifferencesDomain(sourceId: sourceId, name: store.name, feeder: store.feeder, ledgers: ledgers, hashCache: hashCache, report: report) {
            wake?()
            return try stores.flatMap { try differences(of: $0, folder: folder, files: files) }
        }
    }

    static func differences(of store: Declared, folder: String?, files: StoreFiles) throws -> [Differences.Store] {
        var found: [(member: String, database: URL)] = []
        if let match = store.match {
            let directory = try files.path(store.path, account: folder)
            guard FileFacts.isDirectory(directory.path) else { return [] }
            for name in try FileManager.default.contentsOfDirectory(atPath: directory.path).filter({ StoreFiles.matches(match, $0) }).sorted() {
                let file = try files.admit(directory.appendingPathComponent(name), spelled: "\(store.path)/\(name)")
                if FileFacts.isRegularFile(file.path) { found.append((store.member.replacingOccurrences(of: "<name>", with: name), file)) }
            }
        } else {
            found = [(store.member, try files.path(store.path, account: folder))]
        }
        let root = try store.fileRoot.map { try files.path($0, account: folder) }
        let attachments = store.attachments.map { attachments in
            Differences.Attachments(member: attachments.member) { sealed in try locators(attachments.select, in: sealed) }
        }
        return found.map { file in
            var read = Differences.Store(member: file.member, database: file.database, identity: identity(store.identity),
                                         schema: { schema(store, $0) }, attachments: attachments, fileRoot: root,
                                         optional: store.optional ?? false, vet: { try StoreSQL.check(store, against: $0) })
            read.named = { files.named($0, under: $1) }
            read.opener = files.opener
            read.declared = digest(store)
            return read
        }
    }

    static func digest(_ store: Declared) -> String {
        let json = (try? JSONEncoder().encode(store)).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? NSNull()
        return SHA256.hash(data: Data(StoreDigest.canonical(json).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func identity(_ declared: Declared.Identity) -> DatabaseIdentity.Kind {
        switch declared {
        case .file: return .file
        case .coreData: return .coreData
        case .calendar: return .calendar
        }
    }

    static func schema(_ store: Declared, _ declared: Set<String>) -> StoreSchema {
        StoreSchema(tables: store.tables.map { table in
            let role: StoreSchema.Table.Role
            switch table.role {
            case .changes: role = .changes
            case .follows: role = .follows
            case .whole: role = .whole
            case .main(let time, let rows): role = .main(time: time, rows: rows)
            }
            return StoreSchema.Table(table.name, key: table.key, role, keep: StoreSQL.applying(table.keep, declared).first,
                                     touchedBy: (table.touchedBy ?? []).filter { StoreSQL.applies($0, declared) }.map { ($0[0], $0[1]) },
                                     chosen: table.chosen,
                                     whenDeclared: table.whenDeclared ?? false, files: table.files ?? [])
        })
    }

    static func locators(_ selects: Declared.Selects, in sealed: URL) throws -> [String] {
        let alternatives: [(sql: String, when: String?)]
        switch selects {
        case .one(let sql): alternatives = [(sql, nil)]
        case .first(let list): alternatives = list.map { ($0.sql, $0.when) }
        }
        var found: [String] = []
        for select in alternatives {
            if let when = select.when {
                let parts = when.split(separator: ".", maxSplits: 1).map(String.init)
                let columns = try SQLite.columns(of: parts[0], in: sealed)
                guard parts.count == 2 ? columns.contains(parts[1]) : !columns.isEmpty else { continue }
            }
            try SQLite.rows(select.sql, in: sealed) { cells in
                switch cells.first {
                case .text(let locator)?: if !locator.isEmpty { found.append(locator) }
                case .other?: throw SqliteEngineError.locatorNotText(select.when.flatMap { $0.contains(".") ? $0 : nil })
                default: break
                }
            }
        }
        return found
    }
}

enum SqliteEngineError: PathFreeError, Equatable {
    case locatorNotText(String?)

    var description: String {
        switch self {
        case .locatorNotText(let column?): return "\(column) is not text or NULL"
        case .locatorNotText(nil): return "a file the store names is not text or NULL"
        }
    }
}

import DeviceFiles
import Foundation
import SQLite3

public final class BackupPull {
    public enum Store: String, CaseIterable, Sendable {
        case imessage
        case whatsapp
        case appleCalls = "apple-calls"
    }

    public enum RoomAsk: Sendable, Equatable {
        case stores(bytes: Int64)
        case media(bytes: Int64)
    }

    public struct Progress: Sendable, Equatable {
        public let store: Store
        public let hashed: Int
        public let indexed: Int
    }

    public struct Asks: Sendable {
        public let held: @Sendable ([String]) async throws -> Set<String>
        public let room: @Sendable (RoomAsk) async throws -> Void
        public let most: @Sendable () -> Int64?
        public let progress: @Sendable (Progress) -> Void

        public init(held: @escaping @Sendable ([String]) async throws -> Set<String>,
                    room: @escaping @Sendable (RoomAsk) async throws -> Void,
                    most: @escaping @Sendable () -> Int64? = { nil },
                    progress: @escaping @Sendable (Progress) -> Void = { _ in }) {
            self.held = held
            self.room = room
            self.most = most
            self.progress = progress
        }
    }

    public struct Pulled: Sendable, Equatable {
        public let store: Store
        public let folder: URL
        public let members: [String]
        public let blobs: [BackupDigest]
    }

    public struct Result: Sendable, Equatable {
        public let pulled: [Pulled]
        public let unreadable: [Store: String]
        public var tooLarge: Set<Store> = []
        public let blobs: URL
    }

    public static let heldBatch = 5_000
    public static let progressEvery: Duration = .milliseconds(250)

    private let backup: OpenBackup
    private let destination: URL
    private let work: URL
    private let files: DeviceFiles
    private let asks: Asks
    private var blobs: URL { destination.appendingPathComponent("blobs", isDirectory: true) }

    public init(_ backup: OpenBackup, into destination: URL, scratch: URL, files: DeviceFiles, asks: Asks) {
        self.backup = backup
        self.destination = destination
        self.work = scratch.appendingPathComponent("backup-pull-\(UUID().uuidString)", isDirectory: true)
        self.files = files
        self.asks = asks
    }

    public func run() async throws -> Result {
        try? FileManager.default.removeItem(at: destination)
        defer { try? FileManager.default.removeItem(at: work) }
        do {
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        } catch { throw BackupError.unreadable("\(destination.lastPathComponent) could not be made") }
        do {
            return try await pull()
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }


    private struct Plan {
        let store: Store
        let databases: [(member: String, file: BackupFile, wal: BackupFile?)]
    }

    private struct Read {
        let store: Store
        let folder: URL
        var media: [String: (file: BackupFile, digest: BackupDigest)]
        var memberBytes: Int64
        var accounts: [String]
    }

    private func pull() async throws -> Result {
        let plans = try plan()
        var storeBytes: Int64 = 0
        for plan in plans { for database in plan.databases { storeBytes += database.file.size + (database.wal?.size ?? 0) } }
        try await asks.room(.stores(bytes: storeBytes))
        var reads: [Read] = []
        var unreadable: [Store: String] = [:]
        for plan in plans {
            try Task.checkCancellation()
            try stillTheSame()
            let folder = destination.appendingPathComponent(plan.store.rawValue, isDirectory: true)
            do {
                reads.append(try read(plan, into: folder))
            } catch BackupError.unreadable(let why) {
                try? FileManager.default.removeItem(at: folder)
                unreadable[plan.store] = why
            }
        }
        try stillTheSame()
        let accounts = ["apple": reads.first { $0.store == .imessage }?.accounts ?? [],
                        "whatsapp": reads.first { $0.store == .whatsapp }?.accounts ?? []]

        var bySha: [String: BackupFile] = [:]
        for read in reads { for (_, medium) in read.media { bySha[medium.digest.sha256] = medium.file } }
        let hashes = bySha.keys.sorted()
        var held = Set<String>()
        for start in stride(from: 0, to: hashes.count, by: Self.heldBatch) {
            held.formUnion(try await asks.held(Array(hashes[start..<min(start + Self.heldBatch, hashes.count)])))
        }
        func lacking(_ read: Read) -> [BackupDigest] {
            Array(Set(read.media.values.map(\.digest)).filter { !held.contains($0.sha256) }).sorted { $0.sha256 < $1.sha256 }
        }
        var tooLarge = Set<Store>()
        if let most = asks.most() {
            for read in reads where read.memberBytes + lacking(read).reduce(0, { $0 + $1.bytes }) > most {
                try? FileManager.default.removeItem(at: read.folder)
                tooLarge.insert(read.store)
            }
            reads.removeAll { tooLarge.contains($0.store) }
        }
        let lackingAll = Set(reads.flatMap(lacking))
        let largest = reads.map { read in read.memberBytes + lacking(read).reduce(0) { $0 + $1.bytes } }.max() ?? 0
        try await asks.room(.media(bytes: lackingAll.reduce(0) { $0 + $1.bytes } + largest))

        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        for digest in lackingAll.sorted(by: { $0.sha256 < $1.sha256 }) {
            try Task.checkCancellation()
            let made = work.appendingPathComponent(digest.sha256)
            let written: BackupDigest
            do {
                written = try backup.extract(bySha[digest.sha256]!, to: made)
            } catch BackupError.unreadable { continue }
            guard written == digest else { throw BackupError.remade }
            try place(made, at: Self.blob(digest.sha256, in: blobs, files: files))
        }
        try stillTheSame()

        var pulled: [Pulled] = []
        for read in reads {
            try write(data: Self.backupJSON(facts(of: read.store, accounts: accounts)), to: read.folder.appendingPathComponent("backup.json"))
            let members = try FileManager.default.contentsOfDirectory(atPath: read.folder.path).sorted()
            pulled.append(Pulled(store: read.store, folder: read.folder, members: members, blobs: lacking(read)))
        }
        return Result(pulled: pulled, unreadable: unreadable, tooLarge: tooLarge, blobs: blobs)
    }

    public static func blob(_ sha256: String, in blobs: URL, files: DeviceFiles) -> URL {
        blobs.appendingPathComponent(files.name(sha256))
    }

    private func plan() throws -> [Plan] {
        func database(_ member: String, _ place: (domain: String, path: String)) throws -> (member: String, file: BackupFile, wal: BackupFile?)? {
            guard let file = try backup.file(domain: place.domain, path: place.path), file.isFile else { return nil }
            let wal = try backup.file(domain: place.domain, path: BackupStore.wal(of: place.path))
            return (member, file, wal?.isFile == true ? wal : nil)
        }
        var plans: [Plan] = []
        if let messages = try database("messages.db", BackupStore.messages) {
            plans.append(Plan(store: .imessage, databases: [messages]))
        }
        if let chats = try database("chats.sqlite", BackupStore.whatsAppChats) {
            plans.append(Plan(store: .whatsapp, databases: [chats] + [try database("calls.sqlite", BackupStore.whatsAppCalls)].compactMap { $0 }))
        }
        if let calls = try database("callhistory.sqlite", BackupStore.calls) {
            plans.append(Plan(store: .appleCalls, databases: [calls]))
        }
        return plans
    }

    private func read(_ plan: Plan, into folder: URL) throws -> Read {
        asks.progress(Progress(store: plan.store, hashed: 0, indexed: 0))
        let made = work.appendingPathComponent(plan.store.rawValue, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: made) }
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for database in plan.databases {
            let member = made.appendingPathComponent(database.member)
            try backup.extract(database.file, to: member)
            if let wal = database.wal { try backup.extract(wal, to: URL(fileURLWithPath: member.path + "-wal")) }
            try Self.fold(member)
        }
        var read = Read(store: plan.store, folder: folder, media: [:], memberBytes: 0, accounts: [])
        switch plan.store {
        case .imessage:
            read.media = try index(plan.store, pointers: try Self.strings("SELECT DISTINCT filename FROM attachment WHERE filename IS NOT NULL",
                                                                          in: made.appendingPathComponent("messages.db")),
                                   domain: BackupStore.messageAttachments.domain, under: BackupStore.messageAttachments.prefix) { filename in
                guard let at = filename.range(of: BackupStore.messageAttachments.prefix) else { return nil }
                return (path: String(filename[at.lowerBound...]), key: String(filename[filename.index(at.lowerBound, offsetBy: "Library/SMS/".count)...]))
            }
            try writeIndex(read.media, to: folder.appendingPathComponent("attachments.json"))
            read.accounts = try appleAccounts(made.appendingPathComponent("messages.db"))
        case .whatsapp:
            read.media = try index(plan.store, pointers: try Self.strings("SELECT DISTINCT ZMEDIALOCALPATH FROM ZWAMEDIAITEM WHERE ZMEDIALOCALPATH IS NOT NULL AND ZMEDIALOCALPATH != ''",
                                                                          in: made.appendingPathComponent("chats.sqlite")),
                                   domain: BackupStore.whatsAppMessage.domain, under: BackupStore.whatsAppMessage.prefix) { pointer in
                (path: BackupStore.whatsAppMessage.prefix + pointer, key: pointer)
            }
            try writeIndex(read.media, to: folder.appendingPathComponent("media.json"))
            read.accounts = try ownJabberID()
        case .appleCalls:
            break
        }
        for database in plan.databases {
            try place(made.appendingPathComponent(database.member), at: folder.appendingPathComponent(database.member))
        }
        read.memberBytes = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .reduce(0) { $0 + Int64(try files.size(of: $1)) }
        return read
    }

    private func place(_ made: URL, at kept: URL) throws {
        do {
            try files.place(made, at: kept, flush: .barrier)
        } catch { throw BackupError.unreadable("\(kept.lastPathComponent) could not be kept") }
    }

    private func index(_ store: Store, pointers: [String], domain: String, under prefix: String,
                       place: (String) -> (path: String, key: String)?) throws -> [String: (file: BackupFile, digest: BackupDigest)] {
        var files: [String: BackupFile] = [:]
        for file in try backup.files(domain: domain, under: prefix) where file.isFile { files[file.relativePath] = file }
        var named: [(key: String, file: BackupFile)] = []
        var keys = Set<String>()
        for pointer in pointers {
            guard let placed = place(pointer), let file = files[placed.path], keys.insert(placed.key).inserted else { continue }
            named.append((placed.key, file))
        }
        var media: [String: (file: BackupFile, digest: BackupDigest)] = [:]
        let clock = ContinuousClock()
        var told = clock.now
        asks.progress(Progress(store: store, hashed: 0, indexed: named.count))
        for (done, entry) in named.enumerated() {
            try Task.checkCancellation()
            do {
                media[entry.key] = (entry.file, try backup.digest(entry.file))
            } catch BackupError.unreadable {}
            if done + 1 == named.count || clock.now - told >= Self.progressEvery {
                told = clock.now
                asks.progress(Progress(store: store, hashed: done + 1, indexed: named.count))
            }
        }
        return media
    }

    private func appleAccounts(_ messages: URL) throws -> [String] {
        let logins = try Self.strings("SELECT DISTINCT account_login FROM chat WHERE account_login IS NOT NULL", in: messages)
        return Set(logins.compactMap { login -> String? in
            guard login.lowercased().hasPrefix("e:") else { return nil }
            let value = login.dropFirst(2).trimmingCharacters(in: .whitespaces).lowercased()
            return value.isEmpty ? nil : value
        }).sorted()
    }

    private func ownJabberID() throws -> [String] {
        guard let preferences = try backup.file(domain: BackupStore.whatsAppPreferences.domain, path: BackupStore.whatsAppPreferences.path),
              preferences.isFile else { return [] }
        guard let plist = try? PropertyListSerialization.propertyList(from: try backup.contents(preferences), format: nil) as? [String: Any],
              let own = plist["OwnJabberID"] as? String, !own.isEmpty else { return [] }
        return [own]
    }

    struct Facts {
        let store: Store
        let accounts: [String: [String]]
        let device: String
        let encrypted: Bool
        let ios: String
        let lastBackup: Date
        let model: String
        let modelName: String
        let serial4: String?
    }

    private func facts(of store: Store, accounts: [String: [String]]) -> Facts {
        let folder = backup.folder
        return Facts(store: store, accounts: accounts, device: folder.device, encrypted: folder.encrypted,
                     ios: folder.productVersion, lastBackup: folder.lastBackup, model: folder.productType,
                     modelName: folder.modelName, serial4: folder.serial4)
    }

    static func backupJSON(_ facts: Facts) throws -> Data {
        var json: [String: Any] = [
            "accounts": facts.accounts.mapValues { Array(Set($0)).sorted() },
            "device": facts.device,
            "encrypted": facts.encrypted,
            "ios": facts.ios,
            "last_backup": BackupFolder.stamp.string(from: facts.lastBackup),
            "model": facts.model,
            "model_name": facts.modelName,
            "store": facts.store.rawValue,
        ]
        if let serial4 = facts.serial4 { json["serial4"] = serial4 }
        do {
            return try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys, .withoutEscapingSlashes])
        } catch { throw BackupError.unreadable("backup.json could not be written") }
    }

    private func stillTheSame() throws {
        guard let now = try? BackupFolder(at: backup.folder.url), now.finished, now.lastBackup == backup.folder.lastBackup else {
            throw BackupError.remade
        }
    }


    static let blobIndexFormat = "org.lifestreamprotocol.blob-index/1"

    private func writeIndex(_ media: [String: (file: BackupFile, digest: BackupDigest)], to url: URL) throws {
        var entries: [String: Any] = [:]
        for (locator, item) in media { entries[locator] = ["sha256": item.digest.sha256, "bytes": item.digest.bytes] }
        try write(json: ["format": Self.blobIndexFormat, "entries": entries], to: url)
    }

    private func write(json: Any, to url: URL) throws {
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys, .withoutEscapingSlashes])
        } catch { throw BackupError.unreadable("\(url.lastPathComponent) could not be written") }
        try write(data: data, to: url)
    }

    private func write(data: Data, to url: URL) throws {
        do {
            try files.replace(url, with: data, commit: .atomic)
        } catch { throw BackupError.unreadable("\(url.lastPathComponent) could not be written") }
    }

    static func fold(_ url: URL) throws {
        let name = url.lastPathComponent
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db else {
            sqlite3_close(db)
            throw BackupError.unreadable("\(name) is no database")
        }
        do {
            let checkpoint = try row("PRAGMA wal_checkpoint(TRUNCATE)", db: db, name: name)
            guard checkpoint.first == "0" else { throw BackupError.unreadable("\(name)'s log did not fold in") }
            guard try row("PRAGMA journal_mode=DELETE", db: db, name: name).first == "delete" else {
                throw BackupError.unreadable("\(name) stayed in WAL mode")
            }
        } catch {
            sqlite3_close(db)
            throw error
        }
        sqlite3_close(db)
        for sibling in ["-wal", "-shm"] { try? FileManager.default.removeItem(atPath: url.path + sibling) }
    }

    private static func row(_ sql: String, db: OpaquePointer, name: String) throws -> [String] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw BackupError.unreadable("\(name) is no database: \(String(cString: sqlite3_errmsg(db)))")
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw BackupError.unreadable("\(name) did not answer \(sql)") }
        return (0..<sqlite3_column_count(statement)).map { column in
            sqlite3_column_text(statement, column).map { String(cString: $0) } ?? ""
        }
    }

    static func strings(_ sql: String, in url: URL) throws -> [String] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
            sqlite3_close(db)
            throw BackupError.unreadable("\(url.lastPathComponent) is no database")
        }
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw BackupError.unreadable("\(url.lastPathComponent) holds no table for \(sql): \(String(cString: sqlite3_errmsg(db)))")
        }
        defer { sqlite3_finalize(statement) }
        var values: [String] = []
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
            if let text = sqlite3_column_text(statement, 0) { values.append(String(cString: text)) }
            step = sqlite3_step(statement)
        }
        guard step == SQLITE_DONE else { throw BackupError.unreadable("\(url.lastPathComponent) stopped reading (\(step))") }
        return values
    }
}

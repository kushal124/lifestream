import DeviceFiles
import Evidence
import Foundation

public struct ImportLedger: Sendable {
    public let file: URL
    public let files: DeviceFiles
    let written: (@Sendable () -> Void)?

    public init(file: URL, files: DeviceFiles, written: (@Sendable () -> Void)? = nil) {
        self.file = file
        self.files = files
        self.written = written
    }

    public static func `in`(_ carried: URL, files: DeviceFiles, written: (@Sendable () -> Void)? = nil) -> ImportLedger {
        ImportLedger(file: carried.appendingPathComponent("imports.json"), files: files, written: written)
    }

    func kept(_ record: Record) -> DeviceFiles? {
        record.backup == nil ? nil : files
    }

    public enum State: String, Codable, Sendable {
        case checking, refused, waiting, sending, already, sent, missing
    }

    public enum Why: String, Codable, Sendable {
        case damaged
        case notThisKind = "not-this-kind"
        case nothingRead = "nothing-read"
        case tooLarge = "too-large"
        case turn
        case macRoom = "mac-room"
        case homeRoom = "home-room"
        case battery
    }

    public struct Record: Codable, Sendable, Equatable {
        public let id: String
        public let kind: String
        public var path: String
        public var bytes: Int64
        public var modified: Date
        public var state: State
        public var why: Why?
        public var sha256: String?
        public var seal: Int?
        public var pass: String?
        public var blobs: [Blob]?
        public var bundle: Int64?
        public var backup: String?
        public var bundled: Bool?

        public init(id: String, kind: String, path: String, bytes: Int64, modified: Date, state: State = .checking, why: Why? = nil) {
            self.id = id
            self.kind = kind
            self.path = path
            self.bytes = bytes
            self.modified = modified
            self.state = state
            self.why = why
        }

        public var name: String { (path as NSString).lastPathComponent }

        var unsent: Bool { state == .waiting || state == .sending }

        public var owed: Bool { state == .checking || unsent }

        public var waitBytes: Int64 { bundle ?? bytes }

        var keepsItsFolder: Bool { backup != nil && (state == .checking || unsent && bundled != true) }

        var outcome: Outcome {
            switch state {
            case .checking, .waiting, .sending: return .owed
            case .sent, .already: return .sent
            case .refused: return why == .tooLarge ? .tooLarge : .unreadable
            case .missing: return .lost
            }
        }
    }

    public enum Outcome: String, Codable, Sendable {
        case owed, sent, unreadable
        case tooLarge = "too-large"
        case lost
    }

    public struct Backup: Codable, Sendable, Equatable {
        public var at: Date
        public var stores: [String: Outcome]

        public init(at: Date, stores: [String: Outcome]) {
            self.at = at
            self.stores = stores
        }

        public var owed: Bool { stores.values.contains(.owed) }
    }

    public struct Blob: Codable, Sendable, Equatable {
        public let path: String
        public let sha256: String
        public let bytes: Int64

        public init(path: String, sha256: String, bytes: Int64) {
            self.path = path
            self.sha256 = sha256
            self.bytes = bytes
        }
    }

    public struct Contents: Codable, Sendable, Equatable {
        public var files: [Record] = []
        public var backups: [String: Backup]?

        public init() {}
    }

    public func read() throws -> Contents {
        try Self.lock.withLock { try load() }
    }

    @discardableResult
    public func change<Value>(_ body: (inout Contents) throws -> Value) throws -> Value {
        let (value, wrote) = try Self.lock.withLock { () -> (Value, Bool) in
            var contents = try load()
            let before = contents
            let value = try body(&contents)
            Self.settle(&contents)
            guard contents != before else { return (value, false) }
            try write(contents)
            if !Self.kept(before).subtracting(Self.kept(contents)).isEmpty { prune(contents) }
            return (value, true)
        }
        if wrote { written?() }
        return value
    }

    static func settle(_ contents: inout Contents) {
        guard contents.files.contains(where: { $0.backup != nil }) else { return }
        for record in contents.files {
            guard let backup = record.backup else { continue }
            contents.backups?[backup]?.stores[record.name] = record.outcome
        }
        contents.files.removeAll { $0.backup != nil && [.refused, .missing].contains($0.state) }
    }


    public var backupsFolder: URL { file.deletingLastPathComponent().appendingPathComponent("backups", isDirectory: true) }

    public func backupFolder(_ backup: String) -> URL {
        backupsFolder.appendingPathComponent(files.name(backup), isDirectory: true)
    }

    private static func kept(_ contents: Contents) -> Set<String> {
        var kept = Set<String>()
        for record in contents.files where record.keepsItsFolder {
            kept.insert(URL(fileURLWithPath: record.path).standardizedFileURL.path)
            for blob in record.blobs ?? [] { kept.insert(URL(fileURLWithPath: blob.path).standardizedFileURL.path) }
        }
        return kept
    }

    private static var underWay: Set<String> = []

    public func pulling(_ folders: [URL]) {
        Self.lock.withLock { Self.underWay.formUnion(folders.map(\.standardizedFileURL.path)) }
    }

    public func pulled(_ folders: [URL]) {
        Self.lock.withLock {
            Self.underWay.subtract(folders.map(\.standardizedFileURL.path))
            if let contents = try? load() { prune(contents) }
        }
    }

    public func prune() throws {
        try Self.lock.withLock { prune(try load()) }
    }

    private func prune(_ contents: Contents) {
        let skipped = Self.underWay
        Self.prune(backupsFolder.standardizedFileURL, keeping: Self.kept(contents), skipping: skipped)
    }

    @discardableResult
    private static func prune(_ folder: URL, keeping kept: Set<String>, skipping: Set<String>) -> Bool {
        guard let names = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey]) else {
            return false
        }
        var stays = false
        for url in names {
            let path = url.standardizedFileURL.path
            if kept.contains(path) || skipping.contains(path) {
                stays = true
                continue
            }
            let isFolder = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            if isFolder, kept.contains(where: { $0.hasPrefix(path + "/") }) || skipping.contains(where: { $0.hasPrefix(path + "/") }),
               prune(url, keeping: kept, skipping: skipping) {
                stays = true
                continue
            }
            try? FileManager.default.removeItem(at: url)
        }
        return stays
    }


    public func handOver(_ urls: [URL], kind: String) throws -> [Record] {
        try change { contents in
            var checking: [Record] = []
            for url in urls {
                let stamp = ImportFiles.stamp(url, kept: nil)
                let bytes = stamp?.bytes ?? 0, modified = stamp?.modified ?? Date(timeIntervalSince1970: 0)
                if let at = contents.files.firstIndex(where: { $0.kind == kind && $0.path == url.path }) {
                    guard [.refused, .missing].contains(contents.files[at].state) else { continue }
                    contents.files[at] = Record(id: contents.files[at].id, kind: kind, path: url.path, bytes: bytes, modified: modified)
                    checking.append(contents.files[at])
                    continue
                }
                let record = Record(id: UUID().uuidString.lowercased(), kind: kind, path: url.path, bytes: bytes, modified: modified)
                contents.files.append(record)
                checking.append(record)
            }
            return checking
        }
    }

    public func handOver(backup: String, stores: [(folder: URL, blobs: [Blob])], left: [String: Outcome] = [:], kind: String,
                         at: Date) throws -> [Record] {
        try change { contents in
            var checking: [Record] = []
            var backups = contents.backups ?? [:]
            backups[backup] = Backup(at: at, stores: left)
            contents.backups = backups
            for store in stores {
                guard !contents.files.contains(where: { $0.path == store.folder.path && $0.owed }) else { continue }
                let stamp = ImportFiles.stamp(store.folder, kept: files)
                let bytes = stamp?.bytes ?? 0
                var record = Record(id: UUID().uuidString.lowercased(), kind: kind, path: store.folder.path, bytes: bytes,
                                    modified: stamp?.modified ?? Date(timeIntervalSince1970: 0))
                record.blobs = store.blobs
                record.bundle = bytes + store.blobs.reduce(0) { $0 + $1.bytes }
                record.backup = backup
                contents.files.append(record)
                checking.append(record)
            }
            return checking
        }
    }

    public func again(_ id: String, at url: URL) throws -> Record? {
        try change { contents in
            guard let at = contents.files.firstIndex(where: { $0.id == id && $0.state == .missing }) else { return nil }
            let stamp = ImportFiles.stamp(url, kept: nil)
            let record = Record(id: id, kind: contents.files[at].kind, path: url.path, bytes: stamp?.bytes ?? 0,
                                modified: stamp?.modified ?? Date(timeIntervalSince1970: 0))
            contents.files[at] = record
            return record
        }
    }

    public func check(_ record: Record, against kind: ImportCheck, most: Int64) throws {
        let outcome = ImportFiles.check(URL(fileURLWithPath: record.path), bytes: record.bytes, modified: record.modified,
                                        against: kind, most: most, bundle: record.bundle, kept: kept(record))
        try change { contents in
            guard let at = contents.files.firstIndex(where: { $0.id == record.id && $0.path == record.path && $0.state == .checking }) else {
                return
            }
            contents.files[at].state = outcome.state
            contents.files[at].why = outcome.why
        }
    }

    @discardableResult
    public func forget(_ id: String) throws -> Bool {
        try change { contents in
            let before = contents.files.count
            contents.files.removeAll { $0.id == id && [.refused, .missing, .already, .sent].contains($0.state) }
            return contents.files.count < before
        }
    }

    public func launch() throws {
        try change { contents in contents.files.removeAll { $0.state == .already } }
    }


    private static let lock = NSLock()

    private func load() throws -> Contents {
        guard FileManager.default.fileExists(atPath: file.path) else { return Contents() }
        do {
            guard let data = try files.read(file, maximumBytes: ShippingState.mostKept) else { return Contents() }
            return try Self.decoder.decode(Contents.self, from: data)
        } catch {
            throw ImportLedgerError.unreadable(file.lastPathComponent)
        }
    }

    private func write(_ contents: Contents) throws {
        do {
            try ShippingState.replace(file, with: try Self.encoder.encode(contents) + Data("\n".utf8), files: files)
        } catch {
            throw ImportLedgerError.unwritable(file.lastPathComponent)
        }
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(UTCInstant.rfc3339(date))
        }
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = UTCInstant.date(rfc3339: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an instant"))
            }
            return date
        }
        return decoder
    }()
}

public enum ImportLedgerError: PathFreeError, Equatable {
    case unreadable(String)
    case unwritable(String)

    public var description: String {
        switch self {
        case .unreadable(let name): return "the import ledger \(name) does not read"
        case .unwritable(let name): return "the import ledger \(name) cannot be written"
        }
    }
}

public struct ImportCheck: Sendable, Equatable {
    public let recognise: [String]
    public let leaves: [String]
    public let root: String?

    public init(recognise: [String], leaves: [String] = [], root: String? = nil) {
        self.recognise = recognise
        self.leaves = leaves
        self.root = root
    }
}

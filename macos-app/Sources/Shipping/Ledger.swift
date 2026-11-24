import DeviceFiles
import Evidence
import Foundation

protocol LedgerEntry: Codable, Equatable, Sendable {
    func absorbing(_ older: Self) -> Self
}

struct SealLedger<Entry: LedgerEntry> {
    let file: URL
    let files: DeviceFiles

    func held(through received: Int) throws -> [(seal: Int, entry: Entry)] {
        try read().filter { $0.key <= received }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    func newest(through received: Int) throws -> Entry? {
        try held(through: received).last?.entry
    }

    func rolledBack(after received: Int) throws -> [Entry] {
        try read().filter { $0.key > received }.sorted { $0.key < $1.key }.map(\.value)
    }

    func record(_ entry: Entry, at seal: Int) throws {
        var seals = try read().filter { $0.key < seal }
        seals[seal] = entry
        try write(seals)
    }

    func prune(imported: Int) throws {
        let seals = try read()
        guard let base = seals.keys.filter({ $0 <= imported }).max() else { return }
        var kept = seals.filter { $0.key >= base }
        for older in seals.keys.filter({ $0 < base }).sorted(by: >) {
            kept[base] = kept[base]!.absorbing(seals[older]!)
        }
        if kept != seals { try write(kept) }
    }

    func update(_ change: (Int, Entry) -> Entry?) throws {
        let seals = try read()
        let changed = Dictionary(uniqueKeysWithValues: seals.compactMap { seal, entry in change(seal, entry).map { (seal, $0) } })
        if changed != seals { try write(changed) }
    }

    func read() throws -> [Int: Entry] {
        do {
            guard let data = try files.read(file, maximumBytes: ShippingState.mostKept) else { return [:] }
            let stored = try JSONDecoder().decode(Stored.self, from: data)
            var seals: [Int: Entry] = [:]
            for (key, entry) in stored.seals {
                guard let seal = Int(key), seal >= 0, String(seal) == key else { throw LedgerError.unreadable(file.lastPathComponent) }
                seals[seal] = entry
            }
            return seals
        } catch {
            throw LedgerError.unreadable(file.lastPathComponent)
        }
    }

    private func write(_ seals: [Int: Entry]) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let stored = Stored(seals: Dictionary(uniqueKeysWithValues: seals.map { (String($0.key), $0.value) }))
        try ShippingState.replace(file, with: try encoder.encode(stored) + Data("\n".utf8), files: files)
    }

    private struct Stored: Codable {
        let seals: [String: Entry]
    }
}

enum LedgerError: PathFreeError, Equatable {
    case unreadable(String)

    var description: String {
        switch self {
        case .unreadable(let name): return "the ledger \(name) is not a map of seals to what each carried"
        }
    }
}

public struct Lost: Sendable, Equatable {
    public let items: Int
    public let what: String

    public init(items: Int, what: String) {
        self.items = items
        self.what = what
    }

    var json: JSONText { .object([("items", .int(items)), ("what", .string(what))]) }
}

protocol DeletingEntry: LedgerEntry {
    var deleted: Int { get }
}

extension SealLedger where Entry: DeletingEntry {
    func lost(after received: Int, word: String) throws -> [Lost] {
        let deleted = try rolledBack(after: received).reduce(0) { $0 + $1.deleted }
        return deleted == 0 ? [] : [Lost(items: deleted, what: "\(word), up to that many: this Mac deleted them after an earlier import")]
    }
}

public struct SealCustody: Sendable, Equatable {
    public let pass: String
    public let received: Int
    public let imported: Int
    public let history: Bool

    public init(pass: String, received: Int, imported: Int, history: Bool = true) {
        self.pass = pass
        self.received = received
        self.imported = imported
        self.history = history
    }

    public var seal: Int { received + 1 }

    func manifest(_ source: String, lost: [Lost]) -> JSONText {
        var members: [(String, JSONText)] = [("seal", .int(seal))]
        if !lost.isEmpty { members.append(("lost", .array(lost.map(\.json)))) }
        return .object([(source, .object(members))])
    }
}

public struct Ledgers: Sendable {
    public let root: URL
    public let files: DeviceFiles

    public init(root: URL, files: DeviceFiles) {
        self.root = root
        self.files = files
    }

    public func fileName(forSource source: String) -> String {
        ShippingState.fileName(forSource: files.name(source))
    }

    func file(pass: String, source: String) -> URL {
        root.appendingPathComponent(ShippingState.fileName(forSource: pass), isDirectory: true)
            .appendingPathComponent(fileName(forSource: source) + ".json")
    }

    func memory(pass: String, source: String) -> URL {
        root.appendingPathComponent(ShippingState.fileName(forSource: pass), isDirectory: true)
            .appendingPathComponent(fileName(forSource: source), isDirectory: true)
    }

    func ledger<Entry: LedgerEntry>(_ type: Entry.Type = Entry.self, pass: String, source: String) -> SealLedger<Entry> {
        SealLedger(file: file(pass: pass, source: source), files: files)
    }

    func keep(only pass: String) {
        let kept = ShippingState.fileName(forSource: pass)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? [] where name != kept {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(name, isDirectory: true))
        }
    }
}

struct HashEntry: LedgerEntry {
    var mark: String?
    var hashes: [String]

    func absorbing(_ older: HashEntry) -> HashEntry {
        HashEntry(mark: mark, hashes: Array(Set(hashes).union(older.hashes)).sorted())
    }

    static func shipped(_ ledger: SealLedger<HashEntry>, through received: Int) throws -> Set<String> {
        Set(try ledger.held(through: received).flatMap(\.entry.hashes))
    }
}

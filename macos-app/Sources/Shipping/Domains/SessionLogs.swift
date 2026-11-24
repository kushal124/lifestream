import CryptoKit
import DeviceFiles
import Evidence
import Foundation
import HomeLink

struct SessionLog: Equatable {
    let name: String
    let url: URL
    let bytes: Int
    let modifiedAt: Int
    var wholeOf: String? = nil
}

enum SessionStarter: Equatable {
    case person
    case program
    case notYet
    case unreadable
}

struct SessionLogShipper {
    static let defaultBudget = 256 << 20
    static let tailBytes = 4096
    static let margin = 60 * 1_000_000_000
    static let partsFile = "parts.json"
    static let guardBytes = 64 << 20
    static let unreadCode = "SESSION_LOG_UNREADABLE"

    let sourceId: String
    let feeder: String
    let stateFile: URL
    let ledgers: Ledgers
    let budget: Int
    var opener: FileOpener = .own
    let historyOwed = SealNote(false)
    let stated = SealNote<Through?>(nil)

    var owesHistory: Bool { historyOwed.value }
    var through: Through? { stated.value }

    func seal(_ request: SealRequest, listedAt: Date, list: (_ known: Set<String>, _ askFrom: Int) throws -> [SessionLog],
              starter: (SessionLog) throws -> SessionStarter) throws -> [SealedBundle] {
        stated.value = nil
        var state = readState()
        let askFrom = state.askedThrough - Self.margin
        let logs = try list(Set(state.people + (state.unread ?? []) + (state.undecided ?? [])), askFrom)
        let listed = Dictionary(logs.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })

        var people = Set(state.people).intersection(listed.keys)
        var unread = Set(state.unread ?? []).intersection(listed.keys)
        var undecided = Set(state.undecided ?? []).intersection(listed.keys)
        var asked = false
        for log in logs where log.wholeOf == nil && !people.contains(log.name) && log.modifiedAt >= askFrom {
            asked = true
            unread.remove(log.name)
            undecided.remove(log.name)
            switch try StoreFiles.unlessRefused({ try starter(log) }) {
            case .person: people.insert(log.name)
            case .program: break
            case .unreadable: unread.insert(log.name)
            case .notYet, nil: undecided.insert(log.name)
            }
        }
        if asked { state.askedThrough = Self.nanoseconds(listedAt) }
        let changed = asked || people != Set(state.people) || unread != Set(state.unread ?? []) || undecided != Set(state.undecided ?? [])
            || state.lead != nil
        state.people = people.sorted(by: JSONText.javaScriptOrder)
        state.unread = unread.isEmpty ? nil : unread.sorted(by: JSONText.javaScriptOrder)
        state.undecided = undecided.isEmpty ? nil : undecided.sorted(by: JSONText.javaScriptOrder)

        let ledger = ledgers.ledger(SessionEntry.self, pass: request.custody.pass, source: sourceId)
        let base = try ledger.newest(through: request.custody.received)?.files ?? [:]
        var next = base.filter { listed[$0.key] != nil }
        var due = logs.filter { log in log.wholeOf.map(people.contains) ?? people.contains(log.name) }
        var months = Months()
        for log in due { months.file(modifiedAt: log.modifiedAt, bytes: log.bytes) }
        if let start = request.start.map(Self.nanoseconds) {
            let newest = Dictionary(due.map { (Self.session(of: $0.name), $0.modifiedAt) }, uniquingKeysWith: max)
            due = due.filter { newest[Self.session(of: $0.name)]! >= start }
        }
        var older: [SessionLog] = []
        if due.reduce(0, { $0 + Self.owed($1, shipped: next[$1.name]) }) > budget {
            let since = Self.nanoseconds(request.fetchedAt.addingTimeInterval(-HistoryPage.recent))
            let recent = Set(due.filter { $0.modifiedAt >= since }.map { Self.session(of: $0.name) })
            older = due.filter { !recent.contains(Self.session(of: $0.name)) }
            due = due.filter { recent.contains(Self.session(of: $0.name)) }
        }

        let lead = state.lead
        var bundles: [SealedBundle] = []
        var custody = request.custody
        let counted = request.owed(months)
        let live = try pack(due, lead: lead, logs: logs, next: &next, request: request, custody: custody, ledger: ledger,
                            months: counted)
        state.lead = live.lead
        if let bundle = live.bundle {
            bundles.append(bundle)
            custody = SealCustody(pass: custody.pass, received: custody.seal, imported: custody.imported, history: custody.history)
        }
        if !older.isEmpty, HistoryPage.paced(request.custody) {
            let page = try pack(older, lead: lead, logs: logs, next: &next, request: request, custody: custody, ledger: ledger,
                                months: bundles.isEmpty ? counted : nil, history: true)
            if let bundle = page.bundle { bundles.append(bundle) }
        }
        historyOwed.value = older.contains { Self.owed($0, shipped: next[$0.name]) > 0 }
        stated.value = bundles.isEmpty && request.owesThrough ? request.through(readThrough: request.fetchedAt, months: months) : nil
        if !bundles.isEmpty || changed { try write(state) }
        return bundles
    }

    static func owed(_ log: SessionLog, shipped: Shipped?) -> Int {
        guard log.wholeOf == nil else { return shipped?.bytes == log.bytes ? 0 : log.bytes }
        return max(0, log.bytes - (shipped?.bytes ?? 0))
    }

    private func pack(_ due: [SessionLog], lead: String?, logs: [SessionLog], next: inout [String: Shipped], request: SealRequest,
                      custody: SealCustody, ledger: SealLedger<SessionEntry>, months: [String: Through.Month]?,
                      history: Bool = false) throws -> (bundle: SealedBundle?, lead: String?) {
        let listed = Dictionary(logs.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        let scratch = try SealWork.directory(prefix: "session-parts-", in: request.scratch)
        defer { try? FileManager.default.removeItem(at: scratch) }

        var parts: [(part: Part, file: URL)] = []
        var carried: [(name: String, file: URL)] = []
        var room = budget
        var leads: String?
        for name in Self.order(due, lead: lead) {
            guard let log = listed[name], room > 0 else { continue }
            if log.wholeOf != nil {
                guard next[name]?.bytes != log.bytes else { continue }
                if log.bytes > room, !(parts.isEmpty && carried.isEmpty) {
                    leads = name
                    room = 0
                    continue
                }
                let target = scratch.appendingPathComponent(String(parts.count + carried.count))
                guard let hash = try StoreFiles.unlessRefused({ try Self.copyWhole(try opener.file(log.url), into: target) }) else { continue }
                carried.append((name, target))
                next[name] = Shipped(bytes: hash.bytes, lines: 0, hash: hash.sha256)
                room -= hash.bytes
                continue
            }
            var from = next[name] ?? .start
            guard let file = try StoreFiles.unlessRefused({ try opener.file(log.url) }) else { continue }
            if from.bytes > 0, (try? Self.onlyAppended(log, file, since: from)) != true { from = .start }
            guard log.bytes > from.bytes else { continue }
            let target = scratch.appendingPathComponent(String(parts.count + carried.count))
            guard let copied = try? Self.copyLines(of: log, file, from: from.bytes, room: room, alone: parts.isEmpty && carried.isEmpty, into: target),
                  let tail = copied.lines == 0 ? "" : try? Self.tail(of: file, through: from.bytes + copied.bytes) else { continue }
            if copied.lines > 0 {
                parts.append((Part(file: name, fromByte: from.bytes, fromLine: from.lines + 1, lines: copied.lines), target))
                next[name] = Shipped(bytes: from.bytes + copied.bytes, lines: from.lines + copied.lines, hash: tail)
                room -= copied.bytes
            }
            if copied.full {
                leads = name
                room = 0
            }
        }

        guard !parts.isEmpty || !carried.isEmpty else { return (nil, leads) }
        let sessions = Set(parts.map { Self.session(of: $0.part.file) } + carried.map { Self.session(of: $0.name) })
        let wholes = Set(logs.filter { $0.wholeOf != nil }.map(\.name))
        let indexed = next.keys.filter { wholes.contains($0) && sessions.contains(Self.session(of: $0)) }.sorted(by: JSONText.javaScriptOrder)
        let index = JSONText.object([
            ("parts", .array(parts.map { entry in
                .object([("file", .string(entry.part.file)), ("from_byte", .int(entry.part.fromByte)),
                         ("from_line", .int(entry.part.fromLine)), ("lines", .int(entry.part.lines))])
            })),
            ("files", .array(indexed.map { name in
                .object([("file", .string(name)), ("sha256", .string(next[name]!.hash)), ("bytes", .int(next[name]!.bytes))])
            })),
        ])
        let fetchedAt = history ? request.fetchedAt.addingTimeInterval(0.001) : request.fetchedAt
        var facts: [(String, JSONText)] = [("logs", .int(parts.count)),
                                           ("files", .int(carried.count)),
                                           ("lines", .int(parts.reduce(0) { $0 + $1.part.lines })),
                                           ("snapshot_taken_at", .string(UTCInstant.rfc3339(fetchedAt)))]
        if history { facts.append(HistoryPage.fact) }
        facts += Months.facts(months)
        let written = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: feeder, fetchedAt: fetchedAt,
            files: [BundleWriter.File(name: Self.partsFile, content: .bytes(index.data + Data("\n".utf8)))]
                + parts.map { BundleWriter.File(name: $0.part.file, content: .file($0.file)) }
                + carried.map { BundleWriter.File(name: $0.name, content: .file($0.file)) },
            facts: facts, custody: (custody, []), through: ledgers.files)
        try ledger.record(SessionEntry(files: next), at: custody.seal)
        let sidecar = BundleSidecar(id: written.id, sourceId: sourceId, custody: custody, history: history, months: months)
        return (SealedBundle(file: written.file, sidecar: sidecar), leads)
    }

    var unread: Unread? {
        guard let names = readState().unread, let first = names.first else { return nil }
        let more = names.count > 1 ? " and \(names.count - 1) more" : ""
        return Unread(code: Self.unreadCode,
                      message: "\(names.count) session log\(names.count == 1 ? "" : "s") read to \(Self.guardBytes >> 20) MiB "
                          + "without the line that says who started it: \(first)\(more)")
    }

    func applied(_ answer: FreshAnswer) {
        guard let custody = answer.sources[sourceId] else { return }
        try? ledgers.ledger(SessionEntry.self, pass: answer.pass, source: sourceId).prune(imported: custody.imported)
    }

    static func order(_ due: [SessionLog], lead: String?) -> [String] {
        let leading = lead.flatMap { name in due.contains { $0.name == name } ? session(of: name) : nil }
        return due.sorted { left, right in
            let (one, other) = (session(of: left.name), session(of: right.name))
            if one != other {
                if let leading, one == leading || other == leading { return one == leading }
                return JSONText.javaScriptOrder(one, other)
            }
            if (left.wholeOf == nil) != (right.wholeOf == nil) { return left.wholeOf != nil }
            if (left.name == lead) != (right.name == lead) { return left.name == lead }
            return JSONText.javaScriptOrder(left.name, right.name)
        }.map(\.name)
    }


    struct State: Codable, Equatable {
        var askedThrough: Int = 0
        var people: [String] = []
        var lead: String?
        var unread: [String]?
        var undecided: [String]?

        enum CodingKeys: String, CodingKey {
            case askedThrough = "asked_through_ns"
            case people
            case lead
            case unread
            case undecided
        }
    }

    struct SessionEntry: LedgerEntry {
        var files: [String: Shipped]

        func absorbing(_ older: SessionEntry) -> SessionEntry { self }
    }

    struct Shipped: Codable, Equatable {
        var bytes: Int
        var lines: Int
        var hash: String

        static let start = Shipped(bytes: 0, lines: 0, hash: "")
    }

    struct Part: Equatable {
        let file: String
        let fromByte: Int
        let fromLine: Int
        let lines: Int
    }

    func readState() -> State {
        guard let data = try? ledgers.files.read(stateFile, maximumBytes: ShippingState.mostKept), let state = try? JSONDecoder().decode(State.self, from: data) else {
            return State()
        }
        return state
    }

    private func write(_ state: State) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try ShippingState.replace(stateFile, with: try encoder.encode(state) + Data("\n".utf8), files: ledgers.files)
    }


    static func onlyAppended(_ log: SessionLog, _ file: OpenedFile, since shipped: Shipped) throws -> Bool {
        guard log.bytes >= shipped.bytes else { return false }
        return try tail(of: file, through: shipped.bytes) == shipped.hash
    }

    static func tail(of file: OpenedFile, through end: Int) throws -> String {
        let count = min(tailBytes, end)
        let handle = file.handle
        try handle.seek(toOffset: UInt64(end - count))
        let data = try handle.read(upToCount: count) ?? Data()
        guard data.count == count else { return "" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func copyLines(of log: SessionLog, _ file: OpenedFile, from: Int, room: Int, alone: Bool,
                          into target: URL) throws -> (bytes: Int, lines: Int, full: Bool) {
        let source = file.handle
        try source.seek(toOffset: UInt64(from))
        guard FileManager.default.createFile(atPath: target.path, contents: nil) else { throw SessionLogError.scratch(target.lastPathComponent) }
        let sink = try FileHandle(forWritingTo: target)
        defer { try? sink.close() }
        let available = log.bytes - from
        var read = 0
        var end = 0
        var lines = 0
        var full = false
        while read < available, !full {
            let chunk = try source.read(upToCount: min(FileChunks.size, available - read)) ?? Data()
            if chunk.isEmpty { break }
            chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                var at = 0
                while at < raw.count, let hit = memchr(base + at, 0x0A, raw.count - at) {
                    let offset = base.distance(to: UnsafeRawPointer(hit))
                    let through = read + offset + 1
                    if through <= room || (lines == 0 && alone) {
                        end = through
                        lines += 1
                    }
                    if through >= room { full = true; break }
                    at = offset + 1
                }
            }
            try sink.write(contentsOf: chunk)
            read += chunk.count
            if read >= room, lines > 0 || !alone { full = true }
        }
        guard lines > 0 else {
            try? FileManager.default.removeItem(at: target)
            return (0, 0, full)
        }
        try sink.truncate(atOffset: UInt64(end))
        return (end, lines, full)
    }

    static func copyWhole(_ file: OpenedFile, into target: URL) throws -> (bytes: Int, sha256: String) {
        guard FileManager.default.createFile(atPath: target.path, contents: nil) else { throw SessionLogError.scratch(target.lastPathComponent) }
        let sink = try FileHandle(forWritingTo: target)
        defer { try? sink.close() }
        var digest = SHA256()
        var bytes = 0
        try file.chunks { chunk in
            digest.update(data: chunk)
            bytes += chunk.count
            try sink.write(contentsOf: chunk)
        }
        return (bytes, digest.finalize().map { String(format: "%02x", $0) }.joined())
    }

    static func session(of name: String) -> String {
        let first = name.split(separator: "/", maxSplits: 1).first.map(String.init) ?? name
        return first.hasSuffix(".jsonl") ? String(first.dropLast(6)) : first
    }

    static func starter(in url: URL, opener: FileOpener = .own, _ decide: (Data) -> SessionStarter?) throws -> SessionStarter {
        let handle = try opener.file(url).handle
        var pending = Data()
        var read = 0
        while read < guardBytes {
            let chunk = try handle.read(upToCount: min(1 << 16, guardBytes - read)) ?? Data()
            if chunk.isEmpty { return .notYet }
            read += chunk.count
            let searched = pending.count
            pending.append(chunk)
            var start = 0
            var from = searched
            while let newline = pending[(pending.startIndex + from)...].firstIndex(of: 0x0A) {
                if let answer = decide(Data(pending[(pending.startIndex + start)..<newline])) { return answer }
                start = newline - pending.startIndex + 1
                from = start
            }
            pending = Data(pending[(pending.startIndex + start)...])
        }
        return .unreadable
    }

    static func object(_ line: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
    }

    static func nanoseconds(_ date: Date) -> Int {
        Int((date.timeIntervalSince1970 * 1_000_000_000).rounded(.down))
    }

    static func log(named name: String, at url: URL) -> SessionLog? {
        guard let status = FileFacts.of(url.path), status.st_mode & S_IFMT == S_IFREG else { return nil }
        let modified = Int(status.st_mtimespec.tv_sec) * 1_000_000_000 + Int(status.st_mtimespec.tv_nsec)
        return SessionLog(name: name, url: url, bytes: Int(status.st_size), modifiedAt: modified)
    }

    static func names(in directory: URL) throws -> [String] {
        guard FileFacts.isDirectory(directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: directory.path)
    }

    static func matches(_ name: String, _ pattern: NSRegularExpression) -> Bool {
        pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }
}

enum SessionLogError: Error, Equatable, CustomStringConvertible {
    case scratch(String)

    var description: String {
        switch self {
        case .scratch(let name): return "cannot write the scratch part \(name)"
        }
    }
}

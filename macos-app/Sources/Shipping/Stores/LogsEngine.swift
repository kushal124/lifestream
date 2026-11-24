import Evidence
import Foundation
import HomeLink

final class LogsEngine: ShippingDomain {
    typealias Root = HomeLink.MacStore.Engine.Root
    typealias Start = HomeLink.MacStore.Engine.Start

    let sourceId: String
    let name: String
    private let roots: [Root]
    private let match: NSRegularExpression
    private let beside: NSRegularExpression?
    private let start: Start?
    private let road: StoreFiles
    let shipper: SessionLogShipper
    private let clock: @Sendable () -> Date

    init(sourceId: String, store: HomeLink.MacStore, roots: [Root], match: String, beside: String?, start: Start?, road: StoreFiles,
         stateFile: URL, ledgers: Ledgers, budget: Int = SessionLogShipper.defaultBudget, clock: @escaping @Sendable () -> Date = { Date() }) throws {
        self.sourceId = sourceId
        name = store.name
        for root in roots { _ = try road.path(root.path) }
        self.roots = roots
        self.match = try NSRegularExpression(pattern: match)
        self.beside = try beside.map { try NSRegularExpression(pattern: $0) }
        self.start = start
        self.road = road
        shipper = SessionLogShipper(sourceId: sourceId, feeder: store.feeder, stateFile: stateFile, ledgers: ledgers, budget: budget,
                                    opener: road.opener)
        self.clock = clock
    }

    func seal(_ request: SealRequest) throws -> [SealedBundle] {
        shipper.stated.value = nil
        guard try rootsNow().contains(where: { FileFacts.isDirectory($0.url.path) }) else { return [] }
        let listedAt = clock()
        return try shipper.seal(request, listedAt: listedAt, list: logs, starter: starter)
    }

    func applied(_ answer: FreshAnswer) { shipper.applied(answer) }

    var unread: Unread? { shipper.unread }
    var owesHistory: Bool { shipper.owesHistory }
    var through: Through? { shipper.through }

    func logs(known: Set<String> = [], askFrom: Int = Int.min) throws -> [SessionLog] {
        var found: [String: SessionLog] = [:]
        var order: [String] = []
        func add(_ log: SessionLog) {
            guard found[log.name] == nil else { return }
            found[log.name] = log
            order.append(log.name)
        }
        for root in try rootsNow() where FileFacts.isDirectory(root.url.path) {
            if root.days {
                for name in known.sorted() where found[name] == nil {
                    if let log = located(name, in: root.url) { add(log) }
                }
            }
            for folder in try folders(of: root) where !root.days || (Self.modified(folder) ?? Int.min) >= askFrom {
                try walk(folder, "", add)
            }
        }
        return order.map { found[$0]! }
    }

    private func rootsNow() throws -> [(url: URL, depth: Int, days: Bool)] {
        try roots.map { (try road.path($0.path), $0.depth ?? 0, $0.days ?? false) }
    }

    private func located(_ name: String, in root: URL) -> SessionLog? {
        guard let range = name.range(of: "[0-9]{4}-[0-9]{2}-[0-9]{2}", options: .regularExpression) else { return nil }
        let date = name[range].split(separator: "-").map(String.init)
        let day = root.appendingPathComponent(date[0], isDirectory: true).appendingPathComponent(date[1], isDirectory: true)
            .appendingPathComponent(date[2], isDirectory: true)
        return entry(name, at: day.appendingPathComponent(name))
    }

    private func folders(of root: (url: URL, depth: Int, days: Bool)) throws -> [URL] {
        var folders = [root.url]
        for _ in 0..<root.depth {
            folders = try folders.flatMap { folder in
                try SessionLogShipper.names(in: folder).map { folder.appendingPathComponent($0, isDirectory: true) }
                    .filter { FileFacts.isDirectory($0.path) }
            }
        }
        return folders
    }

    private func walk(_ folder: URL, _ prefix: String, _ add: (SessionLog) -> Void) throws {
        for name in try SessionLogShipper.names(in: folder) {
            let relative = prefix.isEmpty ? name : "\(prefix)/\(name)"
            let url = folder.appendingPathComponent(name)
            if FileFacts.isDirectory(url.path) {
                try walk(url, relative, add)
            } else if let log = entry(relative, at: url) {
                add(log)
            }
        }
    }

    private func entry(_ name: String, at url: URL) -> SessionLog? {
        let isLog = StoreFiles.matches(match, name)
        guard isLog || beside.map({ StoreFiles.matches($0, name) }) == true,
              (try? road.admit(url, spelled: nil)) != nil, let log = SessionLogShipper.log(named: name, at: url) else { return nil }
        if isLog { return log }
        return SessionLog(name: log.name, url: log.url, bytes: log.bytes, modifiedAt: log.modifiedAt, wholeOf: SessionLogShipper.session(of: name) + ".jsonl")
    }

    private static func modified(_ folder: URL) -> Int? {
        FileFacts.entry(folder.path).map { Int($0.st_mtimespec.tv_sec) * 1_000_000_000 + Int($0.st_mtimespec.tv_nsec) }
    }

    func starter(_ log: SessionLog) throws -> SessionStarter {
        guard let start else { return .person }
        return try SessionLogShipper.starter(in: log.url, opener: road.opener) { line -> SessionStarter? in
            let object = SessionLogShipper.object(line)
            if case .stating(let path) = start.line {
                guard let object, StoreValues.value(at: path.components(separatedBy: "."), in: object) is String else { return nil }
            }
            guard let object, (start.session ?? []).allSatisfy({ StoreValues.holds($0, object) }) else { return .program }
            return start.program.contains { StoreValues.holds($0, object) } ? .program : .person
        }
    }
}

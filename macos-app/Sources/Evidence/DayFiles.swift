import Foundation
import Darwin

public enum DayFiles {
    public static let keepDays = 30

    public static func name(_ prefix: String, at instant: Date) -> String {
        prefix + day(of: instant) + ".jsonl"
    }

    public static func day(of instant: Date) -> String {
        String(UTCInstant.rfc3339(instant).prefix(10))
    }

    @discardableResult
    public static func prune(in folder: URL, prefix: String, keepDays: Int, now: Date) -> Int {
        var directory = folder
        var stem = prefix
        if let slash = prefix.lastIndex(of: "/") {
            directory = folder.appendingPathComponent(String(prefix[..<slash]), isDirectory: true)
            stem = String(prefix[prefix.index(after: slash)...])
        }
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return 0 }
        let oldest = now.addingTimeInterval(-Double(keepDays) * 86_400)
        var removed = 0
        for name in names where name.hasPrefix(stem) && name.hasSuffix(".jsonl") {
            let spelled = String(name.dropFirst(stem.count).dropLast(".jsonl".count))
            guard let start = start(ofDay: spelled), start.addingTimeInterval(86_400) < oldest else { continue }
            if Darwin.unlink(directory.appendingPathComponent(name).path) == 0 { removed += 1 }
        }
        return removed
    }

    public final class Pruner: @unchecked Sendable {
        private let folder: URL
        private let prefixes: [String]
        private let keepDays: Int
        private let lock = NSLock()
        private var prunedDay: String?

        public init(in folder: URL, prefixes: [String], keepDays: Int = DayFiles.keepDays) {
            self.folder = folder
            self.prefixes = prefixes
            self.keepDays = keepDays
        }

        @discardableResult
        public func prune(at now: Date) -> Int {
            let today = DayFiles.day(of: now)
            let due = lock.withLock { () -> Bool in
                guard prunedDay != today else { return false }
                prunedDay = today
                return true
            }
            guard due else { return 0 }
            return prefixes.reduce(0) { $0 + DayFiles.prune(in: folder, prefix: $1, keepDays: keepDays, now: now) }
        }
    }

    static func start(ofDay spelled: String) -> Date? {
        guard spelled.count == 10, let date = UTCInstant.date(rfc3339: spelled + "T00:00:00.000Z"),
              day(of: date) == spelled else { return nil }
        return date
    }
}

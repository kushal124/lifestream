import Foundation
import HomeLink
import os

private let searchLog = Logger(subsystem: "org.lifestreamprotocol.phone", category: "search")

public enum SearchWords {
    public static func addDays(_ day: String, _ by: Int) -> String {
        guard let parts = parts(day),
              let moved = utc.date(from: DateComponents(year: parts.year, month: parts.month, day: parts.date + by)) else { return day }
        let out = utc.dateComponents([.year, .month, .day], from: moved)
        return dayKey(out.year ?? 0, out.month ?? 0, out.day ?? 0)
    }

    public static func monthEnd(_ month: String) -> String {
        guard let parts = parts(month + "-01") else { return month }
        return dayKey(parts.year, parts.month, daysIn(parts.year, parts.month))
    }

    public struct Span: Equatable, Hashable, Sendable {
        public let label: String
        public let from: String
        public let to: String

        public init(_ label: String, from: String, to: String) {
            self.label = label
            self.from = from
            self.to = to
        }
    }

    public static func spans(today: String, first: String?) -> [Span] {
        let year = Int(today.prefix(4)) ?? 0
        let month = String(today.prefix(7))
        let oldest = first.flatMap { Int($0.prefix(4)) }.map { min($0, year) } ?? year
        return [Span("This month", from: month + "-01", to: monthEnd(month)), Span("This year", from: "\(year)-01-01", to: "\(year)-12-31")]
            + stride(from: year - 1, through: oldest, by: -1).map { Span(String($0), from: "\($0)-01-01", to: "\($0)-12-31") }
    }

    public static func who(_ from: String) -> String {
        from == "the user" ? "You" : from
    }

    public struct Run: Equatable, Sendable {
        public let text: String
        public let marked: Bool

        public init(_ text: String, marked: Bool) {
            self.text = text
            self.marked = marked
        }
    }

    public static func snippet(_ snippet: String) -> [Run] {
        var runs: [Run] = []
        var open = false
        var text = ""
        func close() {
            if text.isEmpty { return }
            if let last = runs.last, last.marked == open { runs[runs.count - 1] = Run(last.text + text, marked: open) }
            else { runs.append(Run(text, marked: open)) }
            text = ""
        }
        for character in snippet {
            if character == "«" || character == "»" {
                close()
                open = character == "«"
            } else {
                text.append(character)
            }
        }
        close()
        return runs
    }

    public static func clock(local: String?) -> String? {
        guard let local, let range = local.range(of: #"\d{2}:\d{2}"#, options: .regularExpression) else { return nil }
        return String(local[range])
    }

    public static func instant(_ text: String?) -> Date? {
        guard let text, let found = text.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})/)
        else { return nil }
        let offset: Int
        if found.7 == "Z" {
            offset = 0
        } else {
            let sign = found.7.hasPrefix("-") ? -1 : 1
            let hm = found.7.dropFirst().split(separator: ":").compactMap { Int($0) }
            offset = sign * (hm[0] * 3600 + hm[1] * 60)
        }
        guard let zone = TimeZone(secondsFromGMT: offset) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: Int(found.1), month: Int(found.2), day: Int(found.3), hour: Int(found.4),
                                                  minute: Int(found.5), second: found.6.flatMap { Int($0) } ?? 0))
    }

    public static func reading(_ reading: HomeLink.Pages.Reading?, today: String) -> String? {
        switch reading {
        case .building(let line, _)?: line
        case .behind(let line, .day(let day))?: line + " " + (day == today ? "today" : Words.shortDay(day, today: today))
        case .behind(let line, _)?: line
        case .unknown?, nil: nil
        }
    }

    public struct FamilyWords: Equatable, Sendable {
        public let label: String
        public let icon: String
    }

    public static func family(_ family: String?) -> FamilyWords {
        guard let family, !family.isEmpty else { return FamilyWords(label: "Other", icon: "info") }
        return families[family] ?? FamilyWords(label: family.prefix(1).uppercased() + family.dropFirst(), icon: "info")
    }

    private static let families: [String: FamilyWords] = [
        "messages": .init(label: "Messages", icon: "message"),
        "mail": .init(label: "Mail", icon: "mail"),
        "calls": .init(label: "Calls", icon: "call"),
        "calendar": .init(label: "Calendar", icon: "calendar-event"),
        "notes": .init(label: "Notes", icon: "note"),
        "voice": .init(label: "Voice notes", icon: "voice-note"),
        "photos": .init(label: "Photos", icon: "photos"),
        "physical": .init(label: "Places", icon: "place"),
        "screen": .init(label: "Mac", icon: "work-mac"),
        "phone": .init(label: "Phone", icon: "phone-screen"),
        "web": .init(label: "Browsing", icon: "web"),
        "ai": .init(label: "AI chats", icon: "ai"),
        "health": .init(label: "Health", icon: "health"),
        "listening": .init(label: "Listening", icon: "listening"),
        "money": .init(label: "Payments", icon: "money"),
        "labels": .init(label: "Labels", icon: "person"),
    ]


    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private static func parts(_ day: String) -> (year: Int, month: Int, date: Int)? {
        let pieces = day.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.map(\.count) == [4, 2, 2], pieces.allSatisfy({ $0.allSatisfy(\.isASCIIDigit) }) else { return nil }
        let (year, month, date) = (Int(pieces[0])!, Int(pieces[1])!, Int(pieces[2])!)
        guard month >= 1 && month <= 12, date >= 1 && date <= daysIn(year, month) else { return nil }
        return (year, month, date)
    }

    private static func daysIn(_ year: Int, _ month: Int) -> Int {
        guard let date = utc.date(from: DateComponents(year: year, month: month, day: 1)) else { return 0 }
        return utc.range(of: .day, in: .month, for: date)?.count ?? 0
    }

    private static func dayKey(_ year: Int, _ month: Int, _ date: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, date)
    }


}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}

public struct SearchHistory: Sendable {
    public static let capacity = 10

    public private(set) var words: [String]
    private let file: URL

    public init(file: URL) {
        self.file = file
        words = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
    }

    public mutating func add(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        words.removeAll { $0.caseInsensitiveCompare(trimmed) == .orderedSame }
        words.insert(trimmed, at: 0)
        words = Array(words.prefix(Self.capacity))
        save()
    }

    public mutating func clear() {
        words = []
        try? FileManager.default.removeItem(at: file)
    }

    private func save() {
        do {
            let folder = file.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileDurability.excludeFromBackup(folder)
            try JSONEncoder().encode(words).write(to: file, options: FileDurability.unlockedOnly)
        } catch {
            searchLog.error("the recent searches were not kept: \(String(describing: error), privacy: .public)")
        }
    }
}

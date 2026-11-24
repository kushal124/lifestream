import Foundation
import HomeLink

public struct PeopleListing: Sendable {
    public typealias Row = HomeLink.Pages.Row
    public typealias ChatRow = HomeLink.Pages.ChatRow

    public struct Section: Sendable, Equatable {
        public let key: String
        public let heading: String?
        public let rows: [Row]
    }

    public struct Lined: Sendable, Equatable {
        public let row: Row
        public let line: String
    }

    public struct Found: Sendable, Equatable {
        public let typed: String
        public let people: [Row]
        public let groups: [ChatRow]

        public func adding(_ atHome: [Row]) -> Found {
            let shown = Set(people.map(\.id))
            return Found(typed: typed, people: people + atHome.filter { !shown.contains($0.id) }, groups: groups)
        }
    }

    public static let aiHeading = "AI"

    public let page: HomeLink.Pages.People
    private let byID: [String: Row]

    public init(_ page: HomeLink.Pages.People) {
        self.page = page
        byID = Dictionary(Self.everyone(page).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    public var nobody: Bool {
        page.counts.people == 0 && page.counts.groups == 0
    }

    public func sections(today: String) -> [Section] {
        page.sections.map { Section(key: $0.key, heading: $0.title ?? Words.sectionWhen($0.key, today: today), rows: $0.rows) }
    }

    public var most: [Lined] {
        page.most.compactMap { most in byID[most.id].map { Lined(row: $0, line: most.line) } }
    }

    public var new: [Lined] {
        page.new.compactMap { new in byID[new.id].map { Lined(row: $0, line: new.line) } }
    }

    public var organise: [Row] {
        page.organise.queue.compactMap { byID[$0] }
    }

    public func found(_ typed: String) -> Found {
        Found(typed: typed, people: Self.everyone(page).filter { PageFilter.shows($0.find, typed: typed) },
              groups: (page.groups.yours + page.groups.quiet).filter { PageFilter.shows($0.find, typed: typed) })
    }

    public static func meta(_ row: Row, today: String, now: Date, grouped: Bool = false) -> String? {
        row.line ?? row.when.flatMap { when($0, today: today, now: now, grouped: grouped) }
    }

    public static func meta(_ chat: ChatRow, today: String, now: Date) -> String? {
        chat.line ?? chat.when.flatMap { when($0, today: today, now: now, grouped: false) }
    }

    public static func when(_ when: HomeLink.Pages.When, today: String, now: Date, grouped: Bool) -> String? {
        switch when {
        case .at(let ms), .clock(let ms): Words.rowWhen(Words.date(ms: Int64(ms)), now: now, grouped: grouped)
        case .day(let day): Words.rowDay(day, today: today, grouped: grouped)
        case .month(let month): Words.month(ofDay: month + "-01", today: today)
        case .unknown: nil
        }
    }

    private static func everyone(_ page: HomeLink.Pages.People) -> [Row] {
        (page.you.map { [$0] } ?? []) + page.sections.flatMap(\.rows) + page.ai
    }
}

public enum PageFilter {
    public static func shows(_ find: [String], typed: String) -> Bool {
        let entries = find.map(fold)
        let words = entries.flatMap { split($0[...]) }
        let found = { (piece: Substring) in
            piece.allSatisfy { $0.isASCII && $0.isNumber } ? entries.contains { $0.contains(piece) } : words.contains { $0.hasPrefix(piece) }
        }
        return fold(typed).split(whereSeparator: \.isWhitespace).allSatisfy { word in
            let pieces = split(word)
            return !pieces.isEmpty && pieces.allSatisfy(found)
        }
    }

    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    static func split(_ text: Substring) -> [Substring] {
        text.split { !($0.isLetter || $0.isNumber) }
    }
}

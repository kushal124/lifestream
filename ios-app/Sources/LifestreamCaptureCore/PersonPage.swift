import Foundation
import HomeLink

public struct PersonPage: Sendable {
    public typealias Page = HomeLink.Pages.Person
    public typealias Where = HomeLink.Pages.Person.Where

    public struct Fact: Sendable, Equatable {
        public let id: String
        public let key: String
        public let words: String
        public let link: URL?
        public let said: String?
    }

    public struct Pair: Sendable, Equatable {
        public let key: String
        public let words: String
    }

    public struct Bar: Sendable, Equatable {
        public let count: Int
        public let when: String
        public let label: String
        public let day: String?
    }

    public enum Figure: Sendable, Equatable {
        case weeks(count: Int, bars: [Bar], marked: Int?)
        case years(total: Int, bars: [Bar], marked: Int?, foot: String)
        case facts([Pair])
        case nothing
    }

    public struct Talks: Sendable, Equatable {
        public let shown: [Where]
        public let folded: [Where]
    }

    public static let groupsShown = 5

    public let page: Page

    public init(_ page: Page) {
        self.page = page
    }

    public var line: String {
        page.head.relationship?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    public var since: String? {
        page.head.since?.civilDay.map(Words.monthYear(ofDay:))
    }

    public var calls: HomeLink.Pages.Month.Calls? {
        if case .facts = page.history { return nil }
        return page.month.calls
    }

    public func figure(today: String) -> Figure {
        switch page.history {
        case .weeks(let weeks, let marked):
            let bars = weeks.indices.map { index in
                let short = Words.shortDay(weeks[index].start, weekday: false, today: today)
                let last = index == weeks.count - 1
                return Bar(count: weeks[index].count, when: last ? "this week" : "week of " + short, label: last ? "This week" : short,
                           day: weeks[index].day)
            }
            return .weeks(count: page.month.count, bars: bars, marked: marked)
        case .years(let years, let total, let marked):
            return .years(total: total, bars: years.map { Bar(count: $0.count, when: $0.year, label: $0.year, day: $0.day) }, marked: marked,
                          foot: monthFoot(today: today))
        case .facts(let total, let first):
            return .facts([Pair(key: "Messages", words: Words.count(total))]
                + (first.map { [Pair(key: "First contact", words: Words.shortDay($0, weekday: false, today: today))] } ?? [])
                + (page.month.calls.map { [Pair(key: "Calls · 30 days", words: Words.count($0.count))] } ?? []))
        case .unknown:
            return .nothing
        }
    }

    public func monthFoot(today: String) -> String {
        page.month.line + (page.month.before.map { $0.joiner + Words.shortDay($0.day, weekday: false, today: today) } ?? "")
    }

    public var talks: Talks {
        var groups = 0
        var shown: [Where] = []
        var folded: [Where] = []
        for each in page.where {
            if !each.group {
                shown.append(each)
            } else if groups < Self.groupsShown {
                groups += 1
                shown.append(each)
            } else {
                folded.append(each)
            }
        }
        return Talks(shown: shown, folded: folded)
    }

    public static func moreGroups(_ count: Int) -> String {
        Words.count(count) + " more " + (count == 1 ? "group" : "groups")
    }

    public func facts(today: String, network: (String) -> String) -> [Fact] {
        var birthdays: [Fact] = []
        var profiles: [Fact] = []
        for chip in page.head.chips {
            switch chip {
            case .birthday(let month, let day):
                let words = Self.birthday(month: month, day: day, today: today)
                birthdays.append(Fact(id: "birthday", key: "Birthday", words: words.hasPrefix("Birthday ") ? String(words.dropFirst(9)) : words,
                                      link: nil, said: nil))
            case .profile(let id, let words, let href):
                let key = PeopleDetails.networkName(id) ?? network(id)
                profiles.append(Fact(id: id + ":" + words, key: key, words: words, link: href.flatMap(URL.init(string:)), said: key + ", " + words))
            case .unknown:
                continue
            }
        }
        let work = page.head.work.map { [Fact(id: "work", key: "Work", words: $0, link: nil, said: nil)] } ?? []
        return birthdays + work + profiles
    }

    public static func birthday(month: Int, day: Int, today: String) -> String {
        let year = Int(today.prefix(4)) ?? 0
        let days = [year, year + 1].lazy.map { each -> Int in
            let leap = each % 4 == 0 && (each % 100 != 0 || each % 400 == 0)
            let on = month == 2 && day == 29 && !leap ? 28 : day
            return Words.daysBetween(today, String(format: "%04d-%02d-%02d", each, month, on))
        }.first { $0 >= 0 } ?? 0
        if days == 0 { return "Birthday today" }
        if days <= 14 { return "Birthday in " + Words.count(days, "day") }
        return "\(day) " + Words.shortMonth(ofDay: String(format: "2000-%02d-01", month))
    }
}

extension HomeLink.Pages.When {
    public var civilDay: String? {
        switch self {
        case .day(let day): day
        case .at(let ms), .clock(let ms): HomeClock.current.dayAt(Int64(ms)).day
        case .month(let month): month + "-01"
        case .unknown: nil
        }
    }
}

import Foundation
import HomeLink

public enum DayReading {
    public typealias Page = HomeLink.Pages.Day
    public typealias Chapter = HomeLink.Pages.DayChapter
    public typealias Block = HomeLink.Pages.DayBlock
    public typealias Row = HomeLink.Pages.DayRow

    public static let also = "also"
    public static let every: TimeInterval = 180

    public struct Turned: Equatable, Sendable {
        public let today: String
        public let revision: Int

        public init(_ clock: ClockInUse) {
            let now = clock.snapshot
            today = clock.telling(by: now) { clock.today() }
            revision = now.revision
        }
    }

    public struct Place: Equatable, Sendable {
        public let chapter: String
        public let block: String?
        public let row: String
    }

    public static func key(_ day: String) -> HomeLink.PageKey {
        HomeLink.PageKey(Page.route, ["day": day])
    }

    public static func again(_ page: Page, now: Date) -> Date? {
        guard page.nowMs != nil else { return nil }
        let next = now.addingTimeInterval(every)
        guard let until = page.untilMs else { return next }
        return min(next, max(now, Date(timeIntervalSince1970: TimeInterval(until) / 1000)))
    }

    public static func opens(_ chapter: Chapter) -> Bool {
        chapter.blocks.contains { !$0.rows.isEmpty }
    }

    public static func place(of row: String, in page: Page) -> Place? {
        for chapter in page.chapters {
            if chapter.key == row || chapter.episode == row { return Place(chapter: chapter.key, block: nil, row: chapter.key) }
            for block in chapter.blocks where block.rows.contains(where: { $0.key == row }) {
                return Place(chapter: chapter.key, block: block.kind == .hour ? block.key : nil, row: row)
            }
        }
        if page.also?.rows.contains(where: { $0.key == row }) == true { return Place(chapter: also, block: nil, row: row) }
        return nil
    }

    public static func row(_ key: String, in page: Page) -> Row? {
        rows(of: page).first { $0.key == key }
    }

    public static func rows(of page: Page) -> [Row] {
        page.allDay + page.chapters.flatMap { $0.blocks.flatMap(\.rows) } + (page.also?.rows ?? []) + page.plans
    }

    public static func first(of name: HomeLink.Pages.DayName, in chapter: Chapter) -> Row? {
        chapter.blocks.lazy.flatMap(\.rows).first { $0.key == name.firstRow }
    }

    public static func unnamed(_ chapter: Chapter) -> Bool {
        chapter.kind == .stay && chapter.head?.quiet == true
    }

    public static func waits(on spots: Set<String>, in page: Page) -> Bool {
        page.chapters.contains { chapter in
            guard unnamed(chapter), let spot = chapter.head?.place else { return false }
            return spots.contains(spot)
        }
    }
}

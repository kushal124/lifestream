import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class WhenWordsTests: XCTestCase {
    private struct Table: Decodable {
        let cases: [Case]
    }

    private struct Case: Decodable {
        let form: String
        let today: String
        let day: String?
        let key: String?
        let month: String?
        let clock: String?
        let grouped: Bool?
        let words: String
    }

    private static func table() throws -> Table {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: root.appendingPathComponent("design/when-words.json")))
    }

    private static func words(_ one: Case) -> String? {
        if one.form == "sectionWhen" { return one.key.flatMap { Words.sectionWhen($0, today: one.today) } }
        if one.form == "lineMonth" { return one.month.map { Words.lineMonth($0) } }
        guard let day = one.day else { return nil }
        return switch one.form {
        case "rowDay": Words.rowDay(day, today: one.today, clock: one.clock ?? "", grouped: one.grouped ?? false)
        case "groupWhen": Words.groupWhen(day, today: one.today)
        case "dateTitle": Words.dateTitle(day, today: one.today)
        case "nearDay": Words.nearDay(day, today: one.today)
        case "stampWhen": Words.stampWhen(day, today: one.today, clock: one.clock ?? "")
        case "lineDay": Words.lineDay(day, today: one.today, clock: one.clock ?? "")
        case "lineClock": Words.lineClock(day, today: one.today, clock: one.clock ?? "")
        default: nil
        }
    }

    func testEveryCaseOfTheTableInItsForm() throws {
        let cases = try Self.table().cases
        XCTAssertFalse(cases.isEmpty)
        for one in cases {
            XCTAssertEqual(Self.words(one), one.words, "\(one.form) of \(one.day ?? one.key ?? one.month ?? "") on \(one.today)")
        }
    }

    func testEveryFormTheTableNamesIsReadHere() throws {
        let forms = Set(try Self.table().cases.map(\.form))
        XCTAssertEqual(forms, ["rowDay", "groupWhen", "sectionWhen", "dateTitle", "nearDay", "stampWhen", "lineDay", "lineMonth", "lineClock"])
        for form in forms {
            XCTAssertNotNil(Self.words(Case(form: form, today: "2026-11-16", day: "2026-11-16", key: "year:2025", month: "2026-11", clock: nil, grouped: nil, words: "")))
        }
    }

    func testAPhraseWordsEachTimeInTheFormTheHomeNamesOnIt() throws {
        let start = try XCTUnwrap(HomeClock.Run(day: "2020-01-01", startMs: 1_577_836_800_000, days: 1, zone: "UTC"))
        let clock = try XCTUnwrap(HomeClock(id: "utc", runs: [start]))
        func ms(_ day: String, _ at: String) throws -> Int64 {
            let parsed = try XCTUnwrap(ISO8601DateFormatter().date(from: "\(day)T\(at):00Z"), day)
            return Int64(parsed.timeIntervalSince1970 * 1000)
        }
        func time(_ one: Case) throws -> HomeLink.Phrase.When {
            if one.form == "lineMonth" { return .month(try XCTUnwrap(one.month)) }
            let day = try XCTUnwrap(one.day, one.form)
            guard let at = one.clock else { return .day(day) }
            return one.form == "lineClock" ? .clock(try ms(day, at)) : .at(try ms(day, at))
        }
        let cases = try Self.table().cases.filter { $0.form.hasPrefix("line") }
        XCTAssertEqual(Set(cases.map(\.form)), ["lineDay", "lineMonth", "lineClock"])
        for one in cases {
            let time = try time(one)
            let now = Date(timeIntervalSince1970: TimeInterval(try ms(one.today, "12:00")) / 1000)
            let phrase = HomeLink.Phrase([.words("Seen"), .time(time), .words("here")])
            XCTAssertEqual(Words.phrase(phrase, clock: clock, now: now), "Seen \(one.words) here",
                           "\(one.form) of \(one.day ?? one.month ?? "") \(one.clock ?? "") on \(one.today)")
        }
    }

    func testASectionKeyThatIsNoTimeKeyHasNoWordsOfTheApps() {
        for key in ["none", "month:2026-13", "month:2026-1", "year:25", "day:2026-11-16", ""] {
            XCTAssertNil(Words.sectionWhen(key, today: "2026-11-16"), key)
        }
    }
}

import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class StreamsAnswerTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")

    private static func answer(_ name: String) throws -> StreamsAnswer {
        try JSONDecoder().decode(StreamsAnswer.self, from: Data(contentsOf: fixtures.appendingPathComponent(name)))
    }

    private static func row(_ fields: String) throws -> HomeLink.Pages.StreamRow {
        let health = #"{"state": "ok", "reason": null, "words": "Fine", "since_ms": null, "next_ms": null, "acts": [], "detail": null, "line": null}"#
        let text = #"{"ids": ["gmail"], "joined": false, "name": "Gmail", "icon": "mail", "health": \#(health), "last": null, "act": null, "find": ["Gmail"], \#(fields)}"#
        return try JSONDecoder().decode(HomeLink.Pages.StreamRow.self, from: Data(text.utf8))
    }

    func testThePhonesAnswerReadsAsThePageAndTheReportAtOnce() throws {
        let answer = try Self.answer("connectors.phone.json")
        XCTAssertEqual(answer.position, answer.page.position)
        XCTAssertFalse(answer.page.rows.isEmpty, "the home's rows")
        for row in answer.page.rows {
            let lead = try XCTUnwrap(answer.lead(of: row), "\(row.name): a member the report holds")
            XCTAssertTrue(row.ids.contains(lead.id), row.name)
            XCTAssertEqual(lead.health.state.rawValue, row.health.state.rawValue, "\(row.name): the member whose health the row says")
        }
        let joined = try XCTUnwrap(answer.page.rows.first { $0.joined }, "the fixture joins two streams in one row")
        XCTAssertGreaterThan(joined.ids.count, 1)
        XCTAssertEqual(answer.report.needs.map(\.id), answer.page.needs.map(\.id), "one list of needs, in the home's order")
        for connector in answer.report.connectors {
            XCTAssertTrue(answer.callout(of: connector.id).allSatisfy { need in answer.report.needs.contains(need) }, connector.id)
        }
    }

    func testARowSaysTheHomesLineItsTimeInTheseWordsAndItsMore() throws {
        let start = try XCTUnwrap(HomeClock.Run(day: "2020-01-01", startMs: 1_577_836_800_000, days: 1, zone: "UTC"))
        let clock = try XCTUnwrap(HomeClock(id: "utc", runs: [start]))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-05T12:00:00Z"))
        let timed = try Self.row(#""line": "41 emails, last", "time": {"kind": "day", "day": "2026-10-04"}, "more": ["2 failed"]"#)
        XCTAssertEqual(StreamsLine.words(timed, clock: clock, now: now), "41 emails, last yesterday · 2 failed")
        let plain = try Self.row(#""line": "Every email, sent and received.", "time": null, "more": []"#)
        XCTAssertEqual(StreamsLine.words(plain, clock: clock, now: now), "Every email, sent and received.")
        XCTAssertNil(StreamsLine.last(plain, clock: clock, now: now), "no last time served, none drawn")
    }
}

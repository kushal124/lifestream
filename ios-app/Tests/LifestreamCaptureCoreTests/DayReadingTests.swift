import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class DayReadingTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")

    private static func page(_ name: String) throws -> HomeLink.Pages.Day {
        try JSONDecoder().decode(HomeLink.Pages.Day.self, from: Data(contentsOf: fixtures.appendingPathComponent(name)))
    }

    func testADayIsReadAtItsOwnPageKeyWhichTheShelfKeepsAsADay() {
        let key = DayReading.key("2026-10-05")
        XCTAssertEqual(key.description, "/v1/page/day?day=2026-10-05")
        XCTAssertTrue(PageShelf.isDay(key.description), "the shelf keeps it among its fourteen days")
    }

    func testEveryRowOfAnHourSitsInItsChapterAndItsHour() throws {
        let page = try Self.page("day.brief.json")
        let chapter = try XCTUnwrap(page.chapters.first { $0.blocks.contains { $0.kind == .hour } })
        let hour = try XCTUnwrap(chapter.blocks.first { $0.kind == .hour })
        let row = try XCTUnwrap(hour.rows.first)
        XCTAssertEqual(DayReading.place(of: row.key, in: page), DayReading.Place(chapter: chapter.key, block: hour.key, row: row.key))
        XCTAssertEqual(DayReading.row(row.key, in: page), row)
        XCTAssertNil(DayReading.place(of: "e0", in: page), "a row the page does not hold has no place")
    }

    func testARowOfTheAlsoListSitsUnderAlso() throws {
        let page = try Self.page("day.brief.json")
        let row = try XCTUnwrap(page.also?.rows.first)
        XCTAssertEqual(DayReading.place(of: row.key, in: page), DayReading.Place(chapter: DayReading.also, block: nil, row: row.key))
    }

    func testANamingWaitsWhileAStayAtItsSpotIsStillUnnamed() throws {
        let page = try Self.page("day.past.json")
        let spots = page.chapters.filter(DayReading.unnamed).compactMap(\.head?.place)
        XCTAssertFalse(spots.isEmpty, "the past day holds stays at spots not named")
        XCTAssertTrue(DayReading.waits(on: [spots[0]], in: page))
        XCTAssertFalse(DayReading.waits(on: ["spot:0,0"], in: page), "a spot no stay of the day sits at waits on nothing")
        XCTAssertFalse(DayReading.waits(on: [], in: page))
    }

    func testOnlyTodayReadsAgainAndNoLaterThanItsNextPlan() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let past = try Self.page("day.past.json")
        XCTAssertNil(DayReading.again(past, now: now), "a past day is not read again by the clock")
        let today = try Self.page("day.today.json")
        XCTAssertNotNil(today.untilMs, "today has a plan ahead")
        let again = try XCTUnwrap(DayReading.again(today, now: now))
        XCTAssertLessThanOrEqual(again, now.addingTimeInterval(DayReading.every))
        XCTAssertGreaterThanOrEqual(again, now, "never before now")
    }
}

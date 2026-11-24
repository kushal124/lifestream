import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class DaysListingTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")

    private static func page(_ name: String) throws -> HomeLink.Pages.Days {
        try JSONDecoder().decode(HomeLink.Pages.Days.self, from: Data(contentsOf: fixtures.appendingPathComponent(name)))
    }

    func testTheListIsTheHomesDaysInItsOrderOpeningWhereTheHomeSays() throws {
        let page = try Self.page("days.full.json")
        let listing = try XCTUnwrap(DaysListing([page]))
        XCTAssertEqual(listing.days, page.days.map(\.day), "the days in the answer's order, none added")
        XCTAssertEqual(listing.opening, page.opening)
        XCTAssertEqual(listing.first, page.days.first?.day)
        XCTAssertEqual(listing.totals, Dictionary(uniqueKeysWithValues: page.days.map { ($0.day, $0.counts.total) }))
    }

    func testAListOfSeveralAnswersJoinsThemInTheirOrderAndOpensOnTheFirstsOpening() throws {
        let page = try Self.page("days.full.json")
        let listing = try XCTUnwrap(DaysListing([page, page]))
        XCTAssertEqual(listing.days, page.days.map(\.day) + page.days.map(\.day))
        XCTAssertEqual(listing.written, Set(page.days.map(\.day)))
        XCTAssertNil(DaysListing([]), "no answer, no list")
    }
}

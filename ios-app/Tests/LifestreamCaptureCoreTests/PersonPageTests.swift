import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class PersonPageTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages/canned")

    private static func page(_ name: String, _ change: (inout [String: Any]) -> Void = { _ in }) throws -> PersonPage {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("person.\(name).json")))
            as? [String: Any])
        change(&object)
        return PersonPage(try JSONDecoder().decode(HomeLink.Pages.Person.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    func testABusyPageDrawsTheHomesWeeksInItsOrderWithItsMark() throws {
        let drawn = try Self.page("person-a")
        guard case .weeks(let weeks, let marked) = drawn.page.history,
              case .weeks(let count, let bars, let drawnMark) = drawn.figure(today: drawn.page.today) else { return XCTFail("weeks") }
        XCTAssertEqual(count, drawn.page.month.count, "the big number is the home's thirty days")
        XCTAssertEqual(bars.map(\.count), weeks.map(\.count))
        XCTAssertEqual(bars.map(\.day), weeks.map(\.day), "a bar opens the day the home names")
        XCTAssertEqual(drawnMark, marked)
        XCTAssertEqual(bars.last?.label, "This week")
        XCTAssertEqual(bars.first?.when, "week of " + Words.shortDay(weeks[0].start, weekday: false, today: drawn.page.today))
    }

    func testAQuietPersonWithYearsDrawsTheYearsAndTheMonthLineWithTheHomesJoiner() throws {
        let drawn = try Self.page("person-d")
        let today = drawn.page.today
        guard case .years(let total, let bars, _, let foot) = drawn.figure(today: today),
              case .years(let years, let held, _) = drawn.page.history, let before = drawn.page.month.before else { return XCTFail("years") }
        XCTAssertEqual(total, held)
        XCTAssertEqual(bars.map(\.label), years.map(\.year))
        XCTAssertEqual(foot, drawn.page.month.line + before.joiner + Words.shortDay(before.day, weekday: false, today: today))
        XCTAssertEqual(try Self.page("sam-example").monthFoot(today: today), "None in the last 30 days", "no day before: the line alone")
    }

    func testAHandfulEverIsFactsWithItsCallsAndNoCallsRow() throws {
        let calls: [String: Any] = ["count": 4, "words": "4 calls"]
        let few = try Self.page("person-c") { page in
            page["history"] = ["kind": "facts", "total": 11, "first": "2026-03-02"]
            page["month"] = (page["month"] as? [String: Any] ?? [:]).merging(["calls": calls]) { $1 }
        }
        XCTAssertEqual(few.figure(today: "2026-10-05"), .facts([
            .init(key: "Messages", words: "11"), .init(key: "First contact", words: "2 Mar"), .init(key: "Calls · 30 days", words: "4"),
        ]))
        XCTAssertNil(few.calls, "the calls stand among the facts, never a row of their own too")
        let busy = try Self.page("person-c") { page in page["month"] = (page["month"] as? [String: Any] ?? [:]).merging(["calls": calls]) { $1 } }
        XCTAssertEqual(busy.calls?.count, 4)
        XCTAssertNil(try Self.page("person-c").calls, "none counted: no row")
    }

    func testWhereYouTalkKeepsTheHomesOrderAndFoldsGroupsPastTheFifth() throws {
        let drawn = try Self.page("person-a")
        let talks = drawn.talks
        XCTAssertEqual(talks.shown + talks.folded, drawn.page.where, "every row, in the home's order")
        XCTAssertEqual(talks.shown.filter(\.group).count, PersonPage.groupsShown)
        XCTAssertTrue(talks.shown.contains { !$0.group }, "the one-to-one chat is always shown")
        XCTAssertTrue(talks.folded.allSatisfy(\.group))
        XCTAssertTrue(talks.folded.contains(where: \.quiet), "the quiet groups among the folded")
        XCTAssertEqual(PersonPage.moreGroups(talks.folded.count), "\(talks.folded.count) more groups")
        XCTAssertEqual(PersonPage.moreGroups(1), "1 more group")
        XCTAssertEqual(PersonPage.moreGroups(1_200), "1,200 more groups")
        XCTAssertEqual(try Self.page("person-d").talks.folded, [], "two rows: nothing folded")
    }

    func testTheHeadsChipsAreTheAboutFactsBirthdayWorkThenProfiles() throws {
        let drawn = try Self.page("person-a")
        let facts = drawn.facts(today: "2026-10-05") { $0 }
        XCTAssertEqual(facts.map(\.id), ["birthday", "work", "instagram:@person.a", "site:example.com"])
        XCTAssertEqual(facts.first?.words, "in 3\u{00A0}days")
        XCTAssertEqual(facts[1].words, drawn.page.head.work)
        XCTAssertEqual(facts[2].key, "Instagram")
        XCTAssertEqual(facts[2].link, URL(string: "https://www.instagram.com/person.a/"))
        XCTAssertEqual(facts[2].said, "Instagram, @person.a")
        XCTAssertEqual(drawn.line, "Friend from college")
        XCTAssertEqual(try Self.page("person-d").facts(today: "2026-10-05") { $0 }, [], "nothing known: no About card")
    }

    func testABirthdayIsWordedFromTheDayItIsDrawn() {
        XCTAssertEqual(PersonPage.birthday(month: 10, day: 5, today: "2026-10-05"), "Birthday today")
        XCTAssertEqual(PersonPage.birthday(month: 10, day: 6, today: "2026-10-05"), "Birthday in 1\u{00A0}day")
        XCTAssertEqual(PersonPage.birthday(month: 10, day: 19, today: "2026-10-05"), "Birthday in 14\u{00A0}days")
        XCTAssertEqual(PersonPage.birthday(month: 10, day: 20, today: "2026-10-05"), "20 Oct")
        XCTAssertEqual(PersonPage.birthday(month: 1, day: 2, today: "2026-12-25"), "Birthday in 8\u{00A0}days", "next year's")
        XCTAssertEqual(PersonPage.birthday(month: 2, day: 29, today: "2027-02-20"), "Birthday in 8\u{00A0}days", "the 28th in a year with no 29th")
    }
}

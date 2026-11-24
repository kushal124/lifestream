import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class PeopleListingTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")
    private static let now = Date(timeIntervalSince1970: 1_791_968_400)

    private static func listing(_ name: String) throws -> PeopleListing {
        PeopleListing(try JSONDecoder().decode(HomeLink.Pages.People.self, from: Data(contentsOf: fixtures.appendingPathComponent(name))))
    }

    func testAPersonWithNoContactStandsUnderNoMessagesYetWithTheHomesLine() throws {
        let listing = try Self.listing("people.full.json")
        let none = try XCTUnwrap(listing.sections(today: listing.page.today).last)
        XCTAssertEqual(none.key, "none")
        XCTAssertEqual(none.heading, "No messages yet", "the home's words, never a time")
        let card = try XCTUnwrap(none.rows.first { $0.id.hasPrefix("contact:") })
        XCTAssertNil(card.when)
        XCTAssertEqual(PeopleListing.meta(card, today: listing.page.today, now: Self.now), "Contact card")
        XCTAssertFalse(none.rows.contains { PeopleListing.meta($0, today: listing.page.today, now: Self.now)?.contains("1970") == true },
                       "no row with no contact draws a date")
    }

    func testTheAIsStandInTheirOwnSectionAndNoOther() throws {
        let listing = try Self.listing("people.full.json")
        XCTAssertEqual(listing.page.ai.map(\.name), ["Synthetic Assistant"])
        let listed = listing.sections(today: listing.page.today).flatMap(\.rows).map(\.id)
        XCTAssertFalse(listed.contains("person:person-ai"), "an AI is never among the people")
    }

    func testEveryListDrawsInTheAnswersOrder() throws {
        let listing = try Self.listing("canned/people.list.json")
        let page = listing.page
        let today = page.today
        XCTAssertEqual(listing.sections(today: today).map(\.key), page.sections.map(\.key))
        XCTAssertEqual(listing.sections(today: today).map { $0.rows.map(\.id) }, page.sections.map { $0.rows.map(\.id) })
        XCTAssertEqual(listing.sections(today: today).map(\.heading), ["This month", "September", "August", "2025"],
                       "the time keys worded against the home's day")
        XCTAssertEqual(listing.most.map(\.row.id), page.most.map(\.id))
        XCTAssertEqual(listing.most.map(\.line), page.most.map(\.line))
        XCTAssertEqual(listing.organise.map(\.id), page.organise.queue)
        XCTAssertEqual(listing.found("").groups.map(\.chat), (page.groups.yours + page.groups.quiet).map(\.chat))
    }

    func testTheTimeKeysAreWordedWhenDrawnNeverKept() throws {
        let listing = try Self.listing("canned/people.list.json")
        XCTAssertEqual(listing.sections(today: "2027-01-04").map(\.heading), ["October 2026", "September 2026", "August 2026", "2025"],
                       "the same kept answer, drawn in another year")
    }

    func testTheEmptyHomeAsksForAConnector() throws {
        XCTAssertTrue(try Self.listing("people.nothing.json").nobody)
        XCTAssertFalse(try Self.listing("canned/people.list.json").nobody)
    }

    func testTypeToFilterMatchesTheStartOfAFindWordOrDigitsInsideOne() throws {
        let listing = try Self.listing("canned/people.list.json")
        XCTAssertEqual(listing.found("person a").people.map(\.id), ["person:person-a"])
        XCTAssertEqual(listing.found("PÉRSON  a").people.map(\.id), ["person:person-a"], "folded for case and accents")
        XCTAssertEqual(listing.found("0000004").people.map(\.id), ["person:person-d"], "a run of digits inside a number")
        XCTAssertEqual(listing.found("example").people.map(\.id), ["person:sam-example", "person:person-a", "person:person-c", "email:person-f@example.com"], "a word inside a name or an address starts a find word")
        XCTAssertEqual(listing.found("xample").people, [], "letters inside a word find nothing")
        XCTAssertEqual(listing.found("alpha").groups.map(\.title), ["Group Alpha"])
        XCTAssertEqual(listing.found("zzz"), PeopleListing.Found(typed: "zzz", people: [], groups: []))
    }

    func testTypedWordsSplitOnPunctuationAsTheHomeSplitsFind() {
        XCTAssertTrue(PageFilter.shows(["Ace", "jean", "luc"], typed: "Jean-Luc"), "an Also-called name the home split into its words")
        XCTAssertFalse(PageFilter.shows(["Ace", "jean", "luc"], typed: "jean-paul"), "every piece of a typed word must match")
        XCTAssertTrue(PageFilter.shows(["Person C", "person-c@example.com"], typed: "person-c@example"), "a typed address still matches whole")
        XCTAssertFalse(PageFilter.shows(["Person C"], typed: "@"), "punctuation alone finds nothing")
    }

    private struct FilterRule: Decodable {
        struct Case: Decodable {
            let about: String
            let find: [String]
            let typed: String
            let shown: Bool
        }

        let cases: [Case]
    }

    func testTypeToFilterIsTheDashboardsRuleCaseByCase() throws {
        let file = Self.fixtures.deletingLastPathComponent().appendingPathComponent("rules/filter.json")
        let rule = try JSONDecoder().decode(FilterRule.self, from: Data(contentsOf: file))
        XCTAssertFalse(rule.cases.isEmpty)
        for each in rule.cases {
            XCTAssertEqual(PageFilter.shows(each.find, typed: each.typed), each.shown, each.about)
        }
    }

    func testTheHomesFindAddsOnlyWhoTheListLacks() throws {
        let listing = try Self.listing("canned/people.list.json")
        let atHome = try JSONDecoder().decode(HomeLink.Pages.PeopleFind.self,
                                              from: Data(contentsOf: Self.fixtures.appendingPathComponent("canned/peopleFind.stranger.json")))
        let local = listing.found("Stranger")
        XCTAssertEqual(local.people, [], "not in the list")
        XCTAssertEqual(local.adding(atHome.rows).people.map(\.id), ["phone:+15550000009"])
        let personA = listing.found("person a")
        XCTAssertEqual(personA.adding(personA.people).people.map(\.id), ["person:person-a"], "never twice")
    }
}

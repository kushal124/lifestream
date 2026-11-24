import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class SearchWordsTests: XCTestCase {
    private let decoder = JSONDecoder()


    func testAnyTimeOffersThisMonthThisYearThenEachYearBackToTheFirstHeld() {
        XCTAssertEqual(SearchWords.spans(today: "2026-02-14", first: "2023-07-01"), [
            .init("This month", from: "2026-02-01", to: "2026-02-28"), .init("This year", from: "2026-01-01", to: "2026-12-31"),
            .init("2025", from: "2025-01-01", to: "2025-12-31"), .init("2024", from: "2024-01-01", to: "2024-12-31"),
            .init("2023", from: "2023-01-01", to: "2023-12-31"),
        ])
        XCTAssertEqual(SearchWords.spans(today: "2026-02-14", first: nil).map(\.label), ["This month", "This year"], "nothing held, no years")
        XCTAssertEqual(SearchWords.spans(today: "2026-02-14", first: "2026-01-09").map(\.label), ["This month", "This year"])
    }

    func testTheUserIsYou() {
        XCTAssertEqual(SearchWords.who("the user"), "You")
        XCTAssertEqual(SearchWords.who("Person A"), "Person A")
    }

    func testDaysMoveAndMonthsEnd() {
        XCTAssertEqual(SearchWords.addDays("2026-03-01", -1), "2026-02-28")
        XCTAssertEqual(SearchWords.addDays("2026-12-31", 1), "2027-01-01")
        XCTAssertEqual(SearchWords.monthEnd("2024-02"), "2024-02-29")
        XCTAssertEqual(SearchWords.monthEnd("2026-12"), "2026-12-31")
    }


    func testASnippetsMarksBecomeMarkedRuns() {
        XCTAssertEqual(SearchWords.snippet("are you «free» on «Thu»rsday"), [
            .init("are you ", marked: false), .init("free", marked: true), .init(" on ", marked: false),
            .init("Thu", marked: true), .init("rsday", marked: false),
        ])
        XCTAssertEqual(SearchWords.snippet("an «open mark"), [.init("an ", marked: false), .init("open mark", marked: true)])
        XCTAssertEqual(SearchWords.snippet("a stray» close"), [.init("a stray close", marked: false)])
        XCTAssertEqual(SearchWords.snippet(""), [])
    }

    func testAHitsClockAndInstantAreWhereThePersonWas() {
        XCTAssertEqual(SearchWords.clock(local: "2026-10-04T09:15+01:00"), "09:15")
        XCTAssertEqual(SearchWords.clock(local: "2026-10-14T16:42:05+01:00"), "16:42")
        XCTAssertEqual(SearchWords.clock(local: "07:12"), "07:12")
        XCTAssertNil(SearchWords.clock(local: "2026-10-14"))
        XCTAssertNil(SearchWords.clock(local: nil))
        XCTAssertEqual(SearchWords.instant("2026-10-04T09:15+01:00"), Date(timeIntervalSince1970: 1_791_101_700), "its offset kept")
        XCTAssertEqual(SearchWords.instant("2026-10-04T08:15:00Z"), Date(timeIntervalSince1970: 1_791_101_700))
        XCTAssertEqual(SearchWords.instant("2026-10-04T03:45-04:30"), Date(timeIntervalSince1970: 1_791_101_700))
        XCTAssertNil(SearchWords.instant("2026-10-04"), "a date names no instant")
        XCTAssertNil(SearchWords.instant(nil))
    }

    func testTheHomesReadingLineIsSaidAsItCameWithTheNewestDayStillReadWordedHere() throws {
        let read = { (json: String) in try self.decoder.decode(HomeLink.Pages.Reading.self, from: Data(json.utf8)) }
        XCTAssertEqual(SearchWords.reading(try read(#"{"state":"building","line":"Search is getting ready: 40% read","percent":40}"#), today: "2026-11-14"),
                       "Search is getting ready: 40% read")
        let behind = { (day: String) in try read(#"{"state":"behind","line":"Still reading","newest":{"kind":"day","day":"\#(day)"}}"#) }
        XCTAssertEqual(SearchWords.reading(try behind("2026-11-14"), today: "2026-11-14"), "Still reading today")
        XCTAssertEqual(SearchWords.reading(try behind("2026-11-12"), today: "2026-11-14"), "Still reading Thu 12 Nov")
        XCTAssertNil(SearchWords.reading(nil, today: "2026-11-14"))
    }

    func testEveryFamilyHasWordsAndAnIcon() {
        XCTAssertEqual(SearchWords.family("messages"), .init(label: "Messages", icon: "message"))
        XCTAssertEqual(SearchWords.family("physical"), .init(label: "Places", icon: "place"))
        XCTAssertEqual(SearchWords.family("knitting"), .init(label: "Knitting", icon: "info"))
        XCTAssertEqual(SearchWords.family(nil), .init(label: "Other", icon: "info"))
    }

    func testRecentSearchesKeepTenNewestFirstOnceEachUnderCompleteProtection() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recent-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("recent-searches.json")
        var recent = SearchHistory(file: file)
        XCTAssertEqual(recent.words, [])
        for index in 1...12 { recent.add("query \(index)") }
        recent.add("  Query 3 ")
        recent.add("   ")
        XCTAssertEqual(recent.words.count, SearchHistory.capacity)
        XCTAssertEqual(Array(recent.words.prefix(2)), ["Query 3", "query 12"], "the newest first, the same words once")
        XCTAssertFalse(recent.words.contains("query 2"), "the oldest went")

        XCTAssertEqual(SearchHistory(file: file).words, recent.words, "a new launch reads the same list")
        let values = try folder.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        #if os(iOS)
            let protection = try FileManager.default.attributesOfItem(atPath: file.path)[.protectionKey] as? FileProtectionType
            XCTAssertEqual(protection, .complete)
        #endif

        recent.clear()
        XCTAssertEqual(recent.words, [])
        XCTAssertEqual(SearchHistory(file: file).words, [])

        try Data("not json".utf8).write(to: file)
        XCTAssertEqual(SearchHistory(file: file).words, [], "a file that does not read is an empty list")
    }
}

import Foundation
import HomeLink
import XCTest

@testable import Lifestream

final class AskCitedTests: XCTestCase {
    private static func contract() throws -> [String: HomeLink.Citation] {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/home/test/contract/citations.json")
        return try JSONDecoder().decode([String: HomeLink.Citation].self, from: Data(contentsOf: file))
    }

    func testEachCitedKindOpensWhereTheDoorSays() throws {
        let cited = try Self.contract()
        func opening(_ handle: String) throws -> CitedOpening {
            CitedOpening.of(try XCTUnwrap(cited[handle], handle))
        }
        XCTAssertEqual(try opening("r3"), .moment(day: "2026-10-04", focus: "rec:whatsapp:15550000009:iphone-aa01 message a1"))
        XCTAssertEqual(try opening("r4"), .moment(day: "2026-10-01", focus: "rec:google-calendar:me@example.com:cloud event e3"))
        XCTAssertEqual(try opening("r5"), .moment(day: "2026-10-01", focus: "u:calendar/e3"))
        XCTAssertEqual(try opening("r6"), .moment(day: "2026-10-04", focus: "rec:photos:local:iphone-aa01 photo ph1"))
        XCTAssertEqual(try opening("r7"), .moment(day: "2026-11-02", focus: "u:screen:local:macbook-pro-0001/1793595600000@1793595780000-1793595840000"),
                       "a window opens at its minute")
        XCTAssertEqual(try opening("r8"), .row(ref: try XCTUnwrap(cited["r8"]).ref, asked: "sum of amount over payments, by item"))
        XCTAssertEqual(try opening("r9"), .route(.person("phone:+15550000001")), "a person opens by its handle, which the home's person page takes")
        XCTAssertEqual(try opening("r10"), .route(.group("whatsapp:120363000000000004@g.us")), "a cited group opens its own page, as the home names it")
        XCTAssertEqual(try opening("r11"), .route(.place("example-cafe")))
        XCTAssertEqual(try opening("r12"), .nothing)

        let group = try XCTUnwrap(cited["r10"])
        let oneToOne = HomeLink.Citation(ref: group.ref, kind: .chat, opens: .people("whatsapp:15550000001@s.whatsapp.net", person: "person:person-a"), name: "Person A")
        XCTAssertEqual(CitedOpening.of(oneToOne), .route(.person("person:person-a")), "a one-to-one chat opens the home's person")
        XCTAssertEqual(CitedOpening.of(.init(ref: group.ref, kind: .chat, opens: .read, name: "Example Chat")), .nothing, "only a row opens through read")
        XCTAssertEqual(CitedOpening.of(.init(ref: "map.m1", kind: .other, opens: nil, title: "Synthetic Map")), .nothing)
    }

    func testACitationThatOpensNothingSaysWhy() throws {
        let cited = try Self.contract()
        let gone = try XCTUnwrap(cited["r12"])
        XCTAssertEqual(CitedOpening.unopened(gone), gone.why, "a gone citation says why")
        XCTAssertEqual(gone.words, gone.why, "its capsule says why too")
        XCTAssertEqual(CitedOpening.unopened(.init(ref: "chat.c1", kind: .chat, opens: .read, name: "Example Chat")), "Can't open this on iPhone yet.")
    }

    func testARowThatMovedSaysBothCounts() {
        XCTAssertEqual(AskStatsSheet.moved(7, now: 8), "The answer counted 7; there are 8 now.")
    }

    func testEachFactNamesItsCellsByTheirColumns() {
        let cells: [HomeLink.JSON] = [.string("2026-03-02"), .string("ACME CABS LIMITED"), .null, .string("50.00"), .string("record.r1")]
        XCTAssertEqual(AskStatsSheet.fact(cells, columns: ["day", "payee", "direction", "amount", "ref"]),
                       "day: 2026-03-02 · payee: ACME CABS LIMITED · amount: 50.00", "each cell by its column, an empty one and the ref left out")
    }

    func testAStatsCellReadsAsWords() {
        XCTAssertEqual([HomeLink.JSON.string("2026-09-25T09:00-04:00"), .number(3), .number(2.5), .null, .array([.string("a"), .string("b")])]
            .map(AskStatsSheet.words), ["2026-09-25T09:00-04:00", "3", "2.5", "", "a, b"])
    }
}

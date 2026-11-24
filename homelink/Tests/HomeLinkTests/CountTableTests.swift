import Foundation
import XCTest
@testable import HomeLink

final class CountTableTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private static let contract = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/home/test/contract")

    private static let pages = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/pages")

    private static func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: contract.appendingPathComponent(name + ".json"))
    }

    private func paired(_ script: [ScriptedTransport.Step]) async throws -> (HomeLink, ScriptedTransport) {
        let credentials = MemoryCredentials()
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: pairing)
            .pair(code: "12345678", name: home, account: Fixture.account)
        let transport = ScriptedTransport(script)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), transport)
    }

    func testEveryPlaysCountOfTheContractDecodesByItsColumns() throws {
        let decoder = JSONDecoder()
        let tracks = try decoder.decode(HomeLink.CountTable.self, from: Self.fixture("count-plays"))
        XCTAssertEqual(tracks.total?.sum, .number(415), "the listening kind's plays")
        XCTAssertEqual(tracks.rows.map { tracks.value("track", in: $0)?.string }, ["Riverside", "Riverside Drive", "Riverside Nights",
                                                                                     "Down by the Riverside", "Riverside Morning", "Riverside (Live)"])
        XCTAssertEqual(tracks.value("sum", in: tracks.rows[0]), .number(212))
        XCTAssertNil(tracks.next)

        let months = try decoder.decode(HomeLink.CountTable.self, from: Self.fixture("count-plays-by-month"))
        XCTAssertEqual(months.rows.compactMap { months.value("month", in: $0)?.string }, ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"])
        XCTAssertEqual(months.rows.compactMap { months.value("sum", in: $0)?.number }, [18, 44, 61, 39, 30, 20])

        let plays = try decoder.decode(HomeLink.CountTable.self, from: Self.fixture("count-plays-by-item"))
        XCTAssertEqual(plays.rows.count, 13)
        XCTAssertEqual(plays.value("album", in: plays.rows[0])?.string, "Low Tide")
        XCTAssertEqual(plays.value("app", in: plays.rows[2])?.string, "Music")
        XCTAssertEqual(plays.value("times", in: plays.rows[5]), .number(3))
        XCTAssertEqual(plays.value("time", in: plays.rows.last ?? [])?.string, "2026-11-14T20:05+00:00")
        XCTAssertNil(plays.value("nothing", in: plays.rows[0]))
    }

    func testAKindsPageAndTheCountAreAskedWithTheirParameters() async throws {
        let page = String(decoding: try Data(contentsOf: Self.pages.appendingPathComponent("searchKind.full.json")), as: UTF8.self)
        let count = String(decoding: try Self.fixture("count-plays-by-month"), as: UTF8.self)
        let (link, transport) = try await paired([.reply(200, page), .reply(200, page), .reply(200, count)])
        let seen = try await link.searchKind(HomeLink.PageKey(HomeLink.Pages.SearchKind.route,
                                                              ["query": "lighthouse", "typing": "1", "see": "messages", "upcoming": "1"]))
        XCTAssertEqual(seen.family, .messages)
        XCTAssertEqual(transport.requests[0].url.path, HomeLink.Pages.SearchKind.route)
        XCTAssertEqual(transport.requests[0].url.query, "query=lighthouse&see=messages&typing=1&upcoming=1", "See all's first page is the words and its kind")
        _ = try await link.searchKind(HomeLink.PageKey(HomeLink.Pages.SearchKind.route, ["cursor": "cursor:screen:k1"]))
        XCTAssertEqual(transport.requests[1].url.query, "cursor=cursor%3Ascreen%3Ak1", "a later page is its cursor alone")
        let months = try await link.countTable(HomeLink.CountTableQuery(
            of: "plays", match: [.init("track", whole: "Riverside"), .init("artist", whole: "The Quiet Hours")],
            measure: "times", op: "sum", by: ["month"]))
        XCTAssertEqual(months.rows.count, 6)
        XCTAssertEqual(transport.requests[2].url.path, "/v1/count")
        XCTAssertEqual(transport.requests[2].url.query,
                       "of=plays&match.track=%3DRiverside&match.artist=%3DThe%20Quiet%20Hours&measure=times&op=sum&by=month",
                       "an exact match is the value after `=`, each key its own")
    }

    func testAnExpiredCursorOnAPagedSearchReadIsItsOwnErrorAndAnyOtherRefusalStaysTheLinksFailure() async throws {
        let expired = #"{"code":"CURSOR_EXPIRED","message":"what this page was read from changed since it was given: ask again"}"#
        let (link, _) = try await paired([
            .reply(409, expired), .reply(409, expired), .reply(409, expired), .reply(400, #"{"code":"BAD_CURSOR","message":"not a cursor"}"#),
        ])
        let words = "what this page was read from changed since it was given: ask again"
        do {
            _ = try await link.searchKind(HomeLink.PageKey(HomeLink.Pages.SearchKind.route, ["cursor": "cursor:screen:k2"]))
            XCTFail("expired")
        } catch let failure as HomeLink.CursorExpired {
            XCTAssertEqual(failure.description, words)
        }
        do {
            _ = try await link.search(HomeLink.SearchQuery(cursor: "record-2"))
            XCTFail("expired")
        } catch let failure as HomeLink.CursorExpired {
            XCTAssertEqual(failure.description, words)
        }
        do {
            _ = try await link.countTable(HomeLink.CountTableQuery(of: "plays", measure: "times", op: "sum", by: ["track"], cursor: "count-2"))
            XCTFail("expired")
        } catch is HomeLink.CursorExpired {}
        do {
            _ = try await link.search(HomeLink.SearchQuery(cursor: "record-3"))
            XCTFail("refused")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "BAD_CURSOR")
        }
    }
}

import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class SearchModelTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("search-model-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private static let pages = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")

    private static func json(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: pages.appendingPathComponent(name + ".json"))) as? [String: Any])
    }

    private static func decoded<Value: Decodable>(_ json: Any, as type: Value.Type = Value.self) throws -> Value {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: json, options: .fragmentsAllowed))
    }

    private static func search(_ name: String = "search.full", _ change: (inout [String: Any]) -> Void = { _ in }) throws -> SearchModel.Search {
        var page = try json(name)
        change(&page)
        return try decoded(page)
    }

    private static func kind(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> SearchModel.Kind {
        var page = try json("searchKind.full")
        change(&page)
        return try decoded(page)
    }

    private static func row(_ json: [String: Any]) throws -> SearchModel.Row {
        try decoded(json)
    }

    private final class Script {
        var searches: [[PageShelf.Drawn<SearchModel.Search>]] = []
        var kinds: [Result<SearchModel.Kind, Error>] = []
        var asked: [HomeLink.PageKey] = []
    }

    private func model(_ script: Script) -> SearchModel {
        let door = SearchModel.Door(answers: { key in
            script.asked.append(key)
            let drawn = script.searches.isEmpty ? [] : script.searches.removeFirst()
            return AsyncStream { out in
                drawn.forEach { out.yield($0) }
                out.finish()
            }
        }, kind: { key in
            script.asked.append(key)
            return try script.kinds.removeFirst().get()
        }, revision: { 0 })
        return SearchModel(door: door, recent: folder.appendingPathComponent("recent.json"), settle: .zero, wait: .zero)
    }

    private static func drawn(_ page: SearchModel.Search?, _ state: PageShelf.State = .fresh) -> PageShelf.Drawn<SearchModel.Search> {
        PageShelf.Drawn(key: HomeLink.PageKey(SearchModel.Search.route), page: page, position: nil, state: state)
    }

    func testThePartsAreTheAnswersTopThenItsKindsInItsOrder() async throws {
        for reversed in [false, true] {
            let page = try Self.search { page in
                var kinds = page["kinds"] as? [[String: Any]] ?? []
                kinds.append(["family": "mail", "title": "Mail", "count": ["n": 1, "partial": false], "upcoming": NSNull(), "see": false,
                              "unread": NSNull(), "rows": [Any]()])
                page["kinds"] = reversed ? Array(kinds.reversed()) : kinds
            }
            let script = Script()
            script.searches = [[Self.drawn(page)]]
            let model = model(script)
            model.text = "lighthouse"
            await model.ask(model.asking)
            XCTAssertEqual(model.parts.map(\.id), ["top"] + page.kinds.map(\.family.rawValue), "the home's order, never the phone's")
            XCTAssertEqual(model.drawn?.top, page.top, "each row as the home wrote it, its title and line")
        }
    }

    func testTheWordsAskTheSearchPageWithTheirTimeAndSeeAllAsksTheKindsPage() async throws {
        let script = Script()
        script.searches = [[Self.drawn(try Self.search())]]
        script.kinds = [.success(try Self.kind())]
        let model = model(script)
        model.text = "lighthouse"
        model.span = SearchWords.Span("This year", from: "2026-01-01", to: "2026-12-31")
        await model.ask(model.asking)
        model.kind = "messages"
        await model.see(model.seeing)
        XCTAssertEqual(script.asked.map(\.description), [
            "/v1/page/search?from=2026-01-01&query=lighthouse&to=2026-12-31&typing=1",
            "/v1/page/search/kind?from=2026-01-01&query=lighthouse&see=messages&to=2026-12-31&typing=1",
        ])
        XCTAssertEqual(model.page?.rows.count, 2)
    }

    func testAHomeGettingReadySaysItsLineThenAsksAgainAndAFailureKeepsTheKeptAnswer() async throws {
        let ready = try Self.search("search.reading")
        let found = try Self.search()
        let script = Script()
        script.searches = [[Self.drawn(ready)], [Self.drawn(found, .kept), Self.drawn(found, .offline)]]
        let model = model(script)
        model.text = "lighthouse"
        await model.ask(model.asking)
        XCTAssertEqual(script.asked.count, 2, "asked again while the home was getting ready")
        XCTAssertEqual(SearchModel.readying(ready), "Search is getting ready")
        XCTAssertEqual(model.answer, .failed(.reach(begun: 0)))
        XCTAssertEqual(model.drawn, found, "the kept answer stays drawn under the failure")
    }

    func testClearedWordsDropTheKeptAnswer() async throws {
        let script = Script()
        script.searches = [[Self.drawn(try Self.search(), .offline)]]
        let model = model(script)
        model.text = "lighthouse"
        await model.ask(model.asking)
        XCTAssertNotNil(model.drawn)
        model.text = ""
        await model.ask(model.asking)
        XCTAssertNil(model.drawn)
        XCTAssertNil(model.answer)
    }

    func testEachRowOpensWhereTheHomeSaysAPhotoItsPictureAndOneWithNoWayInSaysSo() throws {
        let model = model(Script())
        let message = try Self.row(["kind": "hit", "ref": "record.m", "family": "messages", "title": "Person A", "line": "a «lighthouse»",
                                    "when": NSNull(), "picture": NSNull(),
                                    "opens": ["page": "days", "day": "2026-10-04", "focus": "rec:whatsapp:canned msg m1"]])
        XCTAssertEqual(model.open(message), .moment(day: "2026-10-04", focus: "rec:whatsapp:canned msg m1"))
        let note = try Self.row(["kind": "hit", "ref": "record.n", "family": "voice", "title": "Voice note", "line": NSNull(), "when": NSNull(),
                                 "picture": NSNull(), "opens": ["page": "days", "day": "2026-10-04", "focus": "u:voice-1"]])
        XCTAssertEqual(model.open(note), .day("2026-10-04", focus: "u:voice-1"))
        let photo = try Self.row(["kind": "hit", "ref": "record.p", "family": "photos", "title": "Photo", "line": NSNull(), "when": NSNull(),
                                  "picture": "sha256:" + String(repeating: "a", count: 64), "opens": NSNull()])
        XCTAssertNil(model.open(photo))
        XCTAssertEqual(model.viewing?.photos, ["sha256:" + String(repeating: "a", count: 64)], "a photo opens the photo itself")
        let gone = try Self.row(["kind": "hit", "ref": "record.g", "family": "mail", "title": "Mail", "line": NSNull(), "when": NSNull(),
                                 "picture": NSNull(), "opens": NSNull()])
        XCTAssertNil(model.open(gone))
        XCTAssertEqual(model.unopened["record.g"], SearchModel.gone)
        let read = try Self.row(["kind": "hit", "ref": "record.r", "family": "notes", "title": "Note", "line": NSNull(), "when": NSNull(),
                                 "picture": NSNull(), "opens": ["page": "read"]])
        XCTAssertNil(model.open(read))
        XCTAssertEqual(model.unopened["record.r"], SearchModel.elsewhere)
    }

    func testANamedMonthOpensItsMonthAPersonByTheHomesPickAndAPlaceByItsSlug() throws {
        let model = model(Script())
        let month = try Self.row(["kind": "date", "when": ["kind": "month", "month": "2026-09"], "opens": ["page": "month", "month": "2026-09", "day": "2026-09-28"]])
        XCTAssertEqual(model.open(month), .month("2026-09"), "the phone opens its month page")
        let chat = try Self.row(["kind": "person", "ref": "chat.c", "name": "Person A", "line": NSNull(), "picture": NSNull(),
                                 "opens": ["page": "people", "id": "whatsapp:15550000001", "person": "person:person-a", "group": NSNull()]])
        XCTAssertEqual(model.open(chat), .person("person:person-a"), "a chat opens the person the home picked")
        let person = try Self.row(["kind": "person", "ref": "person.a", "name": "Person A", "line": NSNull(), "picture": String(repeating: "c", count: 64),
                                   "opens": ["page": "people", "id": "phone:+15550000001", "person": "person:person-a", "group": NSNull()]])
        XCTAssertEqual(model.open(person), .person("person:person-a"), "a person opens by the home's id")
        guard case .person(_, _, _, let picture, _) = person else { return XCTFail("a person row") }
        XCTAssertEqual(picture, String(repeating: "c", count: 64), "a person carries the face the home gives")
        let group = try Self.row(["kind": "person", "ref": "chat.g", "name": "Example Group", "line": NSNull(), "picture": NSNull(),
                                  "opens": ["page": "people", "id": "whatsapp:120363000000000004@g.us", "person": NSNull(), "group": "whatsapp:120363000000000004@g.us"]])
        XCTAssertEqual(model.open(group), .group("whatsapp:120363000000000004@g.us"), "a group opens its own page, as the home names it")
        let place = try Self.row(["kind": "place", "ref": "place.o", "name": "The Office", "line": "3 days", "opens": ["page": "places", "id": "the-office"]])
        XCTAssertEqual(model.open(place), .place("the-office"))
    }

    func testAWindowOpensTheFocusTheHomeGaveItAndASittingItsPage() throws {
        let opens = try Self.decoded(["page": "days", "day": "2026-10-04", "focus": "u:sitting-1@1791100000000-1791100060000"],
                                     as: HomeLink.Pages.Opens.self)
        XCTAssertEqual(LifeRoute.opening(opens, family: "screen"), .day("2026-10-04", focus: "u:sitting-1@1791100000000-1791100060000"))
        XCTAssertEqual(LifeRoute.opening(opens, family: "messages"), .moment(day: "2026-10-04", focus: "u:sitting-1@1791100000000-1791100060000"))
        XCTAssertEqual(LifeRoute.opening(opens, family: nil), .day("2026-10-04", focus: "u:sitting-1@1791100000000-1791100060000"))
        let sitting = try Self.row(["kind": "sitting", "key": "u:sitting-1", "title": "Reading", "line": NSNull(), "said": NSNull(),
                                    "when": ["kind": "at", "at_ms": 1_791_100_000_000], "windows": [Any](), "windows_line": NSNull(),
                                    "opens": ["page": "days", "day": "2026-10-04", "focus": "u:sitting-1"]])
        guard case .sitting(let shown)? = model(Script()).open(sitting) else { return XCTFail("a sitting opens its page") }
        XCTAssertEqual([shown.key, shown.title], ["u:sitting-1", "Reading"])
    }

    func testSeeAllReadsOnByItsCursorAnExpiredCursorStartsAgainAndAFailedPageKeepsItsRows() async throws {
        let script = Script()
        script.searches = [[Self.drawn(try Self.search())]]
        script.kinds = [
            .success(try Self.kind { $0["next"] = "cursor-1" }),
            .success(try Self.kind { $0["next"] = "cursor-2" }),
            .failure(HomeLink.CursorExpired("what this page was read from changed")),
            .success(try Self.kind { $0["next"] = "cursor-3" }),
            .failure(LifeReader.Failure.refused("no")),
        ]
        let model = model(script)
        model.text = "lighthouse"
        await model.ask(model.asking)
        model.kind = "messages"
        await model.see(model.seeing)
        await model.more()
        XCTAssertEqual(model.page?.rows.count, 4, "a later page joins the list")
        XCTAssertEqual(script.asked.last?.description, "/v1/page/search/kind?cursor=cursor-1", "a later page is its cursor alone")
        await model.more()
        XCTAssertEqual(model.page?.rows.count, 2, "an expired cursor reads the first page again")
        XCTAssertEqual(model.page?.next, "cursor-3")
        await model.more()
        XCTAssertEqual(model.page?.rows.count, 2)
        XCTAssertEqual(model.page?.failed, .refused("no"), "a failed later page keeps its rows and says so")
    }

    func testASeeAllOnAHomeGettingReadyAsksAgain() async throws {
        let script = Script()
        script.searches = [[Self.drawn(try Self.search())]]
        script.kinds = [
            .success(try Self.kind { page in
                page["rows"] = [Any]()
                page["reading"] = ["state": "building", "line": "Search is getting ready", "percent": NSNull()]
            }),
            .success(try Self.kind()),
        ]
        let model = model(script)
        model.text = "lighthouse"
        await model.ask(model.asking)
        model.kind = "messages"
        await model.see(model.seeing)
        XCTAssertEqual(script.kinds.count, 0, "asked again once the home was ready")
        XCTAssertEqual(model.page?.rows.count, 2)
    }
}

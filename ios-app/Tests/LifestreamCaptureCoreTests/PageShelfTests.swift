import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class PageShelfTests: XCTestCase {
    private static let name = "https://lifestream.example.ts.net"
    private static let start = Date(timeIntervalSince1970: 1_791_000_000)
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")
    private static let people = HomeLink.PageKey(HomeLink.Pages.People.route)
    private static let personB = HomeLink.PageKey(HomeLink.Pages.Person.route, ["id": "person:person-b"])
    private static let survivor = HomeLink.PageKey(HomeLink.Pages.Person.route, ["id": "person:person-x"])

    private final class Pauses: @unchecked Sendable {
        private let lock = NSLock()
        private var waited: [TimeInterval] = []
        var seconds: [TimeInterval] { lock.withLock { waited } }
        func wait(_ seconds: TimeInterval) { lock.withLock { waited.append(seconds) } }
    }

    private var root: URL!
    private var clock: TestClock!
    private var home: FakeHome!
    private var link: HomeLink!
    private let pauses = Pauses()
    private let credentials = MemoryCredentials()

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-pages-\(UUID().uuidString)")
        clock = TestClock(Self.start)
        let clock = self.clock!
        home = FakeHome(clock: { clock.now })
        link = HomeLink(device: .init(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil), credentials: credentials,
                        folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func shelf() -> PageShelf {
        let clock = self.clock!, pauses = self.pauses
        return PageShelf(root: root, link: link, clock: { clock.now }, pause: { pauses.wait($0) })
    }

    private static func fixture(_ name: String, position: String? = nil, counting: Bool? = nil) throws -> Data {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent(name))) as? [String: Any])
        if let position { object["position"] = position }
        if let counting { object["counting"] = counting }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private static func answer(_ body: Data, etag: String) -> HomeResponse {
        HomeResponse(status: 200, headers: ["ETag": etag], body: body)
    }

    private static let unchanged = HomeResponse(status: 304, body: Data())

    private func drawn<Page: PageAnswer>(_ type: Page.Type, _ key: HomeLink.PageKey, settled: Bool = false,
                                         on shelf: PageShelf? = nil) async -> [PageShelf.Drawn<Page>] {
        var all: [PageShelf.Drawn<Page>] = []
        for await each in (shelf ?? self.shelf()).reading(type, key, settled: settled) { all.append(each) }
        return all
    }

    private func pageFiles() -> [String] {
        let folder = root.appendingPathComponent(DisplayCaches.pages)
        return ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
    }

    private func keepPeople(position: String = "5:1791968400000") async throws {
        home.answersPages([Self.answer(try Self.fixture("people.full.json", position: position), etag: "\"e-1\"")])
        _ = await drawn(HomeLink.Pages.People.self, Self.people)
    }


    func testAnAnswerIsKeptAndTheNextReadAsksWithItsTagAnd304KeepsIt() async throws {
        try await keepPeople()
        XCTAssertEqual(pageFiles(), [PageShelf.indexName, PageShelf.name(of: Self.people.description)].sorted())
        home.answersPages([Self.unchanged])
        let again = await drawn(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(again.map(\.state), [.kept, .fresh])
        XCTAssertEqual(again.last?.page, again.first?.page)
        XCTAssertEqual(home.pagesAsked.map(\.etag), [nil, "\"e-1\""])
        XCTAssertEqual(home.pagesAsked.map(\.path), [Self.people.route, Self.people.route])
        XCTAssertEqual(home.pagesAsked.map(\.query), [nil, nil])
    }

    func testAnOlderPositionIsNeverDrawnOverANewer() async throws {
        try await keepPeople(position: "9:1791968400000")
        let older = try Self.fixture("people.nothing.json", position: "8:1791968500000")
        home.answersPages([Self.answer(older, etag: "\"e-0\"")])
        let read = await drawn(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(read.map(\.state), [.kept, .fresh])
        XCTAssertEqual(read.map { $0.position?.description }, ["9:1791968400000", "9:1791968400000"])
        let kept = await shelf().kept(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(kept?.position?.description, "9:1791968400000")
        XCTAssertEqual(kept?.page, read.first?.page)
    }

    func testOfflineTheKeptAnswerIsDrawnWithItsTime() async throws {
        try await keepPeople(position: "5:1791968400000")
        home.silence()
        let read = await drawn(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(read.map(\.state), [.kept, .offline])
        XCTAssertNotNil(read.last?.page)
        XCTAssertEqual(read.last?.asOf, Date(timeIntervalSince1970: 1_791_968_400))
    }

    func testAShelfFileOfAnOlderBuildIsDroppedAndReadAgain() async throws {
        let folder = root.appendingPathComponent(DisplayCaches.pages)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONEncoder().encode([Self.people.description]).write(to: folder.appendingPathComponent(PageShelf.indexName))
        try Data(#"{"answer": {"people": []}, "etag": "\"old\""}"#.utf8)
            .write(to: folder.appendingPathComponent(PageShelf.name(of: Self.people.description)))
        try Data("{}".utf8).write(to: folder.appendingPathComponent("people.json"))
        let elsewhere = root.appendingPathComponent(DisplayCaches.people).appendingPathComponent("people.json")
        try FileManager.default.createDirectory(at: elsewhere.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: elsewhere)
        home.answersPages([Self.answer(try Self.fixture("people.full.json"), etag: "\"e-2\"")])
        let read = await drawn(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(read.map(\.state), [.fresh])
        XCTAssertEqual(home.pagesAsked.map(\.etag), [nil])
        XCTAssertEqual(pageFiles(), [PageShelf.indexName, PageShelf.name(of: Self.people.description)].sorted())
        XCTAssertTrue(FileManager.default.fileExists(atPath: elsewhere.path), "only the pages folder is PageShelf's")
    }

    func testAKeptAnswerThatNoLongerDecodesIsDroppedAndReadAgain() async throws {
        try await keepPeople()
        let file = root.appendingPathComponent(DisplayCaches.pages).appendingPathComponent(PageShelf.name(of: Self.people.description))
        let stale = PageShelf.Kept(etag: "\"e-1\"", position: "5:1791968400000",
                                   body: #"{"position": "5:1791968400000", "today": "2026-10-05"}"#)
        try JSONEncoder().encode(stale).write(to: file)
        home.answersPages([Self.answer(try Self.fixture("people.full.json"), etag: "\"e-3\"")])
        let read = await drawn(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(read.map(\.state), [.fresh])
        XCTAssertNil(home.pagesAsked.last?.etag)
    }

    func testACountingAnswerIsReadAgainSettledUntilCounted() async throws {
        home.answersPages([
            Self.answer(try Self.fixture("people.counting.json", position: "3:1791968400000"), etag: "\"c-1\""),
            Self.answer(try Self.fixture("people.full.json", position: "4:1791968400000"), etag: "\"c-2\""),
        ])
        let read = await drawn(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(read.map { $0.page?.counting }, [true, false])
        XCTAssertEqual(home.pagesAsked.map(\.query), [nil, "settled=1"])
        XCTAssertEqual(home.pagesAsked.map(\.etag), [nil, "\"c-1\""])
    }

    func testAfterThePagesOwnSaveTheReadIsSettled() async throws {
        home.answersPages([Self.answer(try Self.fixture("people.full.json"), etag: "\"s-1\"")])
        let read = await drawn(HomeLink.Pages.People.self, Self.people, settled: true)
        XCTAssertEqual(read.map(\.state), [.fresh])
        XCTAssertEqual(home.pagesAsked.map(\.query), ["settled=1"])
    }

    func testAMergedAwayPersonIsFiledUnderTheSurvivor() async throws {
        home.answersPages([Self.answer(try Self.fixture("person.full.json"), etag: "\"b-1\"")])
        _ = await drawn(HomeLink.Pages.Person.self, Self.personB)
        home.answersPages([Self.answer(try Self.fixture("person.became.json"), etag: "\"x-1\"")])
        let shelf = shelf()
        let read = await drawn(HomeLink.Pages.Person.self, Self.personB, on: shelf)
        XCTAssertEqual(read.map(\.key), [Self.personB, Self.survivor])
        XCTAssertEqual(read.last?.page?.became, "person:person-x")
        let gone = await shelf.kept(HomeLink.Pages.Person.self, Self.personB)
        let survivor = await shelf.kept(HomeLink.Pages.Person.self, Self.survivor)
        XCTAssertNil(gone)
        XCTAssertEqual(survivor?.page, read.last?.page)
        XCTAssertEqual(pageFiles(), [PageShelf.indexName, PageShelf.name(of: Self.survivor.description)].sorted())
    }

    func testNotNowKeepsTheAnswerWithItsLineAndReadsAgainAfterRetryAfter() async throws {
        try await keepPeople()
        let refusal: [String: Any] = ["code": "NOT_NOW", "message": "Lifestream is starting: it answers in a moment.",
                                      "wait": "starting", "title": "Lifestream is starting", "line": NSNull(), "acts": [Any]()]
        home.answersPages([
            HomeResponse(status: 503, headers: ["Retry-After": "5"], body: try JSONSerialization.data(withJSONObject: refusal)),
            Self.unchanged,
        ])
        let read = await drawn(HomeLink.Pages.People.self, Self.people)
        XCTAssertEqual(read.map(\.state), [.kept, .waiting(line: "Lifestream is starting: it answers in a moment.",
                                                           until: Self.start.addingTimeInterval(5)), .fresh])
        XCTAssertTrue(read.allSatisfy { $0.page != nil })
        XCTAssertEqual(pauses.seconds, [5])
    }

    func testTheNewestFourteenDayPagesAreKept() async throws {
        let shelf = shelf()
        let days = (1...15).map { HomeLink.PageKey(PageShelf.dayRoute, ["day": String(format: "2026-10-%02d", $0)]) }
        for day in days {
            home.answersPages([Self.answer(try Self.fixture("people.full.json"), etag: "\"d\"")])
            _ = await drawn(HomeLink.Pages.People.self, day, on: shelf)
        }
        home.answersPages([Self.answer(try Self.fixture("people.full.json"), etag: "\"p\"")])
        _ = await drawn(HomeLink.Pages.People.self, Self.people, on: shelf)
        let first = await shelf.kept(HomeLink.Pages.People.self, days[0])
        let second = await shelf.kept(HomeLink.Pages.People.self, days[1])
        XCTAssertNil(first)
        XCTAssertNotNil(second)
        XCTAssertEqual(pageFiles().count, PageShelf.days + 2)
    }
}

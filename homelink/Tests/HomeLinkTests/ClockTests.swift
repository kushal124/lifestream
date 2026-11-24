import Foundation
import XCTest
@testable import HomeLink

final class ClockTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-clock-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    static let cases = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/clock-cases.json")

    private let phone = HomeLink.Device(kind: .phone, version: "0.3.0", model: "iPhone", serial4: nil)
    private let mac = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001")

    private func clocks() throws -> [String: (body: Data, cases: [[String: Any]])] {
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.cases)) as? [String: Any])
        var named: [String: (Data, [[String: Any]])] = [:]
        for entry in try XCTUnwrap(file["clocks"] as? [[String: Any]]) {
            let name = try XCTUnwrap(entry["name"] as? String)
            named[name] = (try JSONSerialization.data(withJSONObject: XCTUnwrap(entry["clock"])),
                           try XCTUnwrap(entry["cases"] as? [[String: Any]]))
        }
        return named
    }


    func testEveryCaseFilesUnderTheHomesDayBoundsAndZoneWhateverTheDevicesZone() throws {
        let clocks = try clocks()
        XCTAssertEqual(clocks.count, 11)
        let own = NSTimeZone.default
        defer { NSTimeZone.default = own }
        for far in ["Pacific/Kiritimati", "America/Adak"] {
            NSTimeZone.default = try XCTUnwrap(TimeZone(identifier: far))
            var checked = 0
            for (name, entry) in clocks {
                let clock = try XCTUnwrap(HomeClock(body: entry.body), name)
                XCTAssertNotNil(clock.id, name)
                for item in entry.cases {
                    let at = try XCTUnwrap((item["at"] as? NSNumber)?.int64Value)
                    let day = clock.dayAt(at)
                    let why = "\(name) at \(item["utc"] ?? at): \(item["why"] ?? "")"
                    XCTAssertEqual(day.day, item["day"] as? String, why)
                    XCTAssertEqual(day.startMs, (item["start_ms"] as? NSNumber)?.int64Value, why)
                    XCTAssertEqual(day.endMs, (item["end_ms"] as? NSNumber)?.int64Value, why)
                    XCTAssertEqual(day.zone.identifier, item["zone"] as? String, why)
                    XCTAssertEqual(clock.dayAt(Date(timeIntervalSince1970: TimeInterval(at) / 1000)), day, why)
                    checked += 1
                }
            }
            XCTAssertEqual(checked, clocks.values.reduce(0) { $0 + $1.cases.count }, "every case, under \(far)")
        }
    }

    func testAClockThatDoesNotReadWholeIsNoClock() {
        let run = #"{"day":"2026-01-01","start_ms":1767240000000,"days":3,"zone":"Europe/London"}"#
        XCTAssertNotNil(HomeClock(body: Data(#"{"id":"c-1","zone":"Europe/London","start_hour":4,"runs":[\#(run)],"later":1}"#.utf8)),
                        "a member it does not know is kept unread")
        for body in [
            #"{"id":"c-1","runs":[]}"#,
            #"{"runs":[\#(run)]}"#,
            #"{"id":"","runs":[\#(run)]}"#,
            #"{"id":"c-1","runs":[{"day":"2026-02-30","start_ms":0,"days":1,"zone":"UTC"}]}"#,
            #"{"id":"c-1","runs":[{"day":"2026-1-01","start_ms":0,"days":1,"zone":"UTC"}]}"#,
            #"{"id":"c-1","runs":[{"day":"2026-01-01","start_ms":0,"days":0,"zone":"UTC"}]}"#,
            #"{"id":"c-1","runs":[{"day":"2026-01-01","start_ms":0,"days":1,"zone":"Mars/Olympus"}]}"#,
            #"{"id":"c-1","runs":[{"day":"2026-01-01","start_ms":true,"days":1,"zone":"UTC"}]}"#,
        ] {
            XCTAssertNil(HomeClock(body: Data(body.utf8)), body)
        }
    }


    func testThePlaceholderIsOneOpenRunFromTheDevicesLatest0400InItsZoneWithNoId() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "Asia/Kolkata"))
        let early = HomeClock.placeholder(at: Date(timeIntervalSince1970: 1_791_923_400), zone: zone)
        XCTAssertNil(early.id)
        XCTAssertEqual(early.runs.count, 1)
        XCTAssertEqual(early.runs[0].day, "2026-10-13")
        XCTAssertEqual(early.runs[0].startMs, 1_791_844_200_000, "04:00 on the 13th in Kolkata, 22:30 UTC on the 12th")
        XCTAssertEqual(early.runs[0].zone, zone)
        let late = HomeClock.placeholder(at: Date(timeIntervalSince1970: 1_791_934_200), zone: zone)
        XCTAssertEqual(late.dayAt(1_791_934_200_000).day, "2026-10-14")
        XCTAssertEqual(late.dayAt(1_791_934_200_000 + 3 * 86_400_000).day, "2026-10-17")
        XCTAssertNotEqual(late, try XCTUnwrap(HomeClock(id: "c-1", runs: late.runs)), "a clock the home sent is never the placeholder")
    }


    func testAPhoneReadsAClockAnAnswerNamesOnceAndKeepsIt() async throws {
        let clocks = try clocks()
        let london = try XCTUnwrap(clocks["london-4"]).body
        let id = try XCTUnwrap(HomeClock(body: london)?.id)
        let transport = ClockTransport(answers: [id, id], clocks: [.body(london)])
        let link = try await paired(transport, device: phone)
        let installed = expectation(description: "the clock was kept")
        link.onHomeClock { [link] in
            XCTAssertEqual(link.homeClock?.id, id)
            installed.fulfill()
        }
        XCTAssertNil(link.homeClock, "none before the first read")

        _ = try await link.exchange()
        await fulfillment(of: [installed], timeout: 30)
        XCTAssertEqual(link.homeClock?.id, id)
        XCTAssertEqual(transport.paths, ["/v1/exchange", "/v1/clock"])
        XCTAssertEqual(transport.clockHeaders?["Authorization"]?.hasPrefix("Bearer "), true, "under the pass")

        _ = try await link.exchange()
        await link.clockReadsEnded()
        XCTAssertEqual(transport.paths, ["/v1/exchange", "/v1/clock", "/v1/exchange"], "a clock kept is not read again")
        let relaunched = HomeLink(device: phone, credentials: link.credentials, folder: folder, transport: transport)
        XCTAssertEqual(relaunched.homeClock?.id, id, "kept on disk beside the saved answer")
    }

    func testTheMacsDeliverOnlyPassNeverAsksForTheClock() async throws {
        let transport = ClockTransport(answers: ["149e7dc8591bf2d4"], clocks: [])
        let link = try await paired(transport, device: mac)
        let answer = try await link.exchange()
        await link.clockReadsEnded()
        XCTAssertEqual(answer.clock, "149e7dc8591bf2d4")
        XCTAssertEqual(transport.paths, ["/v1/exchange"], "no /v1/clock")
        XCTAssertNil(link.homeClock)
    }

    func testALateReadOfAnOlderAnswersClockNeverReplacesTheNewerOnes() async throws {
        let clocks = try clocks()
        let (first, second) = (try XCTUnwrap(clocks["london-4"]).body, try XCTUnwrap(clocks["new-york-4"]).body)
        let (firstId, secondId) = (try XCTUnwrap(HomeClock(body: first)?.id), try XCTUnwrap(HomeClock(body: second)?.id))
        let transport = ClockTransport(answers: [firstId, secondId], clocks: [.held(first), .body(second)])
        let link = try await paired(transport, device: phone)
        let installed = expectation(description: "the newer answer's clock was kept")
        link.onHomeClock { [link] in
            XCTAssertEqual(link.homeClock?.id, secondId, "only the newer answer's clock is kept")
            installed.fulfill()
        }

        _ = try await link.exchange()
        await fulfillment(of: [transport.held], timeout: 30)
        _ = try await link.exchange()
        await fulfillment(of: [installed], timeout: 30)
        transport.release()
        await link.clockReadsEnded()
        XCTAssertEqual(transport.paths, ["/v1/exchange", "/v1/clock", "/v1/exchange", "/v1/clock"])
        XCTAssertEqual(link.homeClock?.id, secondId, "the first read answered last, and is not kept")
        let relaunched = HomeLink(device: phone, credentials: link.credentials, folder: folder, transport: transport)
        XCTAssertEqual(relaunched.homeClock?.id, secondId, "nor written")
    }

    func testAFailedReadStaysOwedAndIsTriedAgainAtTheNextLanding() async throws {
        let london = try XCTUnwrap(clocks()["london-4"]).body
        let id = try XCTUnwrap(HomeClock(body: london)?.id)
        let transport = ClockTransport(answers: [id, id], clocks: [.refused, .body(london)])
        let link = try await paired(transport, device: phone)

        _ = try await link.exchange()
        await link.clockReadsEnded()
        await link.probesEnded()
        XCTAssertNil(link.homeClock, "a 503 keeps nothing")
        XCTAssertEqual(transport.paths, ["/v1/exchange", "/v1/clock", "/v1/status"],
                       "and asks nothing more by itself but the one probe its not-now asks")

        _ = try await link.exchange()
        await link.clockReadsEnded()
        XCTAssertEqual(transport.paths, ["/v1/exchange", "/v1/clock", "/v1/status", "/v1/exchange", "/v1/clock"])
        XCTAssertEqual(link.homeClock?.id, id)
    }

    func testAReadLandingAfterUnpairKeepsNone() async throws {
        let clocks = try clocks()
        let london = try XCTUnwrap(clocks["london-4"]).body
        let id = try XCTUnwrap(HomeClock(body: london)?.id)
        let transport = ClockTransport(answers: [id], clocks: [.held(london)])
        let link = try await paired(transport, device: phone)
        _ = try await link.exchange()
        await fulfillment(of: [transport.held], timeout: 30)
        try link.forget()
        transport.release()
        await link.clockReadsEnded()
        XCTAssertNil(link.homeClock, "the read landed after Unpair")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("clock.json").path))
    }

    func testUnpairDropsAKeptClock() async throws {
        let london = try XCTUnwrap(clocks()["london-4"]).body
        let id = try XCTUnwrap(HomeClock(body: london)?.id)
        let transport = ClockTransport(answers: [id], clocks: [.body(london)])
        let link = try await paired(transport, device: phone)
        _ = try await link.exchange()
        await link.clockReadsEnded()
        XCTAssertEqual(link.homeClock?.id, id)
        try link.forget()
        XCTAssertNil(link.homeClock)
        XCTAssertNil(HomeLink(device: phone, credentials: link.credentials, folder: folder, transport: transport).homeClock)
    }

    func testEachChangeOfTheClockKeptIsSignalledAsTheNextRevisionUnpairIncluded() async throws {
        let london = try XCTUnwrap(clocks()["london-4"]).body
        let id = try XCTUnwrap(HomeClock(body: london)?.id)
        let transport = ClockTransport(answers: [id], clocks: [.body(london)])
        let link = try await paired(transport, device: phone)
        let signals = Signals()
        link.onHomeClock { [link] in signals.add(link.keptClock) }
        XCTAssertEqual(link.keptClock, HomeLink.KeptClock(clock: nil, revision: 0), "none as launch found it")

        _ = try await link.exchange()
        await link.clockReadsEnded()
        let kept = link.keptClock
        XCTAssertEqual(kept.clock?.id, id)
        XCTAssertEqual(kept.revision, 1)
        try link.forget()
        XCTAssertEqual(link.keptClock, HomeLink.KeptClock(clock: nil, revision: 2), "Unpair is a change, newer than the read")
        XCTAssertEqual(signals.seen, [kept, link.keptClock], "each signalled, outside the locks (the observer reads the link)")
        let relaunched = HomeLink(device: phone, credentials: link.credentials, folder: folder, transport: transport)
        XCTAssertEqual(relaunched.keptClock, HomeLink.KeptClock(clock: nil, revision: 0))
    }

    private func paired(_ transport: ClockTransport, device: HomeLink.Device) async throws -> HomeLink {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: device, credentials: credentials, folder: folder,
                               transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "https://lifestream.example.ts.net", account: device.kind == .phone ? Fixture.account : nil)
        return HomeLink(device: device, credentials: credentials, folder: folder, transport: transport)
    }
}

private final class Signals: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [HomeLink.KeptClock] = []
    var seen: [HomeLink.KeptClock] { lock.withLock { states } }
    func add(_ state: HomeLink.KeptClock) { lock.withLock { states.append(state) } }
}

final class ClockTransport: HomeTransport, @unchecked Sendable {
    enum Clock {
        case body(Data)
        case held(Data)
        case refused
    }

    let held = XCTestExpectation(description: "a held clock read reached the home")
    private let lock = NSLock()
    private var answers: [String]
    private var clocks: [Clock]
    private var asked: [String] = []
    private var headers: [String: String]?
    private var waiting: CheckedContinuation<Void, Never>?

    init(answers: [String], clocks: [Clock]) {
        self.answers = answers
        self.clocks = clocks
    }

    var paths: [String] { lock.withLock { asked } }
    var clockHeaders: [String: String]? { lock.withLock { headers } }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        String(repeating: "A", count: 52)
    }

    func release() {
        lock.withLock { waiting }?.resume()
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let path = request.url.path
        let next: Any? = lock.withLock {
            asked.append(path)
            if path == "/v1/status" { return "status" }
            if path == "/v1/clock" {
                headers = request.headers
                return clocks.isEmpty ? nil : clocks.removeFirst()
            }
            return answers.isEmpty ? nil : answers.removeFirst()
        }
        if next as? String == "status" { return HomeResponse(status: 200, headers: [:], body: Data("{}".utf8)) }
        if let id = next as? String {
            return HomeResponse(status: 200, headers: [:], body: Data(Fixture.answer(received: 0, imported: 0, extra: #","clock":"\#(id)""#).utf8))
        }
        switch next as? Clock {
        case .body(let bytes)?:
            return HomeResponse(status: 200, headers: ["etag": "\"c\""], body: bytes)
        case .held(let bytes)?:
            await withCheckedContinuation { continuation in
                lock.withLock { waiting = continuation }
                held.fulfill()
            }
            return HomeResponse(status: 200, headers: [:], body: bytes)
        case .refused?:
            return HomeResponse(status: 503, headers: [:], body: Data(#"{"code":"NOT_NOW","wait":"starting","message":"the home is starting","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#.utf8))
        case nil:
            throw URLError(.cannotConnectToHost)
        }
    }
}

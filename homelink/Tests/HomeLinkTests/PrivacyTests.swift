import Foundation
import XCTest
@testable import HomeLink

final class PrivacyTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

    static let states = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/privacy.json")

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private static func state(_ name: String) throws -> String {
        let all = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: states)) as? [String: Any])
        let one = try XCTUnwrap(all[name])
        return String(decoding: try JSONSerialization.data(withJSONObject: one), as: UTF8.self)
    }

    private func paired(_ script: [ScriptedTransport.Step]) async throws -> (HomeLink, ScriptedTransport, String) {
        let credentials = MemoryCredentials()
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: pairing)
            .pair(code: "12345678", name: home, account: Fixture.account)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        let transport = ScriptedTransport(script)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), transport, pass)
    }

    func testTheStateIsAskedOnItsRouteWithThePassAndARefusalIsAFailure() async throws {
        let (link, transport, pass) = try await paired([
            .reply(200, try Self.state("fresh")),
            .reply(403, #"{"code":"PRINCIPAL_SCOPE","message":"an agent's pass reads hiding through the MCP server"}"#),
        ])
        _ = try await link.privacy()
        do {
            _ = try await link.privacy()
            XCTFail("a refusal read as a state")
        } catch let failure as LinkFailure {
            guard case .refused(403, "PRINCIPAL_SCOPE", _) = failure else { return XCTFail("403 read as \(failure)") }
        }
        XCTAssertEqual(transport.requests.map { "\($0.method) \($0.url.absoluteString.replacingOccurrences(of: home, with: ""))" },
                       ["GET /v1/privacy", "GET /v1/privacy"])
        for request in transport.requests {
            XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
            XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0")
        }
    }

    func testAFreshHomeHidesWithoutAModelAndIsReady() async throws {
        let (link, _, _) = try await paired([.reply(200, try Self.state("fresh"))])
        let state = try await link.privacy()
        XCTAssertTrue(state.ready)
        XCTAssertNil(state.line)
        XCTAssertEqual(state.detector, .init(runner: "off", file: "privacy-filter", state: .off, line: nil, bytes: nil, total: nil, model: nil),
                       "the model is off by default, its file named for a Download")
        XCTAssertNil(state.marking)
        XCTAssertEqual(state.level, "all")
        XCTAssertEqual(state.chat, "all")
        XCTAssertEqual(state.links, "tokens")
        XCTAssertEqual(state.levels["names"]?.contains("person"), false, "Keep names hides a person")
        XCTAssertEqual(state.levels["all"]?.contains("face"), true)
        XCTAssertEqual(state.levels["none"], [])
        XCTAssertEqual(state.today, [])
        XCTAssertEqual(state.epoch, 0)
    }

    func testTheModelDownloadingSaysItsBytesAndTodaysTotalsReadWhole() async throws {
        let (link, _, _) = try await paired([.reply(200, try Self.state("downloading"))])
        let state = try await link.privacy()
        XCTAssertTrue(state.ready, "the home hides what it knows while the model downloads")
        XCTAssertNil(state.line)
        XCTAssertEqual(state.detector, .init(runner: "runner-macbook-pro-0001", file: "privacy-filter", state: .downloading, line: nil,
                                             bytes: 340_000_000, total: 900_000_000, model: nil))
        XCTAssertEqual(state.chat, "names")
        XCTAssertEqual(state.always, ["synthetic-word"])
        XCTAssertEqual(state.never, ["Synthetic Cafe"])
        XCTAssertEqual(state.today, [
            .init(receiver: "OpenAI", day: "2026-11-12", items: 412, hidden: 3912, counts: ["person": 2100, "phone": 812, "face": 1000],
                  rows: ["ask": 410, "read": 2]),
            .init(receiver: "Google Places", day: "2026-11-12", items: 3, hidden: 0, counts: ["place": 3], rows: ["lookup": 3]),
        ])
    }

    func testTheModelReadyNamesItselfAndTheMarkingLineReads() async throws {
        let (link, _, _) = try await paired([.reply(200, try Self.state("ready"))])
        let state = try await link.privacy()
        XCTAssertTrue(state.ready)
        XCTAssertEqual(state.detector.state, .ready)
        XCTAssertEqual(state.detector.model, "privacy-filter-1")
        XCTAssertEqual(state.marking, .init(marked: 41, total: 100, line: "Marked 41% of your record"))
        XCTAssertEqual(state.level, "none")
    }

    private static let askRow = #"{"seq":42,"at_ms":1794470400000,"day":"2026-11-12","receiver":"OpenAI","route":"openai:fake-model","by":null,"what":"ask","tool":null,"level":"all","counts":{"face":2,"person":1},"chars":120,"pictures":1,"detector":null,"key":"rk-0001","attempt":1,"refs":1}"#
    private static let readRow = #"{"seq":40,"at_ms":1794466800000,"day":"2026-11-12","receiver":"Hermes","route":null,"by":"p-0000ab01","what":"read","tool":"search","level":["phone","number.bank"],"counts":{},"chars":800,"pictures":0,"detector":null,"key":null,"attempt":null,"refs":3}"#

    func testWhereOneItemWasSentIsAskedByItsFamilyAndItemAndReadsWhole() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, #"{"rows":[\#(Self.askRow),\#(Self.readRow)]}"#),
            .reply(200, #"{"rows":[]}"#),
        ])
        let item = HomeLink.Made.Ask(family: "photos", item: "sha256:00+a/b", prompt: "Describe this photo.")
        let rows = try await link.outbound(of: item)
        XCTAssertEqual(rows.map(\.seq), [42, 40])
        XCTAssertEqual(rows[0].receiver, "OpenAI")
        XCTAssertEqual(rows[0].atMs, 1_794_470_400_000)
        XCTAssertEqual(rows[0].what, "ask")
        XCTAssertEqual(rows[0].level, .named("all"))
        XCTAssertEqual(rows[0].counts, ["face": 2, "person": 1])
        XCTAssertEqual(rows[0].pictures, 1)
        XCTAssertNil(rows[0].sent, "a listed row carries what was sent")
        XCTAssertNil(rows[0].detector, "hidden by what the home knows")
        XCTAssertEqual(rows[1].level, .types(["phone", "number.bank"]))
        XCTAssertEqual(rows[1].by, "p-0000ab01")
        let none = try await link.outbound(of: HomeLink.Made.Ask(family: "messages", item: "sha256:01", prompt: "Transcribe."))
        XCTAssertEqual(none, [], "an item nothing was sent for")
        let paths = transport.requests.map { $0.url.absoluteString.replacingOccurrences(of: home, with: "") }
        XCTAssertEqual(paths[0], "/v1/outbound?family=photos&item=sha256%3A00%2Ba%2Fb")
        XCTAssertEqual(transport.requests.map(\.method), ["GET", "GET"])
    }

    func testOneRowReadAloneCarriesWhatAnAskSent() async throws {
        let sent = Self.askRow.replacingOccurrences(of: #""detector":null"#, with: #""detector":"runner-macbook-pro-0001""#)
            .replacingOccurrences(of: #","refs":1}"#,
            with: #","refs":[{"source":"photos:local:iphone-0001","kind":"asset","key":"A1"}],"sent":{"body":"{\"input\":\"[[Person 1]] by the sea\"}","pictures":[{"blob":"sha256:00"}]}}"#)
        let erased = Self.askRow.replacingOccurrences(of: #","refs":1}"#, with: #","refs":[],"sent":null}"#)
        let (link, transport, _) = try await paired([.reply(200, sent), .reply(200, erased)])
        let row = try await link.outbound(seq: 42)
        XCTAssertEqual(row.sent?.body, #"{"input":"[[Person 1]] by the sea"}"#)
        XCTAssertEqual(row.detector, "runner-macbook-pro-0001", "hidden with the hiding model")
        let gone = try await link.outbound(seq: 42)
        XCTAssertNil(gone.sent, "an ask an erasure took")
        XCTAssertEqual(transport.requests.map { $0.url.absoluteString.replacingOccurrences(of: home, with: "") }, ["/v1/outbound/42", "/v1/outbound/42"])
    }

    func testTheKindsOfDetailReadWithTheirSubtypes() async throws {
        let (link, _, _) = try await paired([.reply(200, try Self.state("fresh"))])
        let kinds = try await link.privacy().types
        XCTAssertEqual(kinds.first, .init(type: "person", one: "name", many: "names", subtypes: []))
        XCTAssertEqual(kinds.first { $0.type == "number" }?.subtypes.first, .init(type: "number.bank", one: "bank number", many: "bank numbers"))
    }

    func testAMemberALaterHomeAddsIsIgnored() async throws {
        var body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.state("fresh").utf8)) as? [String: Any])
        body["later"] = true
        let (link, _, _) = try await paired([.reply(200, String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self))])
        let state = try await link.privacy()
        XCTAssertTrue(state.ready)
    }

    func testAWorksRowSaysHowItsItemsAreSentAndTheRangesSaysNothing() throws {
        let report = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: Data(contentsOf: ReportTests.fixture))
        let rows = report.connectors.compactMap(\.processing).flatMap(\.rows)
        let sent = try XCTUnwrap(rows.first { $0.privacy != nil }?.privacy, "no work's row says how its items are sent")
        XCTAssertTrue(sent.member.hasPrefix("privacy."))
        XCTAssertEqual(sent.words, "Personal details hidden")
        XCTAssertFalse(sent.waiting, "the fixture's work waits on nothing")
        XCTAssertFalse(sent.note.isEmpty)
        XCTAssertEqual(sent.steps.first?.value, "default")
        XCTAssertTrue(rows.contains { $0.member == "llm.range" && $0.privacy == nil }, "the range's row says how items are sent")
        XCTAssertTrue(report.connectors.contains { connector in
            connector.processing?.rows.contains { $0.privacy?.member == sent.member } == true && connector.members.contains { $0.key == sent.member }
        })
    }
}

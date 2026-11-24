import Foundation
import XCTest
@testable import HomeLink

final class RefreshNowTests: XCTestCase {
    private var folder: URL!
    private let mac = HomeLink.Device(kind: .mac, version: "1.4.0", model: "MacBook Pro", serial4: "0001")
    private let home = "https://lifestream.example.ts.net"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ script: [ScriptedTransport.Step]) async throws -> (HomeLink, ScriptedTransport, String) {
        let credentials = MemoryCredentials()
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: pairing).pair(code: "12345678", name: home)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        let transport = ScriptedTransport(script)
        return (HomeLink(device: mac, credentials: credentials, folder: folder, transport: transport), transport, pass)
    }

    func testAPressIsSentOnItsRouteWithThePassAndEachAnswerReadsAsWritten() async throws {
        let (link, transport, pass) = try await paired([
            .reply(200, #"{"state":"queued"}"#),
            .reply(200, #"{"state":"asked"}"#),
            .reply(200, #"{"state":"blocked","blocked":{"reason":"held","words":"Example Bank asked to wait until 14:20","until_ms":1790000000000}}"#),
            .reply(409, #"{"code":"NOT_OFFERED","message":"nothing of example-log refreshes from here"}"#),
        ])
        let queued = try await link.refresh(connector: "example-bank")
        XCTAssertEqual(queued, .queued)
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/refresh")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(try Fixture.object(request) as NSDictionary, ["connector": "example-bank"] as NSDictionary)
        let asked = try await link.refresh(connector: "example-store")
        XCTAssertEqual(asked, .asked)
        let blocked = try await link.refresh(connector: "example-bank")
        XCTAssertEqual(blocked, .blocked(HomeLink.RefreshBlocked(reason: .held, words: "Example Bank asked to wait until 14:20", untilMs: 1_790_000_000_000)))
        do { _ = try await link.refresh(connector: "example-log"); XCTFail("refused") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.description, "nothing of example-log refreshes from here", "the door's words")
        }
    }

    func testALostAnswerIsAskedOnceMoreAndAnUnpairedDeviceSendsNothing() async throws {
        let (link, transport, _) = try await paired([.unreachable, .reply(200, #"{"state":"queued"}"#)])
        let answer = try await link.refresh(connector: "example-bank")
        XCTAssertEqual(answer, .queued)
        XCTAssertEqual(transport.requests.count, 2, "the door's word: the same press is answered again as the first")

        let unpaired = ScriptedTransport([.reply(200, #"{"state":"queued"}"#)])
        let none = HomeLink(device: mac, credentials: MemoryCredentials(), folder: folder, transport: unpaired)
        do { _ = try await none.refresh(connector: "example-bank"); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        XCTAssertTrue(unpaired.requests.isEmpty, "nothing leaves an unpaired device")
    }
}

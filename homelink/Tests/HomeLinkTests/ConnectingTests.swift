import Foundation
import XCTest
@testable import HomeLink

final class ConnectingTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ transport: any HomeTransport) async throws -> HomeLink {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "https://lifestream.example.ts.net", account: Fixture.account)
        return HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
    }

    func testEachActGoesOnItsRouteWithItsBodyAndItsAnswerIsRead() async throws {
        let transport = ScriptedTransport([
            .reply(200, #"{"state":"blocked","blocked":{"reason":"held","words":"Example asked to wait until 14:20","until_ms":1}}"#),
            .reply(200, #"{"refused":"Unlock Lifestream on MacBook Pro first."}"#),
            .reply(200, #"{"account":"person-a@example.com","source":"example:person-a@example.com:cloud"}"#),
            .reply(200, #"{"code":"WDJB-MJHT","open":"https://example.com/device","interval_ms":5000,"expires_ms":2,"attempt":{"a":1}}"#),
            .reply(200, #"{"state":"pending","interval_ms":10000}"#),
            .reply(200, #"{"open":"https://example.com/authorize","attempt":{"b":2},"expires_ms":3,"listening":false}"#),
            .reply(200, #"{"refused":"That address holds no code.","field":"address"}"#),
        ])
        let link = try await paired(transport)

        let refreshed = try await link.refresh(connector: "example-log")
        XCTAssertEqual(refreshed, .blocked(.init(reason: .held, words: "Example asked to wait until 14:20", untilMs: 1)))
        let sealed = try await link.seal(.init(connector: "whoop", member: "password", value: "pw"))
        XCTAssertEqual(sealed, .refused(.init(refused: "Unlock Lifestream on MacBook Pro first.", field: nil)))
        let keyed = try await link.signIn(HomeLink.SignInKeyAsk(connector: "gmail", route: "gmail-imap", values: ["account": "person-a@example.com"]))
        XCTAssertEqual(keyed, .signedIn(.init(account: "person-a@example.com", source: "example:person-a@example.com:cloud")))
        guard case .code(let code) = try await link.signIn(HomeLink.SignInDeviceStartAsk(connector: "granola", route: "granola-mcp")) else {
            return XCTFail("a device code reads as one")
        }
        XCTAssertEqual(code.code, "WDJB-MJHT")
        let polled = try await link.signIn(HomeLink.SignInDevicePollAsk(connector: "granola", route: "granola-mcp", attempt: code.attempt, intervalMs: 5000))
        XCTAssertEqual(polled, .pending(intervalMs: 10000))
        guard case .started(let started) = try await link.signIn(HomeLink.SignInClientStartAsk(
            connector: "example-oauth", route: "example-oauth", client: .init(clientId: "id", clientSecret: "secret"), port: 49152)) else {
            return XCTFail("a client sign-in started reads as one")
        }
        XCTAssertFalse(started.listening)
        let finished = try await link.signIn(HomeLink.SignInClientFinishAsk(connector: "example-oauth", route: "example-oauth", attempt: started.attempt,
                                                                           address: "http://127.0.0.1:49152/?code=c&state=s"))
        XCTAssertEqual(finished, .refused(.init(refused: "That address holds no code.", field: "address")))

        let sent = transport.requests
        XCTAssertEqual(sent.map(\.url.path), ["/v1/refresh", "/v1/seal", "/v1/signin/key", "/v1/signin/device/start", "/v1/signin/device/poll",
                                              "/v1/signin/client/start", "/v1/signin/client/finish"])
        XCTAssertTrue(sent.allSatisfy { $0.method == "POST" && $0.headers["Authorization"] != nil })
        XCTAssertEqual(try Fixture.object(sent[0]) as NSDictionary, ["connector": "example-log"])
        XCTAssertEqual(try Fixture.object(sent[1]) as NSDictionary, ["connector": "whoop", "member": "password", "value": "pw"])
        XCTAssertEqual(try Fixture.object(sent[4])["interval_ms"] as? Int, 5000)
        XCTAssertEqual(try Fixture.object(sent[4])["attempt"] as? NSDictionary, ["a": 1])
        XCTAssertEqual(try Fixture.object(sent[5])["client"] as? NSDictionary, ["client_id": "id", "client_secret": "secret"])
        XCTAssertEqual(try Fixture.object(sent[5])["port"] as? Int, 49152)
        XCTAssertEqual(try Fixture.object(sent[6])["address"] as? String, "http://127.0.0.1:49152/?code=c&state=s")
    }

    func testOnlyARefreshIsSentAgainAfterItsAnswerWasLost() async throws {
        let transport = ScriptedTransport([
            .reply(503, #"{"code":"OUTCOME_UNKNOWN","message":"The home took it and did not answer.","again":true}"#),
            .reply(200, #"{"state":"queued"}"#),
            .reply(503, #"{"code":"OUTCOME_UNKNOWN","message":"The home took it and did not answer.","again":false}"#),
            .reply(409, #"{"code":"NOT_OFFERED","message":"only a phone ships it"}"#),
        ])
        let link = try await paired(transport)
        let queued = try await link.refresh(connector: "example-log")
        XCTAssertEqual(queued, .queued)
        do {
            _ = try await link.seal(.init(connector: "whoop", member: "password", value: "pw"))
            XCTFail("a seal whose outcome is unknown is never sent again")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unanswered(again: false, began: false))
            XCTAssertEqual(failure.code, "OUTCOME_UNKNOWN")
        }
        do {
            _ = try await link.refresh(connector: "notes")
            XCTFail("a refusal is no answer")
        } catch LinkFailure.refused(let status, let code, _) {
            XCTAssertEqual([String(status), code], ["409", "NOT_OFFERED"])
        }
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/refresh", "/v1/refresh", "/v1/seal", "/v1/refresh"])
    }
}

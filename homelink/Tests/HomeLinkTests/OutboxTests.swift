import Foundation
import XCTest
@testable import HomeLink

final class OutboxTests: XCTestCase {
    private let messages = "imessage:local:macbook-pro-0001"
    private let screen = "screen:local:macbook-pro-0001"

    private func answer(received: Int, sources: [String]) throws -> FreshAnswer {
        let answer = try XCTUnwrap(Answer(body: Data(Fixture.answer(received: received, imported: 0, sources: sources).utf8)))
        return FreshAnswer(answer, at: Date(timeIntervalSince1970: 1_792_925_361))
    }

    func testJudgeReadsEverySealOfABundleAgainstTheAnswer() throws {
        let both = try answer(received: 3, sources: [messages, screen])
        let judge = { (seals: [String: Int]) in HomeLink.Outbox.judge(pass: Fixture.pass, seals: seals, answer: both) }
        XCTAssertEqual(judge([messages: 3, screen: 2]), .covered, "received covers every seal")
        XCTAssertEqual(judge([messages: 4, screen: 4]), .next, "every seal is the one after received")
        XCTAssertEqual(judge([messages: 3, screen: 4]), .stale, "one covered and one next is neither")
        XCTAssertEqual(judge([messages: 5]), .stale, "a seal past the next")
        XCTAssertEqual(judge(["location:local:iphone-aa00": 1]), .stale, "a source the answer no longer states")
        XCTAssertEqual(judge([messages: 4, "location:local:iphone-aa00": 1]), .stale, "one source stated, one not")
        XCTAssertEqual(HomeLink.Outbox.judge(pass: "p-0000bb00", seals: [messages: 3], answer: both), .stale,
                       "another pass is stale, whatever its numbers")
        XCTAssertEqual(HomeLink.Outbox.judge(pass: "p-0000bb00", seals: [messages: 4], answer: both), .stale)
    }

    func testTheWaitsAreOneTable() {
        XCTAssertEqual(HomeLink.Outbox.Wait.clockAhead.seconds, 15 * 60, "the home releases a bundle ten minutes ahead within minutes")
        XCTAssertEqual(HomeLink.Outbox.Wait.refused.seconds, 60 * 60)
        XCTAssertEqual(HomeLink.Outbox.Wait.busy.seconds, 60)
        let now = Date(timeIntervalSince1970: 1_792_925_361)
        XCTAssertEqual(HomeLink.Outbox.Wait.busy.until(now), now.addingTimeInterval(60), "no Retry-After: the table's")
        XCTAssertEqual(HomeLink.Outbox.Wait.busy.until(now, retryAfter: 90), now.addingTimeInterval(90), "the door's when it states one")
        XCTAssertEqual(HomeLink.Outbox.Wait.clockAhead.until(now), now.addingTimeInterval(15 * 60))
    }

    func testABusyRefusalKeepsTheDoorsRetryAfterAndNoOther409Changes() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-outbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let mac = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001")
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "https://lifestream.example.ts.net")
        let active = #"{"code":"UPLOAD_ACTIVE","message":"bundle upload is active"}"#
        let transport = ScriptedTransport([
            .reply(409, active, ["Retry-After": "90"]),
            .reply(409, active),
            .reply(409, #"{"code":"STALE","message":"seal 5 is not the next","answer":"# + Fixture.answer(received: 2, imported: 2) + "}"),
        ])
        let link = HomeLink(device: mac, credentials: credentials, folder: folder, transport: transport)
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let send = { try await link.send(bundle: bundle, id: "\(Fixture.source)/20261014T093012.345Z", kind: .new) }

        do { _ = try await send(); XCTFail("busy") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .busy(retryAfter: 90), "the door's Retry-After kept")
            XCTAssertEqual(failure.code, "UPLOAD_ACTIVE")
        }
        do { _ = try await send(); XCTFail("busy") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .busy(retryAfter: nil), "none stated: none kept, the table's wait is the caller's")
        }
        do { _ = try await send(); XCTFail("stale") } catch LinkFailure.stale(let answer) {
            XCTAssertEqual(answer.sources[Fixture.source]?.received, 2, "STALE carries its answer as before")
        }

        let which = #"{"code":"PAIR_WHICH_PHONE","message":"say which","phones":[{"unit":"iphone-17-pro-0042","model":"iPhone 17 Pro","account":"person-a@example.com","last_ms":1791960000000}]}"#
        guard case .whichPhone(let phones) = link.failure(HomeResponse(status: 409, headers: [:], body: Data(which.utf8))) else {
            return XCTFail("PAIR_WHICH_PHONE carries its phones")
        }
        XCTAssertEqual(phones.map(\.unit), ["iphone-17-pro-0042"])
        XCTAssertEqual(link.failure(HomeResponse(status: 409, headers: ["Retry-After": "5"],
                                                 body: Data(#"{"code":"NOT_OFFERED","message":"not offered"}"#.utf8))),
                       .refused(status: 409, code: "NOT_OFFERED", message: "not offered"), "an act's 409 is a refusal as before")
    }
}

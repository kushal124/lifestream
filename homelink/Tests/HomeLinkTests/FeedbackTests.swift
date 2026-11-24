import Foundation
import XCTest
@testable import HomeLink

final class FeedbackTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"
    private let id = "0b6f2a4c-1d3e-4f5a-8b7c-9d0e1f2a3b4c"

    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/feedback")

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
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: pairing)
            .pair(code: "12345678", name: home, account: Fixture.account)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        let transport = ScriptedTransport(script)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), transport, pass)
    }

    private static func fixture(_ name: String) throws -> String {
        try String(contentsOf: fixtures.appendingPathComponent(name), encoding: .utf8)
    }

    func testTheHomesPageAnswerDecodesWithEveryWordItServes() throws {
        let page = try JSONDecoder().decode(HomeLink.Pages.Feedback.self, from: Data(Self.fixture("page.json").utf8))
        XCTAssertTrue(page.open)
        XCTAssertEqual(page.title, "Send feedback")
        XCTAssertEqual(page.about.connector, "Report a problem with {name}")
        XCTAssertEqual(page.field.max, 5000)
        XCTAssertEqual(page.kinds.map(\.kind), [.answer, .connector, .app, .screenshot])
        XCTAssertEqual(page.kinds.map(\.add), [nil, nil, nil, "Add screenshot"], "only a screenshot is added by the person")
        XCTAssertEqual(page.sent.line, "We'll reply to {email}.")
        XCTAssertEqual(HomeLink.Pages.Feedback.route, "/v1/page/feedback")
    }

    func testADraftIsAskedWithItsIDAndAboutAndTheHomesDraftDecodes() async throws {
        let draft = try Self.fixture("draft.json")
        let (link, transport, pass) = try await paired([.reply(200, draft)])
        let answer = try await link.feedbackDraft(id: id, about: .chat("1791968400000-0a1b2c", n: 2))
        XCTAssertEqual(answer.attachments.map(\.kind), [.app])
        XCTAssertEqual(answer.attachments.first?.title, "App details")
        XCTAssertEqual(answer.attachments.first?.text, "Home: 1 (0000000000ab)\niPhone app: 1.0.0, iOS not stated\n")
        XCTAssertNil(answer.email)
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/feedback/draft")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(try Fixture.object(request) as NSDictionary,
                       ["id": id, "about": ["kind": "chat", "chat": "1791968400000-0a1b2c", "n": 2]] as NSDictionary)

        _ = try await link.feedbackDraft(id: id, about: .menu)
        _ = try await link.feedbackDraft(id: id, about: .connector("gmail"))
        XCTAssertEqual(try Fixture.object(transport.requests[1])["about"] as? NSDictionary, ["kind": "menu"] as NSDictionary)
        XCTAssertEqual(try Fixture.object(transport.requests[2])["about"] as? NSDictionary,
                       ["kind": "connector", "connector": "gmail"] as NSDictionary)
    }

    func testAScreenshotGoesAsItsOwnBytesUnderItsDraftsIDAndAForgottenDraftSaysSo() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, #"{"width":1179,"height":2556}"#),
            .reply(404, #"{"code":"NOT_FOUND","message":"no draft holds this id"}"#),
        ])
        let jpeg = Data([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
        let held = try await link.feedbackScreenshot(id: id, jpeg: jpeg)
        XCTAssertEqual(held, .held(HomeLink.Feedback.Size(width: 1179, height: 2556)))
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/feedback/screenshot?id=" + id)
        XCTAssertEqual(request.headers["Content-Type"], "image/jpeg")
        XCTAssertEqual(request.body, .bytes(jpeg), "the picture as captured, nothing wrapped around it")
        let gone = try await link.feedbackScreenshot(id: id, jpeg: jpeg)
        XCTAssertEqual(gone, .forgotten)
    }

    func testSendNamesTheKindsKeptAndTheHomesAnswersReadAsTheySay() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, #"{"id":"\#(id)"}"#),
            .reply(404, #"{"code":"NOT_FOUND","message":"no draft holds this id"}"#),
            .reply(404, #"{"message":"unknown endpoint"}"#),
            .reply(422, #"{"code":"BAD_REQUEST","message":"a report's text is at most 5000 characters"}"#),
        ])
        let sent = try await link.feedbackSend(id: id, text: "  The timeline is slow  ", email: nil, keep: [.answer, .unknown, .app])
        XCTAssertEqual(sent, .sent)
        let request = transport.requests[0]
        XCTAssertEqual(request.url.absoluteString, home + "/v1/feedback/send")
        XCTAssertEqual(try Fixture.object(request) as NSDictionary,
                       ["id": id, "text": "  The timeline is slow  ", "email": NSNull(), "keep": ["answer", "app"]] as NSDictionary,
                       "the person's words as typed, no email as null, only kinds the home names")
        let forgotten = try await link.feedbackSend(id: id, text: "x", email: "person-a@example.com", keep: [])
        XCTAssertEqual(forgotten, .forgotten, "a draft the home forgot is drafted again")
        XCTAssertEqual(try Fixture.object(transport.requests[1])["email"] as? String, "person-a@example.com")
        do { _ = try await link.feedbackSend(id: id, text: "x", email: nil, keep: []); XCTFail("closed") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "HTTP_404", "a closed home is no forgotten draft")
        }
        do { _ = try await link.feedbackSend(id: id, text: "x", email: nil, keep: []); XCTFail("refused") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.description, "a report's text is at most 5000 characters", "the door's words")
        }
    }

    func testALostAnswerIsAskedOnceMoreAsTheDoorAnswersTheSameIDAgain() async throws {
        let (link, transport, _) = try await paired([.lost, .reply(200, #"{"id":"\#(id)"}"#)])
        let sent = try await link.feedbackSend(id: id, text: "x", email: nil, keep: [.app])
        XCTAssertEqual(sent, .sent)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(transport.requests[0], transport.requests[1], "the same report, the same id")
    }

    func testAnIDThatIsNotALowercaseUUIDv4LeavesNothing() async throws {
        let (link, transport, _) = try await paired([.reply(200, #"{}"#)])
        let minted = HomeLink.Feedback.mint()
        XCTAssertTrue(HomeLink.Feedback.isID(minted))
        for bad in [id.uppercased(), "0b6f2a4c1d3e4f5a8b7c9d0e1f2a3b4c", "0b6f2a4c-1d3e-1f5a-8b7c-9d0e1f2a3b4c", "0b6f2a4c-1d3e-4f5a-cb7c-9d0e1f2a3b4c"] {
            XCTAssertFalse(HomeLink.Feedback.isID(bad), bad)
            do { _ = try await link.feedbackDraft(id: bad, about: .menu); XCTFail(bad) } catch let failure as LinkFailure {
                XCTAssertEqual(failure, .unusableID)
            }
            do { _ = try await link.feedbackScreenshot(id: bad, jpeg: Data([0xff])); XCTFail(bad) } catch let failure as LinkFailure {
                XCTAssertEqual(failure, .unusableID)
            }
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testTheReportActOnACardCarriesItsConnector() throws {
        let act = try JSONDecoder().decode(HomeLink.Act.self, from: Data(#"{"do":"report","label":"Report a problem","of":"gmail"}"#.utf8))
        XCTAssertEqual(act.do, .report)
        XCTAssertEqual(act.label, "Report a problem")
        XCTAssertEqual(act.of, "gmail")
    }
}

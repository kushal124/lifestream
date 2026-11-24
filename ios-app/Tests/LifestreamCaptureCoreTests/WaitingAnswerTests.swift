import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class WaitingAnswerTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")

    func testTheWaitingPageReadsAsThePageAndTheListAtOnceEachAskWithTheHomesEditable() throws {
        let answer = try JSONDecoder().decode(WaitingAnswer.self, from: Data(contentsOf: Self.fixtures.appendingPathComponent("agentsWaiting.full.json")))
        XCTAssertEqual(answer.position, answer.page.position)
        XCTAssertFalse(answer.listed.asks.isEmpty, "the fixture holds open asks")
        XCTAssertEqual(answer.listed.asks.map(\.id), answer.page.asks.map(\.id), "one list, read twice")
        XCTAssertEqual(answer.listed.requests.map(\.id), answer.page.requests.map(\.id))
        XCTAssertEqual(answer.listed.requests.map(\.app), answer.page.requests.map(\.app), "a sign-in from an app's own host names its guide")
        XCTAssertEqual(answer.listed.requests.map(\.notice), answer.page.requests.map(\.notice))
        XCTAssertEqual(answer.listed.requests.map(\.head), answer.listed.requests.map { $0.name + " wants to read your Lifestream" },
                       "the home words every sign-in's head as the guide's yes says it")
        for (listed, paged) in zip(answer.listed.asks, answer.page.asks) {
            XCTAssertEqual(listed.editable, paged.editable, "\(listed.id): the home's editable")
            XCTAssertEqual(listed.state, .open, "\(listed.id): the page holds only open asks")
        }
    }
}

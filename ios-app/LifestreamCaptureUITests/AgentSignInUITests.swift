import XCTest

@MainActor
final class AgentSignInUITests: XCTestCase {
    private static let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    private let folder = AgentSignInUITests.app.appendingPathComponent(".build/shots/agent-signin/dark")

    override func setUpWithError() throws {
        continueAfterFailure = false
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    func testJourneyEachSignInSaysTheHomesOutcomeAndOneTheHomeDropsCloses() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--ui-test-started", "--ui-test-dark-appearance", "--ui-test-reset",
                               "--ui-test-locked", "--ui-test-face-id-declines-once", "--ui-test-agent-requests"]
        app.launch()

        let sheet = app.descendants(matching: .any)["agent.request"].firstMatch
        sheet.appears("the first sign-in's sheet")
        let claude = sheet.staticTexts["Claude wants to read your Lifestream"]
        claude.appears("Claude's head")
        XCTAssertTrue(sheet.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "From claude.ai")).firstMatch.exists, "where it signs in from, its host")
        XCTAssertTrue(sheet.staticTexts["Type the code Claude shows"].exists)
        let buttons = sheet.buttons.allElementsBoundByIndex.map(\.label)
        XCTAssertEqual(buttons, ["Edit", "Allow", Self.dontAllow], "its access's Edit, Allow beside the code's field, then Don't allow")
        XCTAssertFalse(sheet.buttons["agent.allow"].isEnabled, "Allow waits for the whole code")
        let code = sheet.textFields["agent.code"]
        code.tap()
        code.typeText("640064")
        shot(1, "request")

        sheet.buttons["agent.allow"].tap()
        sheet.staticTexts["Face ID didn't pass, so nothing was sent."].appears("the declined Face ID's line")
        XCTAssertTrue(claude.exists, "Claude's sheet stays")
        shot(2, "face-id-declined")

        sheet.buttons["agent.allow"].tap()
        sheet.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", try opening("answer-sign-in"))).firstMatch
            .appears("the home's words for the code it took")
        XCTAssertFalse(sheet.textFields["agent.code"].exists, "the code's field gone once the home answered")
        shot(3, "allowed")
        sheet.buttons["Close"].tap()
        claude.vanishes("Claude's sheet, closed by Close")
        let hermes = app.descendants(matching: .any)["agent.request"].firstMatch.staticTexts["Hermes wants to read your Lifestream"]
        hermes.appears("the next waiting, Hermes's")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "from hermes.example.com")).firstMatch.exists, "Hermes's own host")
        shot(4, "next-request")

        let next = app.descendants(matching: .any)["agent.request"].firstMatch
        next.buttons[Self.dontAllow].tap()
        next.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", try opening("answer-sign-in-deny"))).firstMatch
            .appears("the home's words for Don't allow")
        XCTAssertTrue(next.staticTexts["Hermes wants to read your Lifestream"].exists, "the agent stays shown above them")
        shot(5, "not-allowed")
        next.buttons["Close"].tap()
        hermes.vanishes("Hermes's sheet, closed by Close")
        let atlas = app.descendants(matching: .any)["agent.request"].firstMatch.staticTexts["Atlas wants to read your Lifestream"]
        atlas.appears("the last waiting, Atlas's")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Signing in \u{00B7} ")).firstMatch.exists,
                      "no host, for an app on the computer signing in")
        shot(6, "app-on-the-computer")

        trip(app)
        let over = app.descendants(matching: .any)["agent.request"].firstMatch
        over.staticTexts["This sign-in is over. Start it again in Atlas."].appears("the home no longer holds Atlas's request: its words")
        over.buttons["Close"].tap()
        over.vanishes("Atlas's sheet, closed by Close")
        shot(7, "closed")

        XCTAssertEqual(app.descendants(matching: .any)["ui-test.agents.answered"].firstMatch.label,
                       "agent-claude 640064 approved; agent-hermes deny denied",
                       "the code once Face ID passed, Don't allow, and nothing for the request the home dropped")
        XCTAssertEqual(app.descendants(matching: .any)["ui-test.lock.proofs"].firstMatch.label, "declined; passed",
                       "Face ID asked for each yes, and not for Don't allow")

        let unlock = app.buttons["life.unlock"]
        unlock.appears("the app locked again by the trip")
        unlock.tap()
        app.openTab("Timeline")
        shot(8, "app-again")
    }

    func testChatsCardSaysTheScreensLine() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--ui-test-started", "--ui-test-dark-appearance", "--ui-test-reset",
                               "--ui-test-open", "agent-chat-screen"]
        app.launch()
        let card = app.descendants(matching: .any)["ask.access.card"].firstMatch
        card.appears("Chat's card asking to widen Instinct's access")
        card.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Screen shows almost everything you did")).firstMatch
            .appears("the home's screen line on the card")
        XCTAssertTrue(card.buttons["Allow"].exists, "its ask waits: its buttons stand under the line")
        shot(9, "chat-screen")
    }

    func testJourneyClaudesGuideCopiesTheAddressAndItsYesInsideStepTwoConnects() throws {
        let app = launch("--ui-test-guide-sign-in")
        app.openTab("Agents")
        app.scrolledTo("agents.connect").tap()
        let row = app.descendants(matching: .any)["agents.guide.claude"].firstMatch
        row.appears("Claude's row in the list of apps")
        row.tap()

        let guide = app.descendants(matching: .any)["guide.claude"].firstMatch
        guide.appears("Claude's guide")
        let copy = app.buttons["guide.value.1"].firstMatch
        copy.appears("the address's copy")
        until("the address read before the copy") { copy.isEnabled }
        XCTAssertTrue(app.buttons["guide.value.1.share"].firstMatch.exists, "the share sheet beside the address's copy")
        keep("before-the-copy")

        copy.tap()
        app.descendants(matching: .any)["guide.address.on"].firstMatch.appears("the address on after the copy")
        let signIn = app.descendants(matching: .any)["guide.signin"].firstMatch
        signIn.appears("Claude's sign-in inside step 2")
        XCTAssertFalse(app.descendants(matching: .any)["agent.request"].firstMatch.exists, "no sign-in sheet over the guide")
        keep("the-sign-in-arrives")

        let guideCode = signIn.textFields["agent.code"]
        guideCode.tap()
        guideCode.typeText("640064")
        signIn.buttons["agent.allow"].tap()
        let done = app.buttons["guide.done"].firstMatch
        done.appears("Connected, Done in the foot")
        XCTAssertTrue(app.buttons["guide.open"].firstMatch.exists, "the app's own link beside Done")
        keep("connected")

        done.tap()
        guide.vanishes("Done closes the guide")
    }

    private static let dontAllow = "Don\u{2019}t allow"

    private func opening(_ name: String) throws -> String {
        let file = Self.app.deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/agents/door/\(name).json")
        let said = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let parts = try XCTUnwrap((said?["answer"] as? [String: Any])?["outcome"] as? [[String: Any]], name)
        return try XCTUnwrap(parts.first?["words"] as? String, "\(name): its outcome opens with the home's words")
    }

    private func trip(_ app: XCUIApplication) {
        XCUIDevice.shared.press(.home)
        until("the app went away") { app.state == .runningBackground }
        app.activate()
        until("the app came back") { app.state == .runningForeground }
    }

    private func shot(_ slot: Int, _ name: String) {
        let file = folder.appendingPathComponent(String(format: "%02d-%@.png", slot, name))
        XCTAssertNoThrow(try XCUIScreen.main.screenshot().pngRepresentation.write(to: file), file.path)
    }
}

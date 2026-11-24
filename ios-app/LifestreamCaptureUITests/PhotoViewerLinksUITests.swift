import XCTest

@MainActor
final class PhotoViewerLinksUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyLinksLeaveWhatTheyOpenedOver() throws {
        let app = launch("--ui-test-net", "tailscale-flips", open: "search:booked")

        let hit = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'search.hit.0' AND label CONTAINS[c] 'booked'")).firstMatch
        hit.appears("the words bring a message")
        hit.tap()
        let inspector = app.descendants(matching: .any)["inspector"].firstMatch
        inspector.appears("the hit opens its moment")
        let video = app.buttons["inspector.message.video"].firstMatch
        video.appears("1: the message carries its video")
        keep("thread-video")
        video.tap()
        app.plays(at: "2 of 4", "1: the chat's first video, among its photos and videos")
        app.buttons["Close"].firstMatch.tap()
        app.viewer.vanishes("1: the viewer closes")

        app.descendants(matching: .any)["inspector.message.photo"].firstMatch.tap()
        app.viewer.appears("the message's picture opens the viewer")
        app.buttons["viewer.infoButton"].tap()
        let chat = app.descendants(matching: .any)["viewer.info.chat"].firstMatch
        chat.appears("1: the chat it came in")
        XCTAssertTrue(chat.label.hasPrefix("Sent by ") && chat.label.contains("Person A"), "who sent it: \(chat.label)")
        XCTAssertTrue(app.descendants(matching: .any)["viewer.info.date"].firstMatch.exists, "1: and when")
        for part in ["caption", "people", "place", "camera"] {
            XCTAssertFalse(app.descendants(matching: .any)["viewer.info.\(part)"].firstMatch.exists, "1: no \(part) for a chat's image")
        }
        keep("chat")

        chat.tap()
        app.viewer.vanishes("2: the link closes the viewer")
        until("2: the day pushed") { app.inFront("days.day").exists }
        let messages = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'inspector.message.' AND NOT identifier ENDSWITH '.photo'"))
        let selected = { messages.allElementsBoundByIndex.filter(\.isSelected) }
        until("2: the day opens on the message that carried it: \(selected().map(\.label))") {
            let shown = selected()
            return inspector.exists && shown.count == 1
                && shown[0].descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'booked'")).count == 0
        }
        keep("chat-day")
        app.swipeAway(inspector)
        XCTAssertTrue(app.inFront("days.day").exists, "2: the day under it, no sheet left over it")
        app.backFromDay()
        app.buttons["BackButton"].firstMatch.tap()
        app.closeSearch()

        app.openTab("Places")
        app.descendants(matching: .any)["places.list"].firstMatch.appears()
        app.buttons["places.invite"].tap()
        app.buttons["naming.name.0"].appears("the card's names read")
        let card = app.descendants(matching: .any)["naming.photo.0"].firstMatch
        until("the card's first photo drawn") { card.exists && card.value as? String == "drawn" }
        card.tap()
        app.viewer.appears("a card's photo opens the viewer")
        let infoButton = app.buttons["viewer.infoButton"]
        until("3: the viewer opens in Info, as it was left") { infoButton.exists && infoButton.isSelected }
        infoButton.tap()
        let chip = app.buttons["viewer.chip.0"]
        chip.appears("its person")
        chip.tap()
        app.staticTexts["person.name"].appears("3: the chip opens the person")
        XCTAssertFalse(app.viewer.exists, "3: the viewer gone")
        XCTAssertFalse(app.descendants(matching: .any)["naming.close"].firstMatch.exists, "3: the walk gone")
        keep("walk-person")
        app.navigationBars.buttons.firstMatch.tap()

        let office = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "places.row.the-office")).firstMatch
        office.appears()
        app.raiseSheet()
        office.tap()
        let tile = app.scrolledTo("place.photo.0")
        until("its first photo drawn") { tile.exists && tile.value as? String == "drawn" }
        app.trip()
        tile.tap()
        app.viewer.appears("the viewer, the home out of reach")
        app.buttons["viewer.infoButton"].tap()
        let error = app.descendants(matching: .any)["viewer.info.error"].firstMatch
        error.appears("4: Info says what the viewer lacks")
        XCTAssertFalse(app.descendants(matching: .any)["viewer.info.date"].firstMatch.exists, "4: no fact read")
        keep("unreached")
        app.trip()
        app.descendants(matching: .any)["viewer.info.date"].firstMatch.appears("4: the road back, the facts fill in")
        XCTAssertFalse(error.exists, "4: the failure gone")
        keep("reached")
    }
}

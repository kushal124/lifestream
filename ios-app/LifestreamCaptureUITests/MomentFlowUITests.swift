import XCTest

@MainActor
final class MomentFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyASearchedMessageOpensItsConversation() throws {
        let app = launch(open: "search:book the table")
        let note = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'search.hit.0' AND label CONTAINS[c] 'book the table'")).firstMatch
        note.appears("the words bring a voice note")
        note.tap()
        app.descendants(matching: .any)["viewer.made.line"].firstMatch.appears("M6: what wrote the transcript")
        XCTAssertTrue(app.buttons["viewer.made.again"].firstMatch.exists, "M6: and its act")
        keep("voice-transcribed")
        let inspector = app.descendants(matching: .any)["inspector"].firstMatch
        app.swipeAway(inspector)
        app.backFromDay()

        app.openHit("booked")
        inspector.appears("the hit opens its moment")
        let messages = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'inspector.message.' AND NOT identifier ENDSWITH '.photo'"))
        until("M1: each message its own element (\(messages.count))") { messages.count >= 2 }
        app.descendants(matching: .any)["inspector.message.photo"].firstMatch.appears("M2: the photo it carried")
        let quote = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Replying to'")).firstMatch
        quote.appears("M3: the reply quotes the message it answers")
        let selected = messages.allElementsBoundByIndex.filter(\.isSelected)
        XCTAssertEqual(selected.count, 1, "M4: the searched message is the selected one")
        let searched = selected.first?.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'booked'")).count ?? 0
        XCTAssertGreaterThan(searched, 0, "M4: and it is the one searched")
        let out = app.descendants(matching: .any)["inspector.out"].firstMatch
        out.appears("M5: a way to the chat itself")
        XCTAssertTrue(out.label.contains("WhatsApp"), out.label)
        keep("conversation")

        app.descendants(matching: .any)["inspector.message.photo"].firstMatch.tap()
        let close = app.buttons["Close"].firstMatch
        close.appears("M2: the photo opens full size")
        keep("photo")
        close.tap()
        inspector.appears("closing the photo returns to the moment")
    }
}

import XCTest

@MainActor
final class NotesFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyNotes() throws {
        let app = launch(open: "notes")
        app.descendants(matching: .any)["notes.folders"].firstMatch.appears("Notes opens on its folders")
        keep("folders")

        app.buttons["notes.new-folder"].tap()
        let folderName = app.textFields["notes.folder.name"]
        folderName.appears()
        keep("folder-sheet")
        app.type("Projects", into: folderName)
        app.buttons["notes.folder.save"].tap()
        let folder = app.staticTexts["Projects"]
        folder.appears("the folder made")
        folder.tap()
        app.navigationBars["Projects"].appears()
        app.buttons["notes.new-note"].appears()
        keep("empty-list")
        app.buttons["notes.new-note"].tap()

        let body = noteEditor(in: app)
        app.type("Groceries\nMilk", into: body)
        let checklist = app.buttons["notes.editor.checklist"]
        until("the keyboard's checklist button on screen") { checklist.isHittable }
        checklist.tap()
        XCTAssertEqual(body.value as? String, "Groceries\n☐ Milk", "the line becomes a checklist item")
        checklist.tap()
        XCTAssertEqual(body.value as? String, "Groceries\nMilk", "and back")
        checklist.tap()
        app.type("\nBread", into: body)
        let written = "Groceries\n☐ Milk\n☐ Bread"
        XCTAssertEqual(body.value as? String, written)
        XCTAssertLessThanOrEqual(checklist.frame.maxY, app.frame.maxY - 30, "the keyboard's bar clears the home indicator")
        keep("editor")

        app.buttons["notes.editor.style"].tap()
        app.buttons["notes.editor.style.body"].appears()
        keep("format-card")
        let bold = app.buttons["notes.editor.bold"]
        bold.tap()
        XCTAssertEqual(bold.value as? String, "On")
        bold.tap()
        app.buttons["notes.editor.format-close"].tap()
        body.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.65)).tap()
        XCTAssertEqual(body.value as? String, written)
        app.buttons["notes.editor.back"].tap()
        app.noteText("Groceries").appears()

        let search = app.searchFields["Search"]
        search.appears("the folder's list holds its search")
        app.type("Milk", into: search)
        app.noteText("Groceries").appears()
        app.typeText("\n")
        app.buttons["Clear"].firstMatch.tap()

        app.noteText("Groceries").press(forDuration: 0.7)
        app.buttons["Pin"].tap()
        let pinned = app.buttons["notes.pinned.toggle"]
        pinned.appears()
        keep("pinned-list")
        pinned.tap()
        XCTAssertEqual(pinned.value as? String, "Collapsed")
        app.noteText("Groceries").vanishes()
        pinned.tap()
        app.noteText("Groceries").appears()

        app.noteText("Groceries").press(forDuration: 0.7)
        app.buttons["Delete"].tap()
        app.noteText("Groceries").vanishes()
        app.navigationBars.buttons["Folders"].tap()
        app.staticTexts["Recently deleted"].tap()
        app.noteText("Groceries").press(forDuration: 0.7)
        app.buttons["Recover"].tap()
        app.noteText("Groceries").vanishes("recovered out of Recently deleted")
        app.relaunch(open: "notes")
        let all = app.descendants(matching: .any)["notes.folder.all"].firstMatch
        all.appears("Notes again, after the app was ended")
        all.tap()
        app.noteText("Groceries").tap()
        XCTAssertEqual(noteEditor(in: app).value as? String, written, "the note as it was written")

        app.buttons["notes.editor.more"].tap()
        app.buttons["Delete"].tap()
        app.navigationBars.buttons["Folders"].tap()
        app.staticTexts["Recently deleted"].tap()
        app.noteText("Groceries").press(forDuration: 0.7)
        app.buttons["Delete forever"].tap()
        let forever = app.buttons["Delete this note"]
        forever.appears()
        keep("delete-forever")
        app.otherElements["PopoverDismissRegion"].tap()
        forever.vanishes()
        XCTAssertTrue(app.noteText("Groceries").exists, "the note kept")
        app.noteText("Groceries").press(forDuration: 0.7)
        app.buttons["Delete forever"].tap()
        forever.tap()
        app.noteText("Groceries").vanishes()

        app.navigationBars.buttons["Folders"].tap()
        folder.appears()
        folder.swipeLeft()
        let swipeDelete = app.buttons["Delete"]
        swipeDelete.appears()
        swipeDelete.tap()
        let confirm = app.buttons["Delete this folder"]
        confirm.appears()
        swipeDelete.vanishes("the swipe row collapses under the dialog")
        XCTAssertTrue(confirm.exists, "the folder's delete confirmation dismissed itself")
        confirm.tap()
        folder.vanishes()
    }

    private func noteEditor(in app: XCUIApplication) -> XCUIElement {
        let body = app.textViews["notes.editor.body"]
        body.appears("the note's editor")
        return body
    }
}

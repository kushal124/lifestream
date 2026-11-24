import XCTest

@MainActor
final class AppShellUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyTabsAndCaptureMenuOpenEveryCapture() throws {
        let app = launch()

        XCTAssertTrue(app.tab("Chat").isSelected)
        for name in ["Chat", "Timeline", "People", "Places", "Agents"] {
            XCTAssertTrue(app.tab(name).exists, "tab bar item \(name)")
        }
        XCTAssertFalse(app.tab("Connectors").exists, "Connectors is no tab")
        XCTAssertTrue(app.buttons["streams.open"].exists, "Ask's top bar holds Connectors")
        XCTAssertFalse(app.capturePlus.exists, "Ask carries no +")
        app.openTab("Timeline")
        app.capturePlus.appears()
        app.descendants(matching: .any)["days.day"].firstMatch.appears("Days opens on today")
        keep("days")

        for name in ["People", "Places"] {
            app.openTab(name)
            app.rootHead(name).appears(name)
            XCTAssertFalse(app.capturePlus.exists, "\(name) carries no +")
            keep(name.lowercased())
        }

        app.openStreams()
        for row in ["machinery.home", "machinery.phone"] {
            XCTAssertTrue(app.scrolledTo(row).exists, row)
        }
        keep("streams")

        app.closeCaptureSheet()
        app.buttons["search.open"].firstMatch.tap()
        app.descendants(matching: .any)["search.root"].firstMatch.appears()
        XCTAssertFalse(app.capturePlus.exists, "Search carries no +")
        keep("search")
        app.buttons["search.close"].firstMatch.tap()
        app.bringTabBarIntoReach()

        app.openCaptureMenu()
        for item in ["voice", "photo", "note", "checkin", "notes"] {
            XCTAssertTrue(app.buttons["capture.menu.\(item)"].exists, item)
        }
        XCTAssertTrue(app.tab("Timeline").isSelected)
        keep("capture-menu")
        app.tab("Timeline").tap()
        app.buttons["capture.menu.photo"].vanishes()
        XCTAssertTrue(app.capturePlus.exists)

        app.openCamera()
        app.buttons["camera.shutter"].appears()
        app.buttons["capture.close"].firstMatch.tap()
        app.capturePlus.appears()

        app.openCaptureMenu()
        app.buttons["capture.menu.note"].tap()
        let editor = app.textViews["notes.editor.body"]
        editor.appears("Note opens an editable note directly")
        app.type("A synthetic moment", into: editor)
        app.buttons["notes.editor.done"].tap()
        app.buttons["notes.editor.done"].vanishes()

        app.openAllNotes()
        XCTAssertFalse(app.textViews["notes.editor.body"].exists)
        app.descendants(matching: .any)["notes.folder.all"].firstMatch.tap()
        app.noteText("A synthetic moment").appears()
        app.closeCaptureSheet()

        app.openCaptureMenu()
        app.buttons["capture.menu.checkin"].tap()
        let save = app.buttons["checkin.save"]
        save.appears("Check-in opens the moment form")
        keep("checkin")
        app.buttons["checkin.cancel"].tap()
        save.vanishes()
        XCTAssertTrue(app.capturePlus.exists)
    }

    func testJourneyTheLockCoversTheWholeAppUntilUnlockedThenAnAnswersFeedbackIsSent() throws {
        let app = launch(opens: .lock)
        let unlock = app.buttons["life.unlock"]
        XCTAssertTrue(app.staticTexts["Lifestream is locked"].exists, "the cover says so")
        XCTAssertFalse(app.tab("Timeline").exists, "no tab bar under the cover")
        XCTAssertFalse(app.descendants(matching: .any)["root.title"].firstMatch.exists, "no page's title under the cover")
        XCTAssertFalse(app.buttons["streams.open"].firstMatch.exists, "no toolbar under the cover")
        XCTAssertFalse(app.descendants(matching: .any)["ask.home"].firstMatch.exists, "nothing of Ask shows locked")
        keep("locked")

        unlock.tap()
        app.awaitShell()
        app.descendants(matching: .any)["ask.home"].firstMatch.appears("the app opens on Ask")
        app.openTab("Timeline")
        app.descendants(matching: .any)["days.day"].firstMatch.appears()
        app.openTab("People")
        app.rootHead("People").appears()
        XCTAssertFalse(unlock.exists, "one unlock opens every section")

        XCUIDevice.shared.press(.home)
        app.activate()
        unlock.appears()
        XCTAssertFalse(app.descendants(matching: .any)["days.day"].firstMatch.exists, "nothing of the day under the cover")
        XCTAssertFalse(app.tab("People").exists, "the tab bar under the cover again")

        unlock.tap()
        app.awaitShell()
        app.openTab("Chat")
        let composer = app.textViews["Ask"].exists ? app.textViews["Ask"] : app.textFields["Ask"]
        composer.appears("the composer")
        app.type("When did I last have dinner with Person A?", into: composer)
        app.buttons["Send"].tap()

        let more = app.buttons["ask.more"].firstMatch
        more.appears("the answer ended: its … after Copy")
        app.scrollViews["ask.thread"].firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.2)).tap()
        app.keyboards.firstMatch.vanishes("a tap on the thread puts the keyboard away from over the answer's end")
        let end = app.buttons["ask.end"].firstMatch
        end.appears("the answer runs past the screen: the thread offers its end")
        end.tap()
        end.vanishes("the thread at its end")
        more.comesToRest("the … above the composer")
        more.tap()
        let item = app.menuItem("Send feedback")
        item.appears("the … menu holds Send feedback")
        item.tap()

        let sheet = app.descendants(matching: .any)["feedback.sheet"].firstMatch
        sheet.appears("the form opens straight on the note")
        app.descendants(matching: .any)["attachment.remove"].firstMatch.appears("the draft's chips: this answer, the app's details")
        let add = app.descendants(matching: .any)["attachment.add"].firstMatch
        add.appears("the screenshot taken under the sheet, offered")
        let send = app.buttons["feedback.save"].firstMatch
        XCTAssertFalse(send.isEnabled, "Send waits for words")

        let field = app.descendants(matching: .any)["feedback.text"].firstMatch
        app.type("It named the wrong place", into: field)
        until("Send takes the words") { send.isEnabled }
        add.tap()
        add.vanishes("the screenshot added: its chip kept, with its ×")
        keep("feedback-typed")

        let see = app.descendants(matching: .any)["feedback.see"].firstMatch
        app.bringIntoView(see)
        see.tap()
        app.descendants(matching: .any)["feedback.seen"].firstMatch.appears("what is sent, as it leaves")
        app.descendants(matching: .any)["feedback.seen.answer"].firstMatch.appears("the answer's hidden text")
        keep("feedback-seen")
        app.buttons["drawer.back"].firstMatch.tap()
        see.appears("back on the note")

        send.tap()
        sheet.vanishes("the form closes on Send")
        app.descendants(matching: .any)["feedback.sent"].firstMatch.appears("the page's sent words")
        keep("feedback-sent")
    }

    func testVoiceNoteFromPlusStopSavesAndCancelDiscards() throws {
        let app = launch()
        app.openCaptureMenu()
        app.buttons["capture.menu.voice"].tap()
        let stop = app.buttons["voice.stop"]
        stop.appears("Voice note opens the recording panel")
        XCTAssertTrue(app.buttons["voice.cancel"].exists)
        let clock = app.descendants(matching: .any)["voice.clock"].firstMatch
        until("the clock runs: \(clock.label)") { clock.label.hasPrefix("Recording, ") && !clock.label.hasSuffix(" 0:00") }
        keep("voice-panel")
        stop.tap()
        stop.vanishes("Stop saves and closes the panel")

        app.openCaptureMenu()
        app.buttons["capture.menu.voice"].tap()
        let cancel = app.buttons["voice.cancel"]
        cancel.appears()
        until("the clock runs before Cancel: \(clock.label)") { clock.label.hasPrefix("Recording, ") && !clock.label.hasSuffix(" 0:00") }
        cancel.tap()
        cancel.vanishes("Cancel discards and closes the panel")

        app.relaunch(open: "thisphone", push: "details")
        let count = app.descendants(matching: .any)["status.voice-count"].firstMatch
        count.appears("Status's Details")
        app.bringIntoView(count)
        until("This iPhone counts the saved voice note: \(count.label)") { count.label.hasSuffix("today, 1") }
    }
}

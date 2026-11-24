import XCTest

@MainActor
final class PhotoViewerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyPhotoViewer() throws {
        let app = launch(open: "place:the-office")
        app.staticTexts["page.title"].appears("The Office's page")

        openTile(app)
        let title = app.buttons["viewer.title"]
        title.appears("1: the photo's place over it")
        XCTAssertEqual(title.label, "The Office", "the place the home says holds it")
        let date = app.buttons["viewer.date"]
        XCTAssertNotNil(date.label.range(of: #"^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})? · \d\d:\d\d$"#, options: .regularExpression),
                        "1: its moment under it: \(date.label)")
        let chip = app.buttons["viewer.chip.0"]
        XCTAssertEqual(chip.label, "Person A", "1: the person named on it")
        XCTAssertEqual(count(app), "1 of 4", "the page's photos, from the one tapped")
        keep("layer")

        photo(app).pinch(withScale: 2.5, velocity: 1)
        until("2: the pinch zooms: \(drawn(app))") { self.drawn(app).hasSuffix("zoomed") }
        XCTAssertEqual(count(app), "1 of 4", "2: a pinch never steps")
        XCTAssertTrue(app.viewer.exists, "2: nor closes")
        photo(app).doubleTap()
        until("2: a double tap, whole again: \(drawn(app))") { !self.drawn(app).hasSuffix("zoomed") }

        photo(app).tap()
        title.vanishes("2: a tap hides the layer")
        XCTAssertFalse(chip.exists, "the chips go with it")
        keep("bare")
        photo(app).tap()
        title.appears("2: a tap brings it back")

        let before = (picture: picture(app), date: date.label)
        step(app)
        until("3: the count moves: \(count(app))") { self.count(app) == "2 of 4" }
        until("3: the next photo's own facts: \(title.exists ? title.label : "none")") { title.exists && title.label == "Home" }
        until("3: its own date: \(date.label)") { date.exists && date.label != before.date }
        XCTAssertNotEqual(picture(app), before.picture, "3: its own picture")
        XCTAssertEqual(chip.label, "Person B", "3: its own person")

        app.drag(up: true)
        let info = app.descendants(matching: .any)["viewer.info"].firstMatch
        info.appears("4: Info")
        title.vanishes("4: no fact twice: the title leaves")
        XCTAssertFalse(chip.exists, "the chips leave too")
        let parts = ["caption", "people", "place", "date", "camera"].map { app.descendants(matching: .any)["viewer.info.\($0)"].firstMatch }
        for (part, name) in zip(parts, ["caption", "people", "place", "date", "camera"]) {
            XCTAssertTrue(part.exists, "4: Info holds its \(name)")
        }
        for (above, below) in zip(parts, parts.dropFirst()) {
            XCTAssertLessThan(above.frame.minY, below.frame.minY, "4: \(above.identifier) above \(below.identifier)")
        }
        let named = app.descendants(matching: .any)["viewer.info.person.0"].firstMatch
        XCTAssertEqual(named.label, "Person B", "4: Info's person")
        XCTAssertGreaterThan(named.frame.width, 52, "4: Person B's column is as wide as the name, not cut at the face")
        XCTAssertFalse(app.descendants(matching: .any)["viewer.info.chat"].firstMatch.exists, "no chat holds a place's photo")
        XCTAssertTrue(app.descendants(matching: .any)["viewer.info.camera"].firstMatch.label.contains("From your iPhone"),
                      "the camera and where it came from")
        keep("info")
        app.drag(up: false, on: info)
        info.vanishes("4: a swipe down on Info lowers it")
        title.appears("4: the layer returns")

        photo(app).pinch(withScale: 2.5, velocity: 1)
        until("4: zoomed: \(drawn(app))") { self.drawn(app).hasSuffix("zoomed") }
        let zoomedPicture = picture(app)
        app.buttons["viewer.infoButton"].tap()
        info.appears("4: Info, by its button")
        until("4: Info shows the photo whole: \(drawn(app))") { !self.drawn(app).hasSuffix("zoomed") }
        XCTAssertEqual(picture(app), zoomedPicture, "4: the picture read is kept")
        let place = app.descendants(matching: .any)["viewer.info.place"].firstMatch
        XCTAssertTrue(place.label.hasPrefix("Home, "), "the photo's place: \(place.label)")
        step(app, at: 0.2, back: true)
        until("4: stepped back in Info: \(count(app))") { self.count(app) == "1 of 4" }
        until("4: Info's place is the photo's: \(place.label)") { place.label.hasPrefix("The Office, ") }

        let made = app.descendants(matching: .any)["viewer.info.made.line"].firstMatch
        made.appears("8: what wrote the caption")
        let caption = app.descendants(matching: .any)["viewer.info.caption"].firstMatch
        XCTAssertLessThan(caption.frame.maxY, made.frame.maxY, "8: under the caption")
        app.buttons["viewer.made.again"].firstMatch.tap()
        let gemini = app.menuItem("Gemini 3.8 Flash")
        gemini.appears("8: the menu of every other model")
        XCTAssertFalse(app.menuItem("Qwen 3.5").exists, "8: never the one that wrote it")
        keep("info-describe-again")
        gemini.tap()
        until("8: the photo waits on the chosen model: \(made.label)") { made.exists && made.label == "In the queue" }
        app.trip()
        until("8: the chosen model wrote it: \(made.label)") { made.exists && made.label.hasPrefix("Gemini 3.8 Flash") }
        keep("info-described-again")

        step(app, at: 0.2)
        until("4: and on again: \(count(app))") { self.count(app) == "2 of 4" }
        app.buttons["viewer.infoButton"].tap()
        info.vanishes("4: Info's button lowers it")

        chip.tap()
        let person = app.staticTexts["person.name"]
        person.appears("5: the chip opens the person")
        XCTAssertEqual(person.label, "Person B")
        XCTAssertFalse(app.viewer.exists, "5: the viewer closed as the link was followed")
        app.navigationBars.buttons.firstMatch.tap()

        openTile(app)
        app.buttons["viewer.infoButton"].tap()
        place.appears("Info, by its button")
        XCTAssertTrue(place.label.hasPrefix("The Office, ") && place.label.contains("Synthetic Town"), "the place and its area: \(place.label)")
        place.tap()
        app.viewer.vanishes("5: the place card closes the viewer")
        until("5: the place's page pushed") { app.navigationBars.buttons.firstMatch.exists && app.staticTexts["page.title"].label == "The Office" }
        app.navigationBars.buttons.firstMatch.tap()

        openTile(app)
        let dateRow = app.descendants(matching: .any)["viewer.info.date"].firstMatch
        dateRow.appears("6: Info remembered")
        XCTAssertFalse(app.buttons["viewer.title"].exists, "opened in Info")
        dateRow.tap()
        app.viewer.vanishes("5: the date closes the viewer")
        until("5: the date pushes the day") { app.inFront("days.day").exists }
        let moment = app.descendants(matching: .any)["inspector.photo.0"].firstMatch
        moment.appears("5: the day opens on the photo's moment, its burst")
        keep("date-moment")

        moment.tap()
        app.viewer.appears("7: a burst's picture opens the viewer")
        until("7: every photo of the burst: \(count(app))") { self.count(app) == "1 of 4" }
        app.buttons["viewer.infoButton"].tap()
        info.vanishes("7: Info lowered")
        app.buttons["Close"].firstMatch.tap()
        app.viewer.vanishes("7: closed")
        moment.swipeLeft()
        let second = app.descendants(matching: .any)["inspector.photo.1"].firstMatch
        second.appears("7: the burst's second picture")
        second.swipeLeft()
        let video = app.descendants(matching: .any)["inspector.video.2"].firstMatch
        video.appears("7: the burst keeps its video")
        XCTAssertTrue(video.label.hasPrefix("Video, 0:04"), "7: a video with its length: \(video.label)")
        keep("burst-video")
        video.tap()
        app.plays(at: "3 of 4", "7")
        keep("video-playing")

        let scrubber = app.descendants(matching: .any)["viewer.video.scrubber"].firstMatch
        scrubber.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .drag(to: scrubber.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)), pressing: 0.1)
        XCTAssertEqual(count(app), "3 of 4", "7: a drag across the scrubber never steps")
        let mute = app.buttons["viewer.video.mute"]
        mute.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .drag(to: app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.8)), pressing: 0.1)
        XCTAssertEqual(count(app), "3 of 4", "7: a drag from the bar across the screen never steps")
        mute.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .drag(to: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)), pressing: 0.1)
        XCTAssertTrue(app.viewer.exists, "7: nor a drag down from the bar closes the viewer")
        XCTAssertEqual(count(app), "3 of 4")

        step(app)
        until("7: the Live Photo: \(count(app))") { self.count(app) == "4 of 4" }
        XCTAssertFalse(app.descendants(matching: .any)["viewer.video.bar"].firstMatch.exists, "7: a Live Photo has no bar")
        let live = app.descendants(matching: .any)["viewer.live"].firstMatch
        live.appears("7: LIVE on the Live Photo")
        until("7: its still drawn: \(drawn(app))") { self.drawn(app).hasSuffix("live 0") }
        keep("live-rest")
        photo(app).press(forDuration: 2)
        until("7: a press played its motion: \(drawn(app))") { self.drawn(app).hasSuffix("live 1") }
        XCTAssertEqual(count(app), "4 of 4", "7: a press never steps")
        photo(app).tap()
        live.vanishes("7: LIVE hides with the layer")
    }


    private func openTile(_ app: XCUIApplication) {
        let tile = app.scrolledTo("place.photo.0")
        until("its first photo drawn") { tile.exists && tile.value as? String == "drawn" }
        tile.tap()
        app.viewer.appears("the tile opens the viewer")
        until("the photo drawn: \(drawn(app))") { self.drawn(app).hasPrefix("screen") }
    }

    private func step(_ app: XCUIApplication, at height: CGFloat = 0.45, back: Bool = false) {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: back ? 0.1 : 0.9, dy: height))
        from.drag(to: app.coordinate(withNormalizedOffset: CGVector(dx: back ? 0.9 : 0.1, dy: height)))
    }

    private func photo(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["viewer.photo"].firstMatch
    }

    private func drawn(_ app: XCUIApplication) -> String {
        photo(app).exists ? photo(app).value as? String ?? "" : ""
    }

    private func picture(_ app: XCUIApplication) -> String {
        drawn(app).split(separator: " ").dropFirst().first.map(String.init) ?? ""
    }

    private func count(_ app: XCUIApplication) -> String {
        app.descendants(matching: .any)["viewer.count"].firstMatch.value as? String ?? ""
    }
}

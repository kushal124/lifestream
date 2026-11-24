import XCTest

@MainActor
final class ScreenTourUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testTourInDark() throws {
        try tour("dark")
    }

    func testTourInLight() throws {
        try tour("light")
    }


    private var app = XCUIApplication()
    private var folder = URL(fileURLWithPath: "/")

    private func tour(_ appearance: String) throws {
        folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/shots/\(appearance)")
        try? FileManager.default.removeItem(at: folder)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--ui-test-reset", "--ui-test-locked",
                               "--ui-test-\(appearance)-appearance"]
        app.launch()

        try start()
        days()
        inspectors()
        people()
        places()
        search()
        connectors()
        captures()
    }

    private func start() throws {
        app.buttons["firstrun.setup"].appears()
        shot(1, "first-run")
        app.startCapture()
        let unlock = app.buttons["life.unlock"]
        unlock.appears("the life sections start locked")
        shot(2, "locked")
        unlock.tap()
        app.awaitShell()
        app.openTab("Timeline")
        shown("day.stay.0").appears("the day's first stay")

        app.openSearch()
        let field = app.searchTabField
        field.appears()
        let unwritten = Self.civilDay(daysBack: 500)
        field.typeText(unwritten)
        let day = app.descendants(matching: .any)["search.goto.day"]
        day.appears("a date offers its day")
        day.tap()
        app.staticTexts[try Self.beforeHome(unwritten)].appears("a day before the home's history")
        XCTAssertTrue(app.buttons["day.first"].exists, "with the home's first day as a link")
        shot(3, "days-unwritten")
        app.buttons["day.back"].tap()
        let clear = app.buttons["Clear"].firstMatch
        clear.appears("the field's clear, beside its words")
        clear.tap()
        app.openTab("Timeline")
        shown("day.stay.0").appears()
    }

    private func days() {
        XCTAssertTrue(shown("day.title").label.contains(Self.longDate(daysBack: 0)), "Days opens on today")
        shot(4, "days-today")
        XCTAssertTrue(reveal("day.now", by: { app.swipeUp() }), "today's list ends at now")
        shot(6, "days-today-now")
        XCTAssertTrue(reveal("day.end", by: { app.swipeUp() }), "the day's end, the map and the people after it")
        shot(7, "days-today-foot")

        app.yesterdayBeside()
        app.swipeRight()
        until("yesterday") { self.shown("day.title").label.contains(Self.longDate(daysBack: 1)) }
        shown("day.stay.0").appears()
        shot(8, "days-yesterday")
        XCTAssertTrue(reveal("day.people", by: { app.swipeUp() }))
        shot(9, "days-yesterday-foot")
        toDayTop()

        shown("day.title").tap()
        let row = app.buttons["days.day.\(Self.civilDay(daysBack: 1))"]
        row.appears("the days list")
        shot(10, "days-list")
        app.bringIntoView(app.buttons["days.day.\(Self.civilDay(daysBack: 40))"])
        shot(11, "days-last-month")
        app.bringIntoView(row, towardTop: true)
        row.tap()
        row.vanishes("a day of the list opens it")
        until("yesterday again") { self.shown("day.title").label.contains(Self.longDate(daysBack: 1)) }
    }

    private func inspectors() {
        let weekdays = (1..<21).filter(Self.isPlainWeekday)
        let both = weekdays.first { $0 % 12 == 6 }
        let voiceDay = both ?? weekdays.first { $0 % 4 == 2 } ?? 2
        let photosDay = both ?? weekdays.first { $0 % 3 == 0 } ?? 3
        let busyDay = (1...6).first { !Self.isWeekend($0) } ?? 1
        var at = 1

        func go(_ back: Int) {
            toDayTop()
            while at != back {
                if at < back { app.swipeRight(); at += 1 } else { app.swipeLeft(); at -= 1 }
                let date = Self.longDate(daysBack: at)
                until("the day \(date)") { self.shown("day.title").label.contains(date) }
            }
            shown("day.stay.0").appears()
        }

        go(busyDay)
        XCTAssertTrue(reveal("day.stay.1", by: { app.swipeUp() }))
        shown("day.stay.1").tap()
        XCTAssertTrue(reveal("day.hour.1.", by: { app.swipeUp() }), "the busy day's office opens by hour")
        shot(5, "days-hours")

        go(voiceDay)
        openEvery()
        inspect(12, "conversation", "day.row.", label: "Group Alpha")
        inspect(13, "mail", "day.row.", label: "mail")
        inspect(15, "sleep", "day.row.", label: "Woke")
        inspect(16, "sitting", "day.row.", label: "Xcode")
        inspect(17, "voice-note", "day.row.", label: "Remember to book")
        if photosDay != voiceDay {
            go(photosDay)
            openEvery()
        }
        inspect(18, "photos", "day.row.", label: "photos")
    }

    private func openEvery() {
        toDayTop()
        for n in 0..<6 {
            guard reveal("day.stay.\(n)", by: { step() }) else { break }
            let head = shown("day.stay.\(n)")
            if head.value as? String == "Collapsed" { head.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap() }
        }
    }

    private func people() {
        app.tab("People").tap()
        let personA = app.buttons["people.row.person:person-a"]
        personA.appears("the list reads the home's people")
        shot(19, "people")
        personA.tap()
        app.staticTexts["person.name"].appears()
        app.descendants(matching: .any)["person.weeks"].appears()
        shot(20, "person")
    }

    private func places() {
        app.tab("Places").tap()
        let list = app.descendants(matching: .any)["places.list"]
        for _ in 0..<3 where !list.exists {
            let back = app.navigationBars.buttons.firstMatch
            guard back.exists else { break }
            back.tap()
        }
        list.appears()
        app.buttons["places.invite"].appears("the home asks about spots")
        shot(21, "places")

        let office = app.buttons["places.row.the-office"]
        office.appears()
        app.raiseSheet()
        office.tap()
        app.staticTexts["place.rhythm"].appears()
        shot(22, "place")
        app.buttons["place.edit"].tap()
        app.descendants(matching: .any)["places.sheet.reach"].firstMatch.appears()
        shot(23, "place-edit")
        app.buttons["places.sheet.cancel"].tap()
        app.buttons["places.sheet.cancel"].vanishes()
        viewer()
        app.navigationBars.buttons.firstMatch.tap()

        let trips = app.buttons["places.view.trips"]
        trips.appears()
        trips.tap()
        let year = app.descendants(matching: .any)["places.year"]
        year.appears()
        let calendar = Calendar(identifier: .gregorian)
        let tripYear = calendar.component(.year, from: calendar.date(byAdding: .month, value: -1, to: TestClock.now)!)
        if year.value as? String != String(tripYear) {
            year.tap()
            app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND identifier != 'places.year'", String(tripYear))).firstMatch.tap()
        }
        let trip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "places.trip.")).firstMatch
        trip.appears("last month's trip")
        shot(24, "trips")
        trip.tap()
        app.staticTexts["page.title"].appears()
        let day = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "trip.day.")).firstMatch
        day.appears("the trip's days")
        shot(25, "trip")
        app.navigationBars.buttons.firstMatch.tap()
    }

    private func search() {
        app.openSearch()
        let field = app.searchTabField
        field.appears()
        app.descendants(matching: .any)["search.goto.person.person:person-a"].appears()
        shot(26, "search")
        field.typeText("synthetic")
        app.descendants(matching: .any)["search.hit.0"].appears()
        shot(27, "search-results")
        app.bringTabBarIntoReach()
    }

    private func connectors() {
        let report = try? HomeReport()
        let github = try? report?.connector("github")
        app.openStreams()
        app.descendants(matching: .any)["home-connector.whatsapp"].appears("the home's connectors are read")
        let row = app.descendants(matching: .any)["home-connector.github"]
        XCTAssertTrue(row.label.contains(HomeReport.said(github, "line")), "a stream's health on its row: \(row.label)")
        shot(28, "streams")
        XCTAssertTrue(reveal("machinery.phone", by: step))
        for device in report?.devices ?? [] where HomeReport.said(device, "unit") != HomeReport.unit {
            let line = app.descendants(matching: .any)["machinery.device.\(HomeReport.said(device, "unit"))"].firstMatch
            XCTAssertTrue(line.label.contains(HomeReport.said(HomeReport.health(device), "words")), "each other device by its health: \(line.label)")
        }
        shot(43, "streams-devices")
        app.scrolledTo("connectors.shown.not").tap()
        XCTAssertTrue(app.scrolledTo("home-connector.granola").exists, "a connector not set up stands under Not connected, in its kind's section")
        shot(29, "streams-not-set-up")

        app.openMachinery("machinery.library")
        let detail = app.descendants(matching: .any)["connector.detail"]
        detail.appears("a row opens its sheet")
        XCTAssertTrue(app.descendants(matching: .any)["photos.authorization"].exists, "the sheet holds the permission")
        shot(30, "source-photos")
        app.openMachinery("home-connector.whatsapp")
        detail.appears()
        XCTAssertTrue(app.descendants(matching: .any)["connector.detail.week"].exists, "the home's week")
        shot(48, "stream-sheet-medium")
        app.expandSheet()
        XCTAssertTrue(detail.firstMatch.buttons["Close"].exists, "a stream's sheet closes by its ×, as every sheet")
        shot(42, "stream-sheet")
        step()
        shot(44, "stream-sheet-scrolled")
        app.bringIntoView(app.descendants(matching: .any)["connector.detail.processing"].firstMatch)
        shot(49, "stream-sheet-ai")
        app.bringIntoView(app.descendants(matching: .any)["connector.detail.backfill"].firstMatch)
        shot(50, "stream-sheet-history")
        app.openAI("llm.photos")
        shot(51, "stream-sheet-ai-page")
        app.closeConnectorDetail()

        app.openMachinery("machinery.home")
        app.descendants(matching: .any)["home.reached"].firstMatch.appears("the phone is paired with the canned home")
        XCTAssertTrue(app.buttons["export.build"].exists)
        let said = { (words: String) in self.app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)) }
        XCTAssertTrue(said("iPhone Simulator").firstMatch.exists, "this phone is named by its model")
        for raw in ["iphone-aa01", "seal ", ":local:"] { XCTAssertFalse(said(raw).firstMatch.exists, "no id or seal: \(raw)") }
        shot(32, "home")
        app.openMachinery("machinery.status")
        app.navigationBars["Status"].appears()
        app.descendants(matching: .any)["status.operational-state"].appears()
        shot(33, "status")
        app.closeConnectorDetail()
    }

    private func captures() {
        app.openCaptureMenu()
        shot(34, "capture-menu")

        app.buttons["capture.menu.voice"].tap()
        let stop = app.buttons["voice.stop"]
        stop.appears("the voice panel")
        until("the microphone started") { stop.isEnabled }
        shot(35, "voice-panel")
        app.buttons["voice.cancel"].tap()
        stop.vanishes()

        app.openCamera()
        app.buttons["camera.shutter"].appears()
        shot(36, "camera")
        app.closeCaptureSheet()

        app.openCaptureMenu()
        app.buttons["capture.menu.note"].tap()
        let editor = app.textViews["notes.editor.body"]
        editor.appears()
        editor.typeText("A synthetic moment\nThe kettle, the window, the first light.")
        shot(37, "note-editor")
        app.buttons["notes.editor.done"].tap()
        editor.vanishes()

        app.openAllNotes()
        app.descendants(matching: .any)["notes.folders"].appears()
        shot(38, "notes-folders")
        app.closeCaptureSheet()

        app.openCaptureMenu()
        app.buttons["capture.menu.checkin"].tap()
        app.buttons["checkin.save"].appears()
        shot(39, "checkin")
        app.buttons["checkin.cancel"].tap()
        app.buttons["checkin.save"].vanishes()
    }


    private func inspect(_ slot: Int, _ name: String, _ prefix: String, label: String, not excluded: String = "\u{0}") {
        toDayTop()
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@ AND NOT label CONTAINS %@",
                                  prefix, label, excluded))
        var row: XCUIElement?
        for _ in 0..<30 {
            row = rows.allElementsBoundByIndex.first { visible($0) && $0.frame.minY > 200 }
            if row != nil { break }
            step()
        }
        guard let row else { return XCTFail("no row \(label) on the day") }
        row.tap()
        let inspector = app.descendants(matching: .any)["inspector"]
        inspector.appears("the \(name) inspector")
        _ = inspector.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Loading")).firstMatch
            .vanishes(within: 10)
        shot(slot, "inspector-\(name)")
        for _ in 0..<3 where inspector.exists { inspector.swipeDown(velocity: .fast) }
        inspector.vanishes()
    }

    private func step() {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .default, thenHoldForDuration: 0.1)
    }

    private func toDayTop() {
        for _ in 0..<16 {
            let figures = shown("day.figures")
            if figures.exists, figures.isHittable, figures.frame.minY >= 100 { return }
            app.swipeDown()
        }
        XCTFail("the day's top")
    }

    private func visible(_ element: XCUIElement) -> Bool {
        guard element.exists, element.isHittable else { return false }
        let bar = app.navigationBars.firstMatch, tabs = app.tabBars.firstMatch
        let top = bar.exists ? bar.frame.maxY : 0
        let bottom = tabs.exists ? tabs.frame.minY : app.frame.maxY
        return element.frame.minY >= top - 4 && element.frame.maxY <= bottom
    }

    private func reveal(_ prefix: String, by move: () -> Void) -> Bool {
        for _ in 0..<16 {
            if visible(shown(prefix)) { return true }
            move()
        }
        return visible(shown(prefix))
    }

    private func shown(_ prefix: String) -> XCUIElement {
        let matches = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
        return matches.allElementsBoundByIndex.first { $0.isHittable } ?? matches.firstMatch
    }

    private func viewer() {
        let tile = app.scrolledTo("place.photo.0")
        until("its first photo drawn") { tile.exists && tile.value as? String == "drawn" }
        tile.tap()
        let photo = app.descendants(matching: .any)["viewer.photo"].firstMatch
        until("the photo drawn") { photo.exists && (photo.value as? String)?.hasPrefix("screen") == true }
        app.buttons["viewer.title"].appears("the photo's facts")
        shot(45, "viewer")
        photo.tap()
        app.buttons["viewer.title"].vanishes()
        shot(46, "viewer-bare")
        photo.tap()
        app.buttons["viewer.infoButton"].tap()
        app.descendants(matching: .any)["viewer.info.date"].firstMatch.appears("Info")
        shot(47, "viewer-info")
        let count = app.descendants(matching: .any)["viewer.count"].firstMatch
        let onward: [(place: String, slot: Int?, name: String?)] = [("2 of 4", nil, nil), ("3 of 4", 51, "viewer-info-off"),
                                                                    ("4 of 4", 52, "viewer-info-waiting")]
        for (place, slot, name) in onward {
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.2))
            from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.2)))
            until("on to \(place)") { count.value as? String == place }
            if let slot, let name {
                app.descendants(matching: .any)["viewer.info.made.line"].firstMatch.appears("what a model made of it")
                shot(slot, name)
            }
        }
        app.buttons["viewer.infoButton"].tap()
        app.buttons["Close"].firstMatch.tap()
        photo.vanishes()
    }

    private func shot(_ slot: Int, _ name: String) {
        let file = folder.appendingPathComponent(String(format: "%02d-%@.png", slot, name))
        XCTAssertNoThrow(try XCUIScreen.main.screenshot().pngRepresentation.write(to: file), file.path)
    }


    private static func isWeekend(_ back: Int) -> Bool {
        [1, 7].contains(Calendar(identifier: .gregorian).component(.weekday, from: day(back)))
    }

    private static func isPlainWeekday(_ back: Int) -> Bool {
        guard !isWeekend(back) else { return false }
        let calendar = Calendar(identifier: .gregorian)
        let month = calendar.dateComponents([.year, .month], from: calendar.date(byAdding: .month, value: -1, to: TestClock.now)!)
        let trip = (12...14).map { String(format: "%04d-%02d-%02d", month.year!, month.month!, $0) }
        return !trip.contains(civilDay(daysBack: back))
    }

    private static func beforeHome(_ day: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("homelink/Tests/Fixtures/pages/canned/day.\(day).json"))
        let page = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], "the home's page of \(day)")
        return try XCTUnwrap(page["before_home"] as? String, "the home's words for a day before its first")
    }

    private static func civilDay(daysBack: Int) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: day(daysBack))
    }

    private static func longDate(daysBack: Int) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEEE d MMMM"
        return formatter.string(from: day(daysBack))
    }

    private static func day(_ back: Int) -> Date {
        let shifted = TestClock.now.addingTimeInterval(-4 * 3600)
        return Calendar(identifier: .gregorian).date(byAdding: .day, value: -back, to: shifted) ?? shifted
    }
}

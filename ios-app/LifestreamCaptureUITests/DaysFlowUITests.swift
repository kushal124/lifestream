import XCTest

@MainActor
final class DaysFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyDay() throws {
        let app = launch(open: "days")
        app.capturePlus.appears()
        let title = { app.inFront("day.title") }
        app.appearsInFront("day.title", "the day's title")
        XCTAssertTrue(title().label.contains(CannedClock.longDate(daysBack: 0)), "Days opens on today: \(title().label)")
        XCTAssertTrue(title().label.hasSuffix("Today"), "its word under it: \(title().label)")
        app.dayDrawn("today")
        XCTAssertLessThan(app.inFront("days.day").frame.minY, title().frame.maxY - 40,
                          "the day's scroll view starts under the bar")
        let figures = app.inFront("day.figures")
        figures.appears("today's figures")
        let figuresSaid = figures.children(matching: .any).matching(NSPredicate(format: "label != ''")).allElementsBoundByIndex.map(\.label)
        XCTAssertTrue((1...3).contains(figuresSaid.count), "three figures at most: \(figuresSaid)")
        for figure in figuresSaid {
            XCTAssertNotNil(figure.range(of: #"^\S.*, (asleep|steps so far|steps|recovery|messages? sent|to you)$"#, options: .regularExpression),
                            "a figure reads its value, then its caption: \(figure)")
        }
        XCTAssertTrue(figuresSaid.contains { $0.hasSuffix(", steps so far") }, "today's steps are so far: \(figuresSaid)")
        keep("today")
        app.bringIntoView(app.inFront("day.now"))
        XCTAssertTrue(app.inFront("day.now").label.hasPrefix("Now, "), "Now reads itself first: \(app.inFront("day.now").label)")
        keep("now")

        app.yesterdayBeside()
        app.swipeRight()
        until("yesterday: \(title().label)") { title().label.contains(CannedClock.longDate(daysBack: 1)) }
        app.dayDrawn("yesterday")
        let first = { app.inFront("day.stay.0") }
        app.bringIntoView(first())
        XCTAssertEqual(first().value as? String, "Collapsed", "every stay opens folded")
        XCTAssertTrue(first().label.hasPrefix("Home, 04:00, "), "a head reads its place, its time, its length: \(first().label)")
        XCTAssertTrue(app.inFront("day.names.0").exists, "its names band under it")
        XCTAssertEqual(stayRows(app).count, 0, "no row drawn while every stay is folded")
        XCTAssertGreaterThan(rows(app).count, 0, "the dated records' block opens drawn, under \"Also that day\"")
        let heads = headCount(app)
        XCTAssertGreaterThanOrEqual(heads, 2, "yesterday is its stays")
        keep("folded")

        app.bringIntoView(first())
        first().tap()
        until("the stay opens") { self.first(app).value as? String == "Expanded" }
        until("its rows drawn") { self.stayRows(app).count > 0 }
        let row = stayRows(app)[0]
        XCTAssertTrue(row.label.range(of: #"^\d\d:\d\d, "#, options: .regularExpression) != nil, "a row reads its time first: \(row.label)")
        keep("open")
        app.bringIntoView(first())
        first().tap()
        until("the head folds it") { self.first(app).value as? String == "Collapsed" && self.stayRows(app).isEmpty }

        let names = app.inFront("day.names.0")
        app.bringIntoView(names)
        let name = try XCTUnwrap(names.buttons.allElementsBoundByIndex.last { $0.isHittable }, "a name in the band")
        name.tap()
        let inspector = app.descendants(matching: .any)["inspector"].firstMatch
        inspector.appears("the name opens its own item")
        XCTAssertEqual(first().value as? String, "Collapsed", "the stay stays folded")
        XCTAssertEqual(stayRows(app).count, 0, "no row drawn under it")
        keep("name")
        app.swipeAway(inspector)
        app.bringIntoView(first())
        first().tap()
        until("the stay opens") { self.first(app).value as? String == "Expanded" && !self.stayRows(app).isEmpty }

        app.bringIntoView(first(), towardTop: true)
        let bar = app.rootLineFoot
        let isPinned = {
            let head = self.first(app).frame
            return abs(head.minY - bar) < 8 && self.rows(app).contains { $0.frame.minY < head.maxY }
        }
        for _ in 0..<16 {
            if isPinned() { break }
            app.drag(up: true, share: 0.06)
        }
        XCTAssertTrue(isPinned(), "the open head pins under the bar, a row under it")
        let pinned = first()
        keep("pinned")
        let held = pinned.frame.minY
        pinned.tap()
        until("folded from the pinned head") { self.first(app).exists && self.first(app).value as? String == "Collapsed" }
        XCTAssertEqual(first().frame.minY, held, accuracy: 8, "the head stays where it stood")

        app.bringIntoView(app.inFront("day.end"))
        app.bringIntoView(app.inFront("day.map"))
        let map = app.inFront("day.map")
        let end = app.inFront("day.end")
        XCTAssertTrue(end.exists, "the day's end still drawn above the map")
        XCTAssertGreaterThan(map.frame.minY, end.frame.maxY, "the map after the day's end")
        keep("map")
        app.bringIntoView(app.inFront("day.places"))
        XCTAssertGreaterThan(app.inFront("day.places").frame.minY, map.frame.maxY, "Places under the map")
        app.bringIntoView(app.inFront("day.place.home-place"))
        XCTAssertTrue(app.inFront("day.place.home-place").exists, "the stays at Home are its owner place, by the slug the door's labels say")
        app.bringIntoView(app.inFront("day.person.0"))
        let person = app.inFront("day.person.0")
        XCTAssertGreaterThan(person.frame.minY, app.inFront("day.places").frame.minY, "People after Places")
        XCTAssertTrue(person.label.range(of: #"(message|call)"#, options: .regularExpression) != nil,
                      "a person reads their contact in words: \(person.label)")
        keep("people")

        let short = app.buttons.matching(NSPredicate(format: "identifier == 'bar.title' AND label == %@", shortDate(daysBack: 1))).firstMatch
        short.appears("at the day's foot, the bar's short date a button")
        short.tap()
        let yesterday = app.buttons["days.day.\(CannedClock.civilDay(daysBack: 1))"]
        yesterday.appears("the short date opens the days")
        XCTAssertTrue(yesterday.isSelected, "the days open at the day shown")
        yesterday.tap()
        yesterday.vanishes("the day pressed, the page back")
        XCTAssertTrue(person.exists, "still where it was left")

        for back in 2...4 {
            app.swipeRight()
            until("\(back) days back: \(title().label)") { title().label.contains(CannedClock.longDate(daysBack: back)) }
        }
    }

    func testAClockReadLateDrawsTheDayInFrontAgainInItsZone() throws {
        let app = launch("--ui-test-proof", "--ui-test-clock-late", open: "stream:location")
        app.descendants(matching: .any)["connector.detail"].firstMatch.appears("Location's page")
        let refresh = app.descendants(matching: .any)["connector.detail.refresh"].firstMatch
        app.bringIntoView(refresh)
        refresh.tap()
        app.closeCaptureSheet()
        app.asks("clock", reach: 1)
        app.openTab("Timeline")
        let title = { app.inFront("day.title") }
        app.appearsInFront("day.title", "the day's head")
        app.dayDrawn("today")
        XCTAssertTrue(title().label.contains(CannedClock.longDate(daysBack: 0)), "the placeholder's today is the home's: \(title().label)")

        title().tap()
        let list = app.descendants(matching: .any)["days.list"].firstMatch
        list.appears("the calendar")
        let back = CannedClock.civilDay(daysBack: 22)
        app.bringIntoView(app.buttons["days.day.\(back)"])
        app.buttons["days.day.\(back)"].tap()
        list.vanishes("a day of the calendar opens it")
        until("22 days back: \(title().label)") { title().label.contains(CannedClock.longDate(daysBack: 22)) }
        app.dayDrawn("22 days back")
        let first = { app.inFront("day.stay.0") }
        app.bringIntoView(first())
        let home = CannedClock.dayStart(daysBack: 22, in: CannedClock.elsewhere)
        until("the first stay's time in the home's zone, \(home): \(first().label)") { first().label.hasPrefix("Home, \(home), ") }
        XCTAssertTrue(title().label.contains(CannedClock.longDate(daysBack: 22)), "the same day, never navigated: \(title().label)")
    }

    func testJourneyUnnamedStay() throws {
        let app = yesterday()
        let near = try XCTUnwrap(head(app, saying: "Near Home, "), "the stay near Home reads by what it is near")
        let n = near.dropFirst("day.stay.".count)
        app.appearsInFront("day.nameit.\(n)", "Name it on the stay in a spot worth naming")
        XCTAssertEqual(app.inFront("day.nameit.\(n)").elementType, .button, "Name it is a button of its own")
        keep("unnamed-nameit")

        let day = CannedClock.civilDay(daysBack: 1)
        let probe = { (name: String) in app.descendants(matching: .any)["ui-test." + name].firstMatch.label }
        let opened = probe("loop.\(day)")
        app.bringIntoView(app.inFront("day.nameit.\(n)"))
        app.inFront("day.nameit.\(n)").tap()
        app.descendants(matching: .any)["naming.map"].firstMatch.appears("the naming card for the stay's spot")
        let name = app.buttons["naming.name.0"]
        name.appears("the home's names for the spot")
        XCTAssertTrue(name.label.hasPrefix("Synthetic Gym, "), name.label)
        keep("unnamed-naming")
        movedOff(app)
        let before = app.asks("day")
        name.tap()
        app.buttons["naming.close"].tap()
        app.descendants(matching: .any)["naming.map"].firstMatch.vanishes("the walk closed, the day under it")
        until("yesterday's task following the naming: \(probe("loop.\(day)"))") {
            let newest = probe("loop.\(day)")
            return newest != opened && probe("loop.\(day)#\(newest)") == "front"
        }

        let following = probe("loop.\(day)")
        let reads = probe("asks.day.\(day)")
        app.swipeLeft()
        until("today") { app.inFront("day.title").label.contains(CannedClock.longDate(daysBack: 0)) }
        app.dayDrawn("today")
        until("yesterday's following task cancelled: \(probe("loop.\(day)#\(following)"))") { probe("loop.\(day)#\(following)") == "cancelled" }
        until("yesterday's task beside today ended: \(probe("loop.\(day)"))") {
            let newest = probe("loop.\(day)")
            return newest != following && probe("loop.\(day)#\(newest)") == "ended"
        }
        XCTAssertEqual(probe("asks.day.\(day)"), reads, "no read of yesterday once it is off the screen")

        app.swipeRight()
        until("yesterday") { app.inFront("day.title").label.contains(CannedClock.longDate(daysBack: 1)) }
        until("the head reads the place named: \(app.inFront(near).label)") { app.inFront(near).label.hasPrefix("Synthetic Gym, ") }
        XCTAssertGreaterThanOrEqual(app.asks("day"), before + 2, "read at the close, then again until the render landed")
        XCTAssertFalse(app.inFront("day.nameit.\(n)").exists, "a place named carries no link")
        keep("unnamed-named")
    }

    private let CannedNamingReach = 1_000.0

    private func movedOff(_ app: XCUIApplication) {
        let map = app.descendants(matching: .any)["naming.map"].firstMatch
        let center = app.descendants(matching: .any)["circle.center"].firstMatch
        let metres = { () -> Double in
            guard let said = center.value as? String, let match = said.firstMatch(of: /Moved (\d+)\s*m\b/) else { return 0 }
            return Double(match.1) ?? 0
        }
        for _ in 0..<4 where metres() <= 80 {
            let from = map.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.85))
            from.drag(to: from.withOffset(CGVector(dx: -60, dy: 0)), hold: 0.2)
            until("the centre moves: \(String(describing: center.value))") { (center.value as? String) != "Where it was" }
        }
        XCTAssertGreaterThan(metres(), 80, "the circle no longer holds the spot's centre: \(String(describing: center.value))")
        XCTAssertLessThan(metres(), CannedNamingReach, "still where the spot's stays lie: \(String(describing: center.value))")
    }

    private func yesterday() -> XCUIApplication {
        let app = launch(open: "days")
        app.dayDrawn("today")
        app.yesterdayBeside()
        app.swipeRight()
        until("yesterday") { app.inFront("day.title").label.contains(CannedClock.longDate(daysBack: 1)) }
        app.dayDrawn("yesterday")
        return app
    }

    private func stayRows(_ app: XCUIApplication) -> [XCUIElement] {
        let label = app.staticTexts["Also that day"]
        guard label.exists else { return rows(app) }
        let top = label.frame.minY
        return rows(app).filter { $0.frame.minY < top }
    }

    private func head(_ app: XCUIApplication, saying words: String) -> String? {
        let screen = app.frame
        let found = {
            app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'day.stay.' AND label BEGINSWITH %@", words))
                .allElementsBoundByIndex.first { $0.exists && screen.minX <= $0.frame.midX && $0.frame.midX < screen.maxX }?.identifier
        }
        let end = { app.inFront("day.end") }
        for _ in 0..<20 {
            if found() != nil || (end().exists && end().frame.maxY <= screen.maxY) { break }
            app.drag(up: true)
        }
        guard let id = found() else { return nil }
        app.bringIntoView(app.inFront(id))
        return id
    }


    private func first(_ app: XCUIApplication) -> XCUIElement {
        app.inFront("day.stay.0")
    }

    private func rows(_ app: XCUIApplication) -> [XCUIElement] {
        let screen = app.frame
        return app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'day.row.'")).allElementsBoundByIndex
            .filter { $0.exists && screen.minX <= $0.frame.midX && $0.frame.midX < screen.maxX }
    }

    private func headCount(_ app: XCUIApplication) -> Int {
        let screen = app.frame
        let drawnHeads = {
            Set(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'day.stay.'")).allElementsBoundByIndex
                .filter { $0.exists && screen.minX <= $0.frame.midX && $0.frame.midX < screen.maxX }.map(\.identifier))
        }
        var seen = drawnHeads()
        let end = { app.inFront("day.end") }
        for _ in 0..<20 {
            if end().exists && end().frame.maxY <= screen.maxY { break }
            app.drag(up: true)
            seen.formUnion(drawnHeads())
        }
        app.bringIntoView(app.inFront("day.stay.0"), towardTop: true)
        return seen.count
    }

    private func shortDate(daysBack: Int) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE d MMM"
        return formatter.string(from: CannedClock.day(daysBack))
    }
}

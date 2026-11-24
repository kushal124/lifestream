import XCTest

@MainActor
final class SpeedUITests: XCTestCase {
    static let subsystem = "org.lifestreamprotocol.phone"
    static let category = "Interactions"
    private let tabs = ["Chat", "Timeline", "People", "Places", "Agents"]

    private var scale: String { ProcessInfo.processInfo.environment["SPEED_SCALE"] ?? "1" }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }


    func testTabSwitches() throws {
        let app = launch("tabs")
        let switched = ["Chat", "Timeline", "People", "Places"]
        for name in tabs { select(app, name) }
        app.typeText("synthetic")
        putAwayKeyboard(app)
        let origin = app.coordinate(withNormalizedOffset: .zero)
        select(app, "Places")
        let at = Dictionary(uniqueKeysWithValues: tabs.map { name in
            let frame = app.tab(name).frame
            return (name, origin.withOffset(CGVector(dx: frame.midX, dy: frame.midY)))
        })
        var random = SeededRandom(seed: 21)
        var last = "Places"
        measure(metrics: [interval("Tab switch"), XCTClockMetric(), XCTCPUMetric(application: app),
                          XCTMemoryMetric(application: app)], options: once()) {
            for _ in 0..<100 {
                var next = last
                while next == last { next = switched[Int(random.next() % UInt64(switched.count))] }
                at[next]!.tap()
                last = next
            }
            for _ in 0..<10 {
                at["Agents"]!.tap()
                at[last]!.tap()
            }
        }
        XCTAssertTrue(app.tab(last).isSelected, "the taps switched tabs")
    }

    private func putAwayKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.appears(within: 1) else { return }
        if app.searchClose.exists { app.closeSearch() } else { app.typeText("\n") }
        app.keyboards.firstMatch.vanishes("the keyboard went away")
    }


    func testScrolls() throws {
        let app = launch("scrolls")
        let options = once()
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTOSSignpostMetric.scrollDraggingMetric,
                          XCTCPUMetric(application: app), XCTMemoryMetric(application: app)], options: options) {
            for name in ["People", "Places", "Connectors", "Timeline"] {
                select(app, name)
                let list = app.scrollViews.firstMatch
                for _ in 0..<5 { list.swipeUp(velocity: .fast) }
                for _ in 0..<5 { list.swipeDown(velocity: .fast) }
            }
        }
    }

    func testRefresh() throws {
        let app = launch("refresh")
        select(app, "People")
        measure(metrics: [interval("Refresh")], options: once()) {
            for _ in 0..<3 {
                let list = app.scrollViews.firstMatch
                list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
                    .press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
            }
        }
    }


    func testSearchTyping() throws {
        let app = launch("search")
        measure(metrics: [interval("Search keystroke"), XCTCPUMetric(application: app)], options: once()) {
            for (name, words) in [("People", "person ka"), ("Places", "place ka"), ("Connectors", "whats")] {
                select(app, name)
                let field = app.searchFields["Search \(name.lowercased())"]
                field.appears("\(name)'s search")
                field.tap()
                field.typeText(words)
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: words.count))
                putAwayKeyboard(app)
            }
            select(app, "Search")
            let field = app.searchFields["Search your life"]
            field.appears("Search's field")
            field.typeText("person a walk")
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 13))
        }
    }


    func testPushPop() throws {
        let app = launch("pushpop")
        select(app, "People")
        let row = app.buttons["people.row.person:person-a"]
        row.appears("Person A in the list")
        measure(metrics: [XCTOSSignpostMetric.navigationTransitionMetric, XCTCPUMetric(application: app)], options: once()) {
            for round in 0..<10 {
                app.buttons["people.row.person:person-a"].tap()
                app.descendants(matching: .any)["person.screen"].appears()
                let back = app.navigationBars.buttons.element(boundBy: 0)
                until("the push settled") { back.isHittable }
                if round.isMultiple(of: 2) {
                    let place = back.frame
                    let screen = app.descendants(matching: .any)["person.screen"]
                    for _ in 0..<3 where screen.exists {
                        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: place.midX, dy: place.midY)).tap()
                        _ = screen.vanishes(within: 5)
                    }
                } else {
                    let window = app.windows.firstMatch
                    let screen = app.descendants(matching: .any)["person.screen"]
                    for _ in 0..<3 where screen.exists {
                        window.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
                            .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
                        _ = screen.vanishes(within: 5)
                    }
                }
                app.buttons["people.row.person:person-a"].appears("back on the list")
            }
        }
    }

    func testSheets() throws {
        let app = launch("sheets")
        select(app, "Timeline")
        measure(metrics: [interval("Sheet")], options: once()) {
            for _ in 0..<5 {
                app.capturePlus.tap()
                let notes = app.buttons["capture.menu.notes"]
                notes.appears("the + menu's Notes")
                notes.tap()
                let close = app.buttons["capture.close"].firstMatch
                close.appears("the notes sheet")
                tap(close, until: { close.vanishes(within: 3) }, "the notes sheet closed")
            }
        }
    }


    func testReturnToFront() throws {
        let app = launch("return", locked: true)
        select(app, "People")
        measure(metrics: [interval("Return to front"), interval("Unlock"), XCTClockMetric()], options: once()) {
            for _ in 0..<10 {
                XCUIDevice.shared.press(.home)
                until("the app went away") { [.runningBackground, .runningBackgroundSuspended].contains(app.state) }
                app.activate()
                until("the app came back") { app.state == .runningForeground }
                unlock(app)
            }
        }
    }

    private func unlock(_ app: XCUIApplication) {
        let unlock = app.buttons["life.unlock"]
        unlock.appears("the life sections locked")
        tap(unlock, until: { unlock.vanishes(within: 10) }, "the sections opened")
    }

    private func tap(_ element: XCUIElement, until done: () -> Bool, _ what: String) {
        for _ in 0..<3 {
            let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: element)
            if XCTWaiter().wait(for: [hittable], timeout: 5) == .completed { element.tap() }
            if done() { return }
        }
        XCTFail(what)
    }

    func testLaunch() throws {
        let app = launch("launch")
        app.terminate()
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)]) {
            app.launch()
        }
    }


    private func arguments(_ phase: String) -> [String] {
        ["--ui-testing", "--ui-test-speed", "--ui-test-scale", scale, "--ui-test-phase", "\(phase)-x\(scale)"]
    }

    private func launch(_ phase: String, locked: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments(phase) + (locked ? ["--ui-test-locked"] : [])
        app.launch()
        if app.buttons["firstrun.setup"].appears(within: 5) { app.startCapture() }
        if locked { unlock(app) }
        select(app, "Timeline")
        return app
    }

    private func select(_ app: XCUIApplication, _ name: String) {
        if app.keyboards.firstMatch.exists { putAwayKeyboard(app) }
        let streams = app.rootHead("Connectors")
        if name == "Connectors" {
            if !streams.exists { app.buttons["streams.open"].firstMatch.tap() }
            streams.appears(name)
            return
        }
        if streams.exists {
            app.buttons["streams.close"].firstMatch.tap()
            streams.vanishes("Connectors closes")
        }
        if name == "Search" {
            app.openSearch()
            return
        }
        app.bringTabBarIntoReach()
        let tab = app.tab(name)
        for _ in 0..<3 where !tab.isSelected { tab.tap() }
        XCTAssertTrue(tab.isSelected, name)
    }

    private func interval(_ name: String) -> XCTOSSignpostMetric {
        XCTOSSignpostMetric(subsystem: Self.subsystem, category: Self.category, name: name)
    }

    private func once() -> XCTMeasureOptions {
        let options = XCTMeasureOptions()
        options.iterationCount = 1
        return options
    }
}

struct SeededRandom {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return state >> 33
    }
}

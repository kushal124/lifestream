import XCTest

@MainActor
final class CheckInUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testSystemNotificationTapOpensCheckIn() {
        let app = launch()
        app.relaunch("--ui-test-system-notification", opens: .unwaited)
        app.allowing(until: app.descendants(matching: .any)["ui-test.notifications-asked"].firstMatch, "the ask for notifications answered")
        XCUIDevice.shared.press(.home)
        let notification = springboard.staticTexts["Synthetic check-in"].firstMatch
        notification.appears(springboard.debugDescription)
        notification.tap()
        app.buttons["checkin.save"].appears(app.debugDescription)
        XCTAssertTrue(rail("pleasant", in: app).exists)
    }

    func testJourneyMomentAnswersSaveOneReport() {
        let app = launch(open: "checkin", text: .largest)
        until("the app stands in portrait") { app.frame.height > app.frame.width }
        let pleasant = rail("pleasant", in: app)
        pleasant.appears()
        reveal(pleasant, in: app)
        keep("moment-largest")
        let before = pleasant.frame.minY
        let start = pleasant.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.drag(to: start.withOffset(CGVector(dx: 0, dy: -180)))
        XCTAssertLessThan(pleasant.frame.minY, before - 40, "the vertical drag scrolled the form")
        XCTAssertEqual(pleasant.value as? String, "Not selected")

        let save = app.buttons["checkin.save"]
        save.appears(); XCTAssertTrue(save.isEnabled)
        save.tap()
        XCTAssertTrue(app.staticTexts["checkin.validation"].exists)

        let energy = rail("energy", in: app)
        reveal(energy, in: app)
        XCTAssertEqual(energy.value as? String, "Not selected")
        let first = energy.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
        let last = energy.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        first.drag(to: last, velocity: .slow, hold: 0.1)
        XCTAssertTrue(value(energy).hasSuffix("5 of 5"), value(energy))
        let second = energy.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
        last.drag(to: second, velocity: .slow, hold: 0.1)
        XCTAssertTrue(value(energy).hasSuffix("2 of 5"), value(energy))
        XCTAssertEqual(pleasant.value as? String, "Not selected")
        select(3, count: 5, item: "energy", in: app)
        XCTAssertTrue(value(energy).hasSuffix("3 of 5"), "tap-to-select remains available: \(value(energy))")
        let gap = energy.frame.minY - pleasant.frame.minY
        select(3, count: 7, item: "pleasant", in: app)
        XCTAssertEqual(energy.frame.minY - pleasant.frame.minY, gap, accuracy: 1, "longer labels must not move the controls")
        select(3, count: 5, item: "tense", in: app)
        keep("moment-answered")
        save.tap()
        save.vanishes()

        app.relaunch()
        app.openMachinery("settings.checkins")
        let count = app.descendants(matching: .any)["checkin.reportCount"].firstMatch
        count.appears()
        XCTAssertTrue(count.staticTexts["1"].exists || count.label.contains("1"), "The count is read from the checkin log")
        keep("checkins-count")

        app.buttons["checkin.ready"].tap()
        rail("clarity", in: app).appears()
        select(3, count: 5, item: "clarity", in: app)
        select(3, count: 9, item: "kss", in: app)
        let sleepy = rail("kss", in: app)
        let railY = sleepy.frame.minY
        let third = sleepy.coordinate(withNormalizedOffset: CGVector(dx: 2.5 / 9, dy: 0.5))
        let ninth = sleepy.coordinate(withNormalizedOffset: CGVector(dx: 8.5 / 9, dy: 0.5))
        third.drag(to: ninth, velocity: .slow, hold: 0.1)
        XCTAssertTrue(value(sleepy).hasSuffix("9 of 9"), value(sleepy))
        XCTAssertEqual(sleepy.frame.minY, railY, accuracy: 1)
        select(3, count: 9, item: "kss", in: app)
        app.buttons["checkin.save"].tap()
        app.descendants(matching: .any)["checkin.vigilance"].firstMatch.appears()
        keep("vigilance")
    }

    private func rail(_ item: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "checkin.\(item).rail").firstMatch
    }

    private func value(_ rail: XCUIElement) -> String {
        rail.value as? String ?? ""
    }

    private func reveal(_ control: XCUIElement, in app: XCUIApplication) {
        app.bringIntoView(control, between: app.buttons["checkin.save"].firstMatch)
    }

    private func select(_ step: Int, count: Int, item: String, in app: XCUIApplication) {
        let control = rail(item, in: app)
        reveal(control, in: app)
        control.coordinate(withNormalizedOffset: CGVector(dx: (Double(step) - 0.5) / Double(count), dy: 0.5)).tap()
    }
}
